// The voice session’s end decisions, with an explicit clock and no transport or tool effects.
import { handsOff, type EndReason } from "./endReason.ts";
import { STANDARD_WAKE_WORD, withoutWakeWord } from "./wakeWord.ts";

/** "…that's all, bye." yes; "say bye to the old studio, then…" no. */
export const endsWithGoodbye = (said: string) => /\b(good ?)?bye( for now| then)?[\s.!?,]*$/i.test(said.trim());

/** Filler before a command: "okay, pause", "well. pause". */
const LEAD = /^(?:(?:ok(?:ay)?|alright|all right|right|so|well|yes|yeah|yep|please|then|and|now|just|you can|can you|could you)\b[\s,.!]*)*/i;
/**
 * A command to hang up and hear back: it must start the sentence, so "don't pause" or "explain pause" never count. "Go on
 * hold" is one (3 November: Driver refused it twice, "I can't pause the call"); "hold on" is not: it's an objection.
 */
const PAUSE_COMMAND =
  /^(?:pause|hold$|hang up|(?:go|put (?:me|it|this|the call|us)) on hold|hold (?:the call|mode)|call me back|ring me back|get back to me|keep me (?:posted|updated|in the loop)|(?:let me know|tell me|ping me) (?:when|once|if|as soon as) (?:it|they|that|this)(?: one| thread)?(?:(?:'s|’s) (?:done|finished)| (?:comes? back|repl(?:y|ies)|responds?|answers?|finish(?:es)?|is done|is finished|gets back|writes back|updates?|says? something|has (?:news|an update|something)|changes?)))\b/i;
/** "Keep me posted, but don't hang up": staying on the line wins over anything else in the turn. */
const STAY_ON = /\b(?:don'?t|don’t|do not|never|no need to)\s+(?:\w+\s+){0,2}(?:hang(?:ing)? up|pause|go\b|leave)|\bstay (?:on|connected)\b/i;
/**
 * Driver itself saying, in its own words, that it will hang up or call back: "Sure, I'll hang up and call back when it
 * replies." The sentence must open with it (so not "It says I'll call you back", nor a quoted message in a readback), be
 * finished, and be unconditional: offers ("Want me to call you back?", "I'll call back if you like") don't count.
 */
const PROMISE_SENTENCE =
  /^(?:(?:sure|okay|ok|alright|all right|right|got it|will do|no problem|of course|understood)[\s,.!]+)*I(?:'ll|’ll| will) (?:now )?(?:hang up|call (?:you )?back)\b(?![^.!]*\b(?:if|unless)\b)[^.?!]*[.!]$/i;
const promisesCallback = (reply: string) =>
  reply
    .replace(/"[^"]*"?|“[^”]*”?/g, "") // quoted words are someone else's: a message being read back
    // Utterances run together unspaced ("One moment.Sure, I'll hang up."), but "3.30" is one number.
    .split(/(?<=[.?!])(?:\s+|(?=[A-Z]))/)
    .some((sentence) => PROMISE_SENTENCE.test(sentence.trim()));
/** Dictating a message for a thread: "send it a message saying I asked you to pause". */
const DICTATING = /\b(send|message|saying|say that|tell (it|them|the))\b/i;
/**
 * "Okay, pause and let me know when it comes back" yes; "don't pause", "can you explain pause?", "send it: I asked you
 * to pause" no. Only short turns count, so the word inside something longer the user is saying never hangs up. The
 * user's wake word in front counts as nothing ("10 & 2, hold").
 */
export const asksToPause = (said: string, wake = STANDARD_WAKE_WORD) =>
  said.trim().split(/\s+/).length <= 12 &&
  !/\?\s*$/.test(said) &&
  !DICTATING.test(said) &&
  !STAY_ON.test(said) &&
  said.split(/[.!?;]+/).some((sentence) => PAUSE_COMMAND.test(withoutWakeWord(sentence.trim(), wake).replace(LEAD, "")));

/** A short objection opening the turn: "Oh! Don't", "wait", "no, hold on". */
const OBJECTION = /^(?:(?:oh|no|hey|um|uh|er|ah)\b[\s,.!]*)*(?:don'?t|don’t|do not|wait|hold on|hang on)\b/i;

/**
 * The user talking over Driver's "I'll hang up and call you back" (or a goodbye they didn't ask for): they want to stay
 * on when they say so ("no, don't hang up"), object ("Oh! Don't", 2 November) or go on to something else ("let's start
 * a new thread…"), not when they just acknowledge it ("okay, thanks").
 */
export const keepsTalking = (said: string, wake = STANDARD_WAKE_WORD) => {
  const words = said.trim().split(/\s+/).filter(Boolean);
  if (STAY_ON.test(said)) return true;
  if (endsWithGoodbye(said)) return false;
  // Asking again for the hang-up under way ("Go on hold mode" twice, 8 November) isn't talking over it.
  if (asksToPause(said, wake)) return false;
  return OBJECTION.test(said.trim()) || (words.length >= 4 && !/\b(?:thanks|thank you|cheers|ta)[\s.!]*$/i.test(said));
};

/** How much of what the user has said in the session the end policy keeps: enough to see how it ends. */
const USER_WORDS = 300;

/** What the voice model says while it hands a turn to the backend (its instructions allow nothing else). */
const FILLER = /^\s*(?:(?:let me check|one moment)[.!]?\s*)*$/i;

/** A rollover may begin this long before the session's cap, at a quiet moment, and comes this long after it at the latest. */
export const ROLL_EARLY = 90_000;
export const ROLL_LATE = 30_000;

export type EndState = {
  startedAt: number;
  lastActivity: number;
  lastAssistantDelta: number;
  lastUserDelta: number;
  /** What the user has said since the assistant last spoke, and vice versa. */
  userTurn: string;
  /** The end of everything the user has said in this session: empty until they speak. */
  userWords: string;
  reply: string;
  /** This turn's pause was answered on the spot: it mustn't hang up. */
  pauseAnswered: boolean;
  /** A filler-only reply with no delegation is a stall; the first delta starts its deadline. */
  filler: { at: number; text: string } | null;
  awaitingReply: boolean;
  endRequestedAt: number;
  endReason: EndReason;
  /**
   * The goodbye asked for came from a tool (`end_session`) while the user's own words in this session don't end with a
   * goodbye: like a hang-up to wait, the user talking over it keeps the call.
   */
  goodbyeUnasked: boolean;
  closing: EndReason | null;
  /** The user's wake word, which the phrase checks take off the front of what they say. */
  wake: string;
};

export type EndInput =
  | { type: "user_delta"; delta: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "delegation_created" }
  | { type: "tool_requested_end"; reason: EndReason }
  /** A tool's result has gone back to the voice model. */
  | { type: "tool_answered" }
  | { type: "already_replied" }
  | { type: "activity" }
  | { type: "closing"; reason: EndReason }
  /** `holding`: the backend is answering or a change awaits the user's yes, so a rollover waits (up to `ROLL_LATE` past the cap). */
  | { type: "tick"; busy: boolean; idleMs: number; maxMs: number; stallMs?: number; holding?: boolean };

export type EndStep = {
  state: EndState;
  /** `stayOn`: a hang-up to wait was asked for, and the user talked over it: stay on the call instead. */
  decision: null | { requestEnd: EndReason } | { closeNow: EndReason } | { stayOn: EndReason };
  log?: string;
  /** A filler went this many ms without a delegation (a stall), for analytics; the log says what it was. */
  stalledMs?: number;
};

/**
 * `said`: what the user said to open this session, if anything (their words after the wake word to come back from a
 * reading); `wake`: their wake word.
 */
export function initialEndState(now: number, said = "", wake = STANDARD_WAKE_WORD): EndState {
  return {
    startedAt: now, lastActivity: now, lastAssistantDelta: 0, lastUserDelta: 0,
    userTurn: "", userWords: said.trim().slice(-USER_WORDS), reply: "", pauseAnswered: false, filler: null, awaitingReply: false,
    endRequestedAt: 0, endReason: { kind: "goodbye" }, goodbyeUnasked: false, closing: null, wake,
  };
}

/** A requested end the user can talk over: a hang-up to wait or pause, or a goodbye they didn't say themselves. */
const overridable = (s: EndState) => s.endReason.kind === "waiting" || s.endReason.kind === "paused" || (s.endReason.kind === "goodbye" && s.goodbyeUnasked);

/**
 * `correct`: the user's vocabulary (vocabulary.ts), applied to their words before they're checked for a goodbye or a
 * pause; the state keeps them as heard.
 */
export function step(previous: EndState, input: EndInput, now: number, correct: (said: string) => string = (said) => said): EndStep {
  const state = { ...previous, filler: previous.filler ? { ...previous.filler } : null };
  const result: EndStep = { state, decision: null };
  const request = (reason: EndReason, log?: string) => {
    state.endRequestedAt = now;
    state.endReason = reason;
    state.goodbyeUnasked = false;
    result.decision = { requestEnd: reason };
    if (log !== undefined) result.log = log;
  };
  switch (input.type) {
    case "user_delta":
      state.lastActivity = state.lastUserDelta = now;
      if (!state.userTurn) state.pauseAnswered = false;
      state.reply = "";
      state.awaitingReply = true;
      state.filler = null;
      state.userTurn += input.delta;
      state.userWords = (state.userWords + input.delta).slice(-USER_WORDS);
      if (state.endRequestedAt && !state.closing && overridable(state) && keepsTalking(correct(state.userTurn), state.wake)) {
        result.decision = { stayOn: state.endReason };
        result.log = "the user talked over the hang-up: staying on";
        state.endRequestedAt = 0;
        state.endReason = { kind: "goodbye" };
        state.goodbyeUnasked = false;
        // Nothing in this turn hangs up again ("don't hang up" names a hang-up; Driver may repeat its promise).
        state.pauseAnswered = true;
      }
      break;
    case "assistant_delta":
      // Backstop for a voice reply that ends the conversation without delegating.
      if (state.userTurn && !state.endRequestedAt && endsWithGoodbye(correct(state.userTurn))) {
        request({ kind: "goodbye" }, "user said goodbye");
      } else if (state.userTurn && !state.endRequestedAt && !state.pauseAnswered && asksToPause(correct(state.userTurn), state.wake)) {
        request({ kind: "paused" }, "user asked to pause");
      }
      if (state.awaitingReply) state.filler = { at: now, text: "" };
      state.awaitingReply = false;
      if (state.filler) state.filler.text += input.delta;
      state.reply += input.delta;
      // Never on a call the user hasn't spoken in: a call-back or a return from a reading opens with Driver talking.
      if (!state.endRequestedAt && !state.pauseAnswered && state.userWords.trim() && promisesCallback(state.reply)) {
        request({ kind: "paused" }, "the voice said it would hang up");
      }
      state.userTurn = "";
      state.lastActivity = state.lastAssistantDelta = now;
      break;
    case "delegation_created":
      state.filler = null;
      state.awaitingReply = false;
      state.lastActivity = now;
      break;
    case "tool_requested_end":
      request(input.reason);
      // "Okay, thanks" can end a call, but it isn't a goodbye: the user may yet say not to.
      state.goodbyeUnasked = input.reason.kind === "goodbye" && !endsWithGoodbye(correct(state.userWords));
      break;
    case "tool_answered":
      // A hand-off says nothing more (the phone's tone is the cue): hang up now, not once the voice model is quiet.
      if (state.endRequestedAt && !state.closing && handsOff(state.endReason)) result.decision = { closeNow: state.endReason };
      break;
    case "already_replied":
      state.pauseAnswered = true;
      if (state.endReason.kind === "paused") {
        state.endRequestedAt = 0;
        state.endReason = { kind: "goodbye" };
      }
      break;
    case "activity":
      state.lastActivity = now;
      break;
    case "closing":
      if (!state.closing) state.closing = input.reason;
      break;
    case "tick": {
      if (state.closing) break;
      // A session can't run past the cap (deploys wait for it), but the call can: near it, at a quiet moment, the session
      // ends as a rollover and the phone opens the next one in the same conversation at once (5 November: Driver went
      // silent at the cap, and the phone didn't know why). Quiet: no tool at work, no change awaiting a yes, nobody
      // speaking, and Driver has answered the user's last words.
      const age = now - state.startedAt;
      if (age > input.maxMs - ROLL_EARLY && !state.endRequestedAt) {
        const quiet = !input.busy && !input.holding && !state.awaitingReply &&
          now - state.lastAssistantDelta > 1500 && now - state.lastUserDelta > 1500 && state.lastAssistantDelta >= state.lastUserDelta;
        if (quiet || age > input.maxMs + ROLL_LATE) {
          result.decision = { closeNow: { kind: "rollover" } };
          break;
        }
      }
      if (age > input.maxMs + ROLL_LATE) {
        result.decision = { closeNow: { kind: "max_duration" } };
        break;
      }
      // Tool work holds off the idle close, but never for more than a minute.
      const busy = input.busy && now - state.lastActivity < 60_000;
      if (state.endRequestedAt) {
        // Time for the voice model's closing line to start and play out. A hand-off prompts no closing line (the phone
        // reads or records from here; `tool_answered` hangs up first), so only what it was already saying needs to finish.
        const from = handsOff(state.endReason) ? state.lastAssistantDelta : Math.max(state.lastAssistantDelta, state.endRequestedAt);
        // Hanging up to wait (or with a goodbye the user didn't say) leaves a moment more after Driver says so, for the user
        // to say not to, and never while they're speaking: their words reach the brain a second or two after they start.
        const quiet = overridable(state)
          ? now - from > 3500 && now - state.lastUserDelta > 1500
          : now - from > 2500;
        if ((!busy && quiet) || now - state.endRequestedAt > 15_000) {
          result.decision = { closeNow: state.endReason };
          break;
        }
      }
      if (state.filler && now - state.filler.at > (input.stallMs ?? 10_000)) {
        if (FILLER.test(state.filler.text)) {
          const since = state.lastUserDelta ? `+${now - state.lastUserDelta}ms after speech` : "";
          result.log = `stalled: said ${JSON.stringify(state.filler.text.trim())} but never delegated ${since}`;
          result.stalledMs = now - state.filler.at;
        }
        state.filler = null;
      }
      if (!busy && now - state.lastActivity > input.idleMs) result.decision = { closeNow: { kind: "idle" } };
      break;
    }
  }
  return result;
}
