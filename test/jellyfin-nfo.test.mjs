import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApiClient } from "../lib/api-client.mjs";
import { POSTER_DEFAULT, runCli } from "../jellyfin/nfo/cli.mjs";
import { buildNfo, extForContentType, isGenerated, posterName, xmlText } from "../jellyfin/nfo/nfo.mjs";

const KEY = "av_live_SECRETKEY123";
const SIGNED = "https://avbang.net/img/STAR-489/640.webp?grant=SIGNEDGRANT&exp=1";
const TITLE = {
  code: "STAR-489", title: "Office overtime", titleOriginal: null, releaseDate: "2026-04-12", runtimeMin: 142,
  synopsis: "Synopsis.", studio: { slug: "aurora", name: "Aurora" },
  performers: [{ slug: "a", name: "Aya Mizuno" }], tags: [{ slug: "office", name: "Office" }],
};
const imgList = (access = "clear") => ({ code: "STAR-489", images: [{ id: 1, kind: "cover_front", access, urls: [{ width: 640, url: SIGNED }] }] });
const webp = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } });

/** Fake API client: scripted by match results; records calls. */
function fake({ matches, access = "clear", imageFails = false } = {}) {
  const calls = { get: [], img: [] };
  return {
    calls,
    client: {
      get: async (path, params) => {
        calls.get.push([path, params]);
        if (path === "/v1/match") return { matches: matches(params.filename) };
        if (path.endsWith("/images")) return imgList(access);
        return TITLE;
      },
      rawFetchImage: async (url, hosts) => {
        calls.img.push([url, hosts]);
        if (imageFails) throw Object.assign(new Error("image fetch failed: network error"), { name: "ApiError", code: "network" });
        return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" };
      },
    },
  };
}
const hit = (code = "STAR-489") => [{ code, confidence: "code", title: {} }];
const byName = (f) => (/STAR-489/.test(f) ? hit() : []);

let root;
let lines;
const run = (argv, f, env = { AVBANG_API_KEY: KEY }) =>
  runCli(["--root", root, ...argv], env, { createClient: () => f.client, out: (l) => lines.push(l) });
const files = () => readdirSync(root, { recursive: true }).map(String).sort();
const mkvideo = (rel) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  return p;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nfo-test-")); lines = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildNfo", () => {
  it("emits every research field and omits null ones", () => {
    const x = buildNfo({ ...TITLE, titleOriginal: "Original" });
    for (const s of ["<title>Office overtime</title>", "<originaltitle>Original</originaltitle>", "<plot>Synopsis.</plot>",
      "<premiered>2026-04-12</premiered>", "<year>2026</year>", "<runtime>142</runtime>", "<studio>Aurora</studio>",
      "<genre>Office</genre>", "<tag>Office</tag>", "<actor><name>Aya Mizuno</name><type>Actor</type></actor>",
      '<uniqueid type="avbang" default="true">STAR-489</uniqueid>']) assert.ok(x.includes(s), s);
    const y = buildNfo({ ...TITLE, synopsis: null, studio: null, runtimeMin: null, titleOriginal: null });
    for (const t of ["<plot", "<studio", "<runtime", "<originaltitle"]) assert.ok(!y.includes(t), t);
  });

  it("escapes hostile strings, strips control characters and caps lengths", () => {
    const x = buildNfo({ ...TITLE, title: 'A & <b>"x"</b>\u0000\u0007', synopsis: "p".repeat(6000),
      performers: [{ name: "]]></actor><evil/>" }, { name: "n".repeat(500) }], tags: [{ name: "<tag>" }] });
    assert.ok(x.includes("<title>A &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>"));
    assert.ok(!x.includes("<evil/>") && !x.includes("<b>") && !/[\u0000-\u0008]/.test(x));
    assert.equal(/<plot>(p+)<\/plot>/.exec(x)[1].length, 5000);
    assert.equal(/<name>(n+)<\/name>/.exec(x)[1].length, 200);
    assert.equal(xmlText("a\ud800b"), "ab");
  });

  it("never carries a URL, grant or key and rejects a bad code or date", () => {
    const x = buildNfo({ ...TITLE, cover: SIGNED, url: "https://avbang.net/t/x", releaseDate: "2026-04-12T00:00" });
    assert.ok(!/https?:|grant|av_live/i.test(x));
    assert.ok(!x.includes("<premiered"));
    assert.throws(() => buildNfo({ ...TITLE, code: "../x" }));
  });

  it("isGenerated, posterName and content types", () => {
    assert.ok(isGenerated(buildNfo(TITLE)));
    assert.ok(!isGenerated("<movie><title>mine</title></movie>"));
    assert.equal(posterName("/m/a b.mkv", "webp"), "/m/a b-poster.webp");
    assert.throws(() => posterName("/m/a.mkv", "../x"));
    assert.equal(extForContentType("image/WEBP; q=1"), "webp");
    assert.equal(extForContentType("text/html"), null);
  });
});

