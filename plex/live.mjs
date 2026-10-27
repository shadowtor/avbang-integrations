// Live Plex check (phase 28.1, D-08): boots a real, unclaimed Plex Media Server in Docker, the mock AVBang API
// and the container-mode provider, then asserts what PMS stored for 'STAR-489 Office overtime.mkv'.
//   node integrations/plex/live.mjs --mock
// Real-API modes are added by plan 07.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "../lib/mock-api.mjs";
import {
  HOST_FROM_CONTAINER, dockerHostArgs, freePort, poll, reporter, spawnNode, startContainer, throwawayKey, waitForHttp,
} from "../lib/harness.mjs";

const PMS_IMAGE = "plexinc/pms-docker:1.43.5.11079-b3b13e506";
const ID = "tv.plex.agents.custom.avbang.movie";

if (!process.argv.includes("--mock")) {
  console.error("usage: node integrations/plex/live.mjs --mock");
  process.exit(2);
}

const t = reporter();
const key = throwawayKey();
const dir = mkdtempSync(join(tmpdir(), "avbang-plex-"));
// non-empty: PMS skips 0-byte files
writeFileSync(join(dir, "STAR-489 Office overtime.mkv"), Buffer.alloc(4096, 0x1a));
const dir2 = mkdtempSync(join(tmpdir(), "avbang-plex2-"));
writeFileSync(join(dir2, "STAR-490 Night shift.mkv"), Buffer.alloc(4096, 0x1a));
let pms;
let mock;
let server;
try {
  mock = await startMock({ apiKey: key, imageBase: HOST_FROM_CONTAINER });
  const providerPort = await freePort();
  server = spawnNode(["integrations/plex/server.ts"], {
    AVBANG_API_KEY: key,
    AVBANG_API_BASE: `${mock.apiOrigin}/v1`,
    AVBANG_ALLOW_INSECURE: "1",
    AVBANG_TEST_IMAGE_ORIGINS: mock.imageOrigin,
    PORT: String(providerPort),
    BIND: "0.0.0.0",
    NODE_ENV: "development",
  });
  const providerLocal = `http://127.0.0.1:${providerPort}`;
  await waitForHttp(providerLocal + "/");

  const pmsPort = await freePort();
  pms = startContainer("avbang-pms", PMS_IMAGE, [
    "-p", `127.0.0.1:${pmsPort}:32400`,
    "-e", "TZ=UTC",
    "-e", "ALLOWED_NETWORKS=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8",
    "--mount", `type=bind,source=${dir},target=/data/movies`,
    "--mount", `type=bind,source=${dir2},target=/data/movies2`,
    ...dockerHostArgs(),
  ]);
  const P = `http://127.0.0.1:${pmsPort}`;
  const J = { accept: "application/json" };
  const call = async (method, path) => {
    const r = await fetch(P + path, { method, headers: J, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body, text };
  };

  const started = () =>
    waitForHttp(P + "/identity", {
      deadlineMs: 240_000,
      init: { headers: J },
      // PMS 1.43.5 reports startState only while starting (e.g. startingPlugins) and omits it once started
      ok: async (r) => {
        const c = r.ok ? (await r.clone().json()).MediaContainer : null;
        return c?.version !== undefined && c.startState === undefined;
      },
    });
  const idRes = await started();
  const version = (await idRes.json()).MediaContainer.version;
  console.log(`PMS version ${version}`);
  t.check("PMS version is 1.43.5.x", String(version).startsWith("1.43.5"), String(version));

  // register (no trailing slash), group, library
  const uri = `http://${HOST_FROM_CONTAINER}:${providerPort}`;
  await poll(async () => (await call("GET", "/library/sections")).status === 200, { deadlineMs: 120_000, intervalMs: 2000 });
  const reg = await call("POST", `/media/providers/metadata?uri=${encodeURIComponent(uri)}`);
  t.check("provider registered", reg.status === 200, `${reg.status} ${reg.text.slice(0, 200)}`);
  const grp = await call("POST", `/media/providers/metadata/group?title=AVBang&primaryIdentifier=${ID}`);
  t.check("agent group created", grp.status === 200 || grp.status === 201, `${grp.status} ${grp.text.slice(0, 200)}`);
  const groupId = grp.text.match(/"?(?:id|Id|groupId)"?\s*[:=]\s*"?(\d+)/)?.[1] ?? grp.text.match(/(\d+)/)?.[1];
  const lib = await call(
    "POST",
    `/library/sections?name=Movies&type=1&agent=${ID}&scanner=Plex%20Movie&language=en-US&metadataAgentProviderGroupId=${groupId}&location=${encodeURIComponent("/data/movies")}`,
  );
  t.check("library created", lib.status === 200 || lib.status === 201, `${lib.status} ${lib.text.slice(0, 300)}`);
  const sections = await call("GET", "/library/sections");
  const sectionId = sections.body?.MediaContainer?.Directory?.[0]?.key;
  await call("GET", `/library/sections/${sectionId}/refresh?force=1`);

  const item = await poll(
    async () => {
      const all = await call("GET", `/library/sections/${sectionId}/all`);
      const m = all.body?.MediaContainer?.Metadata?.[0];
      if (!m) return null;
      const d = await call("GET", `/library/metadata/${m.ratingKey}`);
      const md = d.body?.MediaContainer?.Metadata?.[0];
      return md?.guid?.startsWith(ID) ? md : null;
    },
    { deadlineMs: 180_000, intervalMs: 3000 },
  );
  if (!item) {
    console.log("provider output:\n" + server.output().slice(-1500));
    console.log("library items: " + JSON.stringify((await call("GET", `/library/sections/${sectionId}/all`)).body).slice(0, 800));
    console.log("sections: " + JSON.stringify(sections.body).slice(0, 500));
  }
  t.check("PMS created the item with the provider guid", !!item);
  if (item) {
    t.check("guid", item.guid === `${ID}://movie/STAR-489`, item.guid);
    t.check("title", item.title === "Office overtime", item.title);
    t.check("year", item.year === 2026, String(item.year));
    t.check("studio", item.studio === "Aurora", item.studio);
    t.check("originallyAvailableAt", item.originallyAvailableAt === "2026-04-12", item.originallyAvailableAt);
    t.check("duration", item.duration === 8520000, String(item.duration));
    t.check("Genre contains Office", item.Genre?.some((g) => g.tag === "Office"));
    t.check("Role contains Aya Mizuno", item.Role?.some((g) => g.tag === "Aya Mizuno"));
    t.check("PMS recorded a thumb", typeof item.thumb === "string", String(item.thumb));
    if (item.thumb) {
      const r = await fetch(P + item.thumb, { signal: AbortSignal.timeout(30_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") ?? "";
      t.check("poster is retrievable from PMS", r.status === 200, String(r.status));
      t.check("poster content type is image/*", ct.startsWith("image/"), ct);
      t.check("poster is WebP (RIFF....WEBP)", buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP", `${ct} ${buf.subarray(0, 12).toString("latin1")}`);
    }
  }

  // trailing-slash registration: PMS then asks for //library/metadata/..., which the provider must collapse.
  // PMS keeps the old URI until restarted (research pitfall 2), so update, restart, add a second library.
  const providerId = reg.body?.MediaContainer?.MetadataAgentProvider?.[0]?.id;
  const upd = await call("PUT", `/media/providers/metadata/${providerId}?uri=${encodeURIComponent(uri + "/")}`);
  t.check("provider URI updated to a trailing slash", upd.status === 200, `${upd.status} ${upd.text.slice(0, 200)}`);
  pms.restart();
  await started();
  await poll(async () => (await call("GET", "/library/sections")).status === 200, { deadlineMs: 120_000, intervalMs: 2000 });
  const lib2 = await call(
    "POST",
    `/library/sections?name=Movies2&type=1&agent=${ID}&scanner=Plex%20Movie&language=en-US&metadataAgentProviderGroupId=${groupId}&location=${encodeURIComponent("/data/movies2")}`,
  );
  t.check("second library created", lib2.status === 200 || lib2.status === 201, `${lib2.status} ${lib2.text.slice(0, 200)}`);
  const sectionId2 = (await call("GET", "/library/sections")).body?.MediaContainer?.Directory?.find((d) => d.title === "Movies2")?.key;
  const item2 = await poll(
    async () => {
      const m = (await call("GET", `/library/sections/${sectionId2}/all`)).body?.MediaContainer?.Metadata?.[0];
      const md = m && (await call("GET", `/library/metadata/${m.ratingKey}`)).body?.MediaContainer?.Metadata?.[0];
      return md?.guid?.startsWith(ID) ? md : null;
    },
    { deadlineMs: 180_000, intervalMs: 3000 },
  );
  t.check("trailing-slash registration still matches (STAR-490)", item2?.guid === `${ID}://movie/STAR-490`, String(item2?.guid));
  t.check("PMS really sent a double slash", server.output().includes("POST //library/metadata/matches 200"));

  // direct provider checks
  const body = JSON.stringify({ type: 1, title: "STAR 489 Office Overtime", filename: "STAR-489 Office overtime.mkv" });
  const post = (path) => fetch(providerLocal + path, { method: "POST", headers: { "content-type": "application/json" }, body });
  const one = await (await post("/library/metadata/matches")).json();
  const two = await post("//library/metadata/matches");
  t.check("double-slash matches request works", two.status === 200);
  t.check("double-slash gives the same candidate", JSON.stringify(await two.json()) === JSON.stringify(one));
  t.check("candidate is STAR-489", one.MediaContainer?.Metadata?.[0]?.ratingKey === "STAR-489");
  const extras = await fetch(providerLocal + "/library/metadata/STAR-489/extras");
  t.check("extras returns 200 with size 0", extras.status === 200 && (await extras.json()).MediaContainer?.size === 0);

  // security observations
  t.check("every mock API request carried Authorization", mock.log.length > 0 && mock.log.every((e) => e.hasAuth));
  t.check("no recorded API URL contains the key", !mock.log.some((e) => e.url.includes(key)));
  t.check("provider output never contains the key", !server.output().includes(key));
  t.check("PMS log never contains the key", !pms.logs().includes(key));
  t.check("foreign image origin never contacted", mock.foreignLog.length === 0);
  t.check("PMS fetched the image from the mock image origin", mock.imageLog.length > 0);

  // 429 -> 503 + Retry-After
  mock.expect429(1);
  const limited = await post("/library/metadata/matches");
  t.check("API 429 becomes 503", limited.status === 503, String(limited.status));
  t.check("Retry-After is copied", limited.headers.get("retry-after") === "7", String(limited.headers.get("retry-after")));
} catch (e) {
  console.log(`FAIL harness error: ${e?.message ?? e}`);
  process.exitCode = 1;
  t.check("script ran to completion", false);
} finally {
  pms?.stop();
  server?.child.kill();
  await mock?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}
if (!t.done()) process.exitCode = 1;
