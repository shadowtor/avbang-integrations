// AVBang Plex Custom Metadata Provider core (phase 28.1, D-01).
//
// One dependency-free module with erasable TypeScript only (no enums, namespaces or parameter
// properties), so Node strips the types and both the self-host container (server.ts) and the hosted
// route import it as is. The data source is an injected Backend.
//
// Images (D-06 for Plex): this module relays a signed https URL from /v1/titles/{code}/images and
// nothing more. It never fetches or stores an image; Plex downloads and keeps its own copy.

const DEFAULT_ID = "tv.plex.agents.custom.avbang.movie";
const KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FILENAME = 512;
const MAX_TITLE = 200;
const MAX_MATCHES = 5;

export type TitleRef = { slug: string; name: string };
export type TitleSummary = {
  code: string | null;
  slug: string;
  title: string;
  releaseDate: string | null;
  studio: TitleRef | null;
  cover: string | null;
  url: string;
};
export type Title = TitleSummary & {
  titleOriginal: string | null;
  runtimeMin: number | null;
  synopsis: string | null;
  performers: TitleRef[];
  tags: TitleRef[];
};
export type ImageList = {
  code: string | null;
  images: {
    id: number;
    kind: string;
    explicit: boolean;
    access: "clear" | "blurred";
    expiresAt: string | null;
    urls: { width: number; url: string }[];
  }[];
};
export type MatchBody = { matches: { code: string; confidence: "code" | "search"; title: TitleSummary }[] };
export type MatchQuery = { filename?: string; title?: string; year?: number };

export interface Backend {
  match(q: MatchQuery): Promise<MatchBody | null>;
  title(code: string): Promise<Title | null>;
  images(code: string): Promise<ImageList | null>;
}

export class ProviderError extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter?: string | null, message?: string) {
    super(message ?? `backend ${status}`);
    this.status = status;
    this.retryAfter = retryAfter ?? null;
  }
}

export type ProviderConfig = {
  identifier?: string;
  title?: string;
  version?: string;
  /** Hosts (or parents of subdomains) an https image URL may point at. */
  imageHosts?: string[];
  /**
   * HARNESS ONLY. Exact origins (scheme, host, port; no wildcard, no suffix) accepted in addition to
   * imageHosts so mock-mode http image URLs pass. Empty by default (inert). createProvider throws when
   * it is non-empty and NODE_ENV is production. Never set by production code paths.
   */
  testImageOrigins?: string[];
};

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function container(identifier: string, items: unknown[] = []) {
  return { MediaContainer: { offset: 0, totalSize: items.length, identifier, size: items.length, Metadata: items } };
}

/** Normalise an allowlist entry or test origin; null when it is not a bare host / origin. */
function normHost(h: string): string | null {
  const v = h.trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v) ? v : null;
}

