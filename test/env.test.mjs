import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecret } from "../lib/env.mjs";

const SECRET = "av_live" + "_sampleSecretValue123";
function withFile(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), "avbang-env-"));
  const f = join(dir, "env");
  writeFileSync(f, text);
  try {
    return fn(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("environment wins over the file", () => {
  withFile("K=fromfile\n", (f) => assert.equal(loadSecret("K", { K: "fromenv", AVBANG_ENV_FILE: f }), "fromenv"));
});

test("file: plain, quoted, export, CRLF; comments and other names ignored", () => {
  const text = `# K=comment\r\nOTHER=x\r\nKK=wrong\r\nexport K = "${SECRET}"\r\n`;
  withFile(text, (f) => assert.equal(loadSecret("K", { AVBANG_ENV_FILE: f }), SECRET));
  withFile(`K='${SECRET}'\n`, (f) => assert.equal(loadSecret("K", { AVBANG_ENV_FILE: f }), SECRET));
  withFile("# K=x\nOTHER=1\n", (f) => assert.equal(loadSecret("K", { AVBANG_ENV_FILE: f }), undefined));
  withFile("K=\n", (f) => assert.equal(loadSecret("K", { AVBANG_ENV_FILE: f }), undefined));
});

test("missing or unreadable file returns undefined and does not throw", () => {
  assert.equal(loadSecret("K", { AVBANG_ENV_FILE: join(tmpdir(), "avbang-no-such-file") }), undefined);
  assert.equal(loadSecret("K", { AVBANG_ENV_FILE: tmpdir() }), undefined);
});

test("never prints a value", () => {
  const out = [];
  const ow = process.stdout.write, ew = process.stderr.write;
  process.stdout.write = (c) => (out.push(String(c)), true);
  process.stderr.write = (c) => (out.push(String(c)), true);
  try {
    withFile(`K=${SECRET}\n`, (f) => loadSecret("K", { AVBANG_ENV_FILE: f }));
    loadSecret("K", { AVBANG_ENV_FILE: tmpdir() });
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
  assert.ok(!out.join("").includes(SECRET));
});
