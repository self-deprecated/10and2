// The server-side settings a call runs with (docs/launch/ops-app.md §4): the defaults are here and in config.ts, in git.
// Each call takes one snapshot when it starts and keeps it to the end (server.ts `startSession`). Pure: no Node or
// Cloudflare imports, so the brain, the cloud, the eval runner and Ops all read the same definitions.
import type { Config } from "./config.ts";
import { PLACEHOLDER, PROMPT_SECTIONS, templateOf, type Prompts } from "./voice/sections.ts";
import { BACKEND_MODELS, LIVE_MODELS } from "./models.ts";
import { CONVERSATION_VOICES, VOICE_SAMPLE_TEXT } from "./voice/voices.ts";
import { FORBIDDEN } from "./user-text.ts";

/**
 * The eval suite a pass was measured with: part of the template hash, so a pass from an older suite doesn't count for
 * this one. Raise it whenever the scenarios in eval/run.ts, or how they're judged, change.
 */
export const EVAL_SUITE_VERSION = 2;

/** Free seconds a day (UTC) for each allowance label (Clerk `public_metadata.driver.allowance`): testers, and the stage account. */
export const ALLOWANCES = { tester: 600, presenter: 3 * 3600 } as const;
export type AllowanceLabel = keyof typeof ALLOWANCES;
export const isAllowance = (label: unknown): label is AllowanceLabel => typeof label === "string" && Object.hasOwn(ALLOWANCES, label);

/**
 * How fast things use minutes, and how many there are (docs/launch/plans.md; Jordan, 8 November). The ledger counts
 * seconds; these say how many seconds each thing takes. A call takes the rates it started with to its end.
 */
export const MINUTES = {
  /** Talking in fast mode uses minutes this many percent as fast. */
  fastPercent: 150,
  /** A reading's audio in 10 & 2's voice uses one second per this many characters (about a third of a minute a minute). */
  readingCharsPerSecond: 45,
  /** Each pick-up (a call, a call-back, back from Hold) uses at least this many seconds: the provider's minimum. */
  pickupSeconds: 15,
  /** The trial: this many free seconds a day (UTC)… */
  trialDailySeconds: 600,
  /** …on up to this many different days. */
  trialDays: 3,
} as const;
export type Minutes = { -readonly [K in keyof typeof MINUTES]: number };

/**
 * The most an account's background work (spend.ts `BACKGROUND`: the briefing's classifier, opener and writer, and
 * rewrites) may cost Driver in a UTC day, in cents. Past it, that work waits for the next day: the briefing is put
 * together from the cards, as at zero minutes (cloud/src/costs.ts). Provisional until measured (cost-tracking.md).
 */
export const BACKGROUND_CENTS_PER_DAY = 25;

/**
 * The longest a session may be set to run before it rolls over: with `ROLL_LATE` it still ends before a deferred code
 * update (cloud/wrangler.jsonc `max_delay`, 20 minutes) could meet it.
 */
export const MAX_MINUTES_CAP = 15;

export type Settings = {
  /** Driver speaks first in a new call (3 November). */
  speakFirstNew: boolean;
  /** A call with nobody speaking for this long ends. */
  idleSeconds: number;
  /** A session rolls over to a new one in the same conversation after about this long (endPolicy.ts). */
  maxMinutes: number;
  /** Driver tells the user during a call when a starred thread replies; `wait_for` works either way. */
  liveNotices: boolean;
  liveModel: string;
  backendModel: string;
  /** The conversation voice, unless the phone chose one. */
  voice: string;
  /** What every reading voice's sample says (`GET /api/voices/sample`); a change makes each sample again, once. */
  sampleText: string;
  /** How fast things use minutes, and the trial (`MINUTES`). A plan's weekly minutes are its level's (cloud/src/plan.ts). */
  minutes: Minutes;
  allowances: Record<AllowanceLabel, number>;
  /** The background work's daily ceiling per account, in cents (`BACKGROUND_CENTS_PER_DAY`). */
  backgroundCentsPerDay: number;
  /** Overrides of the prompts' editable sections (voice/sections.ts). */
  prompts: Prompts;
  /** A line the app shows once (by its text's id), or none. Phone settings come from `current` only (§4.4). */
  banner: { text: string } | null;
  /** The oldest iOS build (12 digits) that may start a new call; null: any. Enforced by the server only (§6). */
  minBuild: { ios: string | null };
  /** The Ops version these came from (docs/launch/ops-app.md §4.2); null: git's defaults. Not a setting. */
  version: number | null;
};

