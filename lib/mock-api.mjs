// Mock AVBang API for the phase 28.1 live scripts and tests. Single owner of every fixture.
// Zero dependencies. Never contacts the real API.
import { createServer } from "node:http";

// A real 64x96 lossy WebP (92 bytes), served as the poster for every image URL.
export const WEBP = Buffer.from(
  "UklGRlQAAABXRUJQVlA4IEgAAABwBACdASpAAGAAPtFosFKoJiSioWgBABoJaQDWIoAACzIkSJPA7nZwzs2aIAD+6mX/9tmD6DGH+HLHsF5jMG222+oZf2bIAAA=",
  "base64",
);

const ref = (name) => ({ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name });

function mk(code, title, releaseDate, runtimeMin, studio, performer, tag, extra = {}) {
  const slug = code.toLowerCase();
  return {
    code,
    slug,
    title,
    titleOriginal: null,
    releaseDate,
    runtimeMin,
    synopsis: `Synopsis for ${title}.`,
    studio: ref(studio),
    performers: [ref(performer)],
    tags: [ref(tag)],
    cover: `https://avbang.net/img/${slug}.webp`,
    url: `https://avbang.net/t/${slug}`,
    ...extra,
  };
}

/** Title and image fixtures. images(origins) builds the strict ImageList; urls are plain mock URLs. */
export const FIXTURES = {
  "STAR-489": {
    title: mk("STAR-489", "Office overtime", "2026-04-12", 142, "Aurora", "Aya Mizuno", "Office"),
    access: "clear",
    origin: "image",
  },
  "STAR-490": {
    title: mk("STAR-490", "Night shift", "2026-05-03", 118, "Aurora", "Rin Sato", "Night"),
    access: "blurred",
    origin: "image",
  },
  "STAR-491": {
    title: mk("STAR-491", "Foreign cover", "2026-06-21", 130, "Borealis", "Mei Tanaka", "Foreign"),
    access: "clear",
    origin: "foreign",
  },
};

const num = (code) => Number(code.split("-")[1]);

export function imageList(code, origins) {
  const f = FIXTURES[code];
  const base = f.origin === "foreign" ? origins.foreignImageOrigin : origins.imageOrigin;
  return {
    code,
    images: [
      {
        id: num(code),
        kind: "cover_front",
        explicit: true,
        access: f.access,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        urls: [640, 1280].map((width) => ({ width, url: `${base}/img/${code}/${width}.webp` })),
      },
    ],
  };
}

export const summary = (t) => ({
  code: t.code, slug: t.slug, title: t.title, releaseDate: t.releaseDate, studio: t.studio, cover: t.cover, url: t.url,
});

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

/**
 * options.apiKey: the exact Bearer value required (default: a throwaway).
 * options.imageBase: host name placed in image URLs (default host.docker.internal; tools on the host pass 127.0.0.1).
 * options.apiBind: bind address of the API listener (default 127.0.0.1; a containerised provider needs 0.0.0.0).
 * options.bind: bind address of the image listeners (default 0.0.0.0 so containers can reach them).
 */
export async function startMock(options = {}) {
  const apiKey = options.apiKey ?? "av_live_mockthrowawaykey0000000000";
  const imageBase = options.imageBase ?? "host.docker.internal";
  const bind = options.bind ?? "0.0.0.0";
  const log = [];
  const foreignLog = [];
  const imageLog = [];
  const switches = { n429: 0, n401: 0 };
  const origins = {};

  const api = createServer((req, res) => {
    const u = new URL(req.url, "http://mock.invalid");
    const auth = req.headers.authorization;
    log.push({ method: req.method, url: req.url, hasAuth: auth !== undefined });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (switches.n401 > 0 || auth !== `Bearer ${apiKey}`) {
      if (switches.n401 > 0) switches.n401--;
      return send(401, { type: "about:blank", title: "Unauthorized", status: 401, code: "invalid_api_key" });
    }
    if (switches.n429 > 0) {
      switches.n429--;
      return send(429, { type: "about:blank", title: "Too Many Requests", status: 429 }, { "retry-after": "7" });
    }
    const m = /^\/v1\/titles\/([A-Za-z0-9-]+)(\/images)?$/.exec(u.pathname);
    if (m) {
      const code = m[1].toUpperCase();
      const f = FIXTURES[code];
      if (!f) return send(404, { type: "about:blank", title: "Not Found", status: 404 });
      return send(200, m[2] ? imageList(code, origins) : f.title);
    }
    if (u.pathname === "/v1/match") {
      const filename = (u.searchParams.get("filename") ?? "").toUpperCase();
      const title = (u.searchParams.get("title") ?? "").trim().toLowerCase();
      const codes = Object.keys(FIXTURES)
        .filter((c) => filename.includes(c))
        .sort((a, b) => filename.indexOf(a) - filename.indexOf(b));
      let matches = codes.map((c) => ({ code: c, confidence: "code", title: summary(FIXTURES[c].title) }));
      if (!codes.length && title) {
        // year filters nothing in the mock
        matches = Object.keys(FIXTURES)
          .filter((c) => {
            const t = FIXTURES[c].title.title.toLowerCase();
            return title.includes(t) || t.includes(title);
          })
          .map((c) => ({ code: c, confidence: "search", title: summary(FIXTURES[c].title) }));
      }
      return send(200, { matches: matches.slice(0, 5) });
    }
    return send(404, { type: "about:blank", title: "Not Found", status: 404 });
  });

  const imageServer = (sink) =>
    createServer((req, res) => {
      sink.push({ method: req.method, url: req.url });
      if (/^\/img\/[A-Za-z0-9-]+\/\d+\.webp$/.test(req.url ?? "")) {
        res.writeHead(200, { "content-type": "image/webp", "content-length": WEBP.length });
        return res.end(WEBP);
      }
      res.writeHead(404);
      res.end();
    });
  const img = imageServer(imageLog);
  const foreign = imageServer(foreignLog);

  const [apiPort, imgPort, foreignPort] = await Promise.all([
    listen(api, options.apiBind ?? "127.0.0.1"),
    listen(img, bind),
    listen(foreign, bind),
  ]);
  origins.imageOrigin = `http://${imageBase}:${imgPort}`;
  origins.foreignImageOrigin = `http://${imageBase}:${foreignPort}`;

  return {
    apiKey,
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    apiOriginFromContainer: `http://host.docker.internal:${apiPort}`,
    imageOrigin: origins.imageOrigin,
    foreignImageOrigin: origins.foreignImageOrigin,
    log,
    imageLog,
    foreignLog,
    expect429: (n) => { switches.n429 = n; },
    expect401: (n) => { switches.n401 = n; },
    close: () =>
      Promise.all([api, img, foreign].map((s) => new Promise((ok) => { s.close(() => ok()); s.closeAllConnections(); }))).then(() => {}),
  };
}