function normOrigin(o: string): string | null {
  try {
    const u = new URL(o.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    if (u.pathname !== "/" || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function createProvider(backend: Backend, config: ProviderConfig = {}) {
  const identifier = config.identifier ?? DEFAULT_ID;
  if (!/^tv\.plex\.agents\.custom\.[A-Za-z0-9.]+$/.test(identifier)) throw new Error("invalid provider identifier");
  const hosts = (config.imageHosts ?? ["avbang.net"]).map(normHost);
  if (hosts.includes(null)) throw new Error("invalid image host");
  const allowedHosts = hosts as string[];
  const testIn = config.testImageOrigins ?? [];
  const testOrigins = new Set<string>();
  if (testIn.length > 0) {
    if (globalThis.process?.env?.NODE_ENV === "production") throw new Error("testImageOrigins is not allowed in production");
    for (const o of testIn) {
      const n = normOrigin(o);
      if (!n) throw new Error("invalid test image origin");
      testOrigins.add(n);
    }
  }

  function imageOk(raw: string): boolean {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.username || u.password) return false;
    if (testOrigins.has(u.origin)) return true;
    if (u.protocol !== "https:" || u.port !== "") return false;
    const h = u.hostname;
    return allowedHosts.some((a) => h === a || h.endsWith("." + a));
  }

  function poster(list: ImageList | null): string | null {
    const imgs = list?.images ?? [];
    const img = imgs.find((i) => i.kind === "cover_front") ?? imgs.find((i) => i.kind === "jacket") ?? imgs[0];
    if (!img || img.urls.length === 0) return null;
    const u = img.urls.find((x) => x.width === 640) ?? img.urls.reduce((a, b) => (b.width > a.width ? b : a));
    return imageOk(u.url) ? u.url : null;
  }

  const year = (d: string | null) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);

  function summaryItem(t: TitleSummary & { code: string }) {
    return {
      ratingKey: t.code,
      key: `/library/metadata/${t.code}`,
      guid: `${identifier}://movie/${t.code}`,
      type: "movie",
      title: t.title,
      ...(t.releaseDate ? { originallyAvailableAt: t.releaseDate } : {}),
      ...(year(t.releaseDate) ? { year: year(t.releaseDate) } : {}),
      ...(t.studio ? { studio: t.studio.name } : {}),
      // Plex Metadata Providers spec: explicit content must carry isAdult. Every AVBang title is adult.
      isAdult: true,
    };
  }

  function fullItem(t: Title & { code: string }, img: string | null) {
    return {
      ...summaryItem(t),
      ...(t.titleOriginal ? { originalTitle: t.titleOriginal } : {}),
      ...(t.synopsis ? { summary: t.synopsis } : {}),
      ...(t.runtimeMin ? { duration: t.runtimeMin * 60000 } : {}),
      Genre: t.tags.map((x) => ({ tag: x.name })),
      Role: t.performers.map((x) => ({ tag: x.name })),
      ...(img ? { Image: [{ type: "coverPoster", url: img }] } : {}),
    };
  }

  const definition = () => ({
    MediaProvider: {
      identifier,
      title: config.title ?? "AVBang",
      version: config.version ?? "1.0.0",
      Types: [{ type: 1, Scheme: [{ scheme: identifier }] }],
      Feature: [
        { type: "metadata", key: "/library/metadata" },
        { type: "match", key: "/library/metadata/matches" },
      ],
    },
  });

  const notFound = () => json(container(identifier), 404);
  const bad = () => json(container(identifier), 400);

  async function matches(req: Request): Promise<Response> {
    let b: unknown;
    try {
      b = await req.json();
    } catch {
      return bad();
    }
    if (typeof b !== "object" || b === null) return bad();
    const o = b as Record<string, unknown>;
    if (o.type !== 1) return bad();
    const q: MatchQuery = {};
    if (o.filename !== undefined) {
      if (typeof o.filename !== "string" || o.filename.length > MAX_FILENAME) return bad();
      q.filename = o.filename;
    }
    if (o.title !== undefined) {
      if (typeof o.title !== "string" || o.title.length > MAX_TITLE) return bad();
      q.title = o.title;
    }
    if (o.year !== undefined && o.year !== null && o.year !== "") {
      const y = Number(o.year);
      if (!Number.isInteger(y) || y < 1000 || y > 9999) return bad();
      q.year = y;
    }
    if (!q.filename && !q.title) return bad();
    // Spec: includeAdult is 1/0 and explicit results are filtered unless 1. PMS omits the field when the
    // library setting "Include adult content" is off (observed on 1.43.5: absent for default libraries,
    // 1 once enabled; it never sends 0). Filtering on absence would hide every title in a default library,
    // so only an explicit 0 is honoured. See 28.1-07-PROGRESS.md.
    if (o.includeAdult === 0 || o.includeAdult === "0") return json(container(identifier));
    const res = await backend.match(q);
    let list = res?.matches ?? [];
    if (list.some((m) => m.confidence === "code")) list = list.filter((m) => m.confidence === "code");
    const items = list
      .filter((m) => typeof m.code === "string" && KEY_RE.test(m.code))
      .slice(0, MAX_MATCHES)
      .map((m) => summaryItem({ ...m.title, code: m.code }));
    return json(container(identifier, items));
  }

  async function item(key: string): Promise<Response> {
    const [t, imgs] = await Promise.all([backend.title(key), backend.images(key)]);
    if (!t || !t.code || !KEY_RE.test(t.code)) return notFound();
    return json(container(identifier, [fullItem({ ...t, code: t.code }, poster(imgs))]));
  }

  async function route(req: Request, path: string): Promise<Response> {
    const p = path.split("?")[0].replace(/^\/{2,}/, "/");
    if (p === "/") return req.method === "GET" ? json(definition()) : notFound();
    if (p === "/library/metadata/matches") return req.method === "POST" ? matches(req) : notFound();
    const m = /^\/library\/metadata\/([^/]+)(\/extras)?$/.exec(p);
    if (!m || req.method !== "GET" || !KEY_RE.test(m[1]) || m[1] === "matches") return notFound();
    if (m[2]) return json(container(identifier));
    return item(m[1]);
  }

  return {
    identifier,
    async handle(req: Request, path: string): Promise<Response> {
      try {
        return await route(req, path);
      } catch (e) {
        if (e instanceof ProviderError && (e.status === 429 || e.status === 503)) {
          // digits only: the value comes from an upstream header, so no header injection or odd formats
          const ra = e.retryAfter && /^\d{1,6}$/.test(e.retryAfter) ? e.retryAfter : "30";
          return json(container(identifier), 503, { "retry-after": ra });
        }
        return json(container(identifier), e instanceof ProviderError ? 502 : 500);
      }
    },
  };
}
