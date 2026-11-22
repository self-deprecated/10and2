// What Commands that wait say (docs/launch/engine.md §11 stage 4, "Then"; Fable's decisions 4-H1 to 4-H3 and 4-L,
// binding for words): a command on a computer's list, held there until the user lets it run from the phone or it's
// stopped. Each line is built here and said or shown word for word, never the model's own, in the style of
// watch-lines.ts. A computer is named only when the account has more than one (`computers`). Thread names leave a
// notification only when Privacy hides them (`names`); the card, the Timeline and a call always name the thread. The
// command is the computer's own, masked (connector/src/gate.ts): `matched`, the one on the list it ran ("terraform
// apply"), names it; `command`, the whole Bash call, is what the body and the card show.
import { createHash } from "node:crypto";
import { clip, computerOf } from "./later-lines.ts";
import { CATEGORY, type Note, type ReachOut } from "./reach.ts";
import { masked } from "./reading.ts";
import type { Store } from "./store.ts";

/** A held command as the brain knows it (`WorkItem.gate`, `ReachOut.held`). */
export type HeldCommand = { command: string; matched: string; since: number };

/** How a hold ended, as the brain knows it: let run or stopped from the phone, no answer in time, or anywhere else. */
export type HeldEnd = "run" | "stop" | "timeout" | "elsewhere";

/** How long the computer waits before the agent is told no (connector/src/gate.ts `GATE_MS`): 5 h 59 min. */
export const HELD_MS = (21_600 - 60) * 1000;

/**
 * Spoken words that would let a held command run, which only the release path may (Fable's 4-H3): refused before any
 * readback, and it stays held. The connector refuses the same words too (connector/src/gate.ts `letsRun`, this one).
 * Only a yes or a "let it run", with nothing after it but more of the same or a word that adds nothing ("go ahead, no
 * worries", "yes, no problem", "go now"); anything else ("okay use the staging file", "yes do it without the flag",
 * "fine, but use staging", "start over") is words for the thread, read back as stopping it, the safe side (Fable's nits
 * on stage 4 and its fix4, and the fix4 code review's).
 */
export const letsRun = (words: string) => LETS_RUN.test(words.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim());
/**
 * What opens words that would let it run: a yes, or asking for it to run ("i approve", "please let it run", "you can
 * let it run", "let that run", "that's fine": Fable's should on fix4, as people agree out loud; "alright", "just do it",
 * "it's okay": Fable's nit on fix5). Never "let it go", which drops it: words for the thread.
 */
const LET_OPENS = "yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|go|go ahead|go on|go for it|let's go|do it|just do it|do that|start|approve|approved|approve it|i approve|proceed|sounds good|looks good|ship it|that works|let it(?! go(?! ahead| on))|let it run|let that run|run it|run that|allow|allow it|carry on|release|release it|please|you can|that's fine|it's fine|it's ok|it's okay|that's ok|that's okay|for sure|all good|of course|definitely|absolutely";
/**
 * What may follow it and still only agree: another of those, or a word that adds nothing ("no worries", "for sure", "i'm
 * sure", "cool"). Never "never mind" alone, which calls it off (the skeptic's nit on fix4): "okay never mind" is words for
 * the thread, read back as stopping it.
 */
const LET_ADDS = `${LET_OPENS}|it|then|now|just|and|right away|thanks|thank you|no worries|no problem|no problems|never mind the warnings?|stop worrying|don't worry|don't worry about it|for sure|i'm sure|thing|cool|great|do|that|it's ok|it's okay|that's ok|that's okay`;
const LETS_RUN = new RegExp(`^(?:${LET_OPENS})(?: (?:${LET_ADDS}))*$`);

/**
 * Spoken words that stop a held command at once, with no readback and no yes (Fable's 4-H3: saying no never asks): a no
 * ("no thanks", "nah", "absolutely not", "hell no": Fable's nit on fix6), a stop ("please don't", "don't run that",
 * "don't let that run", "stop it please", "kill that"), or both, read as `letsRun` reads its words (Fable's should on
 * fix5: these were read back for a yes). Anything else is words for the thread, read back as stopping it; a question
 * ("no?") is never a no.
 */
