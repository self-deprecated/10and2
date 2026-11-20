// Which of a place's coding models the user means: their words against the names, and the providers, its coding app
// gives (docs/launch/thread-model.md, "Matching what was said" and "20 November, evening"). Pure, for tests.
import type { CodingModel, Place } from "./adapter.ts";
import { tokens } from "./handles.ts";
import { APPS, placeParts } from "./places.ts";

/** How many names a question or an offer says, the rest counted ("and 3 more"). */
const SAID = 5;
const NUMBER = /^\d+$/;
const FILLER = new Set(["the", "a", "model"]);
/** What may come before a model's name as it's passed on: "use the Sonnet one", "with Opus 5.5". */
const LEAD = new Set(["use", "using", "with", "on"]);
/** What may come before a provider's name, said with a model's: "Opus on the proxy", "Opus 5.5 with Claude Proxy". */
const VIA = new Set(["on", "with", "via", "through", "from", "in"]);

/**
 * The ways a model's name, or what was said for one, may be read, as compared: lower case, split at anything not a
 * letter or digit, numbers as digits with the point between them gone ("Opus 5.5" and "opus five point five" are both
 * opus 5 5), and without "the", "a", "model", a leading "use" or "with", or a trailing "one" ("the Sonnet one" is
 * sonnet; "six point one" keeps its one). After a number a trailing "one" may be the "one" said after a name ("the
 * GPT-5 one") or a digit ("opus four one", 4.1): both readings, that first.
 */
function readings(s: string): string[][] {
  // `tokens` keeps a lone "one" a word, so the one people say after a name can go before it's read as a number.
  const words = tokens(s).filter((w) => !FILLER.has(w));
  while (words.length > 1 && LEAD.has(words[0])) words.shift();
  const one = words.length > 1 && words.at(-1) === "one" && !["point", "dot"].includes(words.at(-2)!);
  const digits = (ws: string[]) => {
    const d = ws.map((w) => (w === "one" ? "1" : w));
    return d.filter((w, i) => !(["point", "dot"].includes(w) && NUMBER.test(d[i - 1] ?? "") && NUMBER.test(d[i + 1] ?? "")));
  };
  if (!one) return [digits(words)];
  return NUMBER.test(words.at(-2)!) ? [digits(words.slice(0, -1)), digits(words)] : [digits(words.slice(0, -1))];
}

/** A model's name, or what was said, as compared (`readings`; after a number, a trailing "one" as a digit). */
export const modelWords = (s: string): string[] => readings(s).at(-1)!;

/**
 * What the backend passes as a model to start a new thread as usual, after the user agreed to: a model named as the
 * prompt was dictated can't be had where it's starting (proposals.ts `startKept`). Never a model's name.
 */
export const USUAL = "default";
export const isUsual = (said: string | null | undefined) => said?.trim().toLowerCase() === USUAL;

/** A name as compared for once each: without case, spaces or punctuation. */
const nameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Whether two models' names are one, as compared for once each. */
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);
/** A model as compared for once each: its name and its provider, if any. */
const modelKey = (m: { name: string; provider?: string | null }) => `${nameKey(m.name)}|${nameKey(m.provider ?? "")}`;
/** Those of `ms` first of their key, in their order. */
const firstOf = <T>(ms: T[], key: (m: T) => string) => {
  const seen = new Set<string>();
  return ms.filter((m) => !seen.has(key(m)) && !!seen.add(key(m)));
};

/** A model as the readback and the start's answer say it: "Claude Opus 5.5 on Claude Proxy", or its name alone. */
export const withProvider = (m: { name: string; provider?: string | null }) => (m.provider ? `${m.name} on ${m.provider}` : m.name);

/**
 * The models' names, once each, in their order, each with the providers that serve it there, in theirs (none where its
 * coding app names none): the launch note's list, and what's offered.
 */
export function byName(models: CodingModel[]): { name: string; providers: string[] }[] {
  const out = new Map<string, { name: string; providers: string[] }>();
  for (const m of models) {
    const key = nameKey(m.name);
    if (!out.has(key)) out.set(key, { name: m.name, providers: [] });
    const { providers } = out.get(key)!;
    if (m.provider && !providers.some((p) => nameKey(p) === nameKey(m.provider!))) providers.push(m.provider);
  }
  return [...out.values()];
}

