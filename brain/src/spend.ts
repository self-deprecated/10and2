// What each model call costs Driver (docs/launch/cost-tracking.md): the provider's prices in one table, checked on the
// date below, and how a call's usage becomes dollars. Each call's usage is kept in the brain's own store (`costs`,
// store.ts), apart from recordings and never with what was said: its operation, model, service tier, tokens, audio
// seconds or characters, retries and dollars. Pure (no Node or Cloudflare imports): the brain, the cloud and Ops read it.
// Model ids, so the user-text lint allows this file (scripts/lint-user-text.mjs ALLOWED).

/** When the prices below were last read off the provider's pricing page (developers.openai.com/api/docs/pricing). */
export const PRICES_CHECKED = "2026-11-08";

/** Dollars per million tokens. `cacheWrite`: input written to the prompt cache (the 30-minute write). */
type TokenPrice = { input: number; cached: number; cacheWrite: number; output: number };
/** `fast`: the priority tier, which the provider now calls Fast mode. `long`: a request past `LONG_CONTEXT` input tokens. */
type ModelPrice = { standard: TokenPrice; fast: TokenPrice; long: { standard: TokenPrice; fast: TokenPrice } };

const p = (input: number, cached: number, cacheWrite: number, output: number): TokenPrice => ({ input, cached, cacheWrite, output });

/** Past this many input tokens in one request, the long-context price applies to all of it. */
export const LONG_CONTEXT = 272_000;

/** The token models Driver uses (config.ts, models.ts), per million tokens. */
export const TOKEN_PRICES: Record<string, ModelPrice> = {
  "gpt-6-luna": { standard: p(0.1, 0.01, 0.125, 0.5), fast: p(0.2, 0.02, 0.25, 1), long: { standard: p(0.2, 0.02, 0.25, 0.75), fast: p(0.4, 0.04, 0.5, 1.5) } },
  "gpt-6.1-sol": { standard: p(2, 0.1, 2.5, 10), fast: p(4, 0.2, 5, 20), long: { standard: p(4, 0.2, 5, 15), fast: p(8, 0.4, 10, 30) } },
  "gpt-6-sol": { standard: p(2, 0.2, 2.5, 10), fast: p(4, 0.4, 5, 20), long: { standard: p(4, 0.4, 5, 15), fast: p(8, 0.8, 10, 30) } },
};

/** The voice model: dollars per minute, billed per second (at least 15 s a session, which its own count includes). */
export const VOICE_PRICES: Record<string, number> = { "gpt-live-1": 0.05 };

/**
 * Speech: dollars per minute of audio made. The provider prices it by tokens ($0.60 per million text tokens in, $12 per
 * million audio tokens out) and puts that at about $0.015 a minute; its audio tokens aren't returned, so the minute is
 * measured from the audio itself (`aacSeconds`). Without that, by characters: about 900 a minute (billing.md: 60
 * characters are about 4 s of speech).
 */
export const SPEECH_PRICES: Record<string, number> = { "gpt-4o-mini-tts": 0.015 };
export const SPEECH_CHARS_PER_MINUTE = 900;

/** Every operation that pays the provider (cloud/src/costs.ts names the same, with how each is metered). */
export const OPS = ["call", "backend", "speech", "voice_sample", "rewriter", "briefing_writer", "classifier", "opener", "demo_writer"] as const;
export type Op = (typeof OPS)[number];

/**
 * The background work an account's daily budget bounds (settings `backgroundCentsPerDay`): nobody waits on it, the
 * user isn't charged for it, and out of budget it's skipped or put together without a model (costs.ts).
 */
export const BACKGROUND: readonly Op[] = ["classifier", "opener", "briefing_writer", "rewriter"];

/** A model call's usage, as the provider reports it. */
export type Spent = {
  op: Op;
  model: string;
  /** The service tier the provider says it ran on: `standard`, or `fast` (the priority tier). */
  tier?: string;
  /** On the account's own AI key: what it would have cost us. */
  own?: boolean;
  /** The voice session it belongs to (`call`, `backend`), whose rows are one per session. */
  sessionId?: string | null;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  /** Audio: the call's billed seconds (cumulative, as the provider counts them), or speech made. */
  seconds?: number;
  chars?: number;
  retries?: number;
};

/** Records a call's usage; never throws into the call. */
export type RecordSpend = (s: Spent) => void;

/** The provider's name for a tier, as the prices have it: `fast` (it says `fast` or `priority`) or `standard`. */
export function tierOf(t: unknown): "fast" | "standard" {
  return t === "fast" || t === "priority" || t === "ultrafast" ? "fast" : "standard";
}

