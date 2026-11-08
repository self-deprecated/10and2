// Vocabulary: the words a user says that speech recognition gets wrong, each with how it has been misheard ("embargo" ←
// "embar go", "I'm bar go"). Each user's own list is kept on their brain (the store's `vocabulary` key), on top of the
// global defaults below; a user's entry for a word replaces the default's. The phones fetch the merged list
// (`GET /api/vocabulary`) and rewrite their recognizers' text with it; the brain rewrites a call's input transcript and
// every tool call's arguments, and gives the words to both models (docs/launch/vocabulary.md).
//
// Matching is in one place per platform (here, ios/Driver/Vocabulary.swift, android/…/Vocabulary.kt), all three tested
// against brain/test/fixtures/vocabulary-cases.json: whole words and phrases only, case-insensitively, the longest
// mishearing first, never inside another word. Pure: no Node or Cloudflare imports.

export type Entry = { word: string; misheard: string[] };
/** An entry as the phone lists it: `mine`, the user's own (or their change to a default); `builtIn`, a default exists for the word. */
export type Listed = Entry & { mine: boolean; builtIn: boolean };

/**
 * Words every user says, with mishearings that are never ordinary speech: "ten to" ("ten to five") and "10 to" are left
 * out; "10 and 2" is in, since "between 10 & 2" means the same.
 */
export const DEFAULTS: readonly Entry[] = [
  { word: "10 & 2", misheard: ["tenant 2", "tenant two", "ten and two", "10 and 2", "ten & two", "10 & two", "ten and 2", "10 and two", "10and2", "ten n two", "tenon two", "tennant two"] },
  { word: "T3 Code", misheard: ["T three code", "tea three code", "tee three code", "T 3 code", "tea 3 code"] },
  { word: "Claude Code", misheard: ["cloud code", "clawed code", "claud code", "clod code"] },
  { word: "Codex", misheard: ["code x", "code ex"] },
  { word: "worktree", misheard: ["work tree"] },
  { word: "worktrees", misheard: ["work trees"] },
  { word: "TestFlight", misheard: ["test flight"] },
  { word: "GitHub", misheard: ["git hub"] },
  { word: "Xcode", misheard: ["ex code", "x code"] },
];

/** At most this many words, each with at most this many mishearings, each word or mishearing at most `CHARS` long. */
export const MAX_WORDS = 200;
export const MAX_MISHEARD = 20;
export const MAX_CHARS = 60;
/** How many words the models' instructions name: the user's own first. */
const PROMPT_WORDS = 40;

/** Trimmed, spaces collapsed, and a recognizer's punctuation at either end dropped ("Embar go." is "Embar go"). */
export const tidy = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^[\s.,!?;:"“”]+|[\s.,!?;:"“”]+$/g, "");
/** How two spellings are compared: case, curly apostrophes and spacing don't count. */
export const keyOf = (s: string) => tidy(s).toLowerCase().replace(/’/g, "'");

const BOUNDARY = "[\\p{L}\\p{N}'’]";
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** A mishearing as a pattern: any run of spaces between its words, either apostrophe within one. */
const patternOf = (misheard: string) => keyOf(misheard).split(" ").map((w) => w.split("'").map(escape).join("['’]")).join("\\s+");

/** A list ready to rewrite text with. */
export class Vocabulary {
  readonly entries: readonly Entry[];
  private readonly to = new Map<string, string>();
  private readonly pattern: RegExp | null;

  /** `entries` as merged (`merge`): each mishearing belongs to one word, and none is a word or found in one. */
  constructor(entries: readonly Entry[]) {
    this.entries = entries;
    for (const e of entries) for (const h of e.misheard) if (!this.to.has(keyOf(h))) this.to.set(keyOf(h), e.word);
    const all = [...this.to.keys()].sort((a, b) => b.length - a.length);
    this.pattern = all.length ? new RegExp(`(?<!${BOUNDARY})(?:${all.map(patternOf).join("|")})(?!${BOUNDARY})`, "giu") : null;
  }

  /** `text` with every mishearing replaced by its word. */
  correct(text: string): string {
    if (!this.pattern || !text) return text;
    return text.replace(this.pattern, (m) => this.to.get(keyOf(m)) ?? m);
  }

  /** The words, for the models' instructions: at most `PROMPT_WORDS`, in the list's order (the user's own first). */
  words(): string[] {
    return this.entries.slice(0, PROMPT_WORDS).map((e) => e.word);
  }
}

