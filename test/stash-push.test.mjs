import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createGraphql } from "../stash/lib/graphql.mjs";
import { basename, diffScene, parseArgs, pickCover, run } from "../stash/push.mjs";

const KEY = "av_live_SECRETKEY123";
const SKEY = "stash-secret-key-456";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

const title = (code, over = {}) => ({
  code, title: `Title ${code}`, releaseDate: "2026-04-12", synopsis: `Synopsis ${code}`, url: `https://avbang.net/t/${code.toLowerCase()}`,
  studio: { slug: "aurora", name: "Aurora" }, performers: [{ slug: "aya", name: "Aya Mizuno" }], tags: [{ slug: "office", name: "Office" }], ...over,
});
const imgs = (code, url, access = "clear") => ({ code, images: [{ id: 1, kind: "cover_front", explicit: true, access, expiresAt: null, urls: [{ width: 640, url: `${url}/640` }, { width: 1280, url }] }] });
const scene = (id, file, over = {}) => ({ id, title: "", code: "", date: null, details: "", urls: [], studio: null, performers: [], tags: [], files: [{ path: `/data/${file}` }], ...over });

/** In-memory Stash GraphQL, AVBang API and image host behind one fetch. */
function world({ scenes, titles = {}, matches = {}, images = {}, imageBytes = WEBP, imageType = "image/webp" }) {
  const w = { scenes, studios: [], performers: [], tags: [], mutations: [], creates: 0, calls: [], stashHeaders: [], imageCalls: [], apiAuth: [] };
  const list = (kind) => w[kind];
  const gqlHandler = (query, v) => {
    if (/findScenes\(/.test(query)) return { findScenes: { count: w.scenes.length, scenes: w.scenes.slice((v.page - 1) * 100, v.page * 100) } };
    if (/findScene\(/.test(query)) return { findScene: w.scenes.find((s) => s.id === v.id) ?? null };
    for (const [kind, f, l] of [["studios", "findStudios", "studios"], ["performers", "findPerformers", "performers"], ["tags", "findTags", "tags"]]) {
      if (query.includes(f + "(")) return { [f]: { [l]: list(kind).filter((r) => r.name.toLowerCase() === v.f.name.value.toLowerCase()) } };
    }
    for (const [kind, c] of [["studios", "studioCreate"], ["performers", "performerCreate"], ["tags", "tagCreate"]]) {
      if (query.includes(c + "(")) {
        w.mutations.push(c);
        w.creates++;
        const r = { id: String(list(kind).length + 1), name: v.i.name };
        list(kind).push(r);
        return { [c]: { id: r.id } };
      }
    }
    if (/sceneUpdate\(/.test(query)) {
      w.mutations.push("sceneUpdate");
      w.lastInput = v.i;
      const s = w.scenes.find((x) => x.id === v.i.id);
      const { id, studio_id, performer_ids, tag_ids, cover_image, ...plain } = v.i;
      Object.assign(s, plain);
      if (studio_id) s.studio = w.studios.find((x) => x.id === studio_id);
      if (performer_ids) s.performers = performer_ids.map((i) => w.performers.find((x) => x.id === i));
      if (tag_ids) s.tags = tag_ids.map((i) => w.tags.find((x) => x.id === i));
      if (cover_image) s.cover = cover_image;
      return { sceneUpdate: { id } };
    }
    throw new Error(`unhandled query ${query.slice(0, 40)}`);
  };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    w.calls.push(`${init.method ?? "GET"} ${u.host}${u.pathname}`);
    if (u.host === "localhost:9999") {
      w.stashHeaders.push(init.headers);
      const { query, variables } = JSON.parse(init.body);
      try {
        return json({ data: gqlHandler(query, variables) });
      } catch (e) {
        return json({ errors: [{ message: e.message }] });
      }
    }
    if (u.host === "api.avbang.net") {
      w.apiAuth.push(init.headers?.authorization);
      if (u.pathname === "/v1/match") return json({ matches: (matches[u.searchParams.get("filename")] ?? []).map((m) => ({ title: {}, ...m })) });
      const m = /^\/v1\/titles\/([^/]+)(\/images)?$/.exec(u.pathname);
      if (m) {
        const hit = m[2] ? images[m[1]] : titles[m[1]];
        return hit ? json(hit) : json({}, 404);
      }
    }
    w.imageCalls.push(String(url));
    w.imageHeaders = init.headers;
    if (u.pathname.startsWith("/img") || u.host === "mock.test:1") {
      return new Response(imageBytes, { status: 200, headers: { "content-type": imageType, "content-length": String(imageBytes.length) } });
    }
    return new Response("no", { status: 404 });
  };
  return w;
}

const go = async (w, args = [], env = {}) => {
  const out = [];
  const code = await run({ argv: args, env: { AVBANG_API_KEY: KEY, ...env }, fetch: w.fetch, log: (l) => out.push(l), sleep: async () => {} });
  return { code, out: out.join("\n") };
};

const basic = (over = {}) =>
  world({
    scenes: [scene("1", "STAR-489 Office overtime.mp4")],
    titles: { "STAR-489": title("STAR-489") },
    matches: { "STAR-489 Office overtime.mp4": [{ code: "STAR-489", confidence: "code" }] },
    images: { "STAR-489": imgs("STAR-489", "https://avbang.net/img/489.webp") },
    ...over,
  });

const envBackup = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = envBackup; });