/** A Responses API usage block, as tokens. */
export function tokensOf(usage: any): Pick<Spent, "input" | "cached" | "cacheWrite" | "output" | "reasoning"> {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: n(usage?.input_tokens),
    cached: n(usage?.input_tokens_details?.cached_tokens),
    cacheWrite: n(usage?.input_tokens_details?.cache_write_tokens),
    output: n(usage?.output_tokens),
    reasoning: n(usage?.output_tokens_details?.reasoning_tokens),
  };
}

/** What a call cost in dollars at today's prices; null for a model the table doesn't price. */
export function dollars(s: Spent): number | null {
  if (s.op === "call") {
    const perMinute = VOICE_PRICES[s.model];
    return perMinute === undefined ? null : ((s.seconds ?? 0) / 60) * perMinute;
  }
  if (s.op === "speech" || s.op === "voice_sample") {
    const perMinute = SPEECH_PRICES[s.model];
    if (perMinute === undefined) return null;
    const minutes = s.seconds ? s.seconds / 60 : (s.chars ?? 0) / SPEECH_CHARS_PER_MINUTE;
    return minutes * perMinute;
  }
  const m = TOKEN_PRICES[s.model];
  if (!m) return null;
  const input = s.input ?? 0;
  const tier = tierOf(s.tier);
  const price = input > LONG_CONTEXT ? m.long[tier] : m[tier];
  const cached = s.cached ?? 0;
  const written = s.cacheWrite ?? 0;
  // Reasoning tokens are output tokens (the provider counts them in `output_tokens`).
  const fresh = Math.max(0, input - cached - written);
  return (fresh * price.input + cached * price.cached + written * price.cacheWrite + (s.output ?? 0) * price.output) / 1e6;
}

/** How long the rows are kept: a year of weeks to compare, and a little more. */
export const COST_DAYS = 400;

/** The UTC day, as the ledger's. */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The week a UTC day is in, by its Monday (weeks start Monday 00:00 UTC, as the plans do: tiers.md). */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The length of ADTS AAC audio (what speech returns), from its frames' headers; null when it isn't ADTS. */
export function aacSeconds(b: Uint8Array): number | null {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let i = 0;
  let samples = 0;
  let rate = 0;
  while (i + 7 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
    rate = RATES[(b[i + 2] >> 2) & 0xf] ?? 0;
    const length = ((b[i + 3] & 0x3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (!rate || length < 7) return null;
    samples += ((b[i + 6] & 0x3) + 1) * 1024;
    i += length;
  }
  return rate ? samples / rate : null;
}

/** Where a recorder keeps rows: the store's `costs` table (store.ts `addCost`). */
export type CostRow = {
  day: string; op: Op; model: string; tier: string; own: boolean;
  input: number; cached: number; cacheWrite: number; output: number; reasoning: number; seconds: number; chars: number; retries: number; usd: number;
};
type CostSink = { addCost(ref: string, row: CostRow, raise: boolean): void };

/**
 * Records each call's usage in `store`. A voice session's billed seconds are one row raised to the highest count seen
 * (they're cumulative); its backend's responses add up in one row per model and tier; everything else adds up in one
 * row per day, operation, model, tier and key. A session's rows stay on the day it started.
 */
export function recorder(store: CostSink, log: (m: string) => void, now: () => number = Date.now): RecordSpend {
  const unpriced = new Set<string>();
  return (s) => {
    try {
      const usd = dollars(s);
      if (usd === null && !unpriced.has(s.model)) (unpriced.add(s.model), log(`costs: no price for ${s.model}; recorded at $0`));
      const tier = s.op === "call" || s.op === "speech" || s.op === "voice_sample" ? "standard" : tierOf(s.tier);
      const own = !!s.own;
      const row: CostRow = {
        day: dayOf(now()), op: s.op, model: s.model, tier, own,
        input: s.input ?? 0, cached: s.cached ?? 0, cacheWrite: s.cacheWrite ?? 0, output: s.output ?? 0, reasoning: s.reasoning ?? 0,
        seconds: s.seconds ?? 0, chars: s.chars ?? 0, retries: s.retries ?? 0, usd: usd ?? 0,
      };
      const ref = s.op === "call" ? `call:${s.sessionId}` : s.sessionId ? `${s.op}:${s.sessionId}:${s.model}:${tier}` : `${s.op}:${row.day}:${s.model}:${tier}:${own ? "own" : "ours"}`;
      store.addCost(ref, row, s.op === "call");
    } catch (e) {
      log(`costs: couldn't record ${s.op} (${e instanceof Error ? e.name : "error"})`);
    }
  };
}
