// The models a call can run on, for 10 & 2 Ops' settings (docs/launch/ops-app.md §4.1): an allowlist, the first of each
// the default (config.ts reads them, the environment may override the default). Pure, so Ops checks against the same
// list. Offering another model is a change here, in git, after it has run the eval. Model ids, so the user-text lint
// allows this file (scripts/lint-user-text.mjs ALLOWED).
// gpt-live-1.1 since 19 November (docs/launch/gpt-live-1-1.md); gpt-live-1 stays offered so Ops can go back to it.
export const LIVE_MODELS = ["gpt-live-1.1", "gpt-live-1"] as const;
export const BACKEND_MODELS = ["gpt-6-luna"] as const;

/**
 * The engines that read replies aloud (docs/launch/reading-engine.md), the first the default: the replacement, which
 * reads through a Realtime session (everyone's since 20 November), and the text-to-speech model before it, shut down on
 * 6 January 2027 and offered until then so Ops can go back to it. Ops' `readingEngine` picks one per account, or "off".
 * Not gated: the eval doesn't cover readings.
 */
export const READING_ENGINES = ["gpt-realtime-2.1-mini", "gpt-4o-mini-tts"] as const;
/** The engine that reads through a Realtime session, not the speech endpoint. */
export const REALTIME_READER: (typeof READING_ENGINES)[number] = "gpt-realtime-2.1-mini";