describe("dry run (the default)", () => {
  it("sends no mutation and creates nothing, prints the plan", async () => {
    const w = basic();
    const r = await go(w);
    assert.equal(r.code, 0);
    assert.deepEqual(w.mutations, []);
    assert.equal(w.creates, 0);
    assert.match(r.out, /dry run/);
    assert.match(r.out, /would update STAR-489: .*title.*code.*date.*details.*urls.*studio \(new\).*performers \(1 new\).*tags \(1 new\).*cover/);
    assert.equal(w.scenes[0].title, "");
  });
});

describe("matching rules", () => {
  it("updates exactly one code match; skips none, several and title guesses, and lists them", async () => {
    const w = world({
      scenes: [scene("1", "STAR-489 a.mp4"), scene("2", "nothing.mp4"), scene("3", "STAR-489 STAR-490 b.mp4"), scene("4", "guess.mp4")],
      titles: { "STAR-489": title("STAR-489") },
      matches: {
        "STAR-489 a.mp4": [{ code: "STAR-489", confidence: "code" }],
        "STAR-489 STAR-490 b.mp4": [{ code: "STAR-489", confidence: "code" }, { code: "STAR-490", confidence: "code" }],
        "guess.mp4": [{ code: "STAR-489", confidence: "search" }],
      },
      images: { "STAR-489": imgs("STAR-489", "https://avbang.net/img/489.webp") },
    });
    const r = await go(w, ["--apply"]);
    assert.equal(r.code, 0);
    assert.equal(w.scenes[0].code, "STAR-489");
    assert.deepEqual(w.scenes.slice(1).map((s) => s.code), ["", "", ""]);
    assert.match(r.out, /skipped: no match/);
    assert.match(r.out, /skipped: ambiguous \(2 candidates\)/);
    assert.match(r.out, /skipped: match is a title guess/);
    assert.match(r.out, /1 updated.*skipped no match: 1; ambiguous \(2 candidates\): 1; match is a title guess, not a code: 1/);
  });

  it("a title that disappears between match and fetch is skipped", async () => {
    const w = basic({ titles: {} });
    const r = await go(w, ["--apply"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /skipped: title not found/);
  });

  it("uses the base name of Unix and Windows paths", () => {
    assert.equal(basename("/data/a/STAR-489 x.mp4"), "STAR-489 x.mp4");
    assert.equal(basename("D:\\lib\\STAR-489 x.mp4"), "STAR-489 x.mp4");
  });
});

describe("apply and overwrite", () => {
  it("fills every mapped field", async () => {
    const w = basic();
    const r = await go(w, ["--apply"]);
    assert.equal(r.code, 0);
    const s = w.scenes[0];
    assert.equal(s.title, "Title STAR-489");
    assert.equal(s.code, "STAR-489");
    assert.equal(s.date, "2026-04-12");
    assert.equal(s.details, "Synopsis STAR-489");
    assert.deepEqual(s.urls, ["https://avbang.net/t/star-489"]);
    assert.equal(s.studio.name, "Aurora");
    assert.equal(s.performers[0].name, "Aya Mizuno");
    assert.equal(s.tags[0].name, "Office");
    assert.match(s.cover, /^data:image\/webp;base64,UklGR/);
  });

  it("without --overwrite keeps filled fields and adds to lists; with it replaces", async () => {
    const mine = { title: "My title", code: "OLD-1", details: "mine", date: "2020-01-01", urls: ["https://example.com/x"], studio: { id: "9", name: "Mine" }, performers: [{ id: "8", name: "Mine P" }], tags: [{ id: "7", name: "Mine T" }] };
    const w = basic({ scenes: [scene("1", "STAR-489 Office overtime.mp4", mine)] });
    w.studios.push({ id: "9", name: "Mine" });
    w.performers.push({ id: "8", name: "Mine P" });
    w.tags.push({ id: "7", name: "Mine T" });
    await go(w, ["--apply"]);
    const s = w.scenes[0];
    assert.equal(s.title, "My title");
    assert.equal(s.code, "OLD-1");
    assert.equal(s.date, "2020-01-01");
    assert.equal(s.details, "mine");
    assert.equal(s.studio.name, "Mine");
    assert.deepEqual(s.urls, ["https://example.com/x", "https://avbang.net/t/star-489"]);
    assert.deepEqual(s.performers.map((p) => p.name), ["Mine P", "Aya Mizuno"]);
    assert.deepEqual(s.tags.map((p) => p.name), ["Mine T", "Office"]);
    assert.equal(s.cover, undefined); // code was already set: no cover fetch
    assert.equal(w.imageCalls.length, 0);

    await go(w, ["--apply", "--overwrite"]);
    assert.equal(s.title, "Title STAR-489");
    assert.equal(s.code, "STAR-489");
    assert.equal(s.studio.name, "Aurora");
    assert.deepEqual(s.urls, ["https://avbang.net/t/star-489"]);
    assert.deepEqual(s.performers.map((p) => p.name), ["Aya Mizuno"]);
    assert.deepEqual(s.tags.map((p) => p.name), ["Office"]);
    assert.ok(s.cover);
  });

  it("a second --apply writes nothing and creates nothing; also with --overwrite", async () => {
    const w = basic();
    await go(w, ["--apply"]);
    const before = { creates: w.creates, muts: w.mutations.length, counts: [w.studios.length, w.performers.length, w.tags.length], imgs: w.imageCalls.length };
    for (const extra of [[], ["--overwrite"]]) {
      const r = await go(w, ["--apply", ...extra]);
      assert.match(r.out, /0 updated, 1 unchanged/);
    }
    assert.equal(w.creates, before.creates);
    assert.equal(w.mutations.length, before.muts);
    assert.deepEqual([w.studios.length, w.performers.length, w.tags.length], before.counts);
    assert.equal(w.imageCalls.length, before.imgs);
  });

  it("finds existing studios, performers and tags by name (any case) instead of creating them", async () => {
    const w = basic();
    w.studios.push({ id: "5", name: "AURORA" });
    w.performers.push({ id: "6", name: "aya mizuno" });
    w.tags.push({ id: "4", name: "Office" });
    await go(w, ["--apply"]);
    assert.equal(w.creates, 0);
    assert.equal(w.scenes[0].studio.id, "5");
    assert.equal(w.scenes[0].performers[0].id, "6");
  });

  it("creates a shared studio once across scenes", async () => {
    const w = world({
      scenes: [scene("1", "STAR-489 a.mp4"), scene("2", "STAR-490 b.mp4")],
      titles: { "STAR-489": title("STAR-489"), "STAR-490": title("STAR-490") },
      matches: { "STAR-489 a.mp4": [{ code: "STAR-489", confidence: "code" }], "STAR-490 b.mp4": [{ code: "STAR-490", confidence: "code" }] },
      images: {},
    });
    await go(w, ["--apply"]);
    assert.equal(w.studios.length, 1);
    assert.equal(w.performers.length, 1);
  });
});

describe("cover", () => {
  const withImage = (url, access = "clear") => basic({ images: { "STAR-489": imgs("STAR-489", url, access) } });

  it("fetches an allowed https host, picks the largest width up to 1280, sends a data URI, never an Authorization header", async () => {
    const w = withImage("https://img.avbang.net/img/489.webp");
    await go(w, ["--apply"]);
    assert.deepEqual(w.imageCalls, ["https://img.avbang.net/img/489.webp"]);
    assert.ok(w.scenes[0].cover.startsWith("data:image/webp;base64,"));
    assert.equal(w.imageHeaders, undefined);
  });

  it("never fetches a foreign host, a boundary host, plain http or a URL with userinfo; other fields are still written", async () => {
    for (const bad of ["https://evil.example/img/x.webp", "https://avbang.net.evil.com/img/x.webp", "https://evilavbang.net/img/x.webp", "http://avbang.net/img/x.webp", "https://u:p\x40avbang.net/img/x.webp"]) {
      const w = withImage(bad);
      const r = await go(w, ["--apply"]);
      assert.deepEqual(w.imageCalls, [], bad);
      assert.match(r.out, /cover skipped: blocked_image/, bad);
      assert.equal(w.scenes[0].title, "Title STAR-489", bad);
      assert.equal(w.scenes[0].cover, undefined, bad);
    }
  });

  it("a cover that is not an image or fails to download skips the cover only", async () => {
    const w = withImage("https://avbang.net/img/x.webp");
    w.fetch = ((f) => async (url, init) => (new URL(url).host === "avbang.net" ? new Response("x", { status: 200, headers: { "content-type": "text/html" } }) : f(url, init)))(w.fetch);
    const r = await go(w, ["--apply"]);
    assert.match(r.out, /cover skipped: bad_content_type/);
    assert.equal(w.scenes[0].code, "STAR-489");
  });

  it("skips a blurred cover unless --allow-blurred", async () => {
    const w = withImage("https://avbang.net/img/x.webp", "blurred");
    const r = await go(w, ["--apply"]);
    assert.match(r.out, /cover skipped: cover only available blurred/);
    assert.equal(w.scenes[0].cover, undefined);
    assert.equal(w.scenes[0].title, "Title STAR-489");
    const w2 = withImage("https://avbang.net/img/x.webp", "blurred");
    await go(w2, ["--apply", "--allow-blurred"]);
    assert.ok(w2.scenes[0].cover);
  });

  it("prefers a clear image over a blurred one", () => {
    const list = { images: [{ kind: "cover_front", access: "blurred", urls: [{ width: 640, url: "https://avbang.net/b" }] }, { kind: "cover_front", access: "clear", urls: [{ width: 640, url: "https://avbang.net/c" }] }] };
    assert.equal(pickCover(list, { allowBlurred: true }).url, "https://avbang.net/c");
    assert.ok(pickCover({ images: [] }, {}).reason);
  });
});

describe("test image origins", () => {
  const origin = "http://mock.test:1";
  const mockImages = () => basic({ images: { "STAR-489": imgs("STAR-489", `${origin}/img/489.webp`) } });

  it("are honoured only with AVBANG_ALLOW_INSECURE=1, by exact origin", async () => {
    const w = mockImages();
    await go(w, ["--apply"], { AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: origin });
    assert.ok(w.scenes[0].cover);
    const w2 = mockImages();
    const r = await go(w2, ["--apply"], { AVBANG_TEST_IMAGE_ORIGINS: origin });
    assert.equal(r.code, 1);
    assert.deepEqual(w2.mutations, []);
    const w3 = mockImages();
    const r3 = await go(w3, ["--apply"], { AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: "http://mock.test:2" });
    assert.match(r3.out, /cover skipped: blocked_image/);
  });

  it("are refused (exit 1) under NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    const w = mockImages();
    const r = await go(w, ["--apply"], { AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: origin });
    assert.equal(r.code, 1);
    assert.match(r.out, /production/);
    assert.equal(w.calls.length, 0);
  });
});

