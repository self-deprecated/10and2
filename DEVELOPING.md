# Developing 10and2

This repository is the source of the `10and2` npm package: the connector for [10 & 2](https://10and2.app), and the brain it runs for `10and2 brain` (`brain/`). It's
exported from Self-Deprecated's own repository at each release, where the connector is tested against the service it
talks to; changes are made there and arrive here as one commit per version.

- `npm ci && npm run check`: types, tests, the bundles (`dist/10and2.js`, and `dist/brain/main.js` from `brain/`) and a smoke test of them. Node 22.13 or newer.
- `nix build` (or `nix run . -- help`): the same bundle on Node 24. `nix develop` for a shell with Node.
- `src/contract.ts`: the types the connector shares with the service.
- Publishing: `npm publish` from a clean checkout of a release tag (`prepublishOnly` runs the check).

Source-available, not open source: see [LICENSE](LICENSE).
