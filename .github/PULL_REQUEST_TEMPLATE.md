## What this changes

<!-- One or two sentences. Link the issue it closes. Open an issue first for anything large. -->

Closes #

## Checklist

- [ ] `node --test test/` passes
- [ ] The mock-mode harness for the adapter I touched passes (`node <adapter>/live*.mjs --mock`)
- [ ] `node scripts/check-tree.mjs` passes
- [ ] No API keys, tokens, private hostnames or addresses in code, tests, logs or the description
- [ ] The change stays in scope: adapters for the AVBang public API only
- [ ] README or the header comment of the tool is updated if behaviour changed
