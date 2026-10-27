#!/usr/bin/env node
// AVBang push tool for Stash (phase 28.1, D-07). Reads scenes from your Stash over its local GraphQL API, finds
// each one in the AVBang catalogue from its file name (GET /v1/match), and writes the metadata back with sceneUpdate:
// title, code, date, details, urls, studio, performers, tags and the cover.
//
//   AVBANG_API_KEY=av_live_... node push.mjs                  dry run: prints the plan, writes nothing (default)
//   AVBANG_API_KEY=av_live_... node push.mjs --apply          write the changes
//
// Options:  --stash-url URL (default http://localhost:9999)   --api-base URL (default https://api.avbang.net/v1)
//           --apply  --overwrite  --allow-blurred  --scene-id N  --limit N
// Environment:  AVBANG_API_KEY (required)   STASH_API_KEY (only if Stash needs one)
//               AVBANG_IMAGE_HOSTS (cover hosts, default avbang.net)   AVBANG_ALLOW_INSECURE=1 (http API base, tests only)
//
// Safety: nothing is written without --apply. Without --overwrite only empty title, date, details and studio are
// filled, the code is set when empty, and performers, tags and urls are added to (nothing is removed). With
// --overwrite those fields are replaced by the catalogue values. Scenes whose file name matches no title or several
// are skipped and listed, never guessed. Nothing is ever deleted. A re-run changes nothing: studios, performers
// and tags are looked up by name before they are created, and a scene that already has the code is left alone
// (the cover is only fetched while the code is empty, or with --overwrite when the code changes; clear the code
// in Stash to fetch a cover again).
//
// Keys: use a dedicated AVBang key for this tool (an account holds five; revoke it in Settings). Keys are read from
// the environment only, never from arguments or files, and are never printed.
//
// Cover (D-06): this tool downloads the cover bytes itself from the signed URL (valid for 15 minutes), holds them in
// memory only, sends them to Stash as a data URI, writes nothing to disk and keeps no URL. Stash then stores the cover.
// Cover URLs are fetched only over https from an allowed host, with no Authorization header.
import { pathToFileURL } from "node:url";
import { ApiError, createApiClient } from "../lib/api-client.mjs";
import { StashError, createGraphql, findScenes, resolveNames, updateScene } from "./lib/graphql.mjs";

const CODE = /^[A-Za-z0-9-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_TYPE = /^image\/[a-z0-9.+-]{1,40}$/;
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200); // terminal-safe log text
const empty = (v) => v == null || String(v).trim() === "";
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { stashUrl: "http://localhost:9999", apiBase: "https://api.avbang.net/v1", apply: false, overwrite: false, allowBlurred: false, sceneId: undefined, limit: Infinity };
  const takes = new Set(["--stash-url", "--api-base", "--scene-id", "--limit"]);
  for (let i = 0; i < argv.length; i++) {
    let [flag, val] = argv[i].split(/=(.*)/s, 2);
    if (flag === "--apply") o.apply = true;
    else if (flag === "--overwrite") o.overwrite = true;
    else if (flag === "--allow-blurred") o.allowBlurred = true;
    else if (takes.has(flag)) {
      if (val === undefined) val = argv[++i];
      if (val === undefined) throw new UsageError(`${flag} needs a value`);
      if (flag === "--stash-url") o.stashUrl = val;
      else if (flag === "--api-base") o.apiBase = val;
      else {
        if (!/^\d{1,9}$/.test(val) || (flag === "--limit" && Number(val) < 1)) throw new UsageError(`${flag} needs a positive whole number`);
        if (flag === "--scene-id") o.sceneId = val;
        else o.limit = Number(val);
      }
    } else throw new UsageError(`unknown option ${clean(flag)} (keys are read from the environment, not options)`); // never echo a value
  }
  return o;
}

/** Last path segment, for Unix and Windows separators. */
export const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? "";

/**
 * Pure diff of one scene against a catalogue title. ids = resolved Stash ids (null = does not exist yet).
 * Returns { input, changes }: input is the sceneUpdate payload (valid when every id is resolved), changes names what differs.
 */
export function diffScene(scene, t, ids, { overwrite, cover }) {
  const input = { id: scene.id };
  const changes = [];
  const fill = (cur) => overwrite || empty(cur);

  if (t.title && fill(scene.title) && t.title !== scene.title) { input.title = t.title; changes.push("title"); }
  if (t.code && fill(scene.code) && t.code !== scene.code) { input.code = t.code; changes.push("code"); }
  if (DATE.test(t.releaseDate ?? "") && fill(scene.date) && t.releaseDate !== scene.date) { input.date = t.releaseDate; changes.push("date"); }
  if (t.synopsis && fill(scene.details) && t.synopsis !== scene.details) { input.details = t.synopsis; changes.push("details"); }

  const cur = scene.urls ?? [];
  if (typeof t.url === "string" && t.url.startsWith("https://")) {
    const want = overwrite ? [t.url] : cur.includes(t.url) ? cur : [...cur, t.url];
    if (!same(want, cur)) { input.urls = want; changes.push("urls"); }
  }

  if (t.studio?.name && fill(scene.studio?.name)) {
    if (ids.studio === null) changes.push("studio (new)");
    else if (ids.studio !== scene.studio?.id) { input.studio_id = ids.studio; changes.push("studio"); }
  }

  for (const [field, key, existing] of [["performers", "performer_ids", scene.performers ?? []], ["tags", "tag_ids", scene.tags ?? []]]) {
    const want = ids[field];
    if (!want?.length) continue;
    const have = existing.map((x) => x.id);
    const known = want.filter((x) => x !== null);
    const fresh = want.length - known.length; // not in Stash yet (dry run only; apply creates them first)
    const next = overwrite ? known : [...have, ...known.filter((x) => !have.includes(x))];
    if (fresh > 0) changes.push(`${field} (${fresh} new)`);
    else if (!same(next, have)) { input[key] = next; changes.push(field); }
  }

  if (cover) { input.cover_image = cover; changes.push("cover"); }
  return { input, changes };
}

