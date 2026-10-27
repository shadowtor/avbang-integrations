// Live check of integrations/stash/avbang.yml against a real Stash (phase 28.1, D-07/D-08).
//   node integrations/stash/live-scrape.mjs --mock
//   node integrations/stash/live-scrape.mjs --real   (plan 07: AVBANG_API_BASE default https://api-test.avbang.net/v1, key in AVBANG_TEST_KEY)
// The committed avbang.yml is never edited: a copy with the API base and a harness key goes into a temp Stash config dir.
// In scraper mode Stash itself fetches the cover URL, so no test-origin option is involved.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURES, startMock, summary } from "../lib/mock-api.mjs";
import { HOST_FROM_CONTAINER, reporter, throwawayKey } from "../lib/harness.mjs";
import { bootStash, sceneIdsByName } from "./lib/live-common.mjs";

const real = process.argv.includes("--real");
if (!real && !process.argv.includes("--mock")) {
  console.error("usage: node integrations/stash/live-scrape.mjs --mock | --real");
  process.exit(2);
}
const t = reporter();
const SOURCE = readFileSync(fileURLToPath(new URL("./avbang.yml", import.meta.url)), "utf8");
const PROD_BASE = "https://api.avbang.net/v1";
const FAKE_AUTH = "Bearer av_live_xxxxxxxxxx";
t.check("committed scraper carries only the fake key", SOURCE.includes(FAKE_AUTH) && !/av_live_[A-Za-z0-9]{12,}/.test(SOURCE));

