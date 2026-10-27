// Minimal Stash GraphQL helper for push.mjs (phase 28.1). No dependencies.
// Every value travels as a GraphQL variable, never spliced into the query text, so a title or file name
// cannot change a query. The Stash ApiKey goes only into the ApiKey header and is scrubbed from errors.

export class StashError extends Error {
  constructor(message) {
    super(message);
    this.name = "StashError";
  }
}

export function createGraphql({ url, apiKey, fetch: doFetch = globalThis.fetch, timeoutMs = 60_000 }) {
  let endpoint;
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw new Error("bad");
    endpoint = new URL("/graphql", u.origin);
  } catch {
    throw new StashError("--stash-url must be an http(s) URL without credentials");
  }
  const scrub = (s) => (apiKey ? String(s).replaceAll(apiKey, "[key]") : String(s));

  return async function gql(query, variables = {}) {
    let res;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { ApiKey: apiKey } : {}) },
        body: JSON.stringify({ query, variables }),
        redirect: "error", // never carry the ApiKey to a redirect target
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new StashError(`cannot reach Stash at ${endpoint.origin}`);
    }
    if (res.status === 401 || res.status === 403) throw new StashError("Stash refused the request (set STASH_API_KEY if Stash needs one)");
    let body;
    try {
      body = await res.json();
    } catch {
      throw new StashError(`Stash answered HTTP ${res.status} without JSON`);
    }
    if (body.errors?.length) throw new StashError(scrub(`Stash error: ${body.errors.map((e) => e.message).join("; ")}`.slice(0, 400)));
    return body.data;
  };
}

const SCENE = `id title code date details urls
  studio { id name } performers { id name } tags { id name }
  files { path }`;

/** Scenes in id order, 100 per page. sceneId limits to one scene. */
export async function* findScenes(gql, { sceneId } = {}) {
  if (sceneId !== undefined) {
    const d = await gql(`query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
    if (d.findScene) yield d.findScene;
    return;
  }
  for (let page = 1; ; page++) {
    const d = await gql(
      `query($page: Int!) { findScenes(filter: { page: $page, per_page: 100, sort: "id", direction: ASC }) { count scenes { ${SCENE} } } }`,
      { page },
    );
    for (const s of d.findScenes.scenes) yield s;
    if (page * 100 >= d.findScenes.count || d.findScenes.scenes.length === 0) return;
  }
}

const KINDS = {
  studio: { find: "findStudios", filter: "studio_filter", type: "StudioFilterType", create: "studioCreate", input: "StudioCreateInput", list: "studios" },
  performer: { find: "findPerformers", filter: "performer_filter", type: "PerformerFilterType", create: "performerCreate", input: "PerformerCreateInput", list: "performers" },
  tag: { find: "findTags", filter: "tag_filter", type: "TagFilterType", create: "tagCreate", input: "TagCreateInput", list: "tags" },
};

/** Exact (case-insensitive) name lookup. Returns the id or null. */
export async function findByName(gql, kind, name) {
  const k = KINDS[kind];
  const d = await gql(
    `query($f: ${k.type}) { ${k.find}(${k.filter}: $f, filter: { per_page: 10 }) { ${k.list} { id name } } }`,
    { f: { name: { value: name, modifier: "EQUALS" } } },
  );
  const hit = d[k.find][k.list].find((r) => r.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.id : null;
}

export async function createNamed(gql, kind, name) {
  const k = KINDS[kind];
  const d = await gql(`mutation($i: ${k.input}!) { ${k.create}(input: $i) { id } }`, { i: { name } });
  return d[k.create].id;
}

/**
 * Resolve names to ids. Looks each name up first and creates only the missing ones, and only when create is true
 * (apply mode). Missing and not created gives null. cache is a Map shared across the run so a name is created once.
 */
export async function resolveNames(gql, kind, names, { create, cache }) {
  const out = [];
  for (const name of names) {
    const key = `${kind}:${name.toLowerCase()}`;
    let id = cache.get(key);
    if (id === undefined) {
      id = await findByName(gql, kind, name);
      if (id === null && create) id = await createNamed(gql, kind, name);
      if (id !== null) cache.set(key, id);
    }
    out.push(id);
  }
  return out;
}

export async function updateScene(gql, input) {
  await gql(`mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }`, { i: input });
}
