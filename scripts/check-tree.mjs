#!/usr/bin/env node
// Packaging gate for the public adapter repo. Everything in this tree becomes world-readable, so this checks it.
//
//   node scripts/check-tree.mjs [--root dir] [--contact address] [--denylist host,host] [--require-denylist]
//
// Rules (one output line per failure, exit 1 on any): required-file, contact, key-shaped, email, private-ip,
// hostname, import-boundary, workflow-path.
//
// The private hostname list is NOT in this tree. It comes from --denylist, else CHECK_TREE_DENYLIST (environment or the
// gitignored .infra file, read by lib/env.mjs). With none supplied the hostname rule prints SKIPPED and the run still
// passes; --require-denylist turns that into a failure. This file scans itself like any other: it holds no hostname and
// builds its patterns from fragments, so it needs no exemption. Matched values are never printed, only file:line.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED = [
  "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "MAINTAINERS.md", "SPLIT.md",
  "package.json", ".github/CODEOWNERS", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/workflows/live.yml",
];

const KEY_RE = new RegExp("av" + "_live_" + "([A-Za-z0-9_-]{16,})", "g");
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const CODE_FILE = /\.(?:mjs|cjs|js|ts|mts)$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const isPrivateIp = (a, b, c, d) => [a, b, c, d].every((n) => n <= 255) &&
  (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));

function declaredContact(root, fail) {
  const f = join(root, "SECURITY.md");
  if (!existsSync(f)) return undefined; // reported by required-file
  const lines = readFileSync(f, "utf8").split(/\r?\n/).filter((l) => /^Security contact:/.test(l));
  if (lines.length !== 1) {
    fail("contact", "SECURITY.md", 0, `needs exactly one "Security contact:" line, found ${lines.length}`);
    return undefined;
  }
  const m = lines[0].match(EMAIL_RE);
  if (!m || m.length !== 1) fail("contact", "SECURITY.md", 0, "the Security contact line must hold exactly one email address");
  return m?.[0];
}

function workflowPaths(root, rel, text, fail) {
  const check = (p, line) => {
    if (!existsSync(resolve(root, p))) fail("workflow-path", rel, line, `path does not exist under the root: ${p}`);
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "");
    const kv = line.match(/^\s*-?\s*(?:context|file):\s*["']?([^\s"']+)/);
    if (kv && !kv[1].includes("${{")) check(kv[1], i + 1);
    for (const m of line.matchAll(/\bnode\s+([^|&;]*)/g)) {
      for (const tok of m[1].trim().split(/\s+/)) {
        if (!tok || tok.startsWith("-") || tok.includes("$")) continue;
        if (tok.includes("/") || /\.(?:mjs|js|ts)$/.test(tok)) check(tok, i + 1);
      }
    }
    for (const m of line.matchAll(/\bdocker\s+build\b([^|&;]*)/g)) {
      const toks = m[1].trim().split(/\s+/);
      const f = toks.indexOf("-f");
      if (f >= 0 && toks[f + 1]) check(toks[f + 1], i + 1);
      const ctx = toks.at(-1);
      if (ctx && !ctx.startsWith("-") && !ctx.includes("$") && toks.length > 1) check(ctx, i + 1);
    }
  });
}

export function checkTree({ root, contact, denylist = [], requireDenylist = false }) {
  const failures = [];
  const skipped = [];
  const fail = (rule, file, line, msg) => failures.push({ rule, file, line, msg });

  for (const r of REQUIRED) if (!existsSync(join(root, r))) fail("required-file", r, 0, "missing");
  const declared = declaredContact(root, fail);
  const allowed = (contact ?? declared ?? "").toLowerCase();
  const deny = denylist.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!deny.length) {
    if (requireDenylist) fail("hostname", "-", 0, "no denylist supplied and --require-denylist is set");
    else skipped.push("hostname: SKIPPED (no denylist supplied; set CHECK_TREE_DENYLIST or --denylist)");
  }

  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join("/");
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      for (const m of l.matchAll(KEY_RE)) if (!/^x+$/i.test(m[1])) fail("key-shaped", rel, i + 1, "key-shaped string");
      for (const m of l.matchAll(EMAIL_RE)) if (m[0].toLowerCase() !== allowed) fail("email", rel, i + 1, "email other than the declared contact");
      for (const m of l.matchAll(IPV4_RE)) if (isPrivateIp(...m.slice(1, 5).map(Number))) fail("private-ip", rel, i + 1, "private-network IPv4 literal");
      const low = l.toLowerCase();
      for (const h of deny) if (low.includes(h)) fail("hostname", rel, i + 1, "denylisted hostname");
    });
    if (CODE_FILE.test(rel)) {
      lines.forEach((l, i) => {
        for (const m of l.matchAll(IMPORT_RE)) {
          const spec = m[1];
          if (spec.startsWith("node:")) continue;
          if (spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#") || isAbsolute(spec)) {
            fail("import-boundary", rel, i + 1, "app alias or absolute import");
          } else if (spec.startsWith(".")) {
            const target = relative(root, resolve(dirname(abs), spec));
            if (target.startsWith("..") || isAbsolute(target)) fail("import-boundary", rel, i + 1, "import reaches above the root");
          }
        }
      });
    }
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(rel)) workflowPaths(root, rel, text, fail);
  }
  return { failures, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error("check-tree: root is not a directory");
    process.exit(2);
  }
  let list = opt("--denylist");
  if (list === undefined) {
    const { loadSecret } = await import("../lib/env.mjs");
    list = loadSecret("CHECK_TREE_DENYLIST");
  }
  const { failures, skipped } = checkTree({
    root,
    contact: opt("--contact"),
    denylist: (list ?? "").split(","),
    requireDenylist: argv.includes("--require-denylist"),
  });
  for (const s of skipped) console.log(s);
  for (const f of failures) console.log(`FAIL ${f.rule}: ${f.file}${f.line ? ":" + f.line : ""} ${f.msg}`);
  console.log(failures.length ? `check-tree: ${failures.length} failure(s)` : "check-tree: PASS");
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
