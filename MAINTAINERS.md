# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| Shadowtor | [@Shadowtor](https://github.com/Shadowtor) | Maintainer and release owner; receives security and conduct reports |

There is one maintainer, so there is no separate governance document. Decisions are made in public in issues and pull requests; the maintainer has the final say. Repeat contributors who review well and keep to the scope in CONTRIBUTING.md can be invited to become maintainers.

## Releases

1. Make sure `node --test test/`, `node scripts/check-tree.mjs` and the mock-mode harnesses pass on the default branch.
2. Tag the commit `vX.Y.Z` and push the tag. The `plex-image` workflow builds the Plex provider image and pushes it to GitHub Container Registry.
3. Publish release notes: what changed, which server versions were tested.

## Reports

- Security reports follow SECURITY.md (private vulnerability reporting or the address on its Security contact line).
- Code of Conduct reports go to the address in CODE_OF_CONDUCT.md.
- Everything else goes through issues.

## Availability

Maintenance is done in spare time. Expect a first reply within about a week. Out-of-scope requests are closed politely with a link to the scope in CONTRIBUTING.md.
