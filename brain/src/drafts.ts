// A reply the user dictated on the phone, in their own words, sent as they said it. The phone records and transcribes
// it, keeps it until it's sent, and reads it back to the user; the brain only puts the parts together, with which
// paragraph of the reply each one answers, and sends it through the usual proposal and its heard gate.
import type { Segment } from "./reading.ts";
import type { Proposal, Store } from "./store.ts";

/**
 * One recorded part: what the user said and, when they said it while a reply was read to them, the reading and its
 * paragraph (the brain's, from 0; -1 for the lead-in) it answers.
 */
export type DraftPart = { text: string; readingId: string | null; paragraph: number | null };
export type Draft = { id: string; itemId: string; parts: DraftPart[] };

/**
 * A draft for a thread not started yet (`dictate` with a project): where to start it, its title and profile, carried as
 * the draft's target ("new:…"), so the phone keeps and sends it like any other. Everything in it is checked again when
 * it's proposed, as a start said aloud is.
 */
export type NewThread = { placeId: string; title: string; profile: string };

export const newThreadTarget = (t: NewThread) => `new:${Buffer.from(JSON.stringify([t.placeId, t.title, t.profile])).toString("base64url")}`;

export function parseNewThread(itemId: string): NewThread | null {
  if (!itemId.startsWith("new:")) return null;
  try {
    const [placeId, title, profile] = JSON.parse(Buffer.from(itemId.slice(4), "base64url").toString("utf8"));
    return [placeId, title, profile].every((v) => typeof v === "string" && v) ? { placeId, title, profile } : null;
  } catch {
    return null;
  }
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

/** The start of a paragraph of what was read, as a short quote: whole words, and no quote marks of its own. */
function quote(segments: Segment[], paragraph: number): string | null {
  const text = segments.filter((s) => s.paragraph === paragraph).map((s) => s.text).join(" ").replace(/["“”]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= QUOTE_MAX) return text;
  const cut = text.slice(0, QUOTE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), QUOTE_MAX / 2)).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * The message the agent gets: the user's words as transcribed, nothing reworded. Parts recorded while its reply was
 * read say which paragraph they answer, with the start of it as the user heard it; the rest stand on their own.
 * `segments` gives a reading's segments, for the quotes; a reading of another thread is never quoted.
 */
export function assemble(draft: Draft, segments: (readingId: string) => { itemId: string; segments: Segment[] } | null): string {
  const anchored = draft.parts.some((p) => p.readingId !== null);
  const header = anchored
    ? "(Dictated by voice in Driver while your reply was read to me, and transcribed on my phone, so names and technical words may be misheard.)"
    : "(Dictated by voice in Driver and transcribed on my phone, so names and technical words may be misheard.)";
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

/** How the phone learns what became of a draft it handed over: sent, maybe sent (the outcome was lost), or not. */
export type DraftState = "sent" | "unknown" | "unsent";

export function draftState(proposals: Proposal[]): { state: DraftState; result: string | null } {
  const sent = proposals.find((p) => p.state === "executed" || p.state === "partial");
  if (sent) return { state: "sent", result: sent.result };
  const unsure = proposals.find((p) => p.state === "unknown" || p.state === "executing");
  if (unsure) return { state: "unknown", result: unsure.result };
  return { state: "unsent", result: null };
}

export const draftStateOf = (store: Store, draftId: string) => draftState(store.draftProposals(draftId));
