// Live check of integrations/stash/push.mjs against a real Stash (phase 28.1, D-07/D-08).
//   node stash/live-push.mjs --mock
//   node stash/live-push.mjs --real   (plan 07: AVBANG_API_BASE default https://api-test.avbang.net/v1, key in AVBANG_TEST_KEY)
// Mock mode uses only the plan 01 fixtures. The push tool runs on the host, so the mock image URLs name 127.0.0.1 and
// the tool reaches them through the exact-origin test option (AVBANG_TEST_IMAGE_ORIGINS with AVBANG_ALLOW_INSECURE=1).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMock } from "../lib/mock-api.mjs";
import { reporter, throwawayKey } from "../lib/harness.mjs";
import { bootStash } from "./lib/live-common.mjs";

const real = process.argv.includes("--real");
if (!real && !process.argv.includes("--mock")) {
  console.error("usage: node stash/live-push.mjs --mock | --real");
  process.exit(2);
}
const PUSH = fileURLToPath(new URL("./push.mjs", import.meta.url));
const t = reporter();
let mock;
let stash;
try {
  let key;
  let apiBase;
  let files;
  let env;
  if (real) {
    apiBase = process.env.AVBANG_API_BASE || "https://api-test.avbang.net/v1";
    key = process.env.AVBANG_TEST_KEY;
    if (!key) throw new Error("AVBANG_TEST_KEY is required for --real");
    const r = await fetch(`${apiBase}/titles?limit=1`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    const code = (await r.json()).data?.[0]?.code;
    if (!code) throw new Error("could not discover a catalogue code");
    files = [`${code} Scene.mp4`, "nothing here.mp4"];
    env = {};
  } else {
    key = throwawayKey();
    mock = await startMock({ apiKey: key, imageBase: "127.0.0.1" });
    apiBase = `${mock.apiOrigin}/v1`;
    files = ["STAR-489 Office overtime.mp4", "STAR-490 blurred.mp4", "STAR-491 foreign cover.mp4", "STAR-489 STAR-490 ambiguous.mp4", "nothing here.mp4"];
    env = { AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: mock.imageOrigin };
  }
  stash = await bootStash({ files });
  const { gql, url } = stash;

  // async spawn: the mock API lives in this process and must keep serving while the tool runs
  const push = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [PUSH, "--stash-url", url, "--api-base", apiBase, ...args], {
        env: { ...process.env, NODE_ENV: "development", AVBANG_API_KEY: key, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const timer = setTimeout(() => child.kill(), 300_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
  const scenes = async () => {
    const d = await gql(`{ findScenes(filter:{per_page:-1, sort:"id"}) { scenes { id title code date details urls studio{name} performers{name} tags{name} files{path} paths{screenshot} } } }`);
    const by = {};
    for (const s of d.findScenes.scenes) by[s.files[0].path.split("/").pop()] = s;
    return by;
  };
  const counts = async () => {
    const d = await gql(`{ findStudios{count} findPerformers{count} findTags{count} }`);
    return [d.findStudios.count, d.findPerformers.count, d.findTags.count].join(",");
  };
  const shot = async (s) => {
    const r = await fetch(s.paths.screenshot, { signal: AbortSignal.timeout(30_000) });
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get("content-type") ?? "", hash: createHash("sha256").update(b).digest("hex"), head: b.subarray(0, 12).toString("latin1") };
  };
  const snap = async () => JSON.stringify(Object.values(await scenes()).map(({ paths, ...s }) => s));

  const mainFile = files[0];
  const before = await scenes();
  const coversBefore = {};
  for (const [name, s] of Object.entries(before)) coversBefore[name] = (await shot(s)).hash;
  const countsBefore = await counts();
  const stateBefore = await snap();

  // (1) dry run is inert
  const dry = await push();
  t.check("1 dry run exits 0", dry.code === 0, dry.out.slice(-400));
  t.check("1 dry run prints a plan for the main scene", /would update/.test(dry.out), dry.out.slice(-300));
  t.check("1 Stash is unchanged after a dry run", (await snap()) === stateBefore && (await counts()) === countsBefore);

  // (2) apply
  const app = await push("--apply");
  t.check("2 apply exits 0", app.code === 0, app.out.slice(-600));
  const after = await scenes();
  const s = after[mainFile];
  if (!real) {
    t.check("2 title", s.title === "Office overtime", s.title);
    t.check("2 code", s.code === "STAR-489", s.code);
    t.check("2 date", s.date === "2026-04-12", String(s.date));
    t.check("2 details", s.details === "Synopsis for Office overtime.", s.details);
    t.check("2 urls contain the title url", s.urls.includes("https://avbang.net/t/star-489"), s.urls.join(","));
    t.check("2 studio Aurora", s.studio?.name === "Aurora");
    t.check("2 performer Aya Mizuno", s.performers.some((p) => p.name === "Aya Mizuno"));
    t.check("2 tag Office", s.tags.some((x) => x.name === "Office"));
    const c = await shot(s);
    t.check("2 Stash serves a cover image", c.status === 200 && c.type.startsWith("image/"), `${c.status} ${c.type}`);
    t.check("2 the cover is the pushed one", c.hash !== coversBefore[mainFile], "screenshot unchanged");
    console.log(`INFO A5: Stash serves the pushed WebP cover as ${c.type}, first bytes ${JSON.stringify(c.head)}`);
  } else {
    const api = await (await fetch(`${apiBase}/titles/${s.code}`, { headers: { authorization: `Bearer ${key}` } })).json();
    t.check("2 title filled", s.title === api.title, s.title);
    t.check("2 code filled", s.code === api.code);
    if (api.releaseDate) t.check("2 date filled", s.date === api.releaseDate);
    if (api.synopsis) t.check("2 details filled", s.details === api.synopsis);
    t.check("2 urls contain the title url", s.urls.includes(api.url));
    if (api.studio) t.check("2 studio filled", s.studio?.name === api.studio.name);
    for (const p of api.performers) t.check(`2 performer ${p.name}`, s.performers.some((x) => x.name === p.name));
    for (const g of api.tags) t.check(`2 tag ${g.name}`, s.tags.some((x) => x.name === g.name));
    // api-test image URLs name the production host: the cover is either set or reported skipped, never asserted as delivered
    const cover = (await shot(s)).hash !== coversBefore[mainFile] || /cover skipped/.test(app.out);
    t.check("2 cover set or skipped with a reason", cover, app.out.slice(-300));
  }

  // (3) unmatched and ambiguous scenes untouched and listed as skipped
  const untouched = Object.keys(after).filter((n) => n !== mainFile && (real || !/^STAR-49[01] /.test(n)));
  t.check("3 other scenes are untouched", untouched.every((n) => !after[n].title && !after[n].code && !after[n].studio));
  t.check("3 skips are listed", /skipped: no match/.test(app.out) && (real || /skipped: ambiguous/.test(app.out)), app.out.slice(-500));

  // (4) idempotent rerun
  const countsMid = await counts();
  const stateMid = await snap();
  const again = await push("--apply");
  t.check("4 second apply exits 0 and reports 0 updated", again.code === 0 && /\b0 updated\b/.test(again.out), again.out.slice(-300));
  t.check("4 studio, performer and tag counts unchanged", (await counts()) === countsMid);
  t.check("4 scenes unchanged", (await snap()) === stateMid);
  const again2 = await push("--apply", "--overwrite");
  t.check("4 second apply with --overwrite also reports 0 updated", again2.code === 0 && /\b0 updated\b/.test(again2.out), again2.out.slice(-300));

  if (!real) {
    // (5) blurred fixture: fields yes, cover no unless --allow-blurred
    const b = after["STAR-490 blurred.mp4"];
    t.check("5 STAR-490 got its fields", b.title === "Night shift" && b.code === "STAR-490" && b.studio?.name === "Aurora" && b.performers.some((p) => p.name === "Rin Sato"));
    t.check("5 STAR-490 has no pushed cover", (await shot(b)).hash === coversBefore["STAR-490 blurred.mp4"]);
    t.check("5 the skip is reported", /cover skipped: cover only available blurred/.test(app.out));
    await gql(`mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }`, { i: { id: b.id, code: "" } }); // first-fill state again
    const blurred = await push("--apply", "--allow-blurred");
    t.check("5 --allow-blurred sets the cover", blurred.code === 0 && (await shot((await scenes())["STAR-490 blurred.mp4"])).hash !== coversBefore["STAR-490 blurred.mp4"], blurred.out.slice(-300));

    // (6) the key never travels in a URL or output
    t.check("6 every mock API request carried Authorization", mock.log.length > 0 && mock.log.every((e) => e.hasAuth));
    t.check("6 key in no API URL", !mock.log.some((e) => e.url.includes(key)));
    t.check("6 key in no image URL", !mock.imageLog.some((e) => e.url.includes(key)));
    t.check("6 key in no push output", ![dry, app, again, again2, blurred].some((r) => r.out.includes(key)));

    // (7) foreign cover host is never fetched
    const f = after["STAR-491 foreign cover.mp4"];
    t.check("7 STAR-491 got its fields", f.title === "Foreign cover" && f.code === "STAR-491" && f.studio?.name === "Borealis");
    t.check("7 foreign origin log is empty", mock.foreignLog.length === 0, JSON.stringify(mock.foreignLog));
    t.check("7 the cover was skipped as blocked", /cover skipped: blocked_image/.test(app.out));
    t.check("7 STAR-491 has no pushed cover", (await shot(f)).hash === coversBefore["STAR-491 foreign cover.mp4"]);
    t.check("mock image origin served the clear cover", mock.imageLog.length > 0);
  } else {
    t.check("key in no push output", ![dry, app, again, again2].some((r) => r.out.includes(key)));
  }
} catch (e) {
  console.log(`FAIL harness error: ${String(e?.message ?? e).replaceAll(process.env.AVBANG_TEST_KEY ?? "\u0000", "[key]")}`);
  t.check("script ran to completion", false);
} finally {
  stash?.container.stop();
  await mock?.close();
  if (stash) rmSync(stash.cfg, { recursive: true, force: true });
}
t.done();
