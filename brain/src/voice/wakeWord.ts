// The user's wake word ("10 & 2" unless they chose "Driver" or their own), as the phones match it (WakeWord.swift,
// WakeWord.kt): words compared in a normal form ("ten" is "10", "&" is "and"), with the spellings recognizers give
// listed. In a call the voice model hears it and acts through its instructions; the brain only needs it for the phrase
// check's backstop ("10 & 2, hold"), so a leading wake word is taken off before the check. Until the Vocabulary thread's
// list lands, the built-in spellings are here.

export const STANDARD_WAKE_WORD = "10 & 2";

/** The wake word a phone sends with a call (`wakeWord`): its own, trimmed and kept short; "Driver" for an older phone. */
export function wakeWordOf(body: { wakeWord?: unknown }): string {
  if (typeof body.wakeWord !== "string") return "Driver";
  const phrase = body.wakeWord.replace(/\s+/g, " ").trim().slice(0, 40);
  return phrase || STANDARD_WAKE_WORD;
}

const NUMBERS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20",
};

type Token = { word: string; start: number; end: number };

/** Lowercased words and numbers, with where each is: "10 & 2, hold." is 10, and, 2, hold. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}'’]+|&/gu)) {
    const word = m[0] === "&" ? "and" : m[0].toLowerCase().replace(/’/g, "'");
    out.push({ word, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const normal = (word: string) => NUMBERS[word] ?? word;

/** Every spelling of `phrase`, in normal form, longest first. */
export function spellings(phrase: string): string[][] {
  const base = tokens(phrase).map((t) => normal(t.word));
  const extra = base.join(" ") === "10 and 2" ? ["10 2", "102", "1002", "10 02", "10 n 2", "tenant 2"] : [];
  const all = [phrase, ...extra].map((s) => tokens(s).map((t) => normal(t.word))).filter((s) => s.length);
  const unique = [...new Map(all.map((s) => [s.join(" "), s])).values()];
  return unique.sort((a, b) => b.length - a.length);
}

/** Words that say nothing before the wake word: "okay, 10 & 2, hold". */
const FILLERS = new Set(["okay", "ok", "so", "um", "uh", "er", "oh", "well", "right", "hey", "and", "yeah", "yes"]);

/**
 * `said` with a wake word at its start (fillers aside) taken off, and the comma after it: "Ten and two, hold." is
 * "hold.". Anything else is left as it is.
 */
export function withoutWakeWord(said: string, phrase: string): string {
  const words = tokens(said);
  const normalWords = words.map((t) => normal(t.word));
  const all = spellings(phrase);
  // At the start, or after fillers ("okay, 10 & 2"); a wake word can begin with one ("Hey Copilot").
  for (let i = 0; i < words.length; i++) {
    const spelling = all.find((s) => s.every((w, k) => normalWords[i + k] === w));
    if (spelling) return said.slice(words[i + spelling.length - 1].end).replace(/^[\s,.:;!\-–—]+/, "");
    if (!FILLERS.has(words[i].word)) break;
  }
  return said;
}