/** The settings as git has them: config.ts (and its environment) and the constants above. */
export function defaults(cfg: Pick<Config, "idleMs" | "maxSessionMs" | "liveModel" | "backendModel" | "voice">): Settings {
  return {
    speakFirstNew: true,
    idleSeconds: cfg.idleMs / 1000,
    maxMinutes: cfg.maxSessionMs / 60_000,
    liveNotices: true,
    liveModel: cfg.liveModel,
    backendModel: cfg.backendModel,
    voice: cfg.voice,
    sampleText: VOICE_SAMPLE_TEXT,
    minutes: { ...MINUTES },
    allowances: { ...ALLOWANCES },
    backgroundCentsPerDay: BACKGROUND_CENTS_PER_DAY,
    prompts: {},
    banner: null,
    minBuild: { ios: null },
    version: null,
  };
}

/**
 * Git's settings with git's models (models.ts), whatever the environment says: what a template hash is made over when
 * there's no config to read (settings-hash.ts, the cloud's /health). Only the prompts, models and speak-first enter it.
 */
export const gitSettings = () => defaults({ idleMs: 90_000, maxSessionMs: 15 * 60_000, liveModel: LIVE_MODELS[0], backendModel: BACKEND_MODELS[0], voice: "marin" });

/** At most this long, in characters. */
export const BANNER_MAX = 140;
/** A voice sample's words: long enough to judge a voice by, short enough to make for nothing. */
export const SAMPLE_TEXT_MAX = 300;
/** A banner's id, from its text: the same text is shown once, edited text again (FNV-1a, so it's the same everywhere). */
export function bannerId(text: string): string {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(text)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return `b${h.toString(16).padStart(8, "0")}`;
}

/** A setting's check: why a value can't be used, or null when it can. */
type Check = (v: unknown) => string | null;
const bool: Check = (v) => (typeof v === "boolean" ? null : "must be true or false");
const int = (min: number, max: number): Check => (v) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? null : `must be a whole number from ${min} to ${max}`);
const oneOf = (xs: readonly string[]): Check => (v) => (typeof v === "string" && xs.includes(v) ? null : `must be one of ${xs.join(", ")}`);
/** An object with only these keys, each checked; any may be left out. */
const fields = (checks: Record<string, Check>): Check => (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const [k, x] of Object.entries(v)) {
    if (!Object.hasOwn(checks, k)) return `has no ${k}`;
    const why = checks[k](x);
    if (why) return `${k} ${why}`;
  }
  return null;
};
const banner: Check = (v) => {
  if (v === null) return null;
  const why = fields({ text: (t) => (typeof t === "string" && t.trim() !== "" ? null : "must be some text") })(v);
  if (why) return why;
  const text = (v as { text?: unknown }).text;
  if (typeof text !== "string") return "needs text";
  if (text.length > BANNER_MAX) return `is longer than ${BANNER_MAX} characters`;
  if (/[\u0000-\u001f<>]/.test(text)) return "must be one line of plain text";
  if (FORBIDDEN.test(text)) return "names the AI provider or a model, which users never read (say \"AI\" or \"the voice model\")";
  return null;
};

const sampleText: Check = (v) => {
  if (typeof v !== "string" || v.trim().length < 20) return "must be a sentence or two";
  if (v.length > SAMPLE_TEXT_MAX) return `is longer than ${SAMPLE_TEXT_MAX} characters`;
  if (/[\u0000-\u001f<>]/.test(v)) return "must be one line of plain text";
  if (FORBIDDEN.test(v)) return "names the AI provider or a model, which users never hear (say \"AI\" or \"the voice model\")";
  return null;
};

/** An edited section may be at most this long, or twice its default if that's longer. */
export const PROMPT_MIN_MAX = 1500;
/** The blocks of data the prompts are given (prompts.ts, session.ts): an edit may name them no more than its default does. */
const DELIMITERS = [/<threads>/g, /<\/threads>/g, /<reports?\b/g, /<\/reports?>/g];
const sections = new Map(PROMPT_SECTIONS.map((x) => [x.id, x]));

/** Edits of the prompts' editable sections (§5): plain text, not too long, no placeholders or data delimiters, no provider. */
const prompts: Check = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const [id, text] of Object.entries(v)) {
    const section = sections.get(id);
    if (!section) return `has no section ${id}`;
    if (!section.editable) return `${id} is locked`;
    if (typeof text !== "string" || !text.trim()) return `${id} must be some text`;
    const max = Math.max(2 * section.template.length, PROMPT_MIN_MAX);
    if (text.length > max) return `${id} is longer than ${max} characters`;
    if (new RegExp(PLACEHOLDER.source).test(text) || text.includes("{{")) return `${id} has placeholder syntax ({{…}})`;
    for (const d of DELIMITERS) if ((text.match(d) ?? []).length > (section.template.match(d) ?? []).length) return `${id} names a data block (${d.source.replace(/\\/g, "")}) more than its default does`;
    if (/[\u0000-\u0008\u000b-\u001f]/.test(text)) return `${id} must be plain text`;
    if (FORBIDDEN.test(text)) return `${id} names the AI provider or a model, which users must never hear`;
  }
  return null;
};