export const stopsIt = (words: string) => !/\?/.test(words) && STOPS_IT.test(words.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim());
const NOES = "no|nope|nah|hell no|no way|no thanks|no thank you|absolutely not|definitely not|certainly not|of course not";
const STOPS = "(?:stop|cancel|kill|deny|refuse)(?: it| that| this)?|(?:don't|do not)(?: (?:let|run|do) (?:it|that|this)(?: run)?)?";
const NO_TAILS = "please|now|thanks|thank you";
const STOPS_IT = new RegExp(`^(?:(?:${NOES}) )*(?:please )?(?:${STOPS})(?: (?:${NO_TAILS}))*$|^(?:please )?(?:${NOES})(?: (?:${NOES}|${NO_TAILS}))*$`);

// --- in a call (4-H3) ---

/** Told like a question, through the in-call queue: what it wants to run, where, and where the button is. */
export const heldSaid = (thread: string, matched: string, machine: string, computers: number) =>
  `${thread} wants to run ${clip(matched, 60)}${computers > 1 ? `, on ${machine}` : ""}. It's waiting for you on your phone.`;

/**
 * In a briefing read in full, after the thread's name line and its reply, in place of the hold's raw question ("wants to
 * run terraform apply -auto-approve"): what it wants to run and where the button is, the thread just named (Fable's
 * finding on 4-I's third review). Nothing about letting it run. The command as matched, flags too, clipped at 60 with
 * no "…" and its credentials said as hidden before the full stop, so the sentence always ends there (Fable's and the
 * skeptic's findings on 4-I's fourth review).
 */
export const heldInFull = (matched: string) => `It wants to run ${masked(clip(matched, 60).replace(/…$/, ""))}. It's waiting for you on your phone.`;

/** Where the phone is, as the brain knows it (2b tells the ear and a locked phone; until then a car's call is `car`). */
export type Where = "screen" | "ear" | "car";
/** A spoken "let it run" refused, by where the phone is (chosen in code): the hold stays held. */
export const NOT_BY_VOICE: Record<Where, string> = {
  screen: "I can't let it run by voice. Tap Let it run on your phone.",
  ear: "I can't let it run by voice. Take the phone from your ear and tap Let it run.",
  car: "I can't let it run by voice. It's on your phone for when you can look.",
};
/** A spoken no: stopped at once. */
export const toldNo = (thread: string) => `Stopped. ${thread} was told no.`;
/** Any other message for a thread holding a command: it would stop the command, so the readback says so. */
export const stopsReadback = (matched: string, thread: string, words: string) => `That stops ${clip(matched, 60)} and tells ${thread}: "${words}". Send it?`;
/** After the yes to `stopsReadback`. */
export const sentStopped = (matched: string) => `Sent. ${clip(matched, 60)} wasn't run.`;
/** The phone's line for a follow-up the computer refused because its words would let it run (connector `TAP_TO_RUN`). */
export const TAP_TO_RUN = "Nothing was sent. To let it run, tap Let it run in 10 & 2.";

// --- the notification (4-H2, 4-L) ---

/** Why it came (4-0 (8)): it's on that computer's list. */
export const heldWhy = (machine: string, computers: number) => `It's on your list${computers > 1 ? ` on ${machine}` : ""}.`;

/** Its collapse id: the hold's own (its thread and its id), so the line that takes its place when it ends goes where it was. */
export const heldCollapse = (itemId: string, questionId: string) => `h-${createHash("sha256").update(`${itemId}\n${questionId}`).digest("hex").slice(0, 40)}`;

/**
 * The held command's notification (category HELD; active, default sound, like a question): "terraform apply is waiting
 * on Quartz", "API wants to run:", the command, why; Let it run (it opens the app) and Stop it. Names hidden: "A thread
 * wants to run:", the command still shown (Show thread names hides names only). What agents ask and say off (Privacy,
 * stage 3.4): no command, "A command is waiting on Quartz" / "API wants to run a command."; the app's card and sheet
 * still show it. Never answer buttons, quick replies, Reply… or Call back.
 */
export function heldNoteOf(r: ReachOut, held: HeldCommand, o: { names: boolean; computers: number; asks?: boolean }): Note {
  const machine = r.news.machine ?? "your computer";
  const thread = o.names ? r.news.handle : "A thread";
  return {
    type: "alert", kind: "held", category: CATEGORY.held, collapseId: heldCollapse(r.news.itemId, r.news.question?.id ?? r.key), interruption: "active", sound: "default", expiresAt: held.since + HELD_MS,
    title: `${o.asks === false ? "A command" : clip(held.matched, 32)} is waiting${o.computers > 1 ? ` on ${machine}` : ""}`,
    body: o.asks === false ? `${thread} wants to run a command.` : [`${thread} wants to run:`, clip(held.command, 120)].join("\n"),
    why: heldWhy(machine, o.computers), choices: [], reachOut: r.key, item: r.news.itemId,
    ...(o.names ? { thread: r.news.handle } : {}),
    ...(r.news.question?.id ? { question: { itemId: r.news.itemId, questionId: r.news.question.id } } : {}),
    held: { command: held.command, matched: held.matched },
  };
}

