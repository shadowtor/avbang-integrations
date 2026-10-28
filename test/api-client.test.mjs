import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError, createApiClient } from "../lib/api-client.mjs";

const KEY = "av_live_SECRETKEY123";
const BASE = "https://avbang.net/api";
const json = (b, init = {}) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" }, ...init });
const img = (init = {}) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" }, ...init });

/** Fake clock: sleep advances time; fetch is a scripted queue and records calls. */
function rig(script, extra = {}) {
  const calls = [];
  const clock = { t: 1_000_000, slept: [] };
  const queue = [...script];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, at: clock.t });
    const next = queue.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url) : next;
  };
  const client = createApiClient({
    baseUrl: BASE,
    key: KEY,
    fetch,
    now: () => clock.t,
    sleep: async (ms) => { clock.slept.push(ms); clock.t += ms; },
    ...extra,
  });
  return { client, calls, clock };
}

const envBackup = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = envBackup; });

describe("get", () => {
  it("sends the bearer from the option, parses json, builds params", async () => {
    const { client, calls } = rig([json({ ok: 1 })]);
    assert.deepEqual(await client.get("/v1/titles", { q: "a b", skip: undefined }), { ok: 1 });
    assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].url, "https://avbang.net/v1/titles?q=a+b");
    assert.equal(calls[0].init.redirect, "manual");
  });

  it("rejects non-https base unless allowInsecure; credentials in base", () => {
    assert.throws(() => createApiClient({ baseUrl: "http://avbang.net", key: KEY }), /https/);
    assert.doesNotThrow(() => createApiClient({ baseUrl: "http://127.0.0.1:1", key: KEY, allowInsecure: true }));
    assert.throws(() => createApiClient({ baseUrl: "https://u:p\x40avbang.net", key: KEY }), /credentials/);
    assert.throws(() => createApiClient({ baseUrl: BASE, key: "" }), /key/);
  });

  it("refuses paths that could leave the origin", async () => {
    const { client, calls } = rig([]);
    for (const p of ["//evil.com/x", "v1/x", "/\\evil.com"]) await assert.rejects(client.get(p), (e) => e.code === "bad_request");
    assert.equal(calls.length, 0);
  });

  it("paces calls at perMinute", async () => {
    const { client, calls } = rig([json({}), json({}), json({})], { perMinute: 60 });
    for (const p of ["/a", "/b", "/c"]) await client.get(p); // sequential: the fake clock cannot model concurrent sleepers
    assert.deepEqual(calls.map((c) => c.at - calls[0].at), [0, 1000, 2000]);
  });

  it("honours Retry-After on 429 (capped), then keeps the pace", async () => {
    const r429 = (ra) => new Response("", { status: 429, headers: ra ? { "retry-after": ra } : {} });
    const { client, calls } = rig([r429("30"), r429("99999"), r429("garbage"), json({ done: true })], { perMinute: 60 });
    assert.deepEqual(await client.get("/x"), { done: true });
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.deepEqual(gaps, [30_000, 120_000, 60_000]); // 99999 capped to 120 s, garbage falls back to 60 s
    const after = await rig([r429("1"), json({}), json({})], { perMinute: 60 });
    await after.client.get("/x");
    await after.client.get("/y");
    const [, b, c] = after.calls;
    assert.equal(c.at - b.at, 1000); // back to the configured rate after the storm
  });

  it("gives a typed error after 5 retries instead of looping", async () => {
    const mk = () => new Response("", { status: 429, headers: { "retry-after": "1" } });
    const { client, calls } = rig([mk(), mk(), mk(), mk(), mk(), mk(), mk()]);
    await assert.rejects(client.get("/x"), (e) => e instanceof ApiError && e.code === "rate_limited" && e.status === 429);
    assert.equal(calls.length, 6);
  });

  it("retries a network error once, then fails with a typed error", async () => {
    const ok = rig([new Error("boom"), json({ a: 1 })]);
    assert.deepEqual(await ok.client.get("/x"), { a: 1 });
    const bad = rig([new Error("boom"), new Error("boom")]);
    await assert.rejects(bad.client.get("/x"), (e) => e.code === "network");
  });

  it("passes an abort signal for the timeout", async () => {
    const { client, calls } = rig([json({})]);
    await client.get("/x");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("rejects a response above the byte cap (declared and streamed)", async () => {
    const declared = rig([json({}, { headers: { "content-length": "999999" } })], { maxBytes: 100 });
    await assert.rejects(declared.client.get("/x"), (e) => e.code === "too_large");
    const streamed = rig([new Response(JSON.stringify({ pad: "x".repeat(500) }))], { maxBytes: 100 });
    await assert.rejects(streamed.client.get("/x"), (e) => e.code === "too_large");
  });

  it("never puts the key in an error message", async () => {
    const cases = [
      new Response("nope " + KEY, { status: 500 }),
      new Response("nope", { status: 404 }),
      new Response("{bad", { status: 200 }),
      new Error("connect " + KEY),
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
    ];
    for (const c of cases) {
      const { client } = rig([c, c, c, c, c, c, c]);
      await assert.rejects(client.get("/v1/x", { q: "t" }), (e) => {
        assert.ok(!String(e.message).includes(KEY) && !String(e.stack).includes(KEY));
        return true;
      });
    }
  });
});