/**
 * What staff can change from Ops, each with its check. `gated`: applied only once the eval has passed the prompts and
 * models it makes (§5): a version with any of these needs a pass for its template hash on the code that reads it.
 */
export const SETTINGS: Record<string, { label: string; check: Check; gated?: boolean }> = {
  speakFirstNew: { label: "The voice speaks first on a new call", check: bool },
  idleSeconds: { label: "Hang up after this many seconds of silence", check: int(30, 300) },
  maxMinutes: { label: "Minutes before a session rolls over into the next", check: int(5, MAX_MINUTES_CAP) },
  liveNotices: { label: "Tell starred threads' replies during a call", check: bool },
  voice: { label: "Conversation voice, unless the phone chose one", check: oneOf(CONVERSATION_VOICES) },
  sampleText: { label: "What each reading voice's sample says", check: sampleText },
  minutes: {
    label: "How fast minutes are used, and the trial",
    check: fields({ fastPercent: int(100, 400), readingCharsPerSecond: int(10, 200), pickupSeconds: int(0, 60), trialDailySeconds: int(0, 3600), trialDays: int(0, 14) }),
  },
  allowances: { label: "Free seconds each UTC day, by account label", check: fields({ tester: int(0, 3600), presenter: int(0, 14_400) }) },
  backgroundCentsPerDay: { label: "Background work (briefing, rewrites) each account may cost us a UTC day (cents)", check: int(0, 500) },
  banner: { label: "Banner in the app, shown once", check: banner },
  minBuild: { label: "Oldest iOS build that may start a new call", check: fields({ ios: (v) => (v === null || (typeof v === "string" && /^\d{12}$/.test(v)) ? null : "must be a 12-digit build or none") }) },
  liveModel: { label: "Voice model", check: oneOf(LIVE_MODELS), gated: true },
  backendModel: { label: "Backend model", check: oneOf(BACKEND_MODELS), gated: true },
  prompts: { label: "Prompt sections", check: prompts, gated: true },
};

/**
 * Whether overrides need an eval pass: any gated setting. Speak-first switched on is gated through the prompts it
 * comes with; switched off, it never is (a kill switch).
 */
export const isGated = (o: Overrides) => Object.keys(o).some((k) => SETTINGS[k]?.gated && !(k === "prompts" && Object.keys(o.prompts as object).length === 0));

export type Overrides = Record<string, unknown>;

/**
 * Overrides as stored (JSON text or an object). `strict` (saving a version): any unknown key or bad value is a problem
 * and nothing is kept. Otherwise (a brain reading a version newer code wrote): each unknown key or bad value is
 * dropped, so it falls back to its default, and the rest apply.
 */
/** Keys a setting once had: a version saved with one still applies without it when read (saving one refuses it). */
const RETIRED: Record<string, string[]> = { minutes: ["weeklySeconds"] };