/**
 * The line that takes its place once it ends (same collapse id): passive with no buttons, "API" over "terraform apply: let
 * run from your phone." (stopped…, or "No longer waiting."). No answer in 5 h 59 min: active with its sound,
 * "terraform apply wasn't run", "API waited 6 hours and was told no.", why. What agents ask and say off: no command
 * ("A command wasn't run", "Let run from your phone.", "Stopped from your phone.").
 */
export function heldOverOf(r: ReachOut, held: HeldCommand, end: HeldEnd, o: { names: boolean; computers: number; now: number; asks?: boolean }): Note {
  const thread = o.names ? r.news.handle : "A thread";
  const base = { type: "alert" as const, kind: "held" as const, collapseId: heldCollapse(r.news.itemId, r.news.question?.id ?? r.key), choices: [], reachOut: r.key, item: r.news.itemId, expiresAt: o.now + 24 * 3600_000, ...(o.names ? { thread: r.news.handle } : {}) };
  const what = o.asks === false ? null : clip(held.matched, 32);
  if (end === "timeout") {
    return { ...base, interruption: "active", sound: "default", title: `${what ?? "A command"} wasn't run`, body: `${thread} waited 6 hours and was told no.`, why: heldWhy(r.news.machine ?? "your computer", o.computers) };
  }
  const body = end === "run" ? (what ? `${what}: let run from your phone.` : "Let run from your phone.") : end === "stop" ? (what ? `${what}: stopped from your phone.` : "Stopped from your phone.") : "No longer waiting.";
  return { ...base, interruption: "passive", title: thread, body, why: "" };
}

// --- in the app (4-H2) ---

/** The card's lines: "API wants to run" / the command / "On Quartz · since 14:02". */
export const cardTitle = (thread: string) => `${thread} wants to run`;
/** After Let it run (shown for 2 s), and after Stop it. */
export const LET_RUN = "Let run.";
/** A tap that arrives after the hold ended. */
export const NO_LONGER = "No longer waiting, so nothing was sent.";
/** Face ID's reason: "Let API run terraform apply" (the command clipped to 60). */
export const faceIdReason = (thread: string, matched: string) => `Let ${thread} run ${clip(matched, 60)}`;

// --- the Timeline (4-H2) ---

/** How the user let it run: Face ID (or the passcode), or one tap with the phone unlocked. */
export type HeldHow = "faceid" | "unlocked";
export const timelineRun = (matched: string, thread: string, how: HeldHow) => `Let ${clip(matched, 60)} run in ${thread} (${how === "faceid" ? "Face ID" : "unlocked"})`;
export const timelineStopped = (matched: string, thread: string) => `Stopped ${clip(matched, 60)} in ${thread}`;
export const timelineTimeout = (matched: string, thread: string) => `${clip(matched, 60)} in ${thread} wasn't run: no answer in 6 hours`;

/** `computerOf`, kept here for the card's "On Quartz" (with one computer it's "On your computer"). */
export const heldOn = (machine: string, computers: number) => `On ${computerOf(machine, computers)}`;

/**
 * The phone's (or a spoken no's) answer to a held command, kept on its reach-out before the computer is asked, so the
 * hold's end seen meanwhile says how it ended (engine.ts `watchHeld`). The function it gives takes it back when the
 * computer didn't take it. Nothing when the brain hasn't seen the hold (the engine writes it then, `answeringHold`).
 */
export function answering(store: Pick<Store, "reachOut" | "saveReachOut">, itemId: string, questionId: string, run: boolean, how: HeldHow | undefined, now: number): () => void {
  const key = `held:${itemId}:${questionId}`;
  const r = store.reachOut(key);
  if (!r || r.answer) return () => {};
  store.saveReachOut({ ...r, answer: { run, ...(how ? { how } : {}), at: now } });
  return () => {
    const later = store.reachOut(key);
    if (later && !later.ended) store.saveReachOut({ ...later, answer: undefined });
  };
}
