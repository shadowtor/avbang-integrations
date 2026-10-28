#!/usr/bin/env node
// Proves the split layout. Copies integrations/ (without node_modules) into a fresh temp directory that acts as the
// split repo root, then from there runs: check-tree, node --test, docker build -f plex/Dockerfile . plus a start of the
// image, and (unless --skip-harnesses) every node command under run: in the copied live.yml, exactly as CI would.
//
//   node scripts/simulate-split.mjs [--skip-harnesses]
//
// Needs Docker. The container, image and temp directory are removed on exit. Prints one PASS/FAIL line per step.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecret } from "../lib/env.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipHarnesses = process.argv.includes("--skip-harnesses");
const root = mkdtempSync(join(tmpdir(), "avbang-split-"));
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const image = `avbang-split-sim:${stamp}`;
const container = `avbang-split-sim-${stamp}`;
// The copy must not see the monorepo's secrets file.
const env = { ...process.env };
delete env.AVBANG_ENV_FILE;
let failed = 0;

function step(name, fn) {
  const t = Date.now();
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  console.log(`${err ? "FAIL" : "PASS"} ${name} (${secs}s)`);
  if (err) {
    failed++;
    console.log(String(err.message).split("\n").slice(-25).join("\n"));
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// Commands under run: in a workflow file: single-line "run: cmd" and "run: |" blocks. Only node commands are returned.
function runCommands(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== "|") out.push(m[2].trim());
    else {
      const indent = m[1].length;
      for (i++; i < lines.length && (!lines[i].trim() || lines[i].search(/\S/) > indent); i++) out.push(lines[i].trim());
      i--;
    }
  }
  return out.filter((c) => /^node\s/.test(c));
}

try {
  cpSync(SRC, root, { recursive: true, filter: (p) => basename(p) !== "node_modules" });
  console.log(`split root: ${root}`);
  const list = loadSecret("CHECK_TREE_DENYLIST");

  step("check-tree" + (list ? " (denylist enforced)" : " (denylist SKIPPED)"), () => {
    const out = sh(process.execPath, ["scripts/check-tree.mjs", ...(list ? ["--denylist", list, "--require-denylist"] : [])]);
    if (!/check-tree: PASS/.test(out)) throw new Error(out);
  });
  step("node --test test/", () => sh(process.execPath, ["--test", "test/"]));

  step("docker build -f plex/Dockerfile .", () => sh("docker", ["build", "-q", "-f", "plex/Dockerfile", "-t", image, "."]));
  step("start image, GET / answers the provider definition", () => {
    const key = ["av", "live", "x".repeat(24)].join("_"); // placeholder, never a real key
    sh("docker", ["run", "-d", "--name", container, "-e", `AVBANG_API_KEY=${key}`, "-p", "127.0.0.1::8787", image]);
    const port = sh("docker", ["port", container, "8787/tcp"]).trim().split(":").pop();
    let last = "no answer";
    for (let i = 0; i < 30; i++) {
      const r = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/").then(async r=>{console.log(r.status+" "+await r.text())},e=>{console.log("ERR "+e.message)})`], { encoding: "utf8" });
      last = r.stdout.trim();
      if (last.startsWith("200 ")) break;
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
    }
    if (!last.startsWith("200 ") || !last.includes('"MediaProvider"')) throw new Error(last.slice(0, 300));
  });

  if (skipHarnesses) console.log("SKIP live.yml commands (--skip-harnesses)");
  else {
    for (const cmd of runCommands(readFileSync(join(root, ".github/workflows/live.yml"), "utf8"))) {
      step(cmd, () => sh(process.execPath, cmd.split(/\s+/).slice(1)));
    }
  }
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  spawnSync("docker", ["rmi", "-f", image], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `simulate-split: ${failed} step(s) FAILED` : "simulate-split: PASS");
process.exit(failed ? 1 : 0);
