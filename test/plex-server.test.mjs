// Container entry controls (phase 28.1 plan 01). node:test, zero dependencies.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, startServer, stripToken, ConfigError, MAX_BODY, MAX_UPSTREAM } from "../plex/server.ts";
import { FIXTURES, imageList, summary } from "../lib/mock-api.mjs";

const KEY = "av_live" + "_testkey0123456789abcdef";
const base = { AVBANG_API_KEY: KEY };
const origins = { imageOrigin: "http://127.0.0.1:9000", foreignImageOrigin: "http://127.0.0.1:9001" };

function failsWith(env, re) {
  assert.throws(
    () => loadConfig(env),
    (e) => {
      assert.ok(e instanceof ConfigError, "typed error");
      assert.match(e.message, re);
      assert.ok(!e.message.includes(KEY), "message must not contain the key");
      assert.ok(!e.message.includes("\n"), "one line");
      return true;
    },
  );
}

test("loadConfig defaults", () => {
  const c = loadConfig(base);
  assert.equal(c.apiBase, "https://api.avbang.net/v1");
  assert.deepEqual(c.imageHosts, ["avbang.net"]);
  assert.deepEqual(c.testImageOrigins, []);
  assert.equal(c.port, 8787);
  assert.equal(c.bind, "127.0.0.1", "must never default to all interfaces");
  assert.equal(c.providerToken, null);
  assert.equal(loadConfig({ ...base, BIND: "0.0.0.0" }).bind, "0.0.0.0", "explicit override still works");
});

