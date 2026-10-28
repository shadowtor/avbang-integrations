// Live Jellyfin check (phase 28.1, D-08): the NFO generator writes files, a real Jellyfin server in Docker reads them.
//   node jellyfin/live.mjs --mock [--version 12.4|10.11|all]
//   node jellyfin/live.mjs --real            (12.4 only; AVBANG_TEST_KEY, AVBANG_API_BASE default api-test)
// Mock mode uses the plan 01 mock API and a throwaway key; it never contacts the real API.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../lib/mock-api.mjs";
import { freePort, poll, reporter, startContainer, throwawayKey, waitForHttp } from "../lib/harness.mjs";

// Pinned tags. 10.11.11 was the newest 10.11 tag and 12.4 the newest 12.x tag when checked on 2026-10-27.
const VERSIONS = { "12.4": "jellyfin/jellyfin:12.4", "10.11": "jellyfin/jellyfin:10.11.11" };
const CLI = fileURLToPath(new URL("./nfo/cli.mjs", import.meta.url));
const args = process.argv.slice(2);
const real = args.includes("--real");
const vi = args.indexOf("--version");
const want = vi >= 0 ? args[vi + 1] : "all";
if ((!real && !args.includes("--mock")) || (want !== "all" && !VERSIONS[want])) {
  console.error("usage: node jellyfin/live.mjs --mock [--version 12.4|10.11|all] | --real");
  process.exit(2);
}
const versions = real ? ["12.4"] : want === "all" ? Object.keys(VERSIONS) : [want];

const t = reporter();
const H = { "content-type": "application/json" };
const tmpDirs = [];
const mk = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
const touch = (p) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
};

/** Async on purpose: the mock API lives in this process and must keep serving while the CLI runs. */
function runCli(media, extra, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--root", media, ...extra], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** Start Jellyfin on `media` (read-only), bootstrap it headlessly, return an authed fetch helper. */
async function jellyfin(image, media) {
  const port = await freePort();
  const c = startContainer("avbang-jf", image, [
    "-p", `127.0.0.1:${port}:8096`,
    "--tmpfs", "/config", "--tmpfs", "/cache", // no anonymous volumes to leak
    "--mount", `type=bind,source=${media},target=/media/movies,readonly`,
  ]);
  const U = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(U + path, { method: "POST", headers: { ...H, ...headers }, body: body ? JSON.stringify(body) : undefined });
  await waitForHttp(`${U}/System/Info/Public`, { deadlineMs: 180_000 });
  // /System/Info/Public answers before the startup wizard endpoints do: retry the first one
  const okStep = async (path, body, headers) => {
    const res = await poll(async () => {
      const r = await post(path, body, headers);
      return r.status < 300 ? r : null;
    }, { deadlineMs: 120_000, intervalMs: 2000 });
    if (!res) throw new Error(`bootstrap step ${path} never succeeded`);
    return res;
  };
  await okStep("/Startup/Configuration", { UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" });
  await fetch(`${U}/Startup/User`); // initialises the first user record before it can be set
  await okStep("/Startup/User", { Name: "admin", Password: "harness-pass-1" });
  await okStep("/Startup/RemoteAccess", { EnableRemoteAccess: true, EnableAutomaticPortMapping: false });
  await okStep("/Startup/Complete");
  const auth = await okStep("/Users/AuthenticateByName", { Username: "admin", Pw: "harness-pass-1" }, {
    authorization: 'MediaBrowser Client="ci", Device="ci", DeviceId="ci1", Version="1"',
  });
  const tok = (await auth.json()).AccessToken;
  const A = { authorization: `MediaBrowser Token="${tok}"` };
  const lib = await fetch(`${U}/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true`, {
    method: "POST", headers: { ...H, ...A },
    body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: "/media/movies" }], EnableRealtimeMonitor: false, MetadataSavers: [], TypeOptions: [{ Type: "Movie", MetadataFetchers: [], ImageFetchers: [] }] } }),
  });
  if (lib.status !== 204) throw new Error(`library create failed: HTTP ${lib.status}`);
  let lastItems = "";
  const get = (path) => fetch(U + path, { headers: A });
  const items = async (n) => {
    await fetch(`${U}/Library/Refresh`, { method: "POST", headers: A }); // the creation scan can finish before the files are visible
    return poll(async () => {
    const res = await get("/Items?Recursive=true&IncludeItemTypes=Movie&Fields=OriginalTitle,Overview,PremiereDate,Genres,Studios,People,ProviderIds,ProductionYear,Path");
    const j = await res.json();
    lastItems = `HTTP ${res.status} ${(j.Items ?? []).map((i) => i.Name).join("|")}`;
    return j.Items?.length >= n ? j.Items : null;
    }, { deadlineMs: 180_000, intervalMs: 3000 });
  };
  return { c, get, items, last: () => lastItems, post: (p) => fetch(U + p, { method: "POST", headers: A }) };
}

const poster = (dir) => readdirSync(dir).find((f) => /-poster\.|^poster\.|^folder\./.test(f));

