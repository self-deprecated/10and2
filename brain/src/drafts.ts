// A reply the user dictated on the phone, in their own words, sent as they said it. The phone records and transcribes
// it, keeps it until it's sent, and reads it back to the user; the brain only puts the parts together, with which
// paragraph of the reply each one answers, and sends it through the usual proposal and its heard gate.
import { randomUUID } from "node:crypto";
import type { Segment } from "./reading.ts";
import type { Proposal, Store } from "./store.ts";

/**
 * One recorded part: what the user said and, when they said it while a reply was read to them, the reading and its
 * paragraph (the brain's, from 0; -1 for the lead-in) it answers.
 */
export type DraftPart = { text: string; readingId: string | null; paragraph: number | null };
export type Draft = { id: string; itemId: string; parts: DraftPart[] };

/**
 * A draft for a thread not started yet (`dictate` with no thread): maybe where to start it (`placeId`, when the user
 * named the project before dictating) and a launch profile they asked for, carried as the draft's target ("new:…"), so
 * the phone keeps and sends it like any other. The work system names the thread. Everything in it is checked again when
 * it's proposed, as a start said aloud is; with no place, Driver asks which project after the dictation.
 */
export type NewThread = { placeId: string | null; profile: string | null };

/**
 * `new:` and, base64url, `{"n": <a fresh id, so two prompts never share a draft>, "p": place, "f": profile}`. Phones in
 * TestFlight before 8 November keep `[placeId, title, profile]` instead: still read, the title ignored. That shape can go
 * once every tester's build is from 8 November or later (voice-new-thread.md).
 */
export const newThreadTarget = (t: NewThread, id = randomUUID().slice(0, 8)) =>
  `new:${Buffer.from(JSON.stringify({ n: id, ...(t.placeId ? { p: t.placeId } : {}), ...(t.profile ? { f: t.profile } : {}) })).toString("base64url")}`;

export const isNewThread = (itemId: string) => itemId.startsWith("new:");

export function parseNewThread(itemId: string): NewThread | null {
  if (!isNewThread(itemId)) return null;
  const given = (v: unknown) => (typeof v === "string" && v ? v : null);
  try {
    const t = JSON.parse(Buffer.from(itemId.slice(4), "base64url").toString("utf8"));
    if (Array.isArray(t)) {
      const [placeId, title, profile] = t;
      return [placeId, title, profile].every((v) => typeof v === "string" && v) ? { placeId, profile } : null;
    }
    return t && typeof t === "object" && given(t.n) ? { placeId: given(t.p), profile: given(t.f) } : null;
  } catch {
    return null;
  }
}

/**
 * What a new thread is called until the work system has named it: "your new thread in driver". The voice and the
 * receipts say it; T3 Code and Claude Code name the thread from its first prompt.
 */
export const newThreadName = (place: string | null | undefined) => (place ? `your new thread in ${place}` : "your new thread");

/** Words as compared for a project's name: "screen-gate" is "screen gate". */
const plainWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Projects a dictated prompt names in passing ("…in the driver repo…"), by name without the machine: Driver offers to
 * start it there, for the user to confirm. At most three.
 */
export function mentionedPlaces(text: string, places: { name: string }[]): string[] {
  const said = ` ${plainWords(text)} `;
  const projects = [...new Set(places.map((p) => p.name.replace(/, on [\w-]+$/, "")))];
  return projects.filter((p) => plainWords(p) && said.includes(` ${plainWords(p)} `)).slice(0, 3);
}

/** The longest dictated reply: about half an hour of speech. */
export const DRAFT_MAX = 20_000;
const QUOTE_MAX = 100;

/** The phone's draft, or null when it isn't one. */
export function parseDraft(raw: unknown): Draft | null {
  let d: any = raw;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object" || typeof d.id !== "string" || !/^[\w-]{8,64}$/.test(d.id)) return null;
  if (typeof d.itemId !== "string" || !d.itemId || d.itemId.length > 300 || !Array.isArray(d.parts)) return null;
  const parts: DraftPart[] = [];
  for (const p of d.parts.slice(0, 100)) {
    const text = typeof p?.text === "string" ? p.text.trim() : "";
    if (!text) continue;
    const readingId = typeof p.readingId === "string" && /^[0-9a-f]{24}$/.test(p.readingId) ? p.readingId : null;
    const paragraph = Number.isInteger(p.paragraph) && p.paragraph >= -1 ? p.paragraph : null;
    parts.push({ text, readingId, paragraph: readingId === null ? null : paragraph });
  }
  return parts.length ? { id: d.id, itemId: d.itemId, parts } : null;
}

