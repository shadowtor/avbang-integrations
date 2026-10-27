// AVBang Plex provider, self-host container entry (phase 28.1, D-01).
// Run with node 24+ (types are stripped, no build):  node integrations/plex/server.ts
// The API key lives only in the AVBANG_API_KEY environment variable. The URL you register in Plex
// carries no secret. The key is never logged and never placed in a URL.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createProvider, ProviderError } from "./provider.ts";
import type { Backend, ImageList, MatchBody, MatchQuery, Title } from "./provider.ts";

export const MAX_BODY = 64 * 1024;
export const MAX_UPSTREAM = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export class ConfigError extends Error {}

export type Config = {
  apiKey: string;
  apiBase: string;
  imageHosts: string[];
  testImageOrigins: string[];
  port: number;
  bind: string;
};

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Pure. Throws ConfigError with a one-line message that never contains the key. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.AVBANG_API_KEY ?? "";
  if (!apiKey) throw new ConfigError("AVBANG_API_KEY is required");
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new ConfigError("AVBANG_API_KEY has invalid characters");
  const insecure = env.AVBANG_ALLOW_INSECURE === "1";
  let base: URL;
  try {
    base = new URL(env.AVBANG_API_BASE || "https://api.avbang.net/v1");
  } catch {
    throw new ConfigError("AVBANG_API_BASE is not a valid URL");
  }
  if (base.username || base.password) throw new ConfigError("AVBANG_API_BASE must not contain credentials");
  if (base.search || base.hash) throw new ConfigError("AVBANG_API_BASE must not contain a query or fragment");
  if (base.protocol !== "https:" && !(insecure && base.protocol === "http:")) {
    throw new ConfigError("AVBANG_API_BASE must be https");
  }
  const testImageOrigins = list(env.AVBANG_TEST_IMAGE_ORIGINS);
  if (testImageOrigins.length > 0) {
    if (env.NODE_ENV === "production") throw new ConfigError("AVBANG_TEST_IMAGE_ORIGINS is not allowed when NODE_ENV=production");
    if (!insecure) throw new ConfigError("AVBANG_TEST_IMAGE_ORIGINS requires AVBANG_ALLOW_INSECURE=1");
  }
  const port = env.PORT === undefined || env.PORT === "" ? 8787 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PORT is invalid");
  const imageHosts = list(env.AVBANG_IMAGE_HOSTS);
  return {
    apiKey,
    apiBase: base.href.replace(/\/+$/, ""),
    imageHosts: imageHosts.length ? imageHosts : ["avbang.net"],
    testImageOrigins,
    port,
    bind: env.BIND || "0.0.0.0",
  };
}

type Fetch = typeof fetch;

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new ProviderError(502, null, "upstream response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new ProviderError(502, null, "upstream response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function httpBackend(config: Config, fetchImpl: Fetch = fetch): Backend {
  async function get<T>(path: string, params?: URLSearchParams): Promise<T | null> {
    const url = config.apiBase + path + (params && params.size ? `?${params}` : "");
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
        redirect: "error", // never forward the key to a redirect target
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError(503, "30", "upstream unreachable");
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new ProviderError(429, res.headers.get("retry-after"));
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new ProviderError(503, res.headers.get("retry-after"));
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError(502, null, `upstream status ${res.status}`);
    }
    const text = await readCapped(res, MAX_UPSTREAM);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(502, null, "upstream returned invalid JSON");
    }
  }
  return {
    match(q: MatchQuery) {
      const p = new URLSearchParams();
      if (q.filename) p.set("filename", q.filename);
      if (q.title) p.set("title", q.title);
      if (q.year) p.set("year", String(q.year));
      return get<MatchBody>("/match", p);
    },
    title: (code: string) => get<Title>(`/titles/${encodeURIComponent(code)}`),
    images: (code: string) => get<ImageList>(`/titles/${encodeURIComponent(code)}/images`),
  };
}

export type Deps = { fetch?: Fetch; log?: (line: string) => void };

/** Resolves once listening. Logs only method, path and status. */
export function startServer(config: Config, deps: Deps = {}): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const provider = createProvider(httpBackend(config, deps.fetch), {
    imageHosts: config.imageHosts,
    testImageOrigins: config.testImageOrigins,
  });
  const server = createServer((req, res) => {
    const rawPath = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";
    const safePath = rawPath.replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
    const done = (status: number, body: string, headers: Record<string, string> = {}, close = false) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", ...(close ? { connection: "close" } : {}), ...headers });
      res.end(body);
      log(`${method.replace(/[^A-Z]/g, "?").slice(0, 10)} ${safePath} ${status}`);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        done(413, '{"error":"payload too large"}', {}, true);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", async () => {
      if (over) return;
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const hasBody = method !== "GET" && method !== "HEAD" && body !== undefined;
      const r = await provider.handle(
        new Request("http://provider.invalid/", {
          method,
          headers: { "content-type": req.headers["content-type"] ?? "application/json" },
          ...(hasBody ? { body: new Uint8Array(body) } : {}),
        }),
        rawPath,
      );
      const h: Record<string, string> = {};
      r.headers.forEach((v, k) => (h[k] = v));
      done(r.status, await r.text(), h);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => {
      const a = server.address();
      resolve({
        server,
        port: typeof a === "object" && a ? a.port : config.port,
        close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
      });
    });
  });
}

if (import.meta.main) {
  try {
    const config = loadConfig(process.env);
    const s = await startServer(config);
    console.log(`avbang plex provider listening on ${config.bind}:${s.port}`);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void s.close().then(() => process.exit(0)));
  } catch (e) {
    console.error(e instanceof ConfigError ? `config error: ${e.message}` : "failed to start");
    process.exit(1);
  }
}
