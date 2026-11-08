// What Driver says it did, as words to check against what it did (VoiceSession's claim check). On 7 November the voice
// said "Sent the message to Explore App Limits and Rebranding." for a confirm the brain had refused: nothing was sent.
// Pure: only words in, only claims out. A claim is an action said as done, by Driver: "Sent the message to …", "Kept.",
// "I flagged that moment", "It's sent", "Done." Never a readback, a quote, a question, a promise or a negation.

/** The actions Driver can say it did. "done": any of them. */
export type Claim = "sent" | "started" | "settled" | "snoozed" | "archived" | "kept" | "flagged" | "starred" | "done";

/** What a change carried out is, as a claim of it: a reply is "sent". */
export const CLAIM_OF: Record<string, Claim> = {
  follow_up: "sent", start_work: "started", settle: "settled", settle_subagents: "settled", snooze: "snoozed", archive: "archived",
};

const VERBS = ["sent", "started", "settled", "snoozed", "archived", "kept", "flagged", "starred"];
/** Opening words that don't change what the sentence claims: "Okay, sent." */
const LEAD = /^(?:(?:okay|ok|right|alright|all right|great|good|so|and|yes|yep|sure|well|hmm)\b[\s,.!—-]*)*/i;
/** What may follow a bare verb for it to be the claim, not a word for a thread's state ("Settled threads aren't …"). */
const OBJECT = /^(?:the|it|that|this|your|them|all|both|until|to|for|and|its|their|those|these)\b/i;
/** First person: "I flagged that moment for review", "I've sent it". */
const MINE = new RegExp(String.raw`\bI(?:'ve|’ve| have)?(?: just| now| also)? (${VERBS.join("|")})\b`, "g");
/** It as done: "It's sent.", "The message has been sent to Alpha.", not "It's sent the build" (the thread did that). */
const PASSIVE = new RegExp(
  String.raw`\b(?:it|that|this|the (?:message|reply|follow-up|moment))(?:'s|’s| is| was| has been|'s been|’s been)(?: now| just| all)? (sent|snoozed|archived|kept|flagged|starred)(?=\s*(?:$|[.!,;:—]|to\b|now\b|off\b|for\b))`,
  "gi",
);
const DONE = /^(?:(?:all|that's|that’s|that is|it's|it’s)\s+)?done\W*$/i;
/** A negation: "Nothing was sent", "It's not sent", "Not sent yet". */
const NEGATED = /n't\b|n’t\b|\b(?:not|never|nothing|no|none|cannot|unsent|neither|nor)\b/i;
/** A promise or a condition: "I'll send it", "once it's sent", "it can be sent", "ready to send". */
const NOT_YET = /'ll\b|’ll\b|\b(?:will|going to|gonna|would|could|can|should|shall|might|may|must|if|once|when|whenever|unless|want|wants|ready|about to|need|needs|let me|let's|let’s|try|trying|before|after)\b/i;
/** History, said as history: "already", "earlier", "that one's sent" (a message sent before). */
const RECAP = /\b(?:already|earlier|before|last time|previously|so far|this drive|today|yesterday|this morning|that one's|that one’s|that one has|that one was)\b/i;

/** Readbacks and quotes are what will be done, or someone's words: never a claim. */
function unquoted(text: string): string {
  return text
    .replace(/“[^”]*”?|"[^"]*"?/g, " ")
    // "Send Alpha this message: … Shall I go ahead?": everything to the question is the message.
    .replace(/\bthis message\b[\s\S]*?(?=shall i go ahead|send it now,? or keep it|tap send|$)/gi, " ");
}

/**
 * A claim a sentence makes, and whether it's surely Driver's own (`own`): said in the first person, or of what only
 * Driver does (kept, flagged, starred, "Done."). "Sent the message to Alpha." could be a thread's news put briefly.
 */
export type Said = { claim: Claim; own: boolean };

/** The claims one sentence makes, if any. */
export function claimIn(sentence: string): Said[] {
  const s = sentence.trim();
  if (!s || /\?\s*$/.test(s) || NEGATED.test(s) || NOT_YET.test(s)) return [];
  const out: Said[] = [];
  const add = (verb: string, first: boolean) => {
    const claim = verb.toLowerCase() as Claim;
    const own = first || claim === "kept" || claim === "flagged" || claim === "starred" || claim === "done";
    if (!out.some((o) => o.claim === claim)) out.push({ claim, own });
  };
  const bare = s.replace(/^[\s'"‘’“”(]+/, "").replace(LEAD, "");
  if (DONE.test(bare)) add("done", true);
  const head = /^([A-Za-z]+)(.*)$/s.exec(bare);
  if (head && VERBS.includes(head[1].toLowerCase())) {
    const rest = head[2].trim();
    // Before a name ("Settled Fix login."), an object ("Kept your reply"), or nothing ("Kept.").
    if (!rest || /^[.!,;:—-]/.test(rest) || OBJECT.test(rest) || /^[\d“"‘']/.test(rest) || /^[A-Z]/.test(rest)) add(head[1], false);
  }
  for (const m of s.matchAll(MINE)) add(m[1], true);
  for (const m of s.matchAll(PASSIVE)) add(m[1], false);
  return out;
}

/** Whether a claim is said as history ("it's already sent"), which a recap may say without anything done now. */
export const isRecap = (sentence: string) => RECAP.test(sentence);

/** The user asked what got done ("what did we do", "what have you sent so far"): any claim then is a recap. */
export const asksRecap = (said: string) =>
  /\bwhat (?:did|have|has) (?:we|i|you|driver)\b|\bwhat(?:'s| has| have)? (?:been )?(?:done|sent|changed|happened)\b|\bso far\b|\brecap\b|\bgot done\b/i.test(said);

/**
 * The user's turn asked about something rather than for something ("Was there a new message?", "What did it do?"):
 * an answer may tell what a thread did, in words like Driver's own ("Sent a fix and started the tests").
 */
export const asksAbout = (said: string) =>
  said.split(/(?<=[.!?])\s+/).some((s) => /\?\s*$/.test(s) ||
    /^(?:what|how|why|who|which|where|when|did|does|do|is|are|was|were|has|have|had|any|tell me about)\b/i.test(s.trim().replace(LEAD, "")));

/**
 * The sentences of `text` (Driver's words since the user last spoke) that are over, with readbacks and quotes left out,
 * and the claims each makes. `complete`: the text is all there is (the backend's answer), so its last sentence is over.
 */
export function claimsIn(text: string, complete = false): { sentence: string; said: Said[] }[] {
  const parts = unquoted(text).split(/(?<=[.!?])\s*/);
  const over = complete || /[.!?]\s*$/.test(text) ? parts : parts.slice(0, -1);
  return over.filter((s) => s.trim()).map((sentence) => ({ sentence: sentence.trim(), said: claimIn(sentence) }));
}
