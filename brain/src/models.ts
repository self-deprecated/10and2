// The models a call can run on, for 10 & 2 Ops' settings (docs/launch/ops-app.md §4.1): an allowlist, the first of each
// the default (config.ts reads them, the environment may override the default). Pure, so Ops checks against the same
// list. Offering another model is a change here, in git, after it has run the eval. Model ids, so the user-text lint
// allows this file (scripts/lint-user-text.mjs ALLOWED).
export const LIVE_MODELS = ["gpt-live-1"] as const;
export const BACKEND_MODELS = ["gpt-6-luna"] as const;