export const wordCount = (d: Draft) => d.parts.reduce((n, p) => n + (p.text.match(/\S+/g)?.length ?? 0), 0);

/** The start of a paragraph, as a short quote: whole words, on one line, and no quote marks of its own. */
function shortQuote(paragraph: string): string | null {
  const text = paragraph.replace(/["“”]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= QUOTE_MAX) return text;
  const cut = text.slice(0, QUOTE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), QUOTE_MAX / 2)).replace(/[\s,;:.]+$/, "")}…`;
}

/** The start of a paragraph of what was read, as a short quote. */
const quote = (segments: Segment[], paragraph: number) => shortQuote(segments.filter((s) => s.paragraph === paragraph).map((s) => s.text).join(" "));

/**
 * A reply sent with a tap (`/api/reply`): the user's words as they wrote them, after the start of the paragraph of the
 * thread's reply they answer, if they picked one ("Reply to this"), as a quoted line.
 */
export function tappedReply(text: string, paragraph: string | null): string {
  const said = paragraph === null ? null : shortQuote(paragraph.slice(0, 2000));
  return said ? `> ${said}\n\n${text}` : text;
}

/** What a tapped reply says, without the dictation's first line (a kept reply's) or the quoted line it may start with. */
export const tappedWords = (message: string) => dictatedParts(message).text.replace(/^> [^\n]*\n\n/, "");

/** The first line of a dictated message, saying it was dictated: parts answering a reply as it was read, or none. */
const DICTATED = "(Dictated by voice in Driver and transcribed on my phone, so names and technical words may be misheard.)";
const DICTATED_READ = "(Dictated by voice in Driver while your reply was read to me, and transcribed on my phone, so names and technical words may be misheard.)";

/** A message as its first line saying it was dictated (`note`), if it has one, and the user's words after it. */
export function dictatedParts(message: string): { note: string | null; text: string } {
  for (const note of [DICTATED, DICTATED_READ]) if (message.startsWith(`${note}\n\n`)) return { note, text: message.slice(note.length + 2) };
  return { note: null, text: message };
}

/**
 * The message the agent gets: the user's words as transcribed, nothing reworded. Parts recorded while its reply was
 * read say which paragraph they answer, with the start of it as the user heard it; the rest stand on their own.
 * `segments` gives a reading's segments, for the quotes; a reading of another thread is never quoted.
 */
export function assemble(draft: Draft, segments: (readingId: string) => { itemId: string; segments: Segment[] } | null): string {
  const anchored = draft.parts.some((p) => p.readingId !== null);
  const header = anchored ? DICTATED_READ : DICTATED;
  if (!anchored) return [header, ...draft.parts.map((p) => p.text)].join("\n\n");
  const blocks = draft.parts.map((p) => {
    if (p.readingId === null || p.paragraph === null) return `Overall:\n${p.text}`;
    if (p.paragraph < 0) return `On what I'd asked you:\n${p.text}`;
    const reading = segments(p.readingId);
    const said = reading && reading.itemId === draft.itemId ? quote(reading.segments, p.paragraph) : null;
    return `On paragraph ${p.paragraph + 1} of your reply${said ? ` ("${said}")` : ""}:\n${p.text}`;
  });
  return [header, ...blocks].join("\n\n");
}

/**
 * How the phone learns what became of a draft it handed over: sent, maybe sent (the outcome was lost), kept for later on
 * the brain (`keptId`: it's in Not sent), or not.
 */
export type DraftState = "sent" | "unknown" | "kept" | "unsent";

export function draftState(proposals: Proposal[]): { state: DraftState; result: string | null } {
  const sent = proposals.find((p) => p.state === "executed" || p.state === "partial");
  if (sent) return { state: "sent", result: sent.result };
  const unsure = proposals.find((p) => p.state === "unknown" || p.state === "executing");
  if (unsure) return { state: "unknown", result: unsure.result };
  return { state: "unsent", result: null };
}

export function draftStateOf(store: Store, draftId: string): { state: DraftState; result: string | null; keptId?: string } {
  const s = draftState(store.draftProposals(draftId));
  const kept = s.state === "unsent" ? store.keptByDraft(draftId) : null;
  return kept ? { state: "kept", result: null, keptId: kept.id } : s;
}
