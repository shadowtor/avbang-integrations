// Real-API smoke runner (phase 28.1 plan 07, D-08): every adapter in --real mode against the deployed test API.
//   node smoke.mjs
// The key comes from loadSecret('AVBANG_TEST_KEY') (environment or the gitignored .infra file). It is exported only to
// the child scripts' environment, and all output is passed through a redactor. Exit code 1 if any row fails.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecret } from "./lib/env.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const API = process.env.AVBANG_API_BASE || "https://api-test.avbang.net/v1";
const key = loadSecret("AVBANG_TEST_KEY");
if (!key) {
  console.error("AVBANG_TEST_KEY is not set: add a line AVBANG_TEST_KEY=... to the gitignored .infra file (or the environment).");
  process.exit(2);
}
const redact = (s) => String(s).replaceAll(key, "[KEY]").replace(/av_live_[A-Za-z0-9]{8,}/g, "[KEY]");
const say = (s) => console.log(redact(s));

const rows = [];
const record = (name, ok, ms, note = "") => rows.push({ name, ok, ms, note });

function child(name, script, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let buf = "";
    const p = spawn(process.execPath, [join(root, script), ...args], {
      env: { ...process.env, AVBANG_TEST_KEY: key, AVBANG_API_BASE: API },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (d) => { buf += d; };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("close", (code) => {
      const lines = redact(buf).split(/\r?\n/);
      for (const l of lines) if (l) console.log(`  [${name}] ${l}`);
      record(name, code === 0, Date.now() - t0, code === 0 ? "" : `exit ${code}`);
      resolve();
    });
  });
}

// direct checks (sequential, bounded: 1 unkeyed + 20 keyed calls)
async function direct() {
  const t0 = Date.now();
  const un = await fetch(`${API}/match`, { signal: AbortSignal.timeout(15_000) });
  const ct = un.headers.get("content-type") ?? "";
  record("unkeyed /match is problem+json 401", un.status === 401 && ct.includes("problem+json"), Date.now() - t0, `${un.status} ${ct}`);
  const t1 = Date.now();
  const codes = [];
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/match?filename=${encodeURIComponent(`SMOKE-${100 + i}.mkv`)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    codes.push(r.status);
    await r.arrayBuffer();
  }
  const bad = codes.filter((c) => c === 429 || c === 401 || c >= 500);
  record("20-call keyed /match burst, no 429", bad.length === 0, Date.now() - t1, bad.length ? `statuses ${[...new Set(bad)].join(",")}` : `statuses ${[...new Set(codes)].join(",")}`);
}

await direct();
await child("plex container", "plex/live.mjs", ["--real", "--container"]);
await child("plex hosted", "plex/live.mjs", ["--real", "--hosted"]);
await child("stash scrape", "stash/live-scrape.mjs", ["--real"]);
await child("stash push", "stash/live-push.mjs", ["--real"]);
await child("jellyfin 12.4", "jellyfin/live.mjs", ["--real"]);

say("\nSMOKE RESULT (api: " + API + ")");
for (const r of rows) say(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(40)} ${(r.ms / 1000).toFixed(1)}s ${r.note}`);
const failed = rows.some((r) => !r.ok);
say(failed ? "SMOKE FAILED" : "SMOKE PASSED");
process.exit(failed ? 1 : 0);
