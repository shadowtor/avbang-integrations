// Provider security controls (phase 28.1 plan 01). node:test, zero dependencies: node --test integrations/test/
import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, ProviderError } from "../plex/provider.ts";
import { FIXTURES, imageList, summary } from "../lib/mock-api.mjs";

const ID = "tv.plex.agents.custom.avbang.movie";
const T = FIXTURES["STAR-489"].title;
const origins = { imageOrigin: "http://127.0.0.1:9000", foreignImageOrigin: "http://127.0.0.1:9001" };

function backend(over = {}) {
  const calls = { match: 0, title: 0, images: 0 };
  return {
    calls,
    match: async () => (calls.match++, { matches: [{ code: "STAR-489", confidence: "code", title: summary(T) }] }),
    title: async (c) => (calls.title++, c === "STAR-489" ? T : null),
    images: async () => (calls.images++, imageList("STAR-489", origins)),
    ...over,
  };
}
const get = (p, path) => p.handle(new Request("http://x.invalid/", { method: "GET" }), path);
const post = (p, path, body, raw = false) =>
  p.handle(
    new Request("http://x.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    }),
    path,
  );
const withUrl = (url) =>
  backend({
    images: async () => ({
      code: "STAR-489",
      images: [{ id: 1, kind: "cover_front", explicit: true, access: "clear", expiresAt: null, urls: [{ width: 640, url }] }],
    }),
  });
async function imageOf(p) {
  const j = await (await get(p, "/library/metadata/STAR-489")).json();
  return j.MediaContainer.Metadata[0].Image?.[0]?.url;
}

test("image rule: only https on an allowed host or true subdomain is relayed verbatim", async () => {
  for (const ok of ["https://avbang.net/x", "https://img.avbang.net/x?grant=1.2", "https://a.b.avbang.net/x"]) {
    assert.equal(await imageOf(createProvider(withUrl(ok))), ok);
  }
  for (const bad of [
    "http://avbang.net/x",
    "https://evil.com/x",
    "https://avbang.net.evil.com/x",
    "https://evilavbang.net/x",
    "https://avbang.net\x40evil.com/x",
    "https://user:pw\x40avbang.net/x",
    "https://avbang.net:8443/x",
    "https://avbang.net./x",
    "//avbang.net/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    assert.equal(await imageOf(createProvider(withUrl(bad))), undefined, bad);
  }
});

test("testImageOrigins: inert by default, exact origin only when listed", async () => {
  const mock = "http://127.0.0.1:9000/img/STAR-489/640.webp";
  assert.equal(await imageOf(createProvider(withUrl(mock))), undefined, "default config drops http mock urls");
  const cfg = { testImageOrigins: ["http://127.0.0.1:9000"] };
  assert.equal(await imageOf(createProvider(withUrl(mock), cfg)), mock);
  for (const bad of [
    "http://127.0.0.1:9001/img/x.webp", // other port
    "http://127.0.0.1/img/x.webp", // no port
    "https://127.0.0.1:9000/img/x.webp", // other scheme
    "http://127.0.0.1:9000\x40evil.com/x", // userinfo trick
    "http://127.0.0.1:9000.evil.com/x", // host suffix trick
    "http://127.0.0.10:9000/x",
  ]) {
    assert.equal(await imageOf(createProvider(withUrl(bad), cfg)), undefined, bad);
  }
  // prefix tricks: the match is on the parsed origin, never a string prefix
  assert.equal(await imageOf(createProvider(withUrl("http://127.0.0.1:9000/x"), { testImageOrigins: ["http://127.0.0.1:900"] })), undefined);
  assert.equal(await imageOf(createProvider(withUrl("http://a.test.evil.com/x"), { testImageOrigins: ["http://a.test"] })), undefined);
  assert.equal(await imageOf(createProvider(withUrl("http://a.test/x"), { testImageOrigins: ["http://a.test"] })), "http://a.test/x");
  // an entry that is not a bare origin is rejected instead of widening the rule
  for (const bad of ["http://127.0.0.1:9000/img", "*", "127.0.0.1", "http://a@127.0.0.1:9000"]) {
    assert.throws(() => createProvider(backend(), { testImageOrigins: [bad] }), bad);
  }
});

test("testImageOrigins is refused when NODE_ENV is production", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => createProvider(backend(), { testImageOrigins: ["http://127.0.0.1:9000"] }), /production/);
    assert.doesNotThrow(() => createProvider(backend(), { testImageOrigins: [] }));
    assert.doesNotThrow(() => createProvider(backend()));
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test("poster choice: cover_front first, 640 width, largest otherwise", async () => {
  const mk = (kind, urls) => ({ id: 1, kind, explicit: false, access: "clear", expiresAt: null, urls });
  const list = {
    code: "STAR-489",
    images: [
      mk("promo", [{ width: 640, url: "https://avbang.net/promo" }]),
      mk("cover_front", [{ width: 320, url: "https://avbang.net/s" }, { width: 1280, url: "https://avbang.net/l" }]),
    ],
  };
  assert.equal(await imageOf(createProvider(backend({ images: async () => list }))), "https://avbang.net/l");
  list.images[1].urls.push({ width: 640, url: "https://avbang.net/m" });
  assert.equal(await imageOf(createProvider(backend({ images: async () => list }))), "https://avbang.net/m");
});

test("ratingKey: invalid keys are 404 and never reach the backend", async () => {
  const b = backend();
  const p = createProvider(b);
  for (const bad of ["..", "%2e%2e", "a%2Fb", "a.b", "a b", "a%20b", "x".repeat(33), "STAR-489%00", "a;b", "матч", "matches"]) {
    for (const suffix of ["", "/extras"]) {
      const r = await get(p, `/library/metadata/${bad}${suffix}`);
      assert.equal(r.status, 404, `${bad}${suffix}`);
    }
  }
  for (const bad of ["/library/metadata/../x", "/library/metadata/a/b", "/library/metadata/a/../b"]) {
    assert.equal((await get(p, bad)).status, 404, bad);
  }
  assert.deepEqual(b.calls, { match: 0, title: 0, images: 0 });
  const ok = await get(p, "/library/metadata/STAR-489");
  assert.equal(ok.status, 200);
  assert.equal(b.calls.title, 1);
  const m = (await ok.json()).MediaContainer.Metadata[0];
  assert.equal(m.guid, `${ID}://movie/STAR-489`);
  assert.equal(m.duration, 142 * 60000);
  assert.equal((await get(p, "/library/metadata/STAR-999")).status, 404);
});

test("backend 429 and 503 become 503 with Retry-After; other errors never leak text", async () => {
  for (const [status, ra] of [[429, "7"], [503, "12"]]) {
    const p = createProvider(backend({ title: async () => { throw new ProviderError(status, ra); } }));
    const r = await get(p, "/library/metadata/STAR-489");
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), ra);
  }
  // an upstream header that is not plain seconds is not copied
  const evil = createProvider(backend({ match: async () => { throw new ProviderError(429, "7\r\nx-evil: 1"); } }));
  const r1 = await post(evil, "/library/metadata/matches", { type: 1, filename: "a.mkv" });
  assert.equal(r1.status, 503);
  assert.equal(r1.headers.get("retry-after"), "30");
  assert.equal(r1.headers.get("x-evil"), null);

  const boom = createProvider(backend({ title: async () => { throw new Error("secret stack text /etc/passwd"); } }));
  const r2 = await get(boom, "/library/metadata/STAR-489");
  assert.ok(r2.status >= 500 && r2.status < 600);
  assert.ok(!(await r2.text()).includes("secret"));
  const r3 = await get(createProvider(backend({ title: async () => { throw new ProviderError(502, null, "secret"); } })), "/library/metadata/STAR-489");
  assert.equal(r3.status, 502);
  assert.ok(!(await r3.text()).includes("secret"));
});

