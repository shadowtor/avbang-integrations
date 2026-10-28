# AVBang media server adapters

Adapters that fill in titles, studios, performers, dates and covers in your own media server from the [AVBang public API](https://avbang.net/api). Each adapter looks a file up by the product code in its name (for example `STAR-489`), then reads the title from the API.

There are no dependencies and no install step. Everything is plain Node and one Dockerfile.

## What is here

| Adapter | What it does | Tested against |
| --- | --- | --- |
| `plex/` | Plex custom metadata provider, run as a container you host or used through AVBang's hosted URL | Plex Media Server 1.43.5.11079-b3b13e506 |
| `stash/avbang.yml` | Stash scraper: fragment scrape by file name, and search by name | Stash v0.31.1 |
| `stash/push.mjs` | Stash push tool: reads your scenes, writes metadata back | Stash v0.31.1 |
| `jellyfin/nfo/cli.mjs` | Writes a movie `.nfo` (and a poster) beside each video for Jellyfin to read | Jellyfin 12.4 and 10.11.11 |

A Jellyfin plugin is not provided. The NFO generator is the supported route.

## Status

Each adapter was run end to end with a real AVBang API key against the AVBang test deployment, and against real servers in Docker, before this repo was written. Mock-mode runs of every harness are the same checks CI repeats.

| Adapter | Real API run | Notes |
| --- | --- | --- |
| Plex, container | Passed | Plex matched a title and stored title, year, studio, roles and genres |
| Plex, hosted URL | Passed | Same result. Plex registered the hosted URL and Cloudflare did not block it |
| Stash scraper | Passed | Fragment scrape and name search fill the scene |
| Stash push | Passed | Dry run changes nothing; a second `--apply` changes nothing |
| Jellyfin 12.4 | Passed | NFO and poster read |
| Jellyfin 10.11.11 | Mock API only | NFO and poster read in the mock-mode harness; no real-API run |

Not verified against the real API: image delivery to Plex. The title used in the real Plex runs had no cover, so no image URL was relayed. Image delivery to Plex is covered by the mock-mode harness only.

Plex terms: AVBang's reading is that Plex permits third-party custom metadata providers. This project is not affiliated with or endorsed by Plex. Check Plex's current terms yourself.

## Before you start

- Create an AVBang API key in your account settings. Use one dedicated key per server so you can revoke it without touching the others. An account holds five.
- Keys are limited to 300 requests per minute per key and 600 per minute per IP address. Past that the API answers 429 with a `Retry-After` header. The shared client paces itself at 200 calls a minute, waits out `Retry-After` and gives up after 5 retries.
- Titles that are explicit are blurred for keys that are not entitled to the clear image. Adapters pass on what the API returns.

## Plex

Two ways to use the provider.

**Container (self-hosted).** You run `plex/server.ts` and your key stays on your machine.

```
echo 'AVBANG_API_KEY=<your key>' > .env
docker compose -f plex/compose.example.yml up -d --build
```

Then add `http://127.0.0.1:8787` as a metadata provider in Plex. The container reads the key from the `AVBANG_API_KEY` environment variable only, binds to loopback, and holds nothing else. If Plex runs on another machine, set `PROVIDER_TOKEN` and keep the port on your LAN or a VPN. A version tag in this repo builds an image at `ghcr.io/<owner>/avbang-plex-provider`; no image is published yet, so build it with the command above.

**Hosted URL.** Register `https://api.avbang.net/v1/plex/<your key>` in Plex. Nothing to run, but the URL contains your key, and Plex stores it in its configuration. Use a dedicated key and revoke it if the URL leaks. The container route keeps the key out of Plex's settings.

Adult content: Plex 1.43.5 does not send `includeAdult` for a default library. The provider treats a missing value as allowed and only filters when Plex sends an explicit `0`. Every item it returns is flagged adult. This means the library setting "Include adult content" does not gate AVBang results for Plex itself.

## Stash

**Scraper.** Copy `stash/avbang.yml` into the `scrapers` folder of your Stash configuration, replace the placeholder key in the file, then reload scrapers in Stash settings. Stash has no secret store for scrapers, so the key sits in that file in plaintext. Keep the file private. The fragment scrape needs a code with a hyphen in the file name (`STAR-489`, not `STAR489`). The search by name lists matches and fetches the full record for the one you pick.

**Push tool.**

```
AVBANG_API_KEY=<your key> node stash/push.mjs            # dry run: prints the plan, writes nothing
AVBANG_API_KEY=<your key> node stash/push.mjs --apply    # writes the changes
```

It never deletes anything and skips scenes it cannot match with certainty. Options are listed at the top of `stash/push.mjs`.

## Jellyfin

```
AVBANG_API_KEY=<your key> node jellyfin/nfo/cli.mjs --root /media/movies --dry-run
AVBANG_API_KEY=<your key> node jellyfin/nfo/cli.mjs --root /media/movies
```

For each video it writes `<video name>.nfo` beside the file, then Jellyfin reads it on its next library scan. Existing NFO files are skipped. `--force` replaces only files the tool generated. Symlinks are not followed.

## What each tool stores or downloads

| Tool | Images |
| --- | --- |
| Plex provider | Relays a signed image URL to Plex. It fetches and stores nothing. Plex downloads the image and keeps its own copy. |
| Stash scraper | Stash fetches the cover from the API's image URL and stores it. The scraper keeps nothing. Stash sends no `Authorization` header when it downloads, so covers of explicit titles are blurred. |
| Stash push tool | Downloads the cover in memory, passes it to Stash and writes nothing to disk. |
| Jellyfin NFO generator | Downloads the poster and writes it next to the video as `<video name>-poster.webp`, where it stays until you delete it. Jellyfin also keeps its own copy. Pass `--no-poster` to write the NFO only. Titles whose clear image is not available get an NFO and no poster. |

## Safety

- Your key is read from an environment variable (`AVBANG_API_KEY`, `STASH_API_KEY`) and never printed, written to disk or placed in an NFO. Passing a key as a command-line argument is refused.
- Images are fetched only over https from `avbang.net` and its subdomains, with a size cap, and with no credentials.
- To report a vulnerability see [SECURITY.md](SECURITY.md).

## Develop and test

```
node --test "test/*.test.mjs"
node scripts/check-tree.mjs
node plex/live.mjs --mock
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list, including the Docker harnesses. Node 24 or newer is required; the code was developed and tested on Node 26.

## Getting help

Open an issue using the bug report or feature request form. For API questions see the [API reference](https://avbang.net/api). This is a spare-time project with one maintainer ([MAINTAINERS.md](MAINTAINERS.md)); expect a reply within about a week.

## Licence

[MIT](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To split this directory into its own repository, see [SPLIT.md](SPLIT.md).
