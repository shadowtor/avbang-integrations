// Real-API Plex runs (phase 28.1 plan 07, D-08). Called from live.mjs; not meant to be run directly.
//   hosted:    PMS is registered straight at https://api-test.avbang.net/v1/plex/{key} (no local server)
//   container: the built plex/Dockerfile image runs with the test key against api-test; a small logging proxy sits in
//              front of it so the user agent PMS sends can be recorded (research A14)
// Shape assertions only: lib/site.ts SITE_URL is the production origin, so api-test returns production image hosts whose
// grants were signed by the test secret. Whether PMS stores a poster is recorded, never asserted.
// The key never reaches stdout/stderr: output is passed through a redactor before it is written.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { loadSecret } from "../lib/env.mjs";
import { HOST_FROM_CONTAINER, dockerHostArgs, freePort, poll, reporter, run, startContainer, waitForHttp } from "../lib/harness.mjs";

const API = "https://api-test.avbang.net/v1";

export async function runReal(mode, PMS_IMAGE, ID) {
  const key = loadSecret("AVBANG_TEST_KEY");
  if (!key) {
    console.error("AVBANG_TEST_KEY is not set: add AVBANG_TEST_KEY=... to the .infra file or the environment");
    process.exitCode = 2;
    return;
  }
  for (const s of ["stdout", "stderr"]) {
    const w = process[s].write.bind(process[s]);
    process[s].write = (c, ...a) => w(typeof c === "string" ? c.replaceAll(key, "[KEY]").replace(/av_live_[A-Za-z0-9]{8,}/g, "[KEY]") : c, ...a);
  }
  const t = reporter();
  const auth = { authorization: `Bearer ${key}`, accept: "application/json" };
  const api = async (path) => {
    const r = await fetch(API + path, { headers: auth, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // Discover a real code (prefer one with a cover so the image path is exercised).
  const list = await api("/titles?limit=20");
  t.check("GET /v1/titles answers 200", list.status === 200, String(list.status));
  const rows = list.body?.data ?? [];
  const pick = rows.find((x) => x.cover) ?? rows[0];
  if (!pick) return void t.check("a title was discovered", false);
  const code = pick.code;
  const detail = (await api(`/titles/${encodeURIComponent(code)}`)).body ?? {};
  console.log(`INFO discovered code ${code} (cover ${pick.cover ? "present" : "absent"}, ${detail.performers?.length ?? 0} performers, ${detail.tags?.length ?? 0} tags)`);

  const dir = mkdtempSync(join(tmpdir(), "avbang-plex-real-"));
  writeFileSync(join(dir, `${code} real.mkv`), Buffer.alloc(4096, 0x1a));
  const token = randomBytes(16).toString("hex");
  let pms, provider, proxy, imageTag;
  const seenUa = new Set();
  try {
    let uri;
    if (mode === "hosted") {
      uri = `${API}/plex/${key}`;
    } else {
      const ctx = join(dirname(fileURLToPath(import.meta.url)), "..");
      imageTag = `avbang-plex-provider-real:${randomBytes(4).toString("hex")}`;
      const built = run("docker", ["build", "-f", join(ctx, "plex", "Dockerfile"), "-t", imageTag, ctx], { timeoutMs: 300_000 });
      t.check("image builds", built.code === 0, built.out.slice(-300));
      if (built.code !== 0) throw new Error("image build failed");
      const providerPort = await freePort();
      provider = startContainer("avbang-plex-provider-real", imageTag, [
        "-p", `127.0.0.1:${providerPort}:8787`,
        "-e", `AVBANG_API_KEY=${key}`,
        "-e", `AVBANG_API_BASE=${API}`,
        "-e", `PROVIDER_TOKEN=${token}`, // defence in depth: the proxy below is reachable from the Docker network
      ]);
      await waitForHttp(`http://127.0.0.1:${providerPort}/${token}/`);
      const proxyPort = await freePort();
      proxy = createServer((req, res) => {
        seenUa.add(String(req.headers["user-agent"] ?? "(none)").slice(0, 120));
        const up = httpRequest({ host: "127.0.0.1", port: providerPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on("error", () => res.writeHead(502).end());
        req.pipe(up);
      }).listen(proxyPort, "0.0.0.0");
      uri = `http://${HOST_FROM_CONTAINER}:${proxyPort}/${token}`;
    }

    const pmsPort = await freePort();
    pms = startContainer("avbang-pms-real", PMS_IMAGE, [
      "-p", `127.0.0.1:${pmsPort}:32400`,
      "-e", "TZ=UTC",
      "-e", ["ALLOWED_NETWORKS=172.16.0", "0/12,192.168.0", "0/16,10.0.0", "0/8"].join("."),
      "--mount", `type=bind,source=${dir},target=/data/movies`,
      ...dockerHostArgs(),
    ]);
    const P = `http://127.0.0.1:${pmsPort}`;
    const J = { accept: "application/json" };
    const call = async (method, path) => {
      const r = await fetch(P + path, { method, headers: J, signal: AbortSignal.timeout(30_000) });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body, text };
    };
    const idRes = await waitForHttp(P + "/identity", {
      deadlineMs: 240_000,
      init: { headers: J },
      ok: async (r) => {
        const c = r.ok ? (await r.clone().json()).MediaContainer : null;
        return c?.version !== undefined && c.startState === undefined;
      },
    });
    const version = (await idRes.json()).MediaContainer.version;
    console.log(`PMS version ${version}`);
    await poll(async () => (await call("GET", "/library/sections")).status === 200, { deadlineMs: 120_000, intervalMs: 2000 });

    const reg = await call("POST", `/media/providers/metadata?uri=${encodeURIComponent(uri)}`);
    t.check("provider registered", reg.status === 200, `${reg.status} ${reg.text.slice(0, 200)}`);
    const grp = await call("POST", `/media/providers/metadata/group?title=AVBang&primaryIdentifier=${ID}`);
    t.check("agent group created", grp.status === 200 || grp.status === 201, `${grp.status} ${grp.text.slice(0, 200)}`);
    const groupId = grp.text.match(/"?(?:id|Id|groupId)"?\s*[:=]\s*"?(\d+)/)?.[1] ?? grp.text.match(/(\d+)/)?.[1];
    const lib = await call(
      "POST",
      `/library/sections?name=Movies&type=1&agent=${ID}&scanner=Plex%20Movie&language=en-US&metadataAgentProviderGroupId=${groupId}&location=${encodeURIComponent("/data/movies")}`,
    );
    t.check("library created", lib.status === 200 || lib.status === 201, `${lib.status} ${lib.text.slice(0, 200)}`);
    const sectionId = (await call("GET", "/library/sections")).body?.MediaContainer?.Directory?.[0]?.key;
    await call("GET", `/library/sections/${sectionId}/refresh?force=1`);

    const item = await poll(
      async () => {
        const m = (await call("GET", `/library/sections/${sectionId}/all`)).body?.MediaContainer?.Metadata?.[0];
        const md = m && (await call("GET", `/library/metadata/${m.ratingKey}`)).body?.MediaContainer?.Metadata?.[0];
        return md?.guid?.startsWith(ID) ? md : null;
      },
      { deadlineMs: 180_000, intervalMs: 3000 },
    );
    t.check("PMS created the item with the provider guid", !!item);
    if (item) {
      t.check("guid ends with the discovered code", item.guid === `${ID}://movie/${code}`, item.guid);
      t.check("title is non-empty", typeof item.title === "string" && item.title.length > 0);
      const y = Number(item.year);
      t.check("year is plausible", !detail.releaseDate || (y >= 1950 && y <= 2100), String(item.year));
      if (detail.performers?.length) t.check("Role present", (item.Role?.length ?? 0) > 0);
      if (detail.tags?.length) t.check("Genre present", (item.Genre?.length ?? 0) > 0);
      if (detail.studio) t.check("studio present", !!item.studio);
      console.log(`INFO PMS stored a poster: ${item.thumb ? "yes" : "no"}`);
      if (item.thumb) {
        const r = await fetch(P + item.thumb, { signal: AbortSignal.timeout(30_000) });
        console.log(`INFO poster fetch from PMS: ${r.status} ${r.headers.get("content-type") ?? ""}`);
        await r.arrayBuffer();
      }
    }

    // A14 and image host: one direct keyed request to the hosted route with the PlexMediaServer user agent.
    const ua = [...seenUa].find((u) => /PlexMediaServer/i.test(u)) ?? `PlexMediaServer/${version}`;
    if (mode === "container") console.log(`INFO user agent(s) PMS sent to the provider: ${[...seenUa].join(" | ")}`);
    const hostedUrl = `${API}/plex/${key}/library/metadata/${encodeURIComponent(code)}`;
    const h = await fetch(hostedUrl, { headers: { "user-agent": ua, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const hb = await h.json().catch(() => null);
    console.log(`INFO A14: hosted route with UA "${ua}"${mode === "container" ? "" : " (version from this PMS)"} -> HTTP ${h.status}, cloudflare ${h.headers.get("cf-ray") ? "served (cf-ray present)" : "no cf-ray"}, cf-mitigated ${h.headers.get("cf-mitigated") ?? "none"}`);
    t.check("hosted route answers the PlexMediaServer user agent (not blocked by Cloudflare)", h.status === 200, String(h.status));
    const md = hb?.MediaContainer?.Metadata?.[0];
    const urls = [md?.thumb, md?.art, ...(md?.Image ?? []).map((i) => i.url)].filter((u) => typeof u === "string");
    const hosts = [...new Set(urls.map((u) => { try { return new URL(u).host; } catch { return "(relative)"; } }))];
    console.log(`INFO relayed image hosts in the metadata response: ${hosts.length ? hosts.join(", ") : "none (no image relayed)"}`);
    if (mode === "hosted") t.check("hosted metadata carries isAdult", md?.isAdult === true);
  } catch (e) {
    console.log(`FAIL harness error: ${e?.message ?? e}`);
    t.check("script ran to completion", false);
  } finally {
    pms?.stop();
    provider?.stop();
    proxy?.close();
    if (imageTag) run("docker", ["rmi", "-f", imageTag]);
    rmSync(dir, { recursive: true, force: true });
  }
  t.done();
}
