// Face ID in a call's own words (docs/launch/engine.md §6 and §11, stage 2b; Fable's 2b decisions, topics 4 to 7, binding
// for words): at Privacy's Face ID every time, what's said after a send's readback, what a spoken yes gets, what's said
// when Face ID didn't see the user or a send waited too long, and the "Approve to send" notification. Each line is built
// here, chosen in code by where the phone is (`At`, sent with its call-board poll), and said word for word: the voice
// model never chooses. Pure, for tests and the eval.
import { CATEGORY, clip, type Note } from "./reach.ts";

/**
 * Where the phone is, as it says with `GET /api/calls/current?at=`, in this precedence: `car` (CarPlay: a car's
 * Bluetooth can't be told from headphones), `locked` (the phone locked, or 10 & 2 not in front), `ear` (the proximity
 * sensor covered), `screen` (Call mode showing). Unknown (an older phone, no poll yet, headphones with the proximity
 * sensor not watched, or locked with no notification able to go): null.
 */
export type At = "car" | "locked" | "ear" | "screen";
export const AT: readonly At[] = ["car", "locked", "ear", "screen"];
export const isAt = (x: unknown): x is At => typeof x === "string" && (AT as readonly string[]).includes(x);

/** Said in the car, after the readback, in place of asking for a yes: the send is kept at once (Fable, topic 4). */
export const CAR_KEPT = "It's on your phone to approve when you can look.";

/**
 * What's said after a send's readback at Face ID every time, by where the phone is (Fable, topic 4): `start`, a new
 * thread; `keeps`, a reply to one thread or a dictated prompt, which can be kept for later instead, offered only where
 * hands may not be free and nothing was kept already (locked, unknown). Unknown: today's line, unchanged.
 */
export function faceIdAsk(at: At | null, o: { start: boolean; keeps: boolean }): string {
  const verb = o.start ? "start" : "send";
  switch (at) {
    case "screen": return `Look at your phone to ${verb} it.`;
    case "ear": return `Take the phone from your ear and look at it to ${verb} it.`;
    case "car": return CAR_KEPT;
    case "locked": return `Open the notification to ${verb} it${o.keeps ? ", or say keep it for later" : ""}.`;
    default: return o.keeps ? "Tap Send on your phone to go ahead, or say keep it for later." : "Tap Send on your phone to go ahead.";
  }
}

/** A keepable send's offer after a refused yes (Fable, topic 5). */
const KEEP_IT = " Or say keep it, and it'll be in Drafts.";
/** In the car, a send already open when Face ID every time was chosen is kept at once (Fable, topic 5). */
export const CAR_REFUSED = "That needs Face ID, so I've kept it. It's on your phone to approve when you can look.";

/**
 * A spoken yes held for Face ID (Fable, topic 5), by where the phone is: Tap Send, not Look at your phone, since by then
 * the sheet has usually been missed or cancelled and Send is what's on screen. In the car (`kept`: it was kept as the yes
 * came), `CAR_REFUSED`.
 */
export function faceIdRefusal(at: At | null, keeps: boolean, kept = false): string {
  if (kept) return CAR_REFUSED;
  const tail = keeps ? KEEP_IT : "";
  switch (at) {
    case "ear": return `That needs Face ID. Take the phone from your ear and tap Send.${tail}`;
    case "locked": return `That needs Face ID. Open the notification.${tail}`;
    default: return `That needs Face ID. Tap Send on your phone.${tail}`;
  }
}

/** Face ID asked on screen didn't see the user (it failed, or nobody in 15 s): the send is kept (Fable, topic 6). */
export const COULDNT_SEE = "I couldn't see you. It's in Drafts. Say send it to try again.";
/** A send kept at its 120 s unapproved while the call goes on, anywhere Face ID wasn't seen to fail (Fable, topic 6). */
export const KEPT_WAITING = "I've kept it in Drafts, waiting for your Face ID.";
/** Don't send on "Approve to send" during the call (Fable, topic 7). */
export const NOT_SENT = "Not sent.";
/** Approve on one that's no longer waiting: sent, changed or discarded elsewhere (Fable, topic 7). */
export const NO_LONGER_WAITING = "That's no longer waiting, so nothing was sent.";

/** The "Approve to send" notification's title (Fable, topic 7). */
export const APPROVE_TITLE = "Approve to send";

/** How much of the message the notification's body shows, on one line, cut at a word. */
const BODY_CHARS = 180;

/**
 * Its body (Fable, topic 7): a reply "To API: carry on" ("To a thread: carry on" with names hidden), a new thread "New
 * thread in shop: Add a dark mode switch…" ("New thread: …"), the words on one line, clipped at a word. No why: they're
 * the user's own words from a moment ago.
 */
export function approveBody(o: { start: boolean; name: string | null; message: string }): string {
  const words = approveWords(o.message);
  if (o.start) return o.name ? `New thread in ${o.name}: ${words}` : `New thread: ${words}`;
  return `To ${o.name ?? "a thread"}: ${words}`;
}

/** The message as "Approve to send" shows it: on one line, clipped at a word. */
const approveWords = (message: string) => clip(message.replace(/\s+/g, " ").trim(), BODY_CHARS);

/**
 * "Approve to send" (Fable, topic 7) for a send waiting for Face ID, `id` its proposal's or kept reply's: its own
 * notification under its own collapse id, never merged; `active` with no sound (in a call a sound would talk over the
 * voice, which has just said the line; after a car call the driver was told already); no why. `names`: Privacy's "Show
 * thread names". Its category's Approve opens the app (Face ID), and Don't send never asks.
 */
export function approveNoteOf(a: { id: string; start: boolean; name: string | null; message: string; expiresAt: number; conversationId?: string }, names: boolean): Note {
  return {
    type: "alert", kind: "approve", category: CATEGORY.approve, collapseId: `approve-${a.id}`, interruption: "active", expiresAt: a.expiresAt,
    title: APPROVE_TITLE, body: approveBody({ start: a.start, name: names ? a.name : null, message: a.message }), why: "", choices: [], reachOut: "",
    // `text`: the words, for the line that takes its place once it's sent ("Sent: carry on"); `thread`, that line's title
    // with names shown ("API"; a new thread, "New thread in shop").
    approve: { id: a.id, text: approveWords(a.message) }, ...(names && a.name ? { thread: a.start ? `New thread in ${a.name}` : a.name } : {}),
    ...(a.conversationId ? { conversationId: a.conversationId } : {}),
  };
}