/** Matches `text` as a whole word or phrase of `within`. */
const foundIn = (text: string, within: string) =>
  new RegExp(`(?<!${BOUNDARY})${patternOf(text)}(?!${BOUNDARY})`, "iu").test(within);

/**
 * The user's own entries over the defaults, as the phone lists them: theirs first, then each default whose word they
 * haven't made their own. A mishearing belongs to the first word that has it (theirs win), and one that is itself a
 * word, or a whole word or phrase within one, is dropped, so the real words are never rewritten.
 */
export function merge(own: readonly Entry[], defaults: readonly Entry[] = DEFAULTS): Listed[] {
  const ownKeys = new Set(own.map((e) => keyOf(e.word)));
  const builtIn = new Set(defaults.map((e) => keyOf(e.word)));
  const listed: Listed[] = [
    ...own.map((e) => ({ ...e, mine: true, builtIn: builtIn.has(keyOf(e.word)) })),
    ...defaults.filter((e) => !ownKeys.has(keyOf(e.word))).map((e) => ({ ...e, misheard: [...e.misheard], mine: false, builtIn: true })),
  ];
  const words = listed.map((e) => e.word);
  const taken = new Set<string>();
  return listed.map((e) => ({
    ...e,
    misheard: e.misheard.filter((h) => {
      const k = keyOf(h);
      if (taken.has(k) || words.some((w) => foundIn(h, w))) return false;
      taken.add(k);
      return true;
    }),
  }));
}

/**
 * The user's own entries from a request (`PUT /api/vocabulary`), tidied: the same word twice is one entry, a mishearing
 * given twice (or the word itself) once. A string says what's wrong.
 */
export function parseOwn(body: unknown): Entry[] | string {
  const words = (body as { words?: unknown } | null)?.words;
  if (!Array.isArray(words)) return "words must be a list of { word, misheard }";
  const out: Entry[] = [];
  for (const raw of words) {
    const word = typeof raw?.word === "string" ? tidy(raw.word) : "";
    if (!word || word.length > MAX_CHARS) return `each word must be 1 to ${MAX_CHARS} characters`;
    if (raw.misheard !== undefined && !Array.isArray(raw.misheard)) return "misheard must be a list of how the word was misheard";
    const misheard: string[] = [];
    for (const h of raw.misheard ?? []) {
      const said = typeof h === "string" ? tidy(h) : "";
      if (!said || said.length > MAX_CHARS) return `each mishearing must be 1 to ${MAX_CHARS} characters`;
      misheard.push(said);
    }
    const same = out.find((e) => keyOf(e.word) === keyOf(word));
    const entry = same ?? { word, misheard: [] };
    for (const h of misheard) if (keyOf(h) !== keyOf(word) && !entry.misheard.some((x) => keyOf(x) === keyOf(h))) entry.misheard.push(h);
    if (entry.misheard.length > MAX_MISHEARD) return `at most ${MAX_MISHEARD} mishearings for a word`;
    if (!same) out.push(entry);
  }
  if (out.length > MAX_WORDS) return `at most ${MAX_WORDS} words`;
  return out;
}

/** Where the store keeps the user's own entries. */
export const STORE_KEY = "vocabulary";

/** The user's own entries, as kept (nothing kept, or unreadable: none). */
export function ownOf(store: { get(key: string): string | null }): Entry[] {
  const parsed = parseOwn({ words: safeJson(store.get(STORE_KEY)) });
  return typeof parsed === "string" ? [] : parsed;
}

const safeJson = (s: string | null): unknown => {
  try {
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
};

let cached: { raw: string | null; vocabulary: Vocabulary } | null = null;
/** The user's vocabulary, defaults included, built again only when what's kept has changed. */
export function vocabularyOf(store: { get(key: string): string | null }): Vocabulary {
  const raw = store.get(STORE_KEY);
  if (cached?.raw !== raw) cached = { raw, vocabulary: new Vocabulary(merge(ownOf({ get: () => raw }))) };
  return cached.vocabulary;
}

/**
 * A tool call's arguments with every string corrected, at any depth, except ids (`proposal_id`, `kept_id`, a key
 * ending in `id`), which name things exactly.
 */
export function correctArgs(value: unknown, vocabulary: Vocabulary, key = ""): unknown {
  if (typeof value === "string") return /(^|_)id$|Id$/.test(key) ? value : vocabulary.correct(value);
  if (Array.isArray(value)) return value.map((v) => correctArgs(v, vocabulary, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, correctArgs(v, vocabulary, k)]));
  return value;
}
