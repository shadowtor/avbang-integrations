import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED, checkTree } from "../scripts/check-tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = resolve(HERE, "..");
const SCRIPT = join(REAL_ROOT, "scripts", "check-tree.mjs");

// Fixtures that look like secrets are assembled at runtime so this file stays clean under its own scan.
const CONTACT = ["owner", "example.org"].join("@");
const OTHER = ["someone", "example.net"].join("@");
const KEY = ["av", "live", "q".repeat(20)].join("_");
const PLACEHOLDER = ["av", "live", "x".repeat(16)].join("_");
const IP = [10, 0, 0, 5].join(".");
const HOST = ["internal", "corp", "test"].join(".");

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ct-"));
  const files = {
    ...Object.fromEntries(REQUIRED.map((r) => [r, "ok\n"])),
    "SECURITY.md": `# Security\n\nSecurity contact: ${CONTACT}\n`,
    ".github/workflows/live.yml": "jobs:\n  t:\n    steps:\n      - run: node --test test/\n",
    "test/a.test.mjs": "export {};\n",
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const rules = (r) => r.failures.map((f) => f.rule);
const run = (opts) => {
  const root = fixture(opts.files);
  try {
    return checkTree({ root, ...opts.args });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("clean fixture passes; denylist absence is SKIPPED, not a failure", () => {
  const r = run({});
  assert.deepEqual(r.failures, []);
  assert.match(r.skipped[0], /SKIPPED/);
});

test("missing required file", () => {
  assert.deepEqual(rules(run({ files: { LICENSE: null } })), ["required-file"]);
});

test("contact line: zero or two fail; --contact overrides the allowed address", () => {
  assert.ok(rules(run({ files: { "SECURITY.md": "# none\n" } })).includes("contact"));
  const two = `Security contact: ${CONTACT}\nSecurity contact: ${CONTACT}\n`;
  assert.ok(rules(run({ files: { "SECURITY.md": two } })).includes("contact"));
  const o = run({ files: { "README.md": `mail ${OTHER}\n` }, args: { contact: OTHER } }); // override: OTHER allowed, CONTACT not
  assert.deepEqual(o.failures.map((f) => f.file), ["SECURITY.md"]);
});

test("key-shaped string fails, placeholder tail passes", () => {
  assert.deepEqual(rules(run({ files: { "README.md": `k=${KEY}\n` } })), ["key-shaped"]);
  assert.deepEqual(rules(run({ files: { "README.md": `k=${PLACEHOLDER}\n` } })), []);
});

test("email other than the contact fails; the contact passes anywhere", () => {
  assert.deepEqual(rules(run({ files: { "README.md": `a ${OTHER}\n` } })), ["email"]);
  assert.deepEqual(rules(run({ files: { "README.md": `a ${CONTACT}\n` } })), []);
});

test("private IPv4 fails, loopback and public pass", () => {
  for (const ip of [IP, [172, 16, 4, 4].join("."), [192, 168, 1, 9].join("."), [169, 254, 1, 1].join(".")]) {
    assert.deepEqual(rules(run({ files: { "README.md": `at ${ip}\n` } })), ["private-ip"], ip);
  }
  assert.deepEqual(rules(run({ files: { "README.md": "at 127.0.0.1 and 8.8.8.8 and 172.32.0.1 and 1.43.5.11079\n" } })), []);
});

test("denylisted hostname fails; --require-denylist fails when none given", () => {
  assert.deepEqual(rules(run({ files: { "README.md": `see ${HOST}\n` }, args: { denylist: [HOST] } })), ["hostname"]);
  assert.deepEqual(rules(run({ args: { denylist: [HOST] } })), []);
  assert.deepEqual(rules(run({ args: { requireDenylist: true } })), ["hostname"]);
});

test("import boundary: above the root, app alias, absolute; node: and in-root pass", () => {
  const bad = (src) => rules(run({ files: { "x/a.mjs": src } }));
  // statements are assembled from fragments so this file holds no import-shaped text of its own
  const imp = (spec) => ["import a fr", "om ", JSON.stringify(spec), ";\n"].join("");
  const req = (spec) => ["const a = req", "uire(", JSON.stringify(spec), ");\n"].join("");
  const dyn = (spec) => ["await imp", "ort(", JSON.stringify(spec), ");\n"].join("");
  assert.deepEqual(bad(imp("../../lib/x.mjs")), ["import-boundary"]);
  assert.deepEqual(bad(imp(String.fromCharCode(64) + "/lib/x")), ["import-boundary"]);
  assert.deepEqual(bad(req("../../x")), ["import-boundary"]);
  assert.deepEqual(bad(imp("node:fs") + imp("../test/a.test.mjs") + dyn("./b.mjs")), []);
});

test("workflow paths must exist (node, docker build -f, context/file keys)", () => {
  const wf = (body) => rules(run({ files: { ".github/workflows/live.yml": body } }));
  assert.deepEqual(wf("run: node nope/live.mjs --mock\n"), ["workflow-path"]);
  assert.deepEqual(wf("run: node --test test/\n"), []);
  assert.deepEqual(wf("run: docker build -f plex/Dockerfile .\n"), ["workflow-path"]);
  assert.deepEqual(wf("with:\n  context: missing\n  file: missing/Dockerfile\n"), ["workflow-path", "workflow-path"]);
});

test("the CLI works from any cwd and the real tree passes with no exemption", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check-tree: PASS/);
});

test("the CLI exits non-zero on a failing fixture and never prints the matched key", () => {
  const root = fixture({ "README.md": `k=${KEY}\n` });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL key-shaped/);
    assert.ok(!r.stdout.includes(KEY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