/** Pick the image to download: the clear cover first, a blurred one only with allowBlurred. */
export function pickCover(images, { allowBlurred }) {
  const covers = (images?.images ?? []).filter((i) => i.kind === "cover_front");
  const pick = covers.find((i) => i.access === "clear") ?? (allowBlurred ? covers[0] : null);
  if (!pick) return { reason: covers.length ? "cover only available blurred (use --allow-blurred)" : "no cover image" };
  const urls = pick.urls.filter((u) => u.width <= 1280).sort((a, b) => b.width - a.width);
  const url = (urls[0] ?? pick.urls[0])?.url;
  return url ? { url } : { reason: "no cover image" };
}

export async function run({ argv, env = {}, fetch: doFetch = globalThis.fetch, log = console.log, sleep } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    log(`push: ${e.message}`);
    return 2;
  }
  const apiKey = env.AVBANG_API_KEY;
  if (!apiKey) {
    log("push: AVBANG_API_KEY is not set");
    return 1;
  }
  const insecure = env.AVBANG_ALLOW_INSECURE === "1";
  let api;
  let gql;
  try {
    api = createApiClient({
      baseUrl: o.apiBase,
      key: apiKey,
      allowInsecure: insecure,
      testImageOrigins: (env.AVBANG_TEST_IMAGE_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      fetch: doFetch,
      ...(sleep ? { sleep } : {}),
    });
    gql = createGraphql({ url: o.stashUrl, apiKey: env.STASH_API_KEY, fetch: doFetch });
  } catch (e) {
    log(`push: ${clean(String(e.message).replaceAll(apiKey, "[key]"))}`);
    return 1;
  }
  const hosts = (env.AVBANG_IMAGE_HOSTS ?? "avbang.net").split(",").map((s) => s.trim()).filter(Boolean);
  const cache = new Map();
  const stats = { scenes: 0, matched: 0, updated: 0, unchanged: 0, skipped: {} };
  const skip = (scene, reason) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    log(`  skipped: ${reason}`);
  };

  log(o.apply ? "push: APPLY mode, changes will be written" : "push: dry run, nothing will be written (use --apply to write)");
  try {
    for await (const scene of findScenes(gql, { sceneId: o.sceneId })) {
      if (stats.scenes >= o.limit) break;
      stats.scenes++;
      const file = basename(scene.files?.[0]?.path ?? "");
      log(`scene ${scene.id} "${clean(file)}"`);
      if (!file) { skip(scene, "scene has no file"); continue; }

      const m = await api.get("/v1/match", { filename: file.slice(0, 255) });
      const cands = Array.isArray(m?.matches) ? m.matches : [];
      if (cands.length === 0) { skip(scene, "no match"); continue; }
      if (cands.length > 1) { skip(scene, `ambiguous (${cands.length} candidates)`); continue; }
      if (cands[0].confidence !== "code" || !CODE.test(cands[0].code ?? "")) { skip(scene, "match is a title guess, not a code"); continue; }
      stats.matched++;

      let t;
      try {
        t = await api.get(`/v1/titles/${cands[0].code}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_found") { skip(scene, "title not found"); continue; }
        throw e;
      }

      // cover: only while the scene has no code yet (first fill), or with --overwrite when the code changes
      let cover = null;
      if (empty(scene.code) || (o.overwrite && scene.code !== t.code)) {
        try {
          const pick = pickCover(await api.get(`/v1/titles/${cands[0].code}/images`), o);
          if (pick.reason) log(`  cover skipped: ${pick.reason}`);
          else {
            const img = await api.rawFetchImage(pick.url, hosts);
            if (!IMAGE_TYPE.test(img.contentType)) throw new ApiError("bad_content_type", "bad image type");
            cover = `data:${img.contentType};base64,${Buffer.from(img.bytes).toString("base64")}`;
          }
        } catch (e) {
          if (!(e instanceof ApiError) || e.code === "rate_limited" || e.status === 401 || e.status === 403) throw e;
          log(`  cover skipped: ${e.code}`); // a failed cover never blocks the other fields
        }
      }

      const create = o.apply;
      const ids = {
        studio: t.studio?.name && (o.overwrite || !scene.studio) ? (await resolveNames(gql, "studio", [t.studio.name], { create, cache }))[0] : undefined,
        performers: await resolveNames(gql, "performer", (t.performers ?? []).map((p) => p.name), { create, cache }),
        tags: await resolveNames(gql, "tag", (t.tags ?? []).map((x) => x.name), { create, cache }),
      };
      const { input, changes } = diffScene(scene, t, ids, { overwrite: o.overwrite, cover });
      if (changes.length === 0) { stats.unchanged++; log("  unchanged"); continue; }
      if (!o.apply) { log(`  would update ${t.code}: ${changes.join(", ")}`); continue; }
      await updateScene(gql, input);
      stats.updated++;
      log(`  updated ${t.code}: ${changes.join(", ")}`);
    }
  } catch (e) {
    if (e instanceof StashError || e instanceof ApiError) {
      log(`push: stopped: ${clean(String(e.message).replaceAll(apiKey, "[key]"))}`);
      return 1;
    }
    throw e;
  }
  const skipped = Object.entries(stats.skipped).map(([k, v]) => `${k}: ${v}`);
  log(`done: ${stats.scenes} scenes, ${stats.matched} matched, ${stats.updated} updated, ${stats.unchanged} unchanged, skipped ${skipped.length ? skipped.join("; ") : "none"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