/** A coding model as Settings → New threads → Coding model lists it (`GET /api/places`' `codingModels`). */
export type CodingModelEntry = { name: string; provider: string | null; group: string };

/**
 * Every model `places` offer, once per name and provider, T3 Code's first, then the other coding apps' in their order
 * (each in the places' order), for Settings → New threads → Coding model. `group`, the heading it's under: its T3 Code provider's ("Claude Proxy · T3 Code"), else its coding app's.
 */
export function codingModels(places: Place[]): CodingModelEntry[] {
  // T3 Code's providers first, then the other coding apps in their order, as the Coding app list has them; within each,
  // the places' order (a stable sort).
  const order = Object.keys(APPS);
  return firstOf(places.map((p) => ({ p, app: placeParts(p).app })).sort((a, b) => order.indexOf(a.app) - order.indexOf(b.app)).flatMap(({ p, app }) =>
    (p.models ?? []).map((m) => ({ name: m.name, provider: m.provider ?? null, group: app === "t3" && m.provider ? `${m.provider} · T3 Code` : APPS[app] }))), modelKey);
}

/**
 * The provider said with a model, in `models`' providers' words: a provider's whole name after "on", "with", "via",
 * "through", "from" or "in" ("Opus 5.5 with Claude Proxy"), or anywhere when no model's name has its words; or its words
 * that no model's name has, or some of them ("Opus on the proxy": "proxy" of "Claude Proxy"). The longest said wins, a
 * whole name over part of one; two providers it fits as well both count. `rest`: what was said for the model. None
 * when no provider was said, or nothing else was.
 */
function providerSaid(said: string, models: CodingModel[]): { rest: string; providers: string[] } | null {
  const labels = firstOf(models.flatMap((m) => (m.provider ? [m.provider] : [])), nameKey);
  if (!labels.length) return null;
  const words = tokens(said).filter((w) => !FILLER.has(w));
  const inNames = new Set(models.flatMap((m) => modelWords(m.name)));
  let best: { from: number; to: number; whole: boolean; providers: string[] } | null = null;
  for (const label of labels) {
    const all = tokens(label).filter((w) => !FILLER.has(w));
    const own = all.filter((w) => !inNames.has(w));
    // Its whole name, then each run of its own words ("proxy"; of "Claude Max Proxy": "max", "max proxy", "proxy").
    const runs = [{ run: all, whole: true }, ...own.flatMap((_, a) => own.slice(a).map((_, b) => ({ run: own.slice(a, a + b + 1), whole: false })))];
    for (const { run, whole } of runs) {
      for (let i = 0; run.length && i + run.length <= words.length; i++) {
        if (!run.every((w, j) => words[i + j] === w)) continue;
        const via = i > 0 && VIA.has(words[i - 1]);
        // A whole name some model's has words of ("Claude") only after "on" and the like: else it's the model's.
        if (whole && !via && own.length < all.length) continue;
        // "the proxy provider", and "the proxy's" (said "proxy s").
        const [from, to] = [via ? i - 1 : i, i + run.length + (["provider", "s"].includes(words[i + run.length]) ? 1 : 0)];
        const size = to - from, bestSize = best ? best.to - best.from : 0;
        if (!best || size > bestSize || (size === bestSize && whole && !best.whole)) best = { from, to, whole, providers: [label] };
        else if (best.from === from && best.to === to && best.whole === whole && !best.providers.includes(label)) best.providers.push(label);
      }
    }
  }
  if (!best) return null;
  const rest = [...words.slice(0, best.from), ...words.slice(best.to)];
  return rest.some((w) => !LEAD.has(w)) ? { rest: rest.join(" "), providers: best.providers } : null;
}

