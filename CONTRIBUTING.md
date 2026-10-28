# Contributing

Thanks for helping. This repo holds adapters that connect media servers to the AVBang public API. Read the scope first so your time goes where it can be merged.

## Scope

In scope: the Plex provider, the Stash scraper and push tool, the Jellyfin NFO generator, new adapters for other media servers, bug fixes, tests and documentation.

Out of scope: stash-box endpoints, changes to AVBang itself (this repo cannot change the API), and anything that scrapes or bypasses the API. Adapters use the documented public API only.

## Filing a bug

Use the bug report form. Give the adapter, its version or commit, the media server and its exact version, and redacted logs. Never paste an API key, and remove hostnames and file paths you consider private. If the bug is a security problem, follow SECURITY.md instead.

## Suggesting a feature

Use the feature request form and describe what you are trying to do before how. Open an issue before starting a large pull request so we can agree on the approach.

## Development setup

- Node 24 or newer. The code has no dependencies and no install step. Types in `.ts` files are stripped by Node itself.
- Docker, for the live harnesses. They start real Plex, Jellyfin and Stash servers against a mock AVBang API. They need no key and do not contact AVBang.

```
node --test test/
node scripts/check-tree.mjs
node plex/live.mjs --mock
node stash/live-scrape.mjs --mock
node stash/live-push.mjs --mock
node jellyfin/live.mjs --mock --version all
```

The first run of each harness downloads the server image, so it is slow. `node scripts/simulate-split.mjs` repeats all of this from a clean copy, the way CI sees the repo.

Real-API runs (`--real`) need a personal AVBang API key. They are optional for contributors; the maintainer runs them before a release.

## What a good pull request contains

- One focused change, linked to an issue.
- Tests: unit tests under `test/` for logic, and a harness assertion when behaviour with a real server changes.
- No dependencies. If you think one is needed, ask in the issue first.
- No keys, tokens, private hostnames or addresses anywhere, including tests and logs. `scripts/check-tree.mjs` blocks key-shaped strings and stray email addresses.
- Updated README or tool header comments when behaviour changes. Say what an adapter stores or downloads; do not hide it.
- Nothing imported from outside this directory.

## Review

The maintainer reviews in the open and aims to reply within a week. A pull request is accepted when CI is green, it fits the scope and it keeps the key-handling and image rules in the tool headers. Expect questions rather than silence; if your change is out of scope you get a short explanation and thanks.

## Conduct

Everyone taking part follows the Code of Conduct.