describe("cli", () => {
  it("writes NFO and webp poster beside the video; second run skips", async () => {
    mkvideo("STAR-489 Office overtime/STAR-489 Office overtime.mkv");
    const f = fake({ matches: byName });
    const r = await run(["--poster"], f);
    assert.equal(r.code, 0);
    assert.deepEqual(files(), ["STAR-489 Office overtime",
      join("STAR-489 Office overtime", "STAR-489 Office overtime-poster.webp"),
      join("STAR-489 Office overtime", "STAR-489 Office overtime.mkv"),
      join("STAR-489 Office overtime", "STAR-489 Office overtime.nfo")].sort());
    assert.deepEqual(f.calls.img[0][1], ["avbang.net"]);
    const again = await run(["--poster"], fake({ matches: byName }));
    assert.equal(again.counts.skipped, 1);
    assert.equal(again.counts.written, 0);
  });

  it("no key, bad flags, conflicting poster flags exit 1 with one line", async () => {
    const f = fake({ matches: byName });
    for (const [argv, env] of [[[], {}], [["--poster", "--no-poster"], { AVBANG_API_KEY: KEY }], [["--bogus"], { AVBANG_API_KEY: KEY }]]) {
      lines = [];
      assert.equal((await run(argv, f, env)).code, 1);
      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes(KEY));
    }
    assert.equal((await runCli([], { AVBANG_API_KEY: KEY }, { out: () => {} })).code, 1); // --root missing
  });

  it("POSTER_DEFAULT is true and the default follows the constant; flags override", async () => {
    assert.equal(POSTER_DEFAULT, true);
    mkvideo("STAR-489 a.mkv");
    const f = fake({ matches: byName });
    await run([], f);
    assert.equal(f.calls.img.length, POSTER_DEFAULT ? 1 : 0);
    rmSync(join(root, "STAR-489 a.nfo"));
    rmSync(join(root, "STAR-489 a-poster.webp"), { force: true });
    const g = fake({ matches: byName });
    await run(["--no-poster"], g);
    assert.equal(g.calls.img.length, 0);
    assert.ok(!files().some((n) => n.endsWith(".webp")));
  });

  it("skips unmatched, ambiguous and non-code matches with a reason", async () => {
    mkvideo("nothing.mkv");
    mkvideo("two STAR-489 STAR-490.mkv");
    mkvideo("fuzzy.mkv");
    const f = fake({
      matches: (n) => (n.startsWith("two") ? [...hit(), ...hit("STAR-490")] : n.startsWith("fuzzy") ? [{ code: "STAR-489", confidence: "search" }] : []),
    });
    const r = await run(["--no-poster"], f);
    assert.equal(r.counts.skipped, 3);
    assert.equal(r.counts.written, 0);
    assert.ok(!files().some((n) => n.endsWith(".nfo")));
    assert.ok(lines.some((l) => l.includes("ambiguous")) && lines.some((l) => l.includes("no match")));
  });

  it("--force replaces only NFOs this tool generated", async () => {
    mkvideo("STAR-489 a.mkv");
    mkvideo("STAR-489 b.mkv");
    writeFileSync(join(root, "STAR-489 a.nfo"), "<movie><title>mine</title></movie>");
    writeFileSync(join(root, "STAR-489 b.nfo"), buildNfo({ ...TITLE, title: "Old" }));
    let r = await run(["--no-poster"], fake({ matches: byName }));
    assert.equal(r.counts.written, 0);
    r = await run(["--no-poster", "--force"], fake({ matches: byName }));
    assert.equal(r.counts.written, 1);
    assert.equal(readFileSync(join(root, "STAR-489 a.nfo"), "utf8"), "<movie><title>mine</title></movie>");
    assert.ok(readFileSync(join(root, "STAR-489 b.nfo"), "utf8").includes("Office overtime"));
  });

  it("does not follow symlinks, only reads known video extensions, never writes outside root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nfo-out-"));
    try {
      writeFileSync(join(outside, "STAR-489 out.mkv"), "x");
      let linked = true;
      try { symlinkSync(outside, join(root, "link"), "junction"); } catch { linked = false; }
      try { symlinkSync(join(outside, "STAR-489 out.mkv"), join(root, "STAR-489 l.mkv")); } catch { /* needs privilege on Windows */ }
      writeFileSync(join(root, "STAR-489 a.txt"), "x");
      mkvideo("STAR-489 ok.mkv");
      const f = fake({ matches: byName });
      const r = await run(["--no-poster"], f);
      assert.equal(r.counts.written, 1);
      assert.ok(!readdirSync(outside).some((n) => n.endsWith(".nfo")), `linked=${linked}`);
      assert.ok(!files().includes("STAR-489 a.nfo"));
      assert.ok(!files().includes("STAR-489 l.nfo"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not write through a pre-existing symlinked NFO path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nfo-out-"));
    try {
      mkvideo("STAR-489 s.mkv");
      try { symlinkSync(join(outside, "target.nfo"), join(root, "STAR-489 s.nfo")); } catch { return; }
      const r = await run(["--no-poster", "--force"], fake({ matches: byName }));
      assert.equal(r.counts.written, 0);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blurred posters need --allow-blurred; download failure keeps the NFO", async () => {
    mkvideo("STAR-489 a.mkv");
    let r = await run(["--poster"], fake({ matches: byName, access: "blurred" }));
    assert.equal(r.counts.written, 1);
    assert.equal(r.counts.posters, 0);
    assert.ok(lines.some((l) => l.includes("blurred")));
    rmSync(join(root, "STAR-489 a.nfo"));
    lines = [];
    r = await run(["--poster"], fake({ matches: byName, imageFails: true }));
    assert.equal(r.counts.written, 1);
    assert.equal(r.counts.posters, 0);
    assert.ok(lines.some((l) => l.includes("poster skipped")));
    assert.ok(files().includes("STAR-489 a.nfo"));
  });

  it("never overwrites an existing poster", async () => {
    mkvideo("STAR-489 a.mkv");
    writeFileSync(join(root, "STAR-489 a-poster.webp"), "mine");
    const r = await run(["--poster"], fake({ matches: byName }));
    assert.equal(r.counts.posters, 0);
    assert.equal(readFileSync(join(root, "STAR-489 a-poster.webp"), "utf8"), "mine");
  });

  it("nothing generated contains the key or a signed URL", async () => {
    mkvideo("STAR-489 a.mkv");
    await run(["--poster"], fake({ matches: byName }));
    for (const n of files().filter((x) => x.endsWith(".nfo"))) {
      const t = readFileSync(join(root, n), "utf8");
      assert.ok(!t.includes(KEY) && !t.includes("SIGNEDGRANT") && !/https?:/.test(t));
    }
    assert.ok(!lines.join("\n").includes(KEY));
  });
});

