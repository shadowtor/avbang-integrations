// Pure helpers for the Jellyfin NFO generator (phase 28.1, D-02). No I/O, no URLs, no key.

// XML 1.0 forbids most control characters (and U+FFFE/U+FFFF, lone surrogates); strip them, keep tab and newline.
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿\ud800-\udfff]/g;
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Escape, strip control characters, cap length (in code points). */
export function xmlText(value, max = 200) {
  const s = String(value ?? "").normalize("NFC").replace(BAD_XML, "");
  return [...s].slice(0, max).join("").replace(/[&<>"']/g, (c) => ESC[c]).trim();
}

const el = (tag, value, max) => {
  const t = xmlText(value, max);
  return t ? `<${tag}>${t}</${tag}>` : null;
};

export const CODE_RE = /^[A-Za-z0-9-]{1,32}$/;
const DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;

/** Movie NFO from a /v1/titles/{code} DTO. Empty or null fields are omitted. */
export function buildNfo(title) {
  if (!title || !CODE_RE.test(String(title.code))) throw new Error("title has no valid code");
  const date = DATE_RE.exec(String(title.releaseDate ?? ""));
  const runtime = Number.isInteger(title.runtimeMin) && title.runtimeMin > 0 && title.runtimeMin < 10_000 ? title.runtimeMin : null;
  const names = (list) => (Array.isArray(list) ? list.map((x) => x?.name) : []);
  const lines = [
    el("title", title.title, 200),
    el("originaltitle", title.titleOriginal, 200),
    el("plot", title.synopsis, 5000),
    date && `<premiered>${date[0]}</premiered>`,
    date && `<year>${date[1]}</year>`,
    runtime && `<runtime>${runtime}</runtime>`,
    el("studio", title.studio?.name, 200),
    ...names(title.tags).flatMap((n) => [el("genre", n), el("tag", n)]),
    ...names(title.performers).map((n) => {
      const t = xmlText(n);
      return t && `<actor><name>${t}</name><type>Actor</type></actor>`;
    }),
    `<uniqueid type="avbang" default="true">${xmlText(title.code, 32)}</uniqueid>`,
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<movie>\n${lines.map((l) => `  ${l}`).join("\n")}\n</movie>\n`;
}

/** True for an NFO this tool generated (the only kind --force may replace). */
export const isGenerated = (text) => /<uniqueid\s+type="avbang"/.test(String(text));

const EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
/** File extension for a real image content type, or null when unsupported. */
export const extForContentType = (ct) => EXT[String(ct).split(";")[0].trim().toLowerCase()] ?? null;

/** Poster path beside a video: '<video name>-poster.<ext>'. */
export function posterName(videoPath, ext) {
  if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new Error("bad extension");
  return videoPath.replace(/\.[^./\\]+$/, "") + `-poster.${ext}`;
}

/** NFO path beside a video: '<video name>.nfo'. */
export const nfoName = (videoPath) => videoPath.replace(/\.[^./\\]+$/, "") + ".nfo";

export const VIDEO_EXT = new Set([".mkv", ".mp4", ".avi", ".m4v", ".wmv", ".mov", ".ts"]);
