// When you last wrote in a thread yourself (`WorkItem.typed`, docs/launch/engine.md §11 stage 3.9; ported from
// spike/away-watch's `personWrote`): what the brain reads as "you read the thread up to there", and, typed at a computer,
// as "you're back" (Away ends on it). Each adapter says which messages its work system marks as a person's (`Write`);
// this leaves out the ones that are 10 & 2's own sends, as the connector recorded them before handing them over (the
// Ledger's `sent`), by their words and time, so a follow-up agreed in a call or tapped on a notification is never taken
// for you writing, whichever way the work system records it.
import { createHash } from "node:crypto";

/**
 * One message a work system says a person typed: when (its own time), a digest of its words (`digestOf`), whether it's
 * known to be typed at a computer (`desk`, what ends Away: not T3 Code's phone app, nor OpenCode's or Pi's, whose plugins
 * and extensions write the user's message too), and whether it's the thread's first message, which 10 & 2's own new work
 * can be.
 */
export type Write = { at: string; digest: string; desk: boolean; first?: boolean };

/**
 * One of 10 & 2's own sends, as the Ledger recorded it as it went: its operation key, the thread it went to (null for
 * new work, whose thread isn't known until it starts), a digest of its words, when (ms), and once it's been seen, the
 * message it was found as (`found`, kept by the Ledger: `typedOf`).
 */
export type Sent = { key: string; item: string | null; digest: string; at: number; found?: Found | null };
/** The message a send was found as: its thread and its own time (`Write.at`). */
export type Found = { item: string; at: string };

/** How long after a send its message may first show (a follow-up queued behind a long run is written when it ends). */
export const SEND_TAKES_MS = 12 * 3600_000;
/**
 * How long after 10 & 2's new work its thread may be made: the work system makes it as the start is sent (seconds; a
 * worktree made first, a minute or two). A thread made later with the same first words is yours (the skeptic on
 * 7717d10f3219).
 */
export const NEW_WORK_MS = 10 * 60_000;
/** A computer's clock read twice: a message may be stamped a little before the send that made it. */
const SKEW_MS = 60_000;
/** The most writes an adapter keeps per thread: the newest, which is all the brain asks of them. */
export const WRITES_KEPT = 20;

/** A digest of a message's words, the same however a work system keeps them (cut, spaced): its first 500 characters. */
export function digestOf(words: string): string {
  return createHash("sha256").update(words.replace(/\s+/g, " ").trim().slice(0, 500)).digest("hex").slice(0, 32);
}

/**
 * `WorkItem.typed` for one thread from its writes and 10 & 2's sends: each send takes the first write after it with its
 * words, in its thread (new work: only a thread's first message, in a thread made as it was sent, `NEW_WORK_MS`, by
 * `createdAt` or else that message's time), once; the rest are yours. `at`: the newest of yours;
 * `desk`: the newest typed at a computer. Null for none. A send takes its write once and keeps it (`found`, which
 * `claim` hands the Ledger to keep, and is set on the send): it takes only that write from then on, so once that's
 * older than the newest writes an adapter keeps (`WRITES_KEPT`) it takes nothing, never your same words later (the review of
 * 45ec9eccdf6f, F5: "Continue" typed 20 messages on was taken for 10 & 2's, and Away stayed on).
 */
export function typedOf(item: string, writes: readonly Write[], sends: readonly Sent[], claim?: (key: string, found: Found) => void, createdAt?: string | null): { at: string | null; desk: string | null } {
  const ordered = [...writes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const taken = new Set<Write>();
  const mine = sends.filter((s) => s.item === null || s.item === item);
  // Found before: that write and no other, if it's still among them.
  for (const s of mine) {
    if (!s.found || s.found.item !== item) continue;
    const at = Date.parse(s.found.at);
    const w = ordered.find((x) => !taken.has(x) && x.digest === s.digest && Date.parse(x.at) === at);
    if (w) taken.add(w);
  }
  // New work's thread is made as it's sent: one made later with its words is yours.
  const made = (x: Write, s: Sent) => { const at = Date.parse(createdAt ?? x.at); return at >= s.at - SKEW_MS && at - s.at <= NEW_WORK_MS; };
  for (const s of mine.filter((s) => !s.found).sort((a, b) => a.at - b.at)) {
    const w = ordered.find((x) => !taken.has(x) && x.digest === s.digest && (s.item !== null || (!!x.first && made(x, s))) && Date.parse(x.at) >= s.at - SKEW_MS && Date.parse(x.at) - s.at <= SEND_TAKES_MS);
    if (!w) continue;
    taken.add(w);
    s.found = { item, at: w.at };
    claim?.(s.key, s.found);
  }
  const yours = ordered.filter((w) => !taken.has(w));
  return { at: yours.at(-1)?.at ?? null, desk: yours.filter((w) => w.desk).at(-1)?.at ?? null };
}

/** Keeps the newest `WRITES_KEPT` of a thread's writes. */
export const newest = (writes: Write[]): Write[] => writes.length > WRITES_KEPT ? writes.slice(-WRITES_KEPT) : writes;