describe("keys and options", () => {
  it("AVBANG_API_KEY missing exits 1 with one line", async () => {
    const out = [];
    const code = await run({ argv: [], env: {}, fetch: async () => { throw new Error("no"); }, log: (l) => out.push(l) });
    assert.equal(code, 1);
    assert.equal(out.length, 1);
  });

  it("sends STASH_API_KEY as ApiKey and the bearer to the API; neither is printed", async () => {
    const w = basic();
    const r = await go(w, ["--apply"], { STASH_API_KEY: SKEY });
    assert.ok(w.stashHeaders.every((h) => h.ApiKey === SKEY));
    assert.ok(w.apiAuth.every((a) => a === `Bearer ${KEY}`));
    assert.ok(!r.out.includes(KEY) && !r.out.includes(SKEY));
    const w2 = basic();
    await go(w2);
    assert.ok(w2.stashHeaders.every((h) => !("ApiKey" in h)));
  });

  it("warns when the Stash key would travel over plain http to a non-local host", async () => {
    const w = basic();
    w.fetch = async () => new Response("{}", { status: 401 });
    const r = await go(w, ["--stash-url", "http://nas.lan:9999"], { STASH_API_KEY: SKEY });
    assert.match(r.out, /warning: STASH_API_KEY is sent over plain http/);
    assert.ok(!r.out.includes(SKEY));
    assert.ok(!(await go(basic(), [], { STASH_API_KEY: SKEY })).out.includes("warning"));
  });

  it("keys are not accepted as options and the value is never echoed", async () => {
    const r = await go(basic(), ["--api-key=" + KEY]);
    assert.equal(r.code, 2);
    assert.ok(!r.out.includes(KEY));
    assert.equal((await go(basic(), ["--stash-api-key", SKEY])).out.includes(SKEY), false);
  });

  it("refuses a non-https API base unless AVBANG_ALLOW_INSECURE=1, and credentials in URLs", async () => {
    assert.equal((await go(basic(), ["--api-base", "http://api.avbang.net/v1"])).code, 1);
    assert.equal((await go(basic(), ["--api-base", "https://u:p\x40api.avbang.net/v1"])).code, 1);
    assert.equal((await go(basic(), ["--stash-url", "http://u:p@localhost:9999"])).code, 1);
  });

  it("parses --scene-id and --limit; bad numbers are a usage error", () => {
    assert.deepEqual(parseArgs(["--scene-id", "7", "--limit=3"]), { ...parseArgs([]), sceneId: "7", limit: 3 });
    assert.throws(() => parseArgs(["--limit", "0"]));
    assert.throws(() => parseArgs(["--scene-id", "1; drop"]));
  });

  it("--scene-id limits the run to one scene and --limit caps scenes", async () => {
    const mk = () => world({
      scenes: [scene("1", "STAR-489 a.mp4"), scene("2", "STAR-489 b.mp4"), scene("3", "STAR-489 c.mp4")],
      titles: { "STAR-489": title("STAR-489") },
      matches: Object.fromEntries(["a", "b", "c"].map((x) => [`STAR-489 ${x}.mp4`, [{ code: "STAR-489", confidence: "code" }]])),
      images: {},
    });
    const w = mk();
    await go(w, ["--scene-id", "2", "--apply"]);
    assert.deepEqual(w.scenes.map((s) => s.code), ["", "STAR-489", ""]);
    const w2 = mk();
    const r = await go(w2, ["--limit", "2"]);
    assert.match(r.out, /2 scenes/);
  });

  it("progress and results are counts and names only; control characters in file names are neutralised", async () => {
    const w = world({ scenes: [scene("1", "evil\u001b[2Jname.mp4")] });
    const r = await go(w);
    assert.ok(!r.out.includes("\u001b"));
  });

  it("transport failures exit 1 and a scene that is not matched does not", async () => {
    const r = await run({ argv: [], env: { AVBANG_API_KEY: KEY }, fetch: async () => { throw new Error("down"); }, log: () => {}, sleep: async () => {} });
    assert.equal(r, 1);
    const w = world({ scenes: [scene("1", "nothing.mp4")] });
    assert.equal((await go(w)).code, 0);
  });
});