let mock;
let front;
let stash;
const seen = []; // requests the scraper made: { url, hasAuth }
try {
  let base;
  let key;
  let code;
  if (real) {
    base = process.env.AVBANG_API_BASE || "https://api-test.avbang.net/v1";
    key = process.env.AVBANG_TEST_KEY;
    if (!key) throw new Error("AVBANG_TEST_KEY is required for --real");
    const r = await fetch(`${base}/titles?limit=1`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    code = (await r.json()).data?.[0]?.code;
    if (!code) throw new Error("could not discover a catalogue code");
  } else {
    key = throwawayKey();
    mock = await startMock({ apiKey: key });
    code = "STAR-489";
    // The mock owns no /v1/search; this harness-local front adds it from the mock's own FIXTURES and forwards the rest.
    front = createServer(async (req, res) => {
      const u = new URL(req.url, "http://front.invalid");
      const auth = req.headers.authorization;
      seen.push({ url: req.url, hasAuth: auth !== undefined });
      if (u.pathname === "/v1/search") {
        if (auth !== `Bearer ${key}`) { res.writeHead(401); return res.end("{}"); }
        const q = (u.searchParams.get("q") ?? "").toUpperCase();
        const titles = Object.values(FIXTURES).filter((f) => f.title.code.includes(q) || f.title.title.toUpperCase().includes(q)).map((f) => summary(f.title));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ query: q, page: 1, titles, performers: [], studios: [], tags: [] }));
      }
      const up = await fetch(mock.apiOrigin + req.url, { headers: auth ? { authorization: auth } : {} });
      let body = Buffer.from(await up.arrayBuffer());
      const m = /^\/v1\/titles\/([A-Za-z0-9-]+)$/.exec(u.pathname);
      if (up.status === 200 && m) {
        // fixture covers name the production host; point Stash at the mock image origin instead (response rewrite only)
        const j = JSON.parse(body.toString());
        j.cover = `${mock.imageOrigin}/img/${j.code}/640.webp`;
        body = Buffer.from(JSON.stringify(j));
      }
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(body);
    });
    await new Promise((ok) => front.listen(0, "0.0.0.0", ok));
    base = `http://${HOST_FROM_CONTAINER}:${front.address().port}/v1`;
  }

  const yml = SOURCE.replaceAll(PROD_BASE, base).replace(FAKE_AUTH, `Bearer ${key}`);
  stash = await bootStash({ files: [`${code} Scene.mp4`], scrapers: [["avbang.yml", yml]] });
  const { gql, container } = stash;

  const list = await gql(`{ listScrapers(types:[SCENE]) { id name scene { supported_scrapes } } }`);
  const me = list.listScrapers.find((s) => s.id === "avbang");
  t.check("Stash lists the AVBang scraper", !!me);
  const sup = me?.scene?.supported_scrapes ?? [];
  console.log(`INFO supported_scrapes: ${JSON.stringify(me?.scene)}`);
  t.check("supports FRAGMENT and NAME", sup.includes("FRAGMENT") && sup.includes("NAME"), sup.join(","));

  const ids = await sceneIdsByName(gql);
  const sceneId = Object.values(ids)[0];
  const F = `title code details date urls studio{name} performers{name} tags{name} image`;
  const decode = (img) => (img && img.startsWith("data:") ? Buffer.from(img.split(",")[1] ?? "", "base64") : Buffer.alloc(0));
  const assertShape = (label, s) => {
    t.check(`${label}: title`, !!s?.title);
    t.check(`${label}: code`, !!s?.code);
    t.check(`${label}: date`, /^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? ""), String(s?.date));
    t.check(`${label}: urls`, (s?.urls?.length ?? 0) > 0);
  };

  const frag = (await gql(`query($id:ID!){ scrapeSingleScene(source:{scraper_id:"avbang"}, input:{scene_id:$id}) { ${F} } }`, { id: sceneId })).scrapeSingleScene[0];
  assertShape("fragment", frag);
  t.check("fragment: code matches the file name", frag?.code === code, String(frag?.code));
  t.check("fragment: studio", !!frag?.studio?.name);
  t.check("fragment: performers", (frag?.performers?.length ?? 0) > 0);
  t.check("fragment: tags", (frag?.tags?.length ?? 0) > 0);
  t.check("fragment: details", !!frag?.details);
  if (!real) {
    t.check("fragment: title is Office overtime", frag?.title === "Office overtime", String(frag?.title));
    t.check("fragment: date 2026-04-12", frag?.date === "2026-04-12");
    t.check("fragment: studio Aurora", frag?.studio?.name === "Aurora");
    t.check("fragment: performer Aya Mizuno", frag?.performers?.[0]?.name === "Aya Mizuno");
    t.check("fragment: tag Office", frag?.tags?.[0]?.name === "Office");
    t.check("fragment: image present", !!frag?.image);
    const b = decode(frag?.image);
    const webp = b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP";
    t.check("fragment: image decodes to RIFF....WEBP bytes", webp, b.subarray(0, 12).toString("latin1"));
    console.log(`INFO A5: Stash returned the WebP cover as ${frag?.image?.slice(0, 22)}... (${b.length} bytes)`);
  } else {
    // api-test image URLs name the production host; accept a cover or a reported fetch failure
    console.log(`INFO real mode: image ${frag?.image ? "present" : "absent (Stash reported no image)"}`);
  }

  const byName = (await gql(`query{ scrapeSingleScene(source:{scraper_id:"avbang"}, input:{query:"${code}"}) { title code date urls image } }`)).scrapeSingleScene;
  t.check("name scrape returns a result", byName.length > 0);
  assertShape("name", byName[0]);
  // picking a search result: Stash sends the chosen scene back as a fragment (sceneByQueryFragment)
  const pick = (await gql(`query($i:ScrapedSceneInput!){ scrapeSingleScene(source:{scraper_id:"avbang"}, input:{scene_input:$i}) { ${F} } }`, { i: { title: byName[0]?.title, url: byName[0]?.urls?.[0] } })).scrapeSingleScene[0];
  assertShape("picked result", pick);
  t.check("picked result: full record (studio, performers, details)", !!pick?.studio?.name && (pick?.performers?.length ?? 0) > 0 && !!pick?.details);
  if (!real) t.check("name: title is Office overtime", byName[0]?.title === "Office overtime", String(byName[0]?.title));

  if (!real) {
    t.check("scraper sent Authorization on every call", seen.length > 0 && seen.every((e) => e.hasAuth));
    t.check("Stash fetched the cover itself, without Authorization", mock.imageLog.length > 0);
    t.check("key appears in no URL", !seen.some((e) => e.url.includes(key)) && !mock.log.some((e) => e.url.includes(key)));
    t.check("key appears in no Stash log line", !container.logs().includes(key));
  }
} catch (e) {
  console.log(`FAIL harness error: ${String(e?.message ?? e).replaceAll(process.env.AVBANG_TEST_KEY ?? "\u0000", "[key]")}`);
  t.check("script ran to completion", false);
} finally {
  stash?.container.stop();
  front?.close();
  front?.closeAllConnections();
  await mock?.close();
  if (stash) rmSync(stash.cfg, { recursive: true, force: true });
}
t.done();