export function parseOverrides(raw: unknown, strict: boolean): { overrides: Overrides; problems: string[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { overrides: {}, problems: ["isn't JSON"] };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { overrides: {}, problems: ["must be an object"] };
  const overrides: Overrides = {};
  const problems: string[] = [];
  for (const [key, stored] of Object.entries(value)) {
    const retired = !strict && Object.hasOwn(RETIRED, key) && stored && typeof stored === "object" ? RETIRED[key] : [];
    const v = retired.length ? Object.fromEntries(Object.entries(stored as object).filter(([k]) => !retired.includes(k))) : stored;
    const setting = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
    const why = setting ? setting.check(v) : "isn't a setting";
    if (why) problems.push(`${key} ${why}`);
    else overrides[key] = v;
  }
  return strict && problems.length ? { overrides: {}, problems } : { overrides, problems };
}

/** Who can be given a candidate before everyone: testers, or staff (accounts tagged for Ops). */
export const AUDIENCES = ["testers", "staff"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * What a brain reads from Ops: the version everyone gets (`current`), one being tried on an audience first (`candidate`),
 * and how often the pointers have moved.
 */
export type Bundle = {
  generation: number;
  current: { id: number; overrides: unknown } | null;
  candidate?: { id: number; overrides: unknown } | null;
  audience?: Audience | null;
  /** Template hashes the eval has passed (§5): a brain applies a version's gated settings only if its own hash is here. */
  passing?: string[];
};
/** Whom an account counts as, from its server-verified labels. */
export type Who = { tester: boolean; staff: boolean };
export const NOBODY: Who = { tester: false, staff: false };

const inAudience = (audience: Audience | null | undefined, who: Who) => (audience === "testers" && who.tester) || (audience === "staff" && who.staff);

/** Git's settings with a version's overrides on top: objects (`minutes`, `allowances`, `minBuild`) key by key; prompts replace. */
export function apply(base: Settings, overrides: Overrides, version: number | null): Settings {
  const out: Record<string, unknown> = { ...base, version };
  for (const [k, v] of Object.entries(overrides)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = v && b && typeof v === "object" && typeof b === "object" && k !== "banner" && k !== "prompts" ? { ...b, ...v } : v;
  }
  return out as Settings;
}

/**
 * The settings for a call (or a balance, a voice list) now: git's, with the overrides of the version this account gets
 * on top: the candidate when it's in the candidate's audience, otherwise current; or `version`, as the account's own
 * brain resolved it (a Demo call), if this bundle has it. A key newer code wrote that this
 * code doesn't know, or a value it can't use, falls back to git's (`problems` says which).
 */
export type Resolving = {
  who?: Who;
  /** The version the account's own brain resolved (a Demo call). */
  version?: number | null;
  /** Whether a version's gated settings have an eval pass for their template hash on this code (`gateOf`). */
  passes?: (id: number) => boolean;
  /** No gated settings at all: an account on its own AI key, which was checked against git's models. */
  ungated?: boolean;
};

export function resolve(base: Settings, bundle: Bundle | null, o: Resolving = {}): { settings: Settings; problems: string[] } {
  const { who = NOBODY, version } = o;
  const pick = version !== undefined
    ? ([bundle?.candidate, bundle?.current].find((v) => v && v.id === version) ?? bundle?.current ?? null)
    : bundle?.candidate && inAudience(bundle.audience, who) ? bundle.candidate : (bundle?.current ?? null);
  if (!pick) return { settings: base, problems: [] };
  const { overrides, problems } = parseOverrides(pick.overrides, false);
  // The backstop (§5): gated settings only with an eval pass for this code's hash of them; the rest apply regardless.
  if (isGated(overrides) && (o.ungated || !o.passes?.(pick.id))) {
    for (const k of Object.keys(overrides)) if (SETTINGS[k]?.gated) delete overrides[k];
    if (!o.ungated) problems.push(`its prompt or model settings are inert: no eval pass for them on this brain`);
  }
  const settings = apply(base, overrides, pick.id);
  // The app's banner and the oldest build allowed are global: always current's, never a candidate's (§4.4).
  if (pick !== bundle?.current) {
    const current = resolve(base, bundle ? { ...bundle, candidate: null } : null, { passes: o.passes, ungated: o.ungated }).settings;
    settings.banner = current.banner;
    settings.minBuild = current.minBuild;
  }
  return { settings, problems };
}

/**
 * What an eval pass vouches for, as canonical JSON: every prompt section's template as it applies (placeholders
 * unfilled, overrides of editable ones in place), in order; the models; whether Driver speaks first; the suite. The
 * time, the briefing and the threads never enter it.
 */
export function templateManifest(s: Pick<Settings, "prompts" | "liveModel" | "backendModel" | "speakFirstNew">): string {
  return JSON.stringify({
    sections: PROMPT_SECTIONS.map((x) => [x.id, templateOf(x.id, s.prompts)]),
    liveModel: s.liveModel,
    backendModel: s.backendModel,
    speakFirstNew: s.speakFirstNew,
    suite: EVAL_SUITE_VERSION,
  });
}

/** The manifest's SHA-256, in hex: the same in Node and in a Worker. */
export async function templateHash(s: Parameters<typeof templateManifest>[0]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(templateManifest(s)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A version's template hash on this code: its overrides over `base`, as the manifest sees them. */
export async function versionHash(base: Settings, overrides: unknown): Promise<string> {
  return templateHash(apply(base, parseOverrides(overrides, false).overrides, null));
}

/**
 * For each version in `bundle` with gated settings, whether this code's hash of them has a pass: computed when the
 * bundle is read (hashing is async), so `resolve` can stay synchronous.
 */
export async function gateOf(base: Settings, bundle: Bundle | null): Promise<(id: number) => boolean> {
  const passing = new Set(bundle?.passing ?? []);
  const ok = new Set<number>();
  for (const v of [bundle?.current, bundle?.candidate]) if (v && passing.has(await versionHash(base, v.overrides))) ok.add(v.id);
  return (id) => ok.has(id);
}
