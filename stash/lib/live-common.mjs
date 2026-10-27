// Shared Docker Stash bootstrap for live-scrape.mjs and live-push.mjs (phase 28.1, D-08). Test use only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerHostArgs, freePort, poll, run, startContainer, waitForHttp } from "../../lib/harness.mjs";

export const STASH_IMAGE = "stashapp/stash:v0.31.1";

/** Boot Stash, run the headless setup, create 1-second mp4 files named `files` under /data, scan, wait for the scenes. */
export async function bootStash({ files, scrapers = [] }) {
  const cfg = mkdtempSync(join(tmpdir(), "avbang-stash-"));
  mkdirSync(join(cfg, "scrapers"));
  for (const [name, content] of scrapers) writeFileSync(join(cfg, "scrapers", name), content);
  const port = await freePort();
  const c = startContainer("avbang-stash", STASH_IMAGE, [
    "-p", `127.0.0.1:${port}:9999`,
    "--mount", `type=bind,source=${cfg},target=/root/.stash`,
    ...dockerHostArgs(),
  ]);
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}/healthz`, { deadlineMs: 120_000 });

  const gql = async (query, variables) => {
    const r = await fetch(`${url}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    if (j.errors?.length) throw new Error(`graphql: ${j.errors.map((e) => e.message).join("; ").slice(0, 400)}`);
    return j.data;
  };

  await gql(`mutation { setup(input:{configLocation:"/root/.stash/config.yml", stashes:[{path:"/data", excludeVideo:false, excludeImage:true}],
    generatedLocation:"/generated", cacheLocation:"/cache", blobsLocation:"/blobs", storeBlobsInDatabase:true,
    databaseFile:"/root/.stash/stash-go.sqlite"}) }`);
  // the config is read after setup; wait for a normal query to answer
  await poll(async () => (await gql(`{ systemStatus { status } }`)).systemStatus?.status === "OK", { deadlineMs: 120_000, intervalMs: 1500 });

  run("docker", ["exec", c.name, "mkdir", "-p", "/data"]);
  for (const f of files) {
    const r = run("docker", ["exec", c.name, "ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-y", `/data/${f}`]);
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.out.slice(0, 300)}`);
  }
  await gql(`mutation { metadataScan(input:{}) }`);
  const ok = await poll(async () => (await gql(`{ findScenes { count } }`)).findScenes.count >= files.length, { deadlineMs: 180_000, intervalMs: 3000 });
  if (!ok) throw new Error(`scan did not find ${files.length} scenes`);
  return { container: c, url, gql, cfg };
}

/** Scene ids by file basename. */
export async function sceneIdsByName(gql) {
  const d = await gql(`{ findScenes(filter:{per_page:-1}) { scenes { id files { path } } } }`);
  const out = {};
  for (const s of d.findScenes.scenes) out[s.files[0].path.split("/").pop()] = s.id;
  return out;
}