describe("rawFetchImage", () => {
  const HOSTS = ["avbang.net"];

  it("fetches https on the host and true subdomains, without Authorization", async () => {
    const { client, calls } = rig([img(), img()]);
    const r = await client.rawFetchImage("https://img.avbang.net/a.webp", HOSTS);
    assert.equal(r.contentType, "image/webp");
    assert.deepEqual([...r.bytes], [1, 2, 3]);
    await client.rawFetchImage("https://avbang.net/a.webp", HOSTS);
    assert.equal(calls[0].init.headers, undefined);
  });

  it("refuses boundary hosts, http, userinfo, ports before any request", async () => {
    const { client, calls } = rig([]);
    for (const u of [
      "https://avbang.net.evil.com/a.webp",
      "https://evilavbang.net/a.webp",
      "http://avbang.net/a.webp",
      "https://user:pw\x40avbang.net/a.webp",
      "https://avbang.net\x40evil.com/a.webp",
      "https://avbang.net:8443/a.webp",
      "file:///etc/passwd",
      "not a url",
    ]) await assert.rejects(client.rawFetchImage(u, HOSTS), (e) => e.code === "blocked_image", u);
    assert.equal(calls.length, 0);
  });

  it("follows at most 2 redirects and only to allowed hosts", async () => {
    const redir = (to) => new Response("", { status: 302, headers: { location: to } });
    const two = rig([redir("/b"), redir("https://img.avbang.net/c"), img()]);
    assert.equal((await two.client.rawFetchImage("https://avbang.net/a", HOSTS)).contentType, "image/webp");
    const three = rig([redir("/b"), redir("/c"), redir("/d"), img()]);
    await assert.rejects(three.client.rawFetchImage("https://avbang.net/a", HOSTS), (e) => e.code === "blocked_image");
    const away = rig([redir("https://evil.com/x")]);
    await assert.rejects(away.client.rawFetchImage("https://avbang.net/a", HOSTS), (e) => e.code === "blocked_image");
    assert.equal(away.calls.length, 1);
  });

  it("requires image/* and caps size at 5 MiB by default", async () => {
    const html = rig([new Response("<html>", { headers: { "content-type": "text/html" } })]);
    await assert.rejects(html.client.rawFetchImage("https://avbang.net/a", HOSTS), (e) => e.code === "bad_content_type");
    const big = rig([img({ headers: { "content-type": "image/png", "content-length": String(5 * 1024 * 1024 + 1) } })]);
    await assert.rejects(big.client.rawFetchImage("https://avbang.net/a", HOSTS), (e) => e.code === "too_large");
  });

  it("rejects an invalid allowlist", async () => {
    const { client } = rig([]);
    await assert.rejects(client.rawFetchImage("https://avbang.net/a", []), (e) => e.code === "bad_request");
    await assert.rejects(client.rawFetchImage("https://avbang.net/a", ["a/b"]), (e) => e.code === "bad_request");
  });
});

describe("testImageOrigins", () => {
  const mk = (extra, script = []) => rig(script, { baseUrl: "http://127.0.0.1:9", allowInsecure: true, ...extra });

  it("fetches http only on exactly the listed origin", async () => {
    const { client, calls } = mk({ testImageOrigins: ["http://127.0.0.1:8123"] }, [img()]);
    await client.rawFetchImage("http://127.0.0.1:8123/a.webp", ["avbang.net"]);
    assert.equal(calls.length, 1);
    for (const u of ["http://127.0.0.1:8124/a.webp", "http://127.0.0.1/a.webp", "http://127.0.0.1:81233/a", "https://127.0.0.1:8123/a", "http://127.0.0.1:8123\x40evil.com/a"]) {
      await assert.rejects(client.rawFetchImage(u, ["avbang.net"]), (e) => e.code === "blocked_image", u);
    }
    assert.equal(calls.length, 1);
  });

  it("is inert by default", async () => {
    const { client, calls } = mk({}, []);
    await assert.rejects(client.rawFetchImage("http://127.0.0.1:8123/a.webp", ["avbang.net"]), (e) => e.code === "blocked_image");
    assert.equal(calls.length, 0);
  });

  it("throws without allowInsecure, with a bad origin, or under production", () => {
    assert.throws(() => createApiClient({ baseUrl: BASE, key: KEY, testImageOrigins: ["http://127.0.0.1:1"] }), /allowInsecure/);
    assert.throws(() => mk({ testImageOrigins: ["http://127.0.0.1:1/path"] }), /invalid test image origin/);
    assert.throws(() => mk({ testImageOrigins: ["ftp://x"] }), /invalid test image origin/);
    process.env.NODE_ENV = "production";
    assert.throws(() => mk({ testImageOrigins: ["http://127.0.0.1:1"] }), /production/);
  });
});