/** Names as a question or an offer says them: "A, B or C", or the first few "and 3 more". */
export function sayNames(names: string[]): string {
  if (names.length > SAID) return `${names.slice(0, SAID).join(", ")} and ${names.length - SAID} more`;
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

/** Whether `said` is in `name`, in order and next to each other, and not part of a version: "opus 5" isn't "opus 5 5". */
function within(said: string[], name: string[]): boolean {
  for (let i = 0; i + said.length <= name.length; i++) {
    if (!said.every((w, j) => name[i + j] === w)) continue;
    if (NUMBER.test(said[0]) && NUMBER.test(name[i - 1] ?? "")) continue;
    if (NUMBER.test(said.at(-1)!) && NUMBER.test(name[i + said.length] ?? "")) continue;
    return true;
  }
  return false;
}

/** `viaProvider`: the user named its provider ("Opus on the proxy"), so the readback says it. */
export type ModelMatch = { kind: "match"; model: CodingModel; viaProvider: boolean } | { kind: "several"; names: string[] } | { kind: "none"; names: string[] };

/**
 * The model the user's words name among `models`: one whose name is exactly what they said wins (or is, but for a first
 * word one of them left out: "Opus 5.5" for "Claude Opus 5.5", or the other way round), else the only one whose name
 * has it. Said two ways (`readings`: "the GPT-5 one"), each way's matches count: GPT-5 or GPT-5.1 is asked, never
 * guessed. A provider said with it (`providerSaid`) narrows them to its; with none, a name several providers serve is
 * the first listed, the one a start with none would use. Several: the names to ask between (with their providers when
 * one was said: two of one name are told apart by them); none: every name, to offer (`sayNames`).
 */
export function matchModel(said: string, models: CodingModel[]): ModelMatch {
  const via = providerSaid(said, models);
  const pool = via ? models.filter((m) => via.providers.some((p) => nameKey(p) === nameKey(m.provider ?? ""))) : models;
  const named = pool.map((m) => ({ m, w: modelWords(m.name) }));
  const brand = (a: string[], b: string[]) => a.length > 1 && same(a.slice(1), b);
  // How well each reading matches: exactly, but for a first word, within a name; the best tier found, and its models.
  const tiers = readings(via?.rest ?? said).filter((words) => words.length).map((words) => {
    const all = [named.filter(({ w }) => same(w, words)), named.filter(({ w }) => brand(w, words) || brand(words, w)), named.filter(({ w }) => within(words, w))];
    const tier = all.findIndex((f) => f.length);
    return { tier: tier === -1 ? Infinity : tier, found: tier === -1 ? [] : all[tier] };
  });
  // Each reading's best; two readings that name different models are asked about, whichever matched more closely. In
  // the place's own order, once per name (and provider, when one was said).
  const found = firstOf(named.filter((n) => tiers.some((t) => t.found.includes(n))).map(({ m }) => m), (m) => (via ? modelKey(m) : nameKey(m.name)));
  const say = (ms: CodingModel[]) => (via ? ms.map(withProvider) : byName(ms).map((n) => n.name));
  if (found.length === 1) return { kind: "match", model: found[0], viaProvider: !!via };
  if (found.length > 1) return { kind: "several", names: say(found) };
  return { kind: "none", names: say(pool) };
}

/**
 * The provider the readback says with `model`, chosen in a place offering `models`: where they have its name on more
 * than one provider, or the user named one (`named`); else none.
 */
export function saidProvider(model: CodingModel, models: CodingModel[], named: boolean): { provider?: string } {
  if (!model.provider) return {};
  return named || models.some((m) => m.id !== model.id && nameKey(m.name) === nameKey(model.name)) ? { provider: model.provider } : {};
}

/**
 * Settings' default model (a name and maybe a provider, from `GET /api/places`) where the place offers one of that
 * name; never a question. That name on that provider where the place has both, else that name's first listed (a name
 * the place has as it is wins: "Muse One" beside "Muse"), else it's matched as said.
 */
export function defaultModel(name: string | null | undefined, provider: string | null | undefined, models: CodingModel[] | undefined): CodingModel | null {
  if (!name?.trim() || !models?.length) return null;
  const called = models.filter((m) => nameKey(m.name) === nameKey(name));
  const exact = called.find((m) => !!provider?.trim() && nameKey(m.provider ?? "") === nameKey(provider)) ?? called[0];
  if (exact) return exact;
  const m = matchModel(name, models);
  return m.kind === "match" ? m.model : null;
}

/** At most what a kept prompt keeps of a model (drafts.ts `m`). */
const KEPT_MAX = 60;
/**
 * A chosen model as a kept prompt keeps it, to match again where it starts: with its provider only when the user named
 * it (`named`), and when that fits whole (cut short, it would name another); else by its name, which another provider
 * of it, or another coding app, can still start.
 */
export const keptName = (m: { name: string; provider?: string | null; named?: boolean }) => (m.named && withProvider(m).length <= KEPT_MAX ? withProvider(m) : m.name);