async function mockRun(ver, image) {
  const label = `[${ver}]`;
  const key = throwawayKey();
  const mock = await startMock({ apiKey: key, imageBase: "127.0.0.1", bind: "127.0.0.1" });
  const media = mk("avbang-jf-media-");
  const A = "STAR-489 Office overtime", B = "STAR-490 Night shift", X = "unknown clip";
  for (const n of [A, B, X]) touch(join(media, n, `${n}.mkv`));
  const env = { AVBANG_API_KEY: key, AVBANG_API_BASE: `${mock.apiOrigin}/v1`, AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: mock.imageOrigin };
  let c;
  try {
    const r = await runCli(media, ["--poster"], env);
    t.check(`${label} CLI exit 0`, r.code === 0, r.out);
    t.check(`${label} NFO beside matched videos`, existsSync(join(media, A, `${A}.nfo`)) && existsSync(join(media, B, `${B}.nfo`)));
    t.check(`${label} unmatched video has no NFO`, !existsSync(join(media, X, `${X}.nfo`)));
    t.check(`${label} clear poster written, blurred one not`, !!poster(join(media, A)) && !poster(join(media, B)));
    t.check(`${label} second run writes nothing`, (await runCli(media, ["--poster"], env)).out.includes("written 0"));
    const nfo = readFileSync(join(media, A, `${A}.nfo`), "utf8");
    t.check(`${label} NFO has no key or url`, !nfo.includes(key) && !/https?:|grant/.test(nfo));
    const noPoster = mk("avbang-jf-nop-");
    touch(join(noPoster, A, `${A}.mkv`));
    await runCli(noPoster, ["--no-poster"], env);
    t.check(`${label} --no-poster writes no image`, !poster(join(noPoster, A)) && existsSync(join(noPoster, A, `${A}.nfo`)));

    const jf = await jellyfin(image, media);
    c = jf.c;
    const items = await jf.items(3);
    t.check(`${label} Jellyfin lists 3 movies`, !!items, jf.last());
    if (!items) return;
    const it = items.find((i) => i.Name === "Office overtime");
    t.check(`${label} Name from NFO (A13: <filename>.nfo is read)`, !!it, `names: ${items.map((i) => i.Name).join(" | ")}`);
    if (it) {
      t.check(`${label} Overview`, it.Overview === "Synopsis for Office overtime.", it.Overview);
      t.check(`${label} PremiereDate and year`, String(it.PremiereDate).startsWith("2026-04-12") && it.ProductionYear === 2026);
      t.check(`${label} Genres, Studios, People`, it.Genres?.includes("Office") && it.Studios?.some((s) => s.Name === "Aurora")
        && it.People?.some((p) => p.Name === "Aya Mizuno" && p.Type === "Actor"));
      t.check(`${label} ProviderIds.avbang`, it.ProviderIds?.avbang === "STAR-489", JSON.stringify(it.ProviderIds));
      const img = await jf.get(`/Items/${it.Id}/Images/Primary`);
      const ct = img.headers.get("content-type") ?? "";
      t.check(`${label} Primary image served (${poster(join(media, A))})`, img.status === 200 && ct.startsWith("image/"), `HTTP ${img.status} ${ct}`);
    }
    const un = items.find((i) => i.Name === X);
    t.check(`${label} unmatched keeps filename name`, !!un);
    const night = items.find((i) => i.Name === "Night shift");
    if (night) {
      const img = await jf.get(`/Items/${night.Id}/Images/Primary`);
      t.check(`${label} blurred title has NFO data but no Primary image`, img.status === 404);
    } else t.check(`${label} blurred title read from NFO`, false);
  } finally {
    c?.stop();
    await mock.close();
  }
}

async function realRun(image) {
  const key = process.env.AVBANG_TEST_KEY;
  const base = process.env.AVBANG_API_BASE || "https://api-test.avbang.net/v1";
  if (!key) throw new Error("AVBANG_TEST_KEY is not set");
  const list = await (await fetch(`${new URL(base).origin}/v1/titles?limit=1`, { headers: { authorization: `Bearer ${key}` } })).json();
  const code = list.data?.[0]?.code;
  t.check("[real] discovered a title code", /^[A-Za-z0-9-]+$/.test(code ?? ""));
  if (!code) return;
  const media = mk("avbang-jf-real-");
  touch(join(media, `${code} real`, `${code} real.mkv`));
  const r = await runCli(media, ["--poster"], { AVBANG_API_KEY: key, AVBANG_API_BASE: base });
  t.check("[real] CLI exit 0 and NFO written", r.code === 0 && r.out.includes("written 1"), r.out);
  const dir = join(media, `${code} real`);
  const nfo = existsSync(join(dir, `${code} real.nfo`)) ? readFileSync(join(dir, `${code} real.nfo`), "utf8") : "";
  t.check("[real] NFO shape", /<title>.+<\/title>/.test(nfo) && nfo.includes(`type="avbang" default="true">${code}<`) && !nfo.includes(key));
  t.check("[real] poster written or skipped with a reason", !!poster(dir) || /poster skipped \(.+\)/.test(r.out), r.out);
  const jf = await jellyfin(image, media);
  try {
    const items = await jf.items(1);
    t.check("[real] Jellyfin read ProviderIds.avbang", items?.[0]?.ProviderIds?.avbang === code, JSON.stringify(items?.[0]?.ProviderIds));
  } finally {
    jf.c.stop();
  }
}

try {
  for (const v of versions) {
    console.log(`--- Jellyfin ${v} (${VERSIONS[v]})`);
    if (real) await realRun(VERSIONS[v]);
    else await mockRun(v, VERSIONS[v]);
  }
} catch (e) {
  t.check("harness ran to completion", false, `${e.message} ${e.cause?.message ?? ""}`.slice(0, 300));
} finally {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  t.done();
}
