// Shared AVBang API client for the Stash push tool and the Jellyfin CLI (phase 28.1).
// Dependency-free (Node fetch only) so the split public repo runs it as is.
//
// - The key comes from the constructor, goes only into the Authorization header, and is never in an error message.
// - Calls are paced (default 200 per minute, below the 300 per key budget) and 429 aware (Retry-After honoured, capped).
// - Image fetch is https-only on an allowlisted host (true subdomains), no userinfo, at most 2 redirects to allowed hosts.

const MAX_RETRIES_429 = 5;
const MAX_RETRY_AFTER_S = 120;
const MAX_REDIRECTS = 2;

export class ApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const normHost = (h) => {
  const v = String(h).trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v) ? v : null;
};

function normOrigin(o) {
  try {
    const u = new URL(String(o).trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    if (u.pathname !== "/" || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Read a body with a hard byte cap, checking the declared length first. */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError("too_large", "response too large");
  const chunks = [];
  let total = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiError("too_large", "response too large");
      }
      chunks.push(value);
    }
  } else {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.byteLength > maxBytes) throw new ApiError("too_large", "response too large");
    return b;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function createApiClient(opts) {
  const {
    baseUrl,
    key,
    perMinute = 200,
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    allowInsecure = false,
    testImageOrigins = [],
    fetch: doFetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts ?? {};

  if (!key || typeof key !== "string") throw new Error("api key required");
  if (!(perMinute > 0)) throw new Error("perMinute must be positive");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("invalid baseUrl");
  }
  if (base.username || base.password) throw new Error("baseUrl must not contain credentials");
  if (base.protocol !== "https:" && !(allowInsecure && base.protocol === "http:")) throw new Error("baseUrl must be https");

  // HARNESS ONLY: exact origins for mock-mode http image URLs. Inert by default.
  const testOrigins = new Set();
  if (testImageOrigins.length > 0) {
    if (globalThis.process?.env?.NODE_ENV === "production") throw new Error("testImageOrigins is not allowed in production");
    if (!allowInsecure) throw new Error("testImageOrigins requires allowInsecure");
    for (const o of testImageOrigins) {
      const n = normOrigin(o);
      if (!n) throw new Error("invalid test image origin");
      testOrigins.add(n);
    }
  }

  const interval = 60_000 / perMinute;
  let nextAt = 0;
  /** Reserve the next slot synchronously, so concurrent callers are spaced too. */
  async function pace() {
    const t = now();
    const at = Math.max(t, nextAt);
    nextAt = at + interval;
    if (at > t) await sleep(at - t);
  }
  function backoff(ms) {
    nextAt = Math.max(nextAt, now() + ms);
  }

  const withTimeout = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined);

  async function get(path, params) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new ApiError("bad_request", "invalid path");
    }
    const url = new URL(base.origin + path);
    if (url.origin !== base.origin) throw new ApiError("bad_request", "invalid path");
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    // errors name the path only: never the query (a title search) and never the key
    const where = `GET ${url.pathname}`;

    let rateRetries = 0;
    let netRetried = false;
    for (;;) {
      await pace();
      let res;
      try {
        res = await doFetch(url, {
          headers: { authorization: `Bearer ${key}`, accept: "application/json" },
          redirect: "manual", // never forward the bearer to a redirect target
          signal: withTimeout(),
        });
      } catch {
        if (!netRetried) {
          netRetried = true;
          continue;
        }
        throw new ApiError("network", `${where}: network error`);
      }
      if (res.status === 429) {
        await res.body?.cancel?.().catch(() => {});
        if (rateRetries >= MAX_RETRIES_429) throw new ApiError("rate_limited", `${where}: rate limited after ${MAX_RETRIES_429} retries`, 429);
        rateRetries++;
        const ra = res.headers.get("retry-after");
        const s = ra && /^\d{1,6}$/.test(ra) ? Math.min(Number(ra), MAX_RETRY_AFTER_S) : 60;
        backoff(s * 1000);
        continue; // pace() sleeps out the backoff, then spaces the retry at the configured rate
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel?.().catch(() => {});
        throw new ApiError(res.status === 404 ? "not_found" : "http", `${where}: HTTP ${res.status}`, res.status);
      }
      const bytes = await readCapped(res, maxBytes);
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ApiError("bad_json", `${where}: invalid JSON`, res.status);
      }
    }
  }

  async function rawFetchImage(rawUrl, allowedHosts) {
    const hosts = (allowedHosts ?? []).map(normHost);
    if (hosts.length === 0 || hosts.includes(null)) throw new ApiError("bad_request", "invalid image host allowlist");

    const allowed = (raw) => {
      let u;
      try {
        u = new URL(raw);
      } catch {
        return null;
      }
      if (u.username || u.password) return null;
      if (testOrigins.has(u.origin)) return u;
      if (u.protocol !== "https:" || u.port !== "") return null;
      return hosts.some((a) => u.hostname === a || u.hostname.endsWith("." + a)) ? u : null;
    };

    let u = allowed(rawUrl);
    if (!u) throw new ApiError("blocked_image", "image URL not allowed");
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await doFetch(u, { redirect: "manual", signal: withTimeout() }); // no Authorization: the image host is not the API
      } catch {
        throw new ApiError("network", "image fetch failed: network error");
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel?.().catch(() => {});
        const loc = res.headers.get("location");
        if (hop >= MAX_REDIRECTS || !loc) throw new ApiError("blocked_image", "image redirect refused");
        let next;
        try {
          next = new URL(loc, u).href;
        } catch {
          throw new ApiError("blocked_image", "image redirect refused");
        }
        u = allowed(next);
        if (!u) throw new ApiError("blocked_image", "image redirect target not allowed");
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel?.().catch(() => {});
        throw new ApiError("http", `image fetch failed: HTTP ${res.status}`, res.status);
      }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        await res.body?.cancel?.().catch(() => {});
        throw new ApiError("bad_content_type", "image fetch failed: not an image");
      }
      return { bytes: await readCapped(res, maxBytes), contentType };
    }
  }

  return { get, rawFetchImage };
}