test("matches: bad bodies are 400 and never reach the backend; double slash behaves as single", async () => {
  const b = backend();
  const p = createProvider(b);
  const bads = [
    { type: 2, title: "x" }, { title: "x" }, { type: "1", title: "x" }, {}, { type: 1 }, { type: 1, title: 5 },
    { type: 1, filename: "x".repeat(513) }, { type: 1, title: "x".repeat(201) }, { type: 1, title: "x", year: "abc" }, [],
  ];
  for (const body of bads) assert.equal((await post(p, "/library/metadata/matches", body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await post(p, "/library/metadata/matches", "not json", true)).status, 400);
  assert.equal((await post(p, "/library/metadata/matches", undefined)).status, 400);
  assert.equal(b.calls.match, 0);
  const body = { type: 1, title: "STAR 489 Office Overtime", filename: "STAR-489 Office overtime.mkv" };
  const one = await (await post(p, "/library/metadata/matches", body)).json();
  const two = await (await post(p, "//library/metadata/matches", body)).json();
  const many = await (await post(p, "////library/metadata/matches", body)).json();
  assert.deepEqual(two, one);
  assert.deepEqual(many, one);
  assert.equal(one.MediaContainer.Metadata[0].ratingKey, "STAR-489");
  assert.equal(b.calls.match, 3);
});

test("matches: at most 5, code candidates preferred over search, keys re-validated", async () => {
  const mkm = (code, confidence) => ({ code, confidence, title: { ...summary(T), code } });
  const many = Array.from({ length: 9 }, (_, i) => mkm(`A-${i}`, "code"));
  const p1 = createProvider(backend({ match: async () => ({ matches: many }) }));
  assert.equal((await (await post(p1, "/library/metadata/matches", { type: 1, title: "x" })).json()).MediaContainer.size, 5);
  const p2 = createProvider(backend({ match: async () => ({ matches: [mkm("S-1", "search"), mkm("C-1", "code"), mkm("../bad", "code")] }) }));
  const r = (await (await post(p2, "/library/metadata/matches", { type: 1, title: "x" })).json()).MediaContainer.Metadata;
  assert.deepEqual(r.map((x) => x.ratingKey), ["C-1"]);
  const p3 = createProvider(backend({ match: async () => ({ matches: [] }) }));
  assert.equal((await (await post(p3, "/library/metadata/matches", { type: 1, title: "x" })).json()).MediaContainer.size, 0);
});

test("definition, extras and unknown routes", async () => {
  const b = backend();
  const p = createProvider(b);
  const d = (await (await get(p, "/")).json()).MediaProvider;
  assert.equal(d.identifier, ID);
  assert.deepEqual(d.Types[0], { type: 1, Scheme: [{ scheme: ID }] });
  assert.deepEqual(d.Feature.map((f) => f.key), ["/library/metadata", "/library/metadata/matches"]);
  const x = await get(p, "/library/metadata/STAR-489/extras");
  assert.equal(x.status, 200);
  assert.equal((await x.json()).MediaContainer.size, 0);
  for (const path of ["/nope", "/library", "/library/metadata", "/library/metadata/matches", "/library/metadata/a/extras/", "/library/metadata/a/b"]) {
    const r = await get(p, path);
    assert.equal(r.status, 404, path);
    assert.ok(!(await r.text()).includes("stack"));
  }
  assert.equal((await p.handle(new Request("http://x.invalid/", { method: "DELETE" }), "/")).status, 404);
  assert.deepEqual(b.calls, { match: 0, title: 0, images: 0 });
  assert.throws(() => createProvider(b, { identifier: "tv.plex.agents.bad" }));
});

test("adult content: items carry isAdult; includeAdult 0 filters, absent or 1 does not (PMS omits it by default)", async () => {
  const b = backend();
  const p = createProvider(b);
  const base = { type: 1, title: "STAR 489" };
  for (const extra of [{}, { includeAdult: 1 }, { includeAdult: "1" }]) {
    const m = (await (await post(p, "/library/metadata/matches", { ...base, ...extra })).json()).MediaContainer.Metadata;
    assert.equal(m.length, 1, JSON.stringify(extra));
    assert.equal(m[0].isAdult, true);
  }
  for (const v of [0, "0"]) {
    const r = await post(p, "/library/metadata/matches", { ...base, includeAdult: v });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).MediaContainer.size, 0);
  }
  const full = (await (await get(p, "/library/metadata/STAR-489")).json()).MediaContainer.Metadata[0];
  assert.equal(full.isAdult, true);
});
