# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately:

- Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), or
- email the address below.

Security contact: legal@avbang.net

Include the adapter, its version or commit, the server version, steps to reproduce and what an attacker gains. Never include a working API key; redact it.

## What to expect

This is a small project with one maintainer. You get an acknowledgement within 7 days. A fix or a written assessment follows as soon as it can be made; if that will take longer than 30 days you are told why. Please keep the report private until a fix is released or 90 days have passed, whichever comes first. Reporters are credited in the release notes unless they ask not to be.

## Supported versions

Only the latest tagged release and the default branch receive fixes.

## What counts as a vulnerability

In scope:

- a way for an adapter to leak the AVBang API key (into logs, URLs, files, NFO output or requests to another host)
- fetching images from a host other than avbang.net or its subdomains, or sending credentials to an image host
- path traversal, symlink following or writes outside the chosen media folder in the Jellyfin tool
- the Plex provider container answering requests it should refuse, or exposing the key
- injection into Stash GraphQL requests or NFO XML

Out of scope:

- problems in AVBang itself, Plex, Jellyfin or Stash (report those to their owners)
- a key stored in plaintext in the Stash scraper file, which is documented and a limit of Stash
- findings that need an attacker who already controls your machine or your media server