describe("real client wiring", () => {
  const MOCK = "http://127.0.0.1:9";
  /** Run with the real client and a fake fetch; returns the urls fetched for images. */
  async function wired(env, imageUrl) {
    mkvideo("STAR-489 a.mkv");
    const fetched = [];
    const fetch = async (u) => {
      const url = String(u);
      fetched.push(url);
      const p = new URL(url);
      if (p.pathname === "/v1/match") return Response.json({ matches: hit() });
      if (p.pathname.endsWith("/images")) return Response.json({ images: [{ kind: "cover_front", access: "clear", urls: [{ width: 640, url: imageUrl }] }] });
      if (p.pathname.startsWith("/v1/titles/")) return Response.json(TITLE);
      return webp();
    };
    const r = await runCli(["--root", root, "--poster"], { AVBANG_API_KEY: KEY, AVBANG_API_BASE: "https://api.avbang.net/v1", ...env },
      { createClient: (o) => createApiClient({ ...o, perMinute: 60_000, fetch }), out: (l) => lines.push(l) });
    return { r, imageFetches: fetched.filter((u) => !new URL(u).pathname.startsWith("/v1/")) };
  }
  const base = { AVBANG_API_BASE: `${MOCK}/v1` };

  it("fetches a mock origin only with AVBANG_TEST_IMAGE_ORIGINS plus the insecure flag", async () => {
    const { r, imageFetches } = await wired({ ...base, AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:7" }, "http://127.0.0.1:7/img/x.webp");
    assert.equal(r.counts.posters, 1);
    assert.deepEqual(imageFetches, ["http://127.0.0.1:7/img/x.webp"]);
  });

  it("ignores the variable without the insecure flag or under production", async () => {
    for (const env of [{ AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:7" }, { AVBANG_ALLOW_INSECURE: "1", NODE_ENV: "production", AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:7" }]) {
      lines = [];
      rmSync(join(root, "STAR-489 a.nfo"), { force: true });
      const { r, imageFetches } = await wired(env, "http://127.0.0.1:7/img/x.webp");
      assert.equal(r.counts.written, 1);
      assert.equal(r.counts.posters, 0);
      assert.deepEqual(imageFetches, []);
      assert.ok(lines.some((l) => l.includes("poster skipped")));
    }
  });

  it("never fetches boundary or foreign hosts", async () => {
    for (const bad of ["https://avbang.net.evil.com/a.webp", "https://evilavbang.net/a.webp", "http://avbang.net/a.webp", "https://u:p@avbang.net/a.webp"]) {
      rmSync(join(root, "STAR-489 a.nfo"), { force: true });
      const { r, imageFetches } = await wired({}, bad);
      assert.equal(r.counts.posters, 0, bad);
      assert.deepEqual(imageFetches, [], bad);
    }
  });

  it("fetches an avbang.net subdomain over https", async () => {
    const { r, imageFetches } = await wired({}, "https://img.avbang.net/a.webp");
    assert.equal(r.counts.posters, 1);
    assert.equal(imageFetches.length, 1);
  });
});
