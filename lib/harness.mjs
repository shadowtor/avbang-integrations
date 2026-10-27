// Shared helpers for the phase 28.1 live scripts. Zero dependencies.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";

const containers = new Set();

function removeAll() {
  for (const name of containers) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  containers.clear();
}
process.on("exit", removeAll);
process.on("SIGINT", () => { removeAll(); process.exit(130); });
process.on("SIGTERM", () => { removeAll(); process.exit(143); });

/** Containers reach the host through this name. */
export const HOST_FROM_CONTAINER = "host.docker.internal";

/** Extra `docker run` args so host.docker.internal resolves (needed on Linux, harmless elsewhere). */
export const dockerHostArgs = () =>
  process.platform === "linux" ? ["--add-host", `${HOST_FROM_CONTAINER}:host-gateway`] : [];

/** Run a command, output capped (default 64 KiB). Never throws; returns { code, out }. */
export function run(cmd, args, { cap = 64 * 1024, input, timeoutMs = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: cap * 4, timeout: timeoutMs, input });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-cap);
  return { code: r.status ?? 1, out };
}

/** Start a detached container with a unique name; it is force-removed on exit, SIGINT and SIGTERM. */
export function startContainer(prefix, image, args = []) {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  containers.add(name);
  const r = run("docker", ["run", "-d", "--name", name, ...args, image]);
  if (r.code !== 0) {
    containers.delete(name);
    throw new Error(`docker run failed: ${r.out.slice(0, 500)}`);
  }
  return {
    name,
    logs: () => run("docker", ["logs", "--tail", "200", name]).out,
    restart: () => run("docker", ["restart", name]),
    stop() {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      containers.delete(name);
    },
  };
}

/** Resolve a free loopback TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Poll until `ok(res)` (default: res.ok) or the deadline passes. Returns the last Response. */
export async function waitForHttp(url, { deadlineMs = 120_000, intervalMs = 1000, ok = (r) => r.ok, init } = {}) {
  const end = Date.now() + deadlineMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
      if (await ok(last)) return last;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${url}${last ? ` (last status ${last.status})` : ""}`);
}

/** A throwaway key-shaped string. Not a credential for anything. */
export const throwawayKey = () => `av_live_${randomBytes(18).toString("hex")}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn until it returns a truthy value or the deadline passes. */
export async function poll(fn, { deadlineMs = 120_000, intervalMs = 2000 } = {}) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

/** Run a child node process, return { child, output() } with output captured and capped. */
export function spawnNode(args, env) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const add = (d) => { buf = (buf + d).slice(-64 * 1024); };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  process.on("exit", () => child.kill());
  return { child, output: () => buf };
}

/** Tiny assert reporter: PASS/FAIL lines, exit non-zero on any failure. */
export function reporter() {
  let failed = 0;
  return {
    check(name, cond, detail = "") {
      console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || !detail ? "" : ` (${detail})`}`);
      if (!cond) failed++;
    },
    done() {
      console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
      process.exitCode = failed ? 1 : 0;
      return failed === 0;
    },
  };
}