describe("graphql helper", () => {
  it("sends values as variables only; a hostile title or name never reaches the query text", async () => {
    const seen = [];
    const gql = createGraphql({ url: "http://localhost:9999", fetch: async (u, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { studios: [] } })); } });
    const evil = 'x") { id } } mutation { sceneDestroy';
    await gql("query($f: StudioFilterType) { findStudios(studio_filter: $f) { studios { id } } }", { f: { name: { value: evil } } });
    assert.ok(!seen[0].query.includes("sceneDestroy"));
    assert.equal(seen[0].variables.f.name.value, evil);
  });

  it("scrubs the ApiKey from errors and refuses redirects", async () => {
    let init0;
    const gql = createGraphql({ url: "http://localhost:9999", apiKey: SKEY, fetch: async (u, init) => { init0 = init; return new Response(JSON.stringify({ errors: [{ message: `bad ${SKEY}` }] })); } });
    await assert.rejects(gql("{x}"), (e) => !e.message.includes(SKEY) && e.message.includes("[key]"));
    assert.equal(init0.redirect, "error");
  });
});

describe("diffScene", () => {
  it("is empty when the scene already matches", () => {
    const s = scene("1", "x.mp4", { title: "T", code: "C-1", date: "2026-01-01", details: "d", urls: ["https://avbang.net/t/c-1"], studio: { id: "1", name: "S" } });
    const t = { code: "C-1", title: "T", releaseDate: "2026-01-01", synopsis: "d", url: "https://avbang.net/t/c-1", studio: { name: "S" }, performers: [], tags: [] };
    assert.deepEqual(diffScene(s, t, { studio: "1", performers: [], tags: [] }, { overwrite: true, cover: null }).changes, []);
  });

  it("ignores a malformed date and a non-https url from the API", () => {
    const t = { code: "C-1", title: null, releaseDate: "12/04/2026", synopsis: null, url: "javascript:alert(1)", studio: null, performers: [], tags: [] };
    assert.deepEqual(diffScene(scene("1", "x.mp4"), t, { performers: [], tags: [] }, { overwrite: false, cover: null }).changes, ["code"]);
  });
});
