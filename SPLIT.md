# Splitting integrations/ into its own repository

`integrations/` is written to live in the AVBang monorepo and in its own public repository. Its root is the split repo root: every path in the Dockerfile, the workflows and the harnesses is relative to this directory. Nothing in here imports from the app.

Planned public repository name: `avbang-integrations`. Nothing has been created on GitHub or pushed.

## The one coupling

The monorepo imports `integrations/plex/provider.ts` for the hosted Plex route. Until the app vendors a released copy of that file, the monorepo keeps importing it from here. Rule: `provider.ts` must stay free of imports (types and Node built-ins excluded) so it can be copied or vendored on its own. Do not add an import to it. `scripts/check-tree.mjs` blocks any import that leaves this directory or uses an app alias.

## Check before you split

From the monorepo root:

```
node integrations/scripts/check-tree.mjs --require-denylist
node integrations/scripts/simulate-split.mjs
```

`check-tree` fails on missing community files, key-shaped strings, stray email addresses, private-network IPs, private hostnames, imports that leave the directory, and workflow paths that do not exist. The hostname list is not in the tree. It is read from `--denylist` or the `CHECK_TREE_DENYLIST` variable (environment or a gitignored `.infra` file).

`simulate-split` copies this directory into a temp folder that acts as the split root and, from there, runs `check-tree`, `node --test test/`, `docker build -f plex/Dockerfile .` with a start of the image, and the commands in `.github/workflows/live.yml`. Add `--skip-harnesses` to skip the last group. It needs Docker.

## History scan (required before publishing)

Create the split branch locally and scan its whole history with gitleaks, run through Docker with a pinned tag. Never use `latest`.

```
git subtree split --prefix=integrations -b split-preview     # slow on a large history: minutes
docker manifest inspect ghcr.io/gitleaks/gitleaks:v8.30.1
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/integrations/.gitleaks.toml:/cfg.toml:ro" \
  ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo --log-opts=split-preview -c /cfg.toml --redact --no-banner
git branch -D split-preview
```

`.gitleaks.toml` extends the default rules and allows only four fake constants used in unit tests. In Git Bash on Windows, prefix the `docker run` line with `MSYS_NO_PATHCONV=1`. Zero findings are required. If gitleaks reports anything, rotate the secret first, then rewrite the history. Use a newer pinned tag if v8.30.1 is outdated, and confirm it with `docker manifest inspect`.

## Creating the public repository (owner steps)

1. Create `avbang-integrations` on GitHub, empty, no template files.
2. From the monorepo: `git subtree split --prefix=integrations -b split-main`, then `git push <new-repo-url> split-main:main`, then delete the local branch.
3. Enable private vulnerability reporting, secret scanning and push protection, Dependabot alerts and version updates (GitHub Actions ecosystem), and branch protection on `main` (required review, required status check `live`, no force push).
4. Enable two-factor authentication for all admins and add a second admin so the repo does not depend on one account.
5. Push a `vX.Y.Z` tag to build the Plex provider image in GitHub Container Registry. After the first push, set the package to public if you want anonymous pulls.
6. Run `docker build -f plex/Dockerfile .` from the new repo root as a last check. The first `live` workflow run confirms CI on Node 24.

## Keeping the monorepo working

After the split, the monorepo keeps `integrations/` as it is. Changes go to one place first (the monorepo while the hosted route depends on `provider.ts`), then are mirrored with a new `git subtree split` or a subtree push. When the app vendors a released copy of `provider.ts`, the monorepo copy can be removed.