test("loadConfig: missing key, non-https base, test origins without the insecure flag or in production", () => {
  failsWith({}, /AVBANG_API_KEY is required/);
  failsWith({ AVBANG_API_KEY: "bad key\r\nx: y" }, /invalid characters/);
  failsWith({ ...base, AVBANG_API_BASE: "http://api.avbang.net/v1" }, /https/);
  failsWith({ ...base, AVBANG_API_BASE: "http://127.0.0.1:1/v1", AVBANG_ALLOW_INSECURE: "0" }, /https/);
  failsWith({ ...base, AVBANG_API_BASE: "ftp://x/v1", AVBANG_ALLOW_INSECURE: "1" }, /https/);
  failsWith({ ...base, AVBANG_API_BASE: `https://user:${KEY}@api.avbang.net/v1` }, /credentials/);
  failsWith({ ...base, AVBANG_API_BASE: "nonsense" }, /valid URL/);
  failsWith({ ...base, AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:9000" }, /AVBANG_ALLOW_INSECURE/);
  failsWith({ ...base, AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:9000", AVBANG_ALLOW_INSECURE: "1", NODE_ENV: "production" }, /production/);
  failsWith({ ...base, PORT: "70000" }, /PORT/);
  // the insecure flag permits http only together with the flag
  const ok = loadConfig({ ...base, AVBANG_API_BASE: "http://127.0.0.1:1/v1", AVBANG_ALLOW_INSECURE: "1", AVBANG_TEST_IMAGE_ORIGINS: "http://127.0.0.1:9000" });
  assert.deepEqual(ok.testImageOrigins, ["http://127.0.0.1:9000"]);
});

function fakeApi() {
  const seen = [];
  const T = FIXTURES["STAR-489"].title;
  const f = async (url, init) => {
    seen.push({ url: String(url), init });
    const u = new URL(String(url));
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname.endsWith("/images")) return json(imageList("STAR-489", origins));
    if (u.pathname.startsWith("/v1/titles/")) return json(T);
    return json({ matches: [{ code: "STAR-489", confidence: "code", title: summary(T) }] });
  };
  return { f, seen };
}

async function boot(fetchImpl, extra = {}) {
  const logs = [];
  const config = loadConfig({ ...base, AVBANG_API_BASE: "https://api.example.test/v1", PORT: "0", BIND: "127.0.0.1", ...extra });
  const s = await startServer(config, { fetch: fetchImpl, log: (l) => logs.push(l) });
  return { s, logs, url: `http://127.0.0.1:${s.port}` };
}

test("startServer: key goes only in the Authorization header, never in URLs or logs", async () => {
  const api = fakeApi();
  const { s, logs, url } = await boot(api.f);
  try {
    const r = await fetch(`${url}/library/metadata/STAR-489?X-Plex-Token=abc`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.MediaContainer.Metadata[0].title, "Office overtime");
    const m = await fetch(`${url}//library/metadata/matches`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer plexsecret" }, body: JSON.stringify({ type: 1, filename: "STAR-489.mkv" }) });
    assert.equal(m.status, 200);
    assert.ok(api.seen.length >= 3);
    for (const { url: u, init } of api.seen) {
      assert.ok(!u.includes(KEY), "key not in URL");
      assert.equal(init.headers.authorization, `Bearer ${KEY}`);
      assert.equal(init.redirect, "error", "redirects never followed (key would travel)");
    }
    const all = logs.join("\n");
    assert.ok(!all.includes(KEY));
    assert.ok(!/authorization|bearer|plexsecret/i.test(all));
    assert.match(all, /GET \/library\/metadata\/STAR-489 200/);
    assert.match(all, /POST \/\/library\/metadata\/matches 200/);
    assert.ok(!all.includes("X-Plex-Token"), "query string not logged");
  } finally {
    await s.close();
  }
});

test("startServer: request bodies over 64 KiB are refused and never reach the API", async () => {
  const api = fakeApi();
  const { s, url } = await boot(api.f);
  try {
    assert.equal(MAX_BODY, 64 * 1024);
    const big = JSON.stringify({ type: 1, title: "x", pad: "y".repeat(MAX_BODY + 10) });
    let status = 0;
    try {
      status = (await fetch(`${url}/library/metadata/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: big })).status;
    } catch {
      status = -1; // connection closed on the client before the response was read
    }
    assert.notEqual(status, 200);
    assert.ok(status === 413 || status === -1, `status ${status}`);
    assert.equal(api.seen.length, 0);
    // just under the cap still works
    const small = JSON.stringify({ type: 1, title: "x", pad: "y".repeat(MAX_BODY - 200) });
    const ok = await fetch(`${url}/library/metadata/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: small });
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

test("startServer: upstream responses over 1 MiB are refused (declared and streamed)", async () => {
  assert.equal(MAX_UPSTREAM, 1024 * 1024);
  // each layer must trip on its own: a lying Content-Length with a small valid body, and a valid JSON body over the cap streamed without Content-Length
  const declared = async () => new Response('{"matches":[]}', { status: 200, headers: { "content-length": String(MAX_UPSTREAM + 10) } });
  const enc = new TextEncoder();
  const bigJson = enc.encode(JSON.stringify({ matches: [], pad: "z".repeat(MAX_UPSTREAM + 10) }));
  const streamed = async () => {
    let off = 0;
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(bigJson.slice(off, off + 64 * 1024));
        off += 64 * 1024;
        if (off >= bigJson.length) c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  for (const impl of [declared, streamed]) {
    const { s, url } = await boot(impl);
    try {
      const r = await fetch(`${url}/library/metadata/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: 1, title: "x" }) });
      assert.equal(r.status, 502);
      const text = await r.text();
      assert.ok(text.length < 1000 && !text.includes("zzzz"));
    } finally {
      await s.close();
    }
  }
});

test("startServer: upstream 429 and 5xx become 503 with Retry-After, unreachable upstream too", async () => {
  const mk = (status, ra) => async () => new Response("{}", { status, headers: ra ? { "retry-after": ra } : {} });
  for (const [impl, want] of [[mk(429, "9"), "9"], [mk(500, "4"), "4"], [mk(502), "30"], [async () => { throw new Error("ECONNREFUSED"); }, "30"]]) {
    const { s, url } = await boot(impl);
    try {
      const r = await fetch(`${url}/library/metadata/STAR-489`);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), want);
    } finally {
      await s.close();
    }
  }
  // 401 from the API is a 502 for Plex and does not echo anything
  const { s, url } = await boot(async () => new Response('{"detail":"key av_live_x invalid"}', { status: 401 }));
  try {
    const r = await fetch(`${url}/library/metadata/STAR-489`);
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes("av_live"));
  } finally {
    await s.close();
  }
});

const TOKEN = "tok_0123456789abcdefghij";

test("PROVIDER_TOKEN: format is validated and stripToken is exact", () => {
  failsWith({ ...base, PROVIDER_TOKEN: "short" }, /PROVIDER_TOKEN/);
  failsWith({ ...base, PROVIDER_TOKEN: "has space and slash/0123456789" }, /PROVIDER_TOKEN/);
  assert.equal(loadConfig({ ...base, PROVIDER_TOKEN: TOKEN }).providerToken, TOKEN);
  assert.equal(stripToken("/x", null), "/x");
  assert.equal(stripToken(`/${TOKEN}/library/metadata/A`, TOKEN), "/library/metadata/A");
  assert.equal(stripToken(`/${TOKEN}//library/metadata/matches`, TOKEN), "//library/metadata/matches");
  assert.equal(stripToken(`/${TOKEN}`, TOKEN), "/");
  for (const bad of ["/", "", "/library/metadata/A", `/${TOKEN}x/a`, `/x${TOKEN}/a`, `//${TOKEN}/a`, "/" + TOKEN.toUpperCase() + "/a"]) {
    assert.equal(stripToken(bad, TOKEN), null, bad);
  }
});

test("startServer with a token: requests without or with a wrong token are 404 and never reach the API", async () => {
  const api = fakeApi();
  const { s, logs, url } = await boot(api.f, { PROVIDER_TOKEN: TOKEN });
  try {
    for (const p of ["/library/metadata/STAR-489", `/${TOKEN}x/library/metadata/STAR-489`, "/", "//library/metadata/matches"]) {
      const r = await fetch(url + p, p.startsWith("//") ? { method: "POST", body: "{}" } : {});
      assert.equal(r.status, 404, p);
    }
    assert.equal(api.seen.length, 0);
    const ok = await fetch(`${url}/${TOKEN}/library/metadata/STAR-489`);
    assert.equal(ok.status, 200);
    const slash = await fetch(`${url}/${TOKEN}//library/metadata/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: 1, filename: "STAR-489.mkv" }) });
    assert.equal(slash.status, 200);
    const all = logs.join("\n");
    assert.ok(!all.includes(TOKEN), "token is never logged");
    assert.match(all, /\[unauthorized\] 404/);
  } finally {
    await s.close();
  }
});

test("startup warning: unauthenticated and non-loopback only", async () => {
  const cases = [
    [{ BIND: "127.0.0.1" }, false],
    [{ BIND: "0.0.0.0" }, true],
    [{ BIND: "0.0.0.0", PROVIDER_TOKEN: TOKEN }, false],
  ];
  for (const [extra, warns] of cases) {
    const { s, logs } = await boot(fakeApi().f, extra);
    try {
      const w = logs.filter((l) => /unauthenticated/.test(l));
      assert.equal(w.length > 0, warns, JSON.stringify(extra));
      if (warns) assert.ok(w.length === 1 && !w[0].includes("\n") &&!w[0].includes(KEY));
    } finally {
      await s.close();
    }
  }
});
