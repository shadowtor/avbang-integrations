// loadSecret(name): the process environment first, then a dotenv-style file (AVBANG_ENV_FILE, else the first
// .infra found walking up from this directory; absent in the split repo, where this returns undefined).
// It never prints or logs a value and never throws.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findFile(env) {
  if (env.AVBANG_ENV_FILE) return env.AVBANG_ENV_FILE;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const p = join(dir, ".infra");
    try {
      readFileSync(p);
      return p;
    } catch { /* keep walking */ }
    const up = resolve(dir, "..");
    if (up === dir) return undefined;
    dir = up;
  }
}

export function loadSecret(name, env = process.env) {
  if (env[name]) return env[name];
  let text;
  try {
    const file = findFile(env);
    if (!file) return undefined;
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}
