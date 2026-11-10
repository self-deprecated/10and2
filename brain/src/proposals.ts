// Every change goes propose → spoken readback → heard gate → user's yes → confirm → receipt.
// The spike showed the voice model can drop or shorten the backend's readback, and thread text can
// try to steer the model, so the brain itself checks (1) that the readback's entities and the gist
// of any message were spoken after the proposal was made, and (2) that the user started a new turn
// after hearing it, and that turn agrees.
import { randomUUID } from "node:crypto";
import type { Action, Adapter, LaunchProfile, Place, Receipt, WorkItem } from "./adapter.ts";
import { DONE, type ClutterGroup } from "./briefing.ts";
import { dictatedParts, DRAFT_MAX, draftState, newThreadName, newThreadTarget, parseNewThread, type NewThread } from "./drafts.ts";
import { inGroup, isMark, keyWords, nameKey, norm, pick, resolve, sayKey, saysHead, speechTokens, spokenTitle, withGroup, type Named } from "./handles.ts";
import { TAP, type KeptReply, type Proposal, type ProposalTarget, type Store } from "./store.ts";
import { mapLimit } from "./util.ts";
import { otherNames, spokenPlaces } from "./places.ts";
import type { Track } from "./analytics.ts";

export type ProposeAction = "follow_up" | "settle" | "snooze" | "archive" | "settle_subagents" | "start_work";
/**
 * What a tap on the phone changes in a thread (`Proposals.tap`): a reply sent with Send is a `follow_up`. Following one
 * is the brain's own (`noted`).
 */
export type TapAction = "settle" | "unsettle" | "snooze" | "unsnooze" | "follow_up";

/** `project` and `profile` are for start_work: where, and which launch profile. The work system names the thread. */
export type ProposeInput = {
  action: ProposeAction;
  handles: string[];
  message: string | null;
  until: string | null;
  project?: string | null;
  profile?: string | null;
};
export type ToolResult = Record<string, unknown>;
/** The user's latest turn and how much the assistant had said when it began. */
export type UserTurn = { text: string; atSpoken: number };

/**
 * What the user said, without the sounds speech-to-text writes in brackets: "[sniff", "[hum]", "[cough]". On 5 November a
 * sniff right after "Do it" became the user's latest turn, the yes was refused, and the voice said "Sent." anyway.
 */
export const spokenWords = (text: string) => text.replace(/\[[^\][\n]{0,40}(?:\]|$)/g, " ").replace(/\s+/g, " ").trim();

/**
 * The result of a reply proposal kept for later (`Proposals.keep`): closed as "cancelled", since nothing was sent, with
 * this result, so its receipt says kept (callview.ts).
 */
export const KEPT = "Kept for later.";

/**
 * What a reply to a thread does in a call (the phone's setting, "Ask each time" by default there): "ask" whether to send
 * it now or keep it for later, "keep" it for later at once (no readback, no yes: nothing is sent), or "send" it on a
 * spoken yes. Only replies to existing threads; any other change is proposed as ever.
 */
export type KeepReplies = "ask" | "keep" | "send";

/**
 * How the user agrees to a change in a call (the phone's setting `confirm`, per kind of change): "none" carries it out
 * as soon as it's proposed; "yes" on a clear yes after it was proposed; "readback" on a yes after the readback was heard
 * in full (every change, before 7 November); "tap" only with the phone's Send.
 */
export type Level = "none" | "yes" | "readback" | "tap";
export type ConfirmLevels = { reply: Level; start: Level; archive: Level; settle: Level; snooze: Level; tidy: Level };
/** What a call gets for any kind of change its phone doesn't say (an older phone says none). */
export const DEFAULT_CONFIRM: ConfirmLevels = { reply: "yes", start: "yes", archive: "yes", settle: "none", snooze: "none", tidy: "none" };
/** Every change read back and heard: a session told nothing (tests, a session made before levels, taken back after a restart). */
export const READBACK_ALL: ConfirmLevels = { reply: "readback", start: "readback", archive: "readback", settle: "readback", snooze: "readback", tidy: "readback" };
const LEVELS: readonly Level[] = ["none", "yes", "readback", "tap"];
/** Which setting a proposed action follows. */
export const CONFIRM_KEY = { follow_up: "reply", start_work: "start", archive: "archive", settle: "settle", snooze: "snooze", settle_subagents: "tidy" } as const satisfies Record<ProposeAction, keyof ConfirmLevels>;

/** The phone's `confirm` (an object, or one encoded as JSON): each kind it says, the default for the rest. */
export function confirmOf(raw: unknown): ConfirmLevels {
  let given: any = raw;
  if (typeof raw === "string") {
    try {
      given = JSON.parse(raw);
    } catch {
      given = null;
    }
  }
  const out = { ...DEFAULT_CONFIRM };
  if (!given || typeof given !== "object") return out;
  for (const k of Object.keys(out) as (keyof ConfirmLevels)[]) if (LEVELS.includes(given[k])) out[k] = given[k];
  return out;
}

/** What a spoken confirm the brain refused would have done, as a receipt says it: "Not sent". */
export const NOT_DONE: Record<string, string> = {
  follow_up: "Not sent", start_work: "Not started", archive: "Not archived", settle: "Not settled", snooze: "Not snoozed", settle_subagents: "Not settled",
};

const EXPIRY_MS = 120_000;
/** An outcome lost to a dropped connection may be retried (same keys) for a while longer. */
const RETRY_MS = 10 * 60_000;
const MAX_TARGETS = 10;
/** How long a carried-out change stays in `/api/updates` for the phone's tone (it polls every 3 s). */
const DONE_MS = 30_000;

export type ProposalDeps = {
  store: Store;
  adapter: Adapter;
  /** Items the user can name, with their spoken handles: unsettled ones only. */
  named: () => (Named & { item: WorkItem })[];
  /** Settled items, so a name that fits one gets "that's settled" rather than "no match". */
  settled?: () => Named[];
  clutter: () => ClutterGroup[];
  /** Where new work can start (the adapter's places), and what it may run with: the first profile is the default. */
  places?: () => Place[];
  profiles?: LaunchProfile[];
  /** A new thread was started: let the briefing know it (and what Driver calls it, where), so it can be named straight away. */
  started?: (itemId: string, started: { title: string; group: string }) => Promise<void>;
  /** Everything the assistant has said aloud in this conversation. */
  spoken: (conversationId: string) => string;
  lastUserTurn: (conversationId: string) => UserTurn;
  now?: () => number;
  log?: (m: string) => void;
  /** Analytics (contracts §5): a reply kept for later is `reply_kept`. */
  track?: Track;
};

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** A name as heard, without the marks inside it ("TestFlight, Quartz" is said either way). */
const nameTokens = (s: string) => speechTokens(s).filter((w) => !isMark(w));

/**
 * A target as its readback says it, with its project: "Agent Reel, in sd". Proposals made before targets kept their
 * project say the name alone.
 */
const said = (t: { handle: string; group?: string }) => (t.group === undefined ? t.handle : withGroup(t.handle, t.group));
/** The same, before what follows it in a sentence: "Send Agent Reel, in sd, this message". */
const saidBefore = (t: { handle: string; group?: string }) => (t.group === undefined ? t.handle : withGroup(t.handle, t.group, true));
type MustHear = Omit<Proposal["mustHear"][number], "from">;

/** A place's project, as heard: "in driver" of "in driver, on Lattice". */
const projectTokens = (name: string) => {
  const t = speechTokens(`in ${name}`);
  const m = t.findIndex(isMark);
  return { project: m < 0 ? t : t.slice(0, m), rest: m < 0 ? [] : t.slice(m) };
};

/**
 * What a new thread's readback must be heard saying, before "with this message": "Start a new thread in <project>" word
 * for word. The machine may be left out when no other machine has a project of that name, and the profile when it's the
 * default; a profile the user asked for is heard as a clause of its own. On 5 November the voice said "…, in Driver, with
 * this message" four times over and each "yes" was refused.
 */
function startHeard(place: Place, places: Place[], profile: LaunchProfile, isDefault: boolean): MustHear[] {
  const { project, rest } = projectTokens(place.name);
  const key = project.join(" ");
  const shared = places.some((o) => o.id !== place.id && projectTokens(o.name).project.join(" ") === key);
  const named = nameTokens("Start a new thread");
  const head = shared ? [...named, ...project, ...rest.filter((w) => !isMark(w))] : [...named, ...project];
  const profileWords = speechTokens(`, with the ${profile.name} profile`);
  const where = [...(shared ? [] : rest), ...(isDefault ? profileWords : [])];
  return [
    { words: [], need: 0, head, where, next: ["with", "this"] },
    ...(isDefault ? [] : [{ words: [], need: 0, head: nameTokens(`with the ${profile.name} profile`), next: "with" }]),
  ];
}

/** The project a readback says after the name, as heard: optional there, since the name alone is unique. */
const whereTokens = (t: { handle: string; group?: string }) => {
  if (said(t) === t.handle) return [];
  // Clause marks are kept between words, so the place may be heard up to one of them ("in sd" of "in sd, on Quartz").
  const words = speechTokens(inGroup(t.group!));
  while (words.length && isMark(words[0])) words.shift();
  while (words.length && isMark(words.at(-1)!)) words.pop();
  return words.filter((w, i) => !isMark(w) || !isMark(words[i - 1]));
};

/**
 * Another thread, open or settled, whose own readback would pass for a target's: "Archive Agent Reel: Dashboard."
 * says "Archive Agent Reel." No wording tells those apart by voice. One thread: whole readbacks are compared (so "Docs:
 * Agent Reel" is fine). Several: each name is its own clause, so a name that starts another at a clause break clashes.
 * A name that sounds exactly the same (`sayKey`) can only be a settled thread, since open names are made unique, and a
 * settled thread can't be acted on: not a clash.
 */
function lookalike(targets: { itemId: string; handle: string; group?: string }[], verb: string, next: string | null, open: Named[], settled: Named[]): { target: string; other: string } | null {
  const others = [...open, ...settled];
  const isOpen = new Set(open.map((o) => o.id));
  const one = targets.length === 1;
  for (const t of targets) {
    for (const o of others) {
      if (o.id === t.itemId || sayKey(o.handle) === sayKey(t.handle)) continue;
      const mine = one ? nameTokens(`${verb} ${t.handle}`) : nameTokens(t.handle);
      // An open thread's readback, said with its project or without. A settled one is never read back, so only its
      // bare name could be taken for this one's.
      for (const name of new Set([o.handle, ...(isOpen.has(o.id) ? [said(o)] : [])])) {
        const theirs = one ? speechTokens(`${verb} ${name}${next ? ` ${next}` : "."}`) : speechTokens(name);
        if (saysHead(theirs, mine, one ? next : null, whereTokens(t))) return { target: t.handle, other: o.handle };
      }
    }
  }
  return null;
}

/** T3 won't settle a thread while a run is going, so Driver doesn't offer to. */
const stillWorking = (t: { handle: string; group?: string }) =>
  `${saidBefore(t)} is still working, and T3 can't settle a thread while it runs. Say so: it can be settled once it finishes.`;

const tooAlike = (c: { target: string; other: string }) =>
  `${c.target} and ${c.other} are named too alike for Driver to tell apart by voice. Tell the user to do this in T3 Code, or to rename one of them.`;

/** Parses the model's `until`: a date (8 AM local) or a local/zoned date-time, in the future. */
export function parseUntil(until: string, now: number): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until.trim());
  const d = dateOnly ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3], 8, 0) : new Date(until);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now || d.getTime() > now + 90 * 86_400_000) return null;
  return d;
}

export function spokenDate(d: Date, now: number): { text: string; words: string[]; timeWords: string[] } {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined });
  const withinWeek = d.getTime() - now < 6.5 * 86_400_000;
  // Within a week the weekday is unambiguous; further out the month has to be heard too.
  const words = withinWeek ? [weekday.toLowerCase()] : [weekday.toLowerCase(), d.toLocaleDateString("en-GB", { month: "long" }).toLowerCase()];
  const timeWords = [String(d.getHours() % 12 || 12)];
  if (d.getMinutes()) timeWords.push(String(d.getMinutes()));
  timeWords.push(d.getHours() < 12 ? "am" : "pm");
  return { text: `${weekday} ${date} at ${time}`, words, timeWords };
}

/** Contractions share their negation with the expanded form, independently of stop words. */
function messageText(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\b(do|does|did|is|are|was|were|have|has|had|could|should|would|must|need|dare|might|wo|ca|sha|ai)nt\b/g, "$1n't")
    .replace(/\b(won't|can't|shan't|ain't)\b/g, (w) => ({ "won't": "will not", "can't": "can not", "shan't": "shall not", "ain't": "is not" })[w]!)
    .replace(/n't\b/g, " not")
    .replace(/\bcannot\b/g, "can not");
}
const negations = (s: string) => messageText(s).match(/\b(not|no|never|without|nothing|none|nobody)\b/g) ?? [];
const messageWords = (s: string) => speechTokens(messageText(s)).flatMap((w) => keyWords(w, true));

/** Locate a cut in the proposed message only when its heard key words form an exact prefix. */
function messagePrefix(message: string, words: string[]): string | null {
  for (const token of message.matchAll(/\S+/g)) {
    const prefix = message.slice(0, token.index + token[0].length);
    const keys = messageWords(prefix);
    if (keys.length === words.length && keys.every((w, i) => w === words[i])) return prefix;
  }
  return null;
}

/** Longest common subsequence: repeated words count only when heard in the same order. */
function inOrder(wanted: string[], said: string[]): number {
  const counts = new Array(said.length + 1).fill(0);
  for (const word of wanted) {
    let previous = 0;
    for (let j = 1; j <= said.length; j++) {
      const old = counts[j];
      counts[j] = word === said[j - 1] ? previous + 1 : Math.max(counts[j], counts[j - 1]);
      previous = old;
    }
  }
  return counts[said.length];
}

/** True when every must-hear group appears in what was spoken after that group's starting point. */
export function heard(p: Pick<Proposal, "mustHear">, spoken: string, atSpoken = spoken.length): boolean {
  return p.mustHear.every((g) => {
    if (g.head) return saysHead(speechTokens(spoken.slice(g.from)), g.head, g.next ?? null, g.where);
    if (g.message !== undefined) {
      // Only an empty message prefix may carry into the immediately following utterance. Either question after a
      // readback ends it: its words are never the message's.
      const parts = spoken.slice(g.from).split(/(\uE000|\bshall\s+i\s+go\s+ahead\b|\bsend\s+it\s+now\W+or\s+keep\s+it\s+for\s+later\b)/i);
      let end = g.from;
      for (let i = 0; i < parts.length; i += 2) {
        const readFrom = end;
        let read = parts[i];
        let boundary = parts[i + 1] ?? "";
        if (boundary === "\uE000" && /\bthis\s+message[^\p{L}\p{N}]*$/iu.test(read) &&
          parts[i + 2] && !/\bthis\s+message\b/i.test(parts[i + 2])) {
          read += boundary + parts[i + 2];
          boundary = parts[i + 3] ?? "";
          i += 2;
        }
        end = readFrom + read.length + boundary.length;
        const start = [...read.matchAll(/\bthis\s+message\s*:?\s*/gi)].at(-1);
        if (!start) continue;
        const messageFrom = start.index + start[0].length;
        const said = read.slice(messageFrom);
        const cut = Math.max(0, Math.min(said.length, atSpoken - readFrom - messageFrom));
        const before = said.slice(0, cut);
        const midWord = /[a-z0-9'’]$/i.test(before) && /^[a-z0-9'’]/i.test(said.slice(cut));
        const completeWords = midWord ? before.replace(/[a-z0-9'’]+$/i, "") : before;
        const words = messageWords(completeWords);
        let expected = g.message;
        let need = g.words.length - Math.floor(g.words.length / 10);
        // A continuation proves a cut-in only if we can map the heard prefix and its next word.
        // Words after the cut never count toward the threshold or supply a missing negation.
        const allWords = messageWords(said);
        if (!midWord && words.length > 0 && words.length < g.words.length && allWords.length > words.length &&
          allWords.slice(0, words.length + 1).every((w, j) => w === g.words[j]) &&
          words.every((w, j) => w === g.words[j])) {
          const prefix = messagePrefix(g.message, words);
          if (prefix !== null) {
            expected = prefix;
            need = g.need;
          }
        }
        const wantedNo = negations(expected);
        const saidNo = negations(completeWords);
        if (saidNo.length === wantedNo.length && inOrder(wantedNo, saidNo) === wantedNo.length &&
          inOrder(g.words, words) >= need) return true;
      }
      return false;
    }
    if (g.sequence) {
      const said = speechTokens(norm(spoken.slice(g.from)));
      return said.some((_, i) => g.sequence!.every((w, j) => said[i + j] === w));
    }
    // Every number reads as digits here, "one" included: these are the readback's words, not a name someone chose.
    const said = new Set(keyWords(spoken.slice(g.from), true));
    const words = [...new Set(g.words.flatMap((w) => keyWords(w, true)))];
    return words.filter((w) => said.has(w)).length >= Math.min(g.need, words.length);
  });
}

const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|send it|please do|confirm|confirmed|correct|absolutely|definitely|sounds good|make it so)\b/i;
// "Send it now, or keep it for later?" (a dictated reply, `keepReplies: "ask"`): "Send it now" (or "Send", 7 November) as the whole answer is a yes;
// inside anything longer ("do you need me to say send now?") it isn't, and "send it later" never is.
const SEND_NOW = /^\W*(?:yes\W+)?send(?: it)?(?: now)?(?:\W+please)?\W*$/i;
const NO = /\b(no|nope|don't|do not|wait|hold on|hang on|stop|cancel|never ?mind|not yet|actually|not|maybe|perhaps|I guess|I think|probably|unsure|hm+|but|unless|except|only if|instead|rather|later|keep)\b/i;
/** The user's own words must agree: the model's judgement alone is not consent (thread text can inject). */
export const agrees = (said: string) => {
  const s = messageText(spokenWords(said)).replace(/\bno (problem|worries)\b/gi, "");
  return (YES.test(s) || SEND_NOW.test(s)) && !NO.test(s);
};

/** What a spoken message can't contain, or null: the readback's own markers, and more than a voice follow-up holds. */
function badMessage(message: string): string | null {
  if (!message) return "What should the message say? Ask the user.";
  if (/\bshall\s+i\s+go\s+ahead\b/i.test(message)) return 'Please rephrase the message without "shall I go ahead", so I can tell it apart from the confirmation question.';
  if (/\bthis\s+message\b/i.test(message)) return 'Please rephrase the message without "this message", so I can tell it apart from the readback prefix.';
  if (message.length > 1000) return "That message is too long for a voice follow-up. Offer to let the user dictate it instead.";
  return null;
}

/**
 * Which place the user means: their words for a project, with or without its machine ("driver", "expo on Quartz"). The
 * same project on two machines is theirs to settle. Pure, for tests.
 */
export function pickPlace(spoken: string, given: Place[]): { place: Place } | { error: string } {
  // Said as the user can say them: no two alike (places.ts).
  const places = spokenPlaces(given);
  if (!places.length) return { error: "Driver can't see any projects right now: their machines may be unreachable. Say so." };
  const words = spoken.replace(/\b(project|repo|repository|machine)\b/gi, " ").trim();
  const named = places.map((p) => ({ id: p.id, handle: p.name, group: "", title: p.name.replace(/, on [\w-]+$/, "") }));
  const r = words ? resolve(words, named) : { kind: "none" as const };
  if (r.kind === "match") return { place: places.find((p) => p.id === r.item.id)! };
  // Each option a clause of its own: names have commas in them ("nix, on Lattice").
  if (r.kind === "ambiguous") return { error: `"${spoken}" could mean ${r.options.map((o) => o.handle).join("; or ")}. Ask the user which, in those words.` };
  // Another name for it: its repository's or its folder's ("mono nix" is the project "nix" in mono/nix), with the machine
  // if they said one.
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const machine = / on ([\w-]+)$/i.exec(words.replace(/,/g, ""))?.[1]?.toLowerCase();
  const said = key(machine ? words.replace(/,?\s+on\s+[\w-]+$/i, "") : words);
  const also = said ? places.filter((p) => otherNames(p).some((n) => key(n) === said) && (!machine || p.name.toLowerCase().endsWith(`, on ${machine}`))) : [];
  if (also.length === 1) return { place: also[0] };
  if (also.length > 1) return { error: `"${spoken}" could mean ${also.map((p) => p.name).join("; or ")}. Ask the user which, in those words.` };
  const recent = [...places].sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? "")).slice(0, 6).map((p) => p.name);
  return { error: `${words ? `No project matches "${spoken}".` : "Which project?"} Projects active lately: ${recent.join("; ")}. Ask the user which.` };
}

/** How long a dictated draft is, as its readback says it: "about 310 words in 3 parts". */
const size = (words: number, parts: number) =>
  `${words < 20 ? `${words} ${words === 1 ? "word" : "words"}` : `about ${Math.round(words / 10) * 10} words`}${parts > 1 ? ` in ${parts} parts` : ""}`;

/** A message may be paraphrased, but its gist must be heard. */
const messageNeed = (n: number) => Math.min(n, Math.max(2, Math.ceil(n * 0.4)));

export class Proposals {
  private readonly d: ProposalDeps;
  private stopped = 0;
  private readonly proposing = new Map<string, number>();
  constructor(deps: ProposalDeps) {
    this.d = deps;
  }
  private preparing(conversationId: string): () => boolean {
    const stopped = this.stopped;
    const revision = (this.proposing.get(conversationId) ?? 0) + 1;
    this.proposing.set(conversationId, revision);
    return () => this.stopped === stopped && this.proposing.get(conversationId) === revision;
  }
  private async check(actions: Action[]): Promise<string | null> {
    for (const action of actions) {
      try {
        const reason = await this.d.adapter.check?.(action);
        if (reason) return reason;
      } catch { return "Driver couldn't check whether that action is allowed right now. Please try again."; }
    }
    return null;
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * A change the user asked for, prepared to agree to as its `levels` say (`Level`): read back and asked about, or
   * (`none`) carried out at once, its result returned.
   */
  async propose(conversationId: string, input: ProposeInput, keepReplies: KeepReplies = "send", levels: ConfirmLevels = READBACK_ALL): Promise<ToolResult> {
    // A reply kept straight away isn't sent, so it needs no readback, and nothing is asked of the computer (it may be asleep).
    const keeping = keepReplies === "keep" && input.action === "follow_up";
    const asked = levels[CONFIRM_KEY[input.action]] ?? "readback";
    // A reply the user's settings ask about ("Send it now, or keep it for later?") is still asked about, whatever its
    // level: then their "send it now" is the yes.
    const level: Level = asked === "none" && keepReplies === "ask" && input.action === "follow_up" ? "yes" : asked;
    const atOnce = !keeping && level === "none";
    const current = this.preparing(conversationId);
    const now = this.now();
    if (input.action !== "settle_subagents" && !this.d.adapter.actions.includes(input.action)) {
      return { error: `This system can't ${input.action.replace("_", " ")}.` };
    }
    const createdFrom = this.d.spoken(conversationId).length;
    let targets: Proposal["targets"] = [];
    let readback: string;
    const fields: Proposal["fields"] = {};
    // Entity groups (verb, names, date) may carry over from a superseded proposal; see below.
    const entities: Omit<Proposal["mustHear"][number], "from">[] = input.action === "settle_subagents" ? [{ words: ["settle"], need: 1 }] : [];
    let messageGroup: Proposal["mustHear"][number] | null = null;

    if (input.action === "settle_subagents") {
      const groups = this.d.clutter();
      const ids = groups.flatMap((g) => g.ids);
      if (ids.length === 0) return { error: "There are no finished subagent threads to settle." };
      targets = groups.flatMap((g) => g.ids.map((itemId) => ({ itemId, handle: "subagent", parentId: g.parentIds?.[itemId] ?? g.parentId })));
      readback = `Settle ${ids.length} finished subagent ${ids.length === 1 ? "thread" : "threads"} under ${groups.length} parent ${groups.length === 1 ? "thread" : "threads"}.`;
      entities.push({ words: ["subagent", "sub", "agent", "review", "finish"], need: 1 });
    } else if (input.action === "start_work") {
      const start = this.newThread({ project: input.project ?? "" }, input.profile ?? null);
      if ("error" in start) return start;
      const message = (input.message ?? "").trim();
      const bad = badMessage(message);
      if (bad) return { error: bad };
      Object.assign(fields, { placeId: start.place.id, place: start.place.name, profile: start.profile, message });
      // Place and profile are heard word for word, as one clause up to "with this message"; the message as a follow-up's.
      readback = `${start.head}, with this message: "${message}"`;
      entities.push(...start.heard);
      const words = messageWords(message);
      messageGroup = { words, need: messageNeed(words.length), from: createdFrom, message };
    } else {
      if (input.handles.length === 0) return { error: "Which thread? Ask the user." };
      if (input.handles.length > MAX_TARGETS) return { error: `At most ${MAX_TARGETS} threads at once.` };
      const named = this.d.named();
      for (const h of input.handles) {
        const r = pick(h, named, this.d.settled?.() ?? [], this.d.store.aliasFor(conversationId, nameKey(h)));
        if (r.kind === "none") return { error: `No thread matches "${h}". Ask the user which one.` };
        if (r.kind === "settled") return { error: `${saidBefore(r.item)} is settled, so Driver leaves it alone. Say so, and ask whether they meant another thread.` };
        if (r.kind === "ambiguous") return { error: `"${h}" could mean ${r.options.map((o, i, all) => withGroup(o.handle, o.group, i < all.length - 1)).join(" or ")}. Ask the user which one.` };
        const item = r.item as Named & { item: WorkItem };
        if (input.action === "settle" && item.item.status === "running") return { error: stillWorking(item) };
        this.d.store.alias(conversationId, nameKey(item.handle), item.id);
        if (!targets.some((t) => t.itemId === item.id)) targets.push({ itemId: item.id, handle: item.handle, group: item.group });
      }
      // Every name in a readback is heard word for word, as a clause of its own: "Archive Agent Reel." for one thread,
      // "Settle 2 threads: Agent Reel; Fix login." for several. Counting words can't tell "Agent Reel" from "Agent Reel
      // Dashboard", a swapped pair, or a thread renamed since; an exact name can. Dates and messages stay tolerant. Each
      // name is read back with its project ("Archive Agent Reel, in sd."), which may be left out when heard.
      const one = targets.length === 1;
      const verb = { follow_up: "Send", snooze: "Snooze", settle: "Settle", archive: "Archive" }[input.action];
      const listed = targets.map(said).join("; ");
      let next: string | null = null;
      if (input.action === "follow_up") {
        const message = (input.message ?? "").trim();
        const bad = badMessage(message);
        if (bad) return { error: bad };
        if (!one) return { error: "Follow up one thread at a time." };
        fields.message = message;
        const words = messageWords(message);
        // Keep the 40% gist for interruptions, but preserve word order and every negation.
        messageGroup = { words, need: messageNeed(words.length), from: createdFrom, message };
        readback = `Send ${saidBefore(targets[0])} this message: "${message}"`;
        next = "this";
      } else if (input.action === "snooze") {
        const until = input.until ? parseUntil(input.until, now) : null;
        if (!until) return { error: "Snooze until when? Give a future date (YYYY-MM-DD) or date-time within 90 days." };
        fields.until = until.toISOString();
        const sd = spokenDate(until, now);
        entities.push({ words: sd.words, need: sd.words.length });
        entities.push({ words: [], need: 0, sequence: sd.timeWords });
        readback = one ? `Snooze ${saidBefore(targets[0])} until ${sd.text}.` : `Snooze ${targets.length} threads until ${sd.text}: ${listed}.`;
        next = "until";
      } else {
        readback = one ? `${verb} ${listed}.` : `${verb} ${targets.length} threads: ${listed}.`;
      }
      if (one) {
        entities.push({ words: [], need: 0, head: nameTokens(`${verb} ${targets[0].handle}`), where: whereTokens(targets[0]), next });
      } else {
        entities.push({ words: [], need: 0, head: nameTokens(`${verb} ${targets.length} threads`), next: input.action === "snooze" ? "until" : null });
        for (const t of targets) entities.push({ words: [], need: 0, head: nameTokens(t.handle), where: whereTokens(t), next: null });
      }
      const clash = lookalike(targets, verb, next, named, this.d.settled?.() ?? []);
      if (clash) return { error: tooAlike(clash) };
    }

    const actions: Action[] = input.action === "start_work"
      ? [{ kind: "start_work", placeId: fields.placeId!, message: fields.message!, profile: fields.profile! }]
      : targets.map((t) => toAction({ action: input.action, fields } as Proposal, t.itemId));
    const reason = keeping ? null : await this.check(actions);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    fields.confirm = level;

    // A new proposal replaces any still open in this conversation, so "yes" can't land on a stale one.
    // If it changes nothing but the message, the names and verb already spoken still count (the voice
    // model often starts reading before a revision lands); the message itself never carries over.
    // One carried out at once asks for no yes, so a change still waiting for one stays open.
    let entitiesFrom = createdFrom;
    const sameEntities = (o: Proposal) =>
      o.action === input.action && o.fields.until === fields.until && o.fields.placeId === fields.placeId &&
      o.fields.profile?.name === fields.profile?.name &&
      JSON.stringify(o.targets.map((t) => t.itemId).sort()) === JSON.stringify(targets.map((t) => t.itemId).sort());
    for (const old of atOnce ? [] : this.d.store.openProposals(conversationId)) {
      if (sameEntities(old)) entitiesFrom = Math.min(entitiesFrom, old.createdFrom);
      this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    }
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: input.action,
      targets,
      fields,
      readback,
      mustHear: [...entities.map((g) => ({ ...g, from: entitiesFrom })), ...(messageGroup ? [messageGroup] : [])],
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      // Carried out at once: claimed now, so nothing else can confirm or cancel it meanwhile.
      state: atOnce ? "executing" : "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    if (keeping) {
      const kept = this.keep(conversationId, p.id);
      const words = fields.message!.split(/\s+/);
      const first = words.length <= 6 ? `${fields.message!.replace(/[\s.!?,;:]+$/, "")}.` : `${words.slice(0, 6).join(" ").replace(/[\s.!?,;:]+$/, "")}…`;
      return { kept: true, kept_id: kept.kept_id, result: `Kept your reply to ${targets[0].handle}, unsent: it's in Not sent on the phone.`, instruction: `Say only "Kept: ${first} It's in Not sent." (no readback: nothing was sent), then carry on with what they want next.` };
    }
    if (atOnce) {
      // The user's settings ask no yes for this: asking for it was enough.
      const r = await this.execute(p, false);
      return "error" in r ? r : { ...r, proposal_id: p.id, instruction: "It's been carried out already, with no readback and no question: tell the user this result in a few words, adding nothing that isn't in it. Never call confirm for it." };
    }
    const isReply = keepReplies === "ask" && input.action === "follow_up";
    const ask = level === "tap"
      ? isReply ? "\"Tap Send on your phone to send it, or I can keep it for later.\"" : "\"Tap Send on your phone to go ahead.\""
      : isReply ? "\"Send it now, or keep it for later?\"" : "\"Shall I go ahead?\"";
    return {
      proposal_id: p.id,
      readback,
      instruction: level === "tap"
        ? `Say the readback word for word, then say ${ask} and stop. Nothing has happened yet: only their tap on Send carries it out, so never call confirm for it.`
        : `Say the readback word for word, then ask ${ask} and stop. Nothing has happened yet.`,
    };
  }

  /**
   * Where a new thread starts and with which profile, from the user's words (`project`) or, for a dictated start, the
   * place it was dictated for (`placeId`). `head` is the readback up to its message, all heard word for word. The work
   * system names the thread.
   */
  newThread(where: { project: string } | { placeId: string }, asked: string | null): { place: Place; profile: LaunchProfile; head: string; heard: MustHear[] } | { error: string } {
    const profiles = this.d.profiles ?? [];
    const profile = this.profileOf(asked);
    if ("error" in profile) return profile;
    const places = spokenPlaces(this.d.places?.() ?? []);
    let place: Place;
    if ("project" in where) {
      const found = pickPlace(where.project, places);
      if ("error" in found) return found;
      place = found.place;
    } else {
      const found = places.find((p) => p.id === where.placeId);
      if (!found) return { error: "That project isn't reachable now (its machine may be asleep), or it's gone from T3, so nothing was started. The prompt is still on the phone." };
      place = found;
    }
    // Two places said alike ("agent-hearth" and "agent hearth" on one machine) can't be told apart by any readback.
    const twin = places.find((o) => o.id !== place.id && sayKey(o.name) === sayKey(place.name));
    if (twin) return { error: tooAlike({ target: place.name, other: twin.name }) };
    return { place, profile, head: `Start a new thread in ${place.name}, with the ${profile.name} profile`, heard: startHeard(place, places, profile, profile === profiles[0]) };
  }

  /** The launch profile the user asked for by name, or with none, the default. */
  profileOf(asked: string | null): LaunchProfile | { error: string } {
    const profiles = this.d.profiles ?? [];
    const named = asked?.trim().replace(/\s+profile$/i, "");
    const profile = named ? profiles.find((p) => nameKey(p.name) === nameKey(named)) : profiles[0];
    return profile ?? { error: profiles.length ? `There's no ${named} profile; there are ${list(profiles.map((p) => p.name))}. Ask the user which.` : "Driver has no launch profiles set up." };
  }

  /** Whether a dictated draft may be proposed: not if it's been sent or is being sent; its own lost proposal again, here. */
  private draftAgain(conversationId: string, draftId: string, now: number, what = "reply"): { proposal: Proposal } | { error: string } | null {
    const earlier = this.d.store.draftProposals(draftId);
    if (earlier.some((p) => p.state === "executed" || p.state === "partial")) return { error: `That ${what} has already been sent.` };
    if (earlier.some((p) => p.state === "executing")) return { error: `That ${what} is being sent right now.` };
    const lost = earlier.find((p) => p.state === "unknown");
    if (lost) {
      if (lost.conversationId === conversationId && now <= lost.createdAt + RETRY_MS) return { proposal: lost };
      return { error: `That ${what} may already have gone through. Check T3 before sending it again.` };
    }
    return null;
  }

  /**
   * A new thread's opening prompt, dictated on the phone (and kept for later as `keptId`, if it is): a start to agree to,
   * read back as one said aloud is, with "your dictated prompt" in place of the message. Sent once, like a dictated
   * reply. `profile`: a launch profile's name, or null for the default.
   */
  async proposeDraftStart(conversationId: string, d: { draftId: string | null; placeId: string; profile: string | null; message: string; words: number; parts: number; keptId?: string }, level: Level = "readback"): Promise<{ proposal: Proposal } | { error: string }> {
    const current = this.preparing(conversationId);
    const now = this.now();
    if (!this.d.adapter.actions.includes("start_work")) return { error: "This system can't start work." };
    if (d.message.length > DRAFT_MAX + 2000) return { error: "That prompt is too long to send." };
    const again = d.draftId ? this.draftAgain(conversationId, d.draftId, now, "prompt") : null;
    if (again) return again;
    const start = this.newThread({ placeId: d.placeId }, d.profile);
    if ("error" in start) return start;
    const reason = await this.check([{ kind: "start_work", placeId: start.place.id, message: d.message, profile: start.profile }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    for (const old of this.d.store.openProposals(conversationId)) this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    const createdFrom = this.d.spoken(conversationId).length;
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: "start_work",
      targets: [],
      fields: {
        placeId: start.place.id, place: start.place.name, profile: start.profile, message: d.message, confirm: draftLevel(level),
        ...(d.draftId ? { draftId: d.draftId } : {}), ...(d.keptId ? { keptId: d.keptId } : {}),
      },
      readback: `${start.head}, with your dictated prompt, ${size(d.words, d.parts)}.`,
      // "…, with your dictated prompt": the head's own clause is followed by "with your", not "with this".
      mustHear: start.heard.map((g) => ({ ...g, from: createdFrom, ...(Array.isArray(g.next) ? { next: ["with", "your"] } : {}) })),
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      state: "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    return { proposal: p };
  }

  /**
   * A reply the user dictated on the phone, already heard back there in full, made into a follow-up to agree to. Its
   * words are the user's own, so only the verb and the name are read back and heard ("Send Agent Reel your dictated
   * reply, …"), as for any follow-up; the message itself was heard on the phone. One already sent, or whose outcome
   * was lost in another conversation, isn't proposed again; one lost in this conversation is that proposal again, so a
   * yes retries it with the same keys.
   */
  async proposeDraft(conversationId: string, d: { draftId: string; itemId: string; message: string; words: number; parts: number }, level: Level = "readback"): Promise<{ proposal: Proposal } | { error: string }> {
    const current = this.preparing(conversationId);
    const now = this.now();
    if (!this.d.adapter.actions.includes("follow_up")) return { error: "This system can't take follow-ups." };
    if (d.message.length > DRAFT_MAX + 2000) return { error: "That reply is too long to send." };
    const again = this.draftAgain(conversationId, d.draftId, now);
    if (again) return again;
    const target = this.d.named().find((n) => n.id === d.itemId);
    if (!target) return { error: "That thread is settled or gone, so the reply wasn't sent. It's still on your phone." };
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const clash = lookalike(targets, "Send", "your", this.d.named(), this.d.settled?.() ?? []);
    if (clash) return { error: tooAlike(clash) };
    const reason = await this.check([{ kind: "follow_up", itemId: target.id, message: d.message }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    for (const old of this.d.store.openProposals(conversationId)) this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    const createdFrom = this.d.spoken(conversationId).length;
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: "follow_up",
      targets,
      fields: { message: d.message, draftId: d.draftId, confirm: draftLevel(level) },
      readback: `Send ${saidBefore(targets[0])} your dictated reply, ${size(d.words, d.parts)}.`,
      mustHear: [{ words: [], need: 0, from: createdFrom, head: nameTokens(`Send ${target.handle}`), where: whereTokens(targets[0]), next: "your" }],
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      state: "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    return { proposal: p };
  }

  /**
   * A dictated reply kept for later as the call opens (the phone's setting `keepReplies: "keep"`), rather than proposed:
   * nothing is sent, and nothing is asked of the computer (it may be asleep: that's what later is for). Kept as a
   * proposal closed as kept, for the call's receipt, and as the kept reply the phone lists. Not if it's been sent, or may
   * have been.
   */
  keepDraft(conversationId: string, d: { draftId: string; itemId: string; message: string; words: number; parts: number }): { proposal: Proposal } | { error: string } {
    const now = this.now();
    const was = draftState(this.d.store.draftProposals(d.draftId)).state;
    if (was === "sent") return { error: "That reply has already been sent." };
    if (was === "unknown") return { error: "That reply may already have gone through. Check T3 before sending it again." };
    const target = this.d.named().find((n) => n.id === d.itemId);
    if (!target) return { error: "That thread is settled or gone, so the reply wasn't kept. It's still on your phone." };
    for (const old of this.d.store.openProposals(conversationId)) this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: "follow_up", targets, fields: { message: d.message, draftId: d.draftId },
      readback: `Send ${saidBefore(targets[0])} your dictated reply, ${size(d.words, d.parts)}.`, mustHear: [], createdFrom: this.d.spoken(conversationId).length,
      expiresAt: now + EXPIRY_MS, state: "proposed", createdAt: now, result: null,
    };
    this.d.store.putProposal(p);
    this.keep(conversationId, p.id);
    return { proposal: this.d.store.proposal(p.id)! };
  }

  /**
   * The user's "keep it for later" for open proposal `id`, a reply to one thread (`keep`): nothing is sent. The reply is
   * kept, unsent, for the phone's Not sent (a dictated one without its first line, which goes back on when it's sent),
   * and the proposal is closed as kept (`KEPT`). The same dictated draft kept again replaces the one kept before.
   */
  keep(conversationId: string, id: string): ToolResult {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) {
      // A reply or a new thread's prompt kept already (its kept id, "K-…"): "keep it" is done. On 8 November the backend
      // passed a dictated prompt's kept id and got "No such proposal.".
      const kept = /^K-/.test(id) ? this.d.store.keptReply(id) : null;
      if (kept) return { kept: true, already: true, kept_id: kept.id, result: "It's kept already, in Not sent on the phone.", instruction: "Say only that it's kept, in Not sent on their phone (\"Kept. It's in Not sent on your phone.\"), then carry on with what they want next." };
      return { error: "No such proposal." };
    }
    if (p.action === "start_work" && p.fields.keptId) return this.keepStart(p);
    if (p.action !== "follow_up" || p.targets.length !== 1) return { error: "Only a reply to a thread or a dictated prompt can be kept for later. Say so, and ask whether to go ahead or leave it." };
    const target = p.targets[0];
    const said = `Kept your reply to ${target.handle}. It's in Not sent on the phone.`;
    const instruction = "Say only that it's kept, in Not sent on their phone (\"Kept. It's in Not sent on your phone.\"), then carry on with what they want next.";
    const keptBefore = p.fields.keptId ? this.d.store.keptReply(p.fields.keptId) : null;
    if (p.state === "cancelled" && p.result === KEPT) return { kept: true, ...(keptBefore ? { kept_id: keptBefore.id } : {}), result: said, instruction };
    if (p.state !== "proposed") return { error: `That reply can't be kept: it's already ${p.state}${p.result ? ` (${p.result})` : ""}.` };
    this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT });
    // A kept reply proposed to send (`sendKept`) and kept again is the same one, still kept.
    if (keptBefore) return { kept: true, kept_id: keptBefore.id, result: said, instruction };
    const { note, text } = dictatedParts(p.fields.message ?? "");
    const kept = this.d.store.keepReply({
      id: `K-${randomUUID().slice(0, 8)}`, threadId: target.itemId, threadName: target.handle, project: target.group ?? "", text, note,
      draftId: p.fields.draftId ?? null, conversationId, keptAt: this.now(),
    });
    this.d.log?.(`proposal ${p.id} kept for later`);
    this.d.track?.("reply_kept", { action: "kept", count: 1 });
    return { kept: true, kept_id: kept.id, result: said, instruction };
  }

  /** "Keep it for later" for a kept prompt proposed to start (`sendKept`): it stays kept, and nothing is started. */
  private keepStart(p: Proposal): ToolResult {
    const kept = this.d.store.keptReply(p.fields.keptId!);
    const instruction = "Say only that it's kept, in Not sent on their phone (\"Kept. It's in Not sent on your phone.\"), then carry on with what they want next.";
    if (p.state === "proposed") this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT });
    else if (!(p.state === "cancelled" && p.result === KEPT)) return { error: `That prompt can't be kept: it's already ${p.state}${p.result ? ` (${p.result})` : ""}.` };
    if (!kept) return { error: "That prompt isn't kept any more: it was started or discarded. Say so." };
    return { kept: true, kept_id: kept.id, result: "Kept your prompt for a new thread. It's in Not sent on the phone.", instruction };
  }

  /** Kept replies being sent by voice now (`sendKept`): each goes once at a time. */
  private readonly sendingKept = new Set<string>();

  /**
   * The user asked to send reply `keptId`, kept for later (the backend's `send_kept`), at their reply level (`levels`):
   * asking is the yes for "none" and "yes", so it's sent now; "readback" proposes it, to read back and agree to; "tap"
   * sends nothing (Send on it in Not sent does). Sent, it's no longer kept; the call's receipt is a change like any.
   */
  async sendKept(conversationId: string, keptId: string, levels: ConfirmLevels = READBACK_ALL, where: { project?: string | null; profile?: string | null } = {}): Promise<ToolResult> {
    const kept = this.d.store.keptReply(keptId);
    if (!kept) return { error: "That reply isn't kept any more: it was sent or discarded. Say so." };
    const start = parseNewThread(kept.threadId);
    if (start) return this.startKept(conversationId, kept, start, levels, where);
    const level = levels.reply ?? "readback";
    if (level === "tap") {
      return { sent: false, result: "Nothing was sent.", instruction: "Nothing was sent: the user's settings send replies only with a tap. Tell them to tap Send on it in Not sent on their phone." };
    }
    if (this.sendingKept.has(kept.id)) return { error: "That reply is being sent right now." };
    if (!this.d.adapter.actions.includes("follow_up")) return { error: "This system can't take follow-ups." };
    const target = this.d.named().find((n) => n.id === kept.threadId);
    if (!target) return { error: "That thread is settled or gone, so nothing was sent. Say so: the reply is still in Not sent on their phone." };
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const message = kept.note ? `${kept.note}\n\n${kept.text}` : kept.text;
    const current = this.preparing(conversationId);
    const reason = await this.check([{ kind: "follow_up", itemId: target.id, message }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That was stopped or replaced; nothing was sent." };
    const now = this.now();
    const createdFrom = this.d.spoken(conversationId).length;
    const words = kept.text.split(/\s+/).filter(Boolean).length;
    // Read back as a dictated reply is: its name, and how long it is (its words are on the phone, in Not sent).
    const readback = `Send ${saidBefore(targets[0])} your kept reply, ${size(words, 1)}.`;
    const base = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: "follow_up", targets, readback, createdFrom, expiresAt: now + EXPIRY_MS, createdAt: now, result: null,
      fields: { message, keptId: kept.id, ...(kept.draftId ? { draftId: kept.draftId } : {}), confirm: level },
    };
    if (level === "readback") {
      const clash = lookalike(targets, "Send", "your", this.d.named(), this.d.settled?.() ?? []);
      if (clash) return { error: tooAlike(clash) };
      for (const old of this.d.store.openProposals(conversationId)) this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
      this.d.store.putProposal({ ...base, state: "proposed", mustHear: [{ words: [], need: 0, from: createdFrom, head: nameTokens(`Send ${target.handle}`), where: whereTokens(targets[0]), next: "your" }] });
      return { proposal_id: base.id, readback, instruction: "Say the readback word for word, then ask \"Shall I go ahead?\" and stop. Nothing has been sent yet." };
    }
    this.sendingKept.add(kept.id);
    try {
      const p: Proposal = { ...base, state: "executing", mustHear: [] };
      this.d.store.putProposal(p);
      this.d.log?.(`kept ${kept.id}: sent by voice as ${p.id}`);
      const r = await this.execute(p, false);
      return "error" in r ? r : { ...r, proposal_id: p.id };
    } finally {
      this.sendingKept.delete(kept.id);
    }
  }

  /**
   * The user asked to start the new thread whose prompt they dictated and kept (`sendKept`), at their start level: in
   * the project they name now (`where.project`), else the one it was dictated for; with neither, they're asked which.
   * Placed, the kept prompt says where from then on, so Send in Not sent can start it too. Then, as for a kept reply:
   * asking is the yes for "none" and "yes", "readback" reads it back first, and "tap" waits for Send in Not sent.
   */
  private async startKept(conversationId: string, kept: KeptReply, start: NewThread, levels: ConfirmLevels, where: { project?: string | null; profile?: string | null }): Promise<ToolResult> {
    if (!this.d.adapter.actions.includes("start_work")) return { error: "This system can't start work." };
    if (this.sendingKept.has(kept.id)) return { error: "That prompt is being started right now." };
    const places = spokenPlaces(this.d.places?.() ?? []);
    // A place no longer there (its machine asleep, or gone from T3) is asked about again, as none is.
    let placeId = places.some((p) => p.id === start.placeId) ? start.placeId : null;
    if (where.project?.trim()) {
      const found = pickPlace(where.project, places);
      if ("error" in found) return found;
      placeId = found.place.id;
    }
    if (!placeId) {
      const recent = [...places].sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? "")).slice(0, 6).map((p) => p.name);
      // Not "ask the user" outright: on 9 November the backend called this for "keep it for later", was told to ask, and
      // asked again and again ("I already said keep it for later").
      return {
        sent: false,
        kept: true,
        result: "Nothing was started: it has no project yet. It stays kept, in Not sent on the phone.",
        instruction: `If the user wanted it kept, or didn't clearly ask to start it, say only "Kept. It's in Not sent on your phone." and don't ask about a project. If they asked to start it, ask which project.${recent.length ? ` Projects active lately: ${recent.join("; ")}.` : ""}`,
      };
    }
    const profile = where.profile?.trim() || start.profile;
    const placed = this.newThread({ placeId }, profile);
    if ("error" in placed) return placed;
    if (placeId !== start.placeId || (profile ?? null) !== start.profile) {
      this.d.store.keepReply({ ...kept, threadId: newThreadTarget({ placeId, profile }), threadName: placed.place.name, project: placed.place.name });
    }
    const level = levels.start ?? "readback";
    if (level === "tap") {
      return { sent: false, result: "Nothing was started.", instruction: `Nothing was started: the user's settings start threads only with a tap. Tell them it's set to start in ${placed.place.name}: they tap Send on it in Not sent on their phone.` };
    }
    const message = kept.note ? `${kept.note}\n\n${kept.text}` : kept.text;
    const words = kept.text.split(/\s+/).filter(Boolean).length;
    const made = await this.proposeDraftStart(conversationId, { draftId: kept.draftId, keptId: kept.id, placeId, profile, message, words, parts: 1 }, level);
    if ("error" in made) return made;
    const p = made.proposal;
    if (level === "readback") return { proposal_id: p.id, readback: p.readback, instruction: "Say the readback word for word, then ask \"Shall I go ahead?\" and stop. Nothing has been started yet." };
    // Asking was the yes.
    this.sendingKept.add(kept.id);
    try {
      this.d.store.putProposal({ ...p, state: "executing" });
      this.d.log?.(`kept ${kept.id}: started by voice as ${p.id}`);
      const r = await this.execute(p, false);
      return "error" in r ? r : { ...r, proposal_id: p.id };
    } finally {
      this.sendingKept.delete(kept.id);
    }
  }

  /** Stop: every change not yet under way is called off. One already executing finishes and keeps its receipt. */
  /** Cancels every open proposal, or with `conversationId`, that conversation's. */
  cancelOpen(reason: string, conversationId?: string) {
    this.stopped++;
    const open = conversationId === undefined ? this.d.store.allOpenProposals() : this.d.store.openProposals(conversationId);
    for (const p of open) this.d.store.putProposal({ ...p, state: "cancelled", result: reason });
  }

  cancel(conversationId: string, id: string): ToolResult {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) return { error: "No such proposal." };
    switch (p.state) {
      case "proposed":
        this.d.store.putProposal({ ...p, state: "cancelled", result: "cancelled by user" });
        return { cancelled: true, result: "Nothing was changed." };
      case "executing":
        return { cancelled: false, result: "It's already being carried out and can't be stopped now." };
      case "unknown":
        this.d.store.putProposal({ ...p, state: "cancelled", result: p.result });
        return { cancelled: true, result: "I won't retry it, but it may already have gone through." };
      case "cancelled":
      case "expired":
        return { cancelled: true, result: "Nothing was changed." };
      default:
        return { cancelled: false, result: `Too late: ${p.result ?? "it already happened."}` };
    }
  }

  /** Changes carried out lately, newest last, for the phone's "done" tone (`/api/updates`). Kept in memory only. */
  private carried: { id: string; at: number }[] = [];

  /** The changes carried out in the last `withinMs`, with how long ago. */
  recentlyDone(withinMs = DONE_MS): { id: string; ageMs: number }[] {
    const now = this.now();
    this.carried = this.carried.filter((c) => now - c.at <= withinMs);
    return this.carried.map((c) => ({ id: c.id, ageMs: now - c.at }));
  }

  /**
   * The user's yes to proposal `id`: said aloud (`voice`, the backend's confirm, checked against what was heard), or a
   * tap on the phone's Send in the live call (`tap`: a signed-in tap is the yes, so there's no heard check). Either way
   * it's carried out the same, with the same checks of the threads, keys and receipt.
   */
  async confirm(conversationId: string, id: string, by: "voice" | "tap" = "voice"): Promise<ToolResult> {
    const r = await this.confirmOnce(conversationId, id, by);
    const state = this.d.store.proposal(id)?.state;
    if ("error" in r && state === "proposed") {
      // On 5 November a refused confirm was answered "Sent." Say it outright: nothing happened.
      return { ...r, error: `Nothing was done: nothing was sent, started or changed. ${r.error} Never say it was done.` };
    }
    return r;
  }

  /**
   * Carries out a proposal, claimed already ("executing"): it starts a thread or sends its commands. One that went
   * through rings the phone's done tone (`recentlyDone`), and a kept reply it sent is no longer kept.
   */
  private async execute(p: Proposal, retry: boolean): Promise<ToolResult> {
    const r = p.action === "start_work" ? await this.start(p, retry) : await this.carryOut(p, retry);
    const state = this.d.store.proposal(p.id)?.state;
    if (state === "executed" || state === "partial") {
      if (!this.carried.some((c) => c.id === p.id)) this.carried.push({ id: p.id, at: this.now() });
      if (p.fields.keptId) this.d.store.dropKept(p.fields.keptId);
    }
    return r;
  }

  private async confirmOnce(conversationId: string, id: string, by: "voice" | "tap"): Promise<ToolResult> {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) return { error: "No such proposal. Propose the change first." };
    const retry = p.state === "unknown";
    if (p.state !== "proposed" && !retry) return { error: `That proposal is already ${p.state}${p.result ? `: ${p.result}` : ""}.` };
    if (this.now() > (retry ? p.createdAt + RETRY_MS : p.expiresAt)) {
      this.d.store.putProposal({ ...p, state: "expired" });
      return { error: "That proposal expired. Propose it again and read it back." };
    }
    // The readback named each target by its name at the time. Names can shift before the yes (a rename, or a
    // duplicate settled so "Fix login in driver 2" now means another thread): then the readback no longer names the
    // target for certain, so it's called off. A retry of an unknown outcome re-sends the same commands to the same
    // threads, already agreed to, so it's exempt.
    if (p.action !== "settle_subagents" && !retry) {
      // A thread moved to another project since is named differently too: the readback said where it was.
      const now = new Map(this.d.named().map((n) => [n.id, n]));
      const nowSaid = (t: Proposal["targets"][number]) => {
        const n = now.get(t.itemId);
        return n && said({ handle: n.handle, group: t.group === undefined ? undefined : n.group });
      };
      const moved = p.targets.find((t) => sayKey(nowSaid(t) ?? "") !== sayKey(said(t)));
      if (moved) {
        this.d.store.putProposal({ ...p, state: "cancelled", result: "a name changed" });
        const current = nowSaid(moved);
        return {
          error: `${saidBefore(moved)} ${current ? `is now called ${current}` : "has been settled or archived"} since the readback, so nothing was changed. ${current ? "Propose it again with the new name." : "Tell the user."}`,
        };
      }
    }
    // A thread renamed since the proposal may now sound like a target: then nothing heard can tell them apart.
    if (p.action !== "settle_subagents" && p.action !== "start_work" && !retry) {
      const verb = { follow_up: "Send", snooze: "Snooze", settle: "Settle", archive: "Archive" }[p.action as Exclude<ProposeAction, "settle_subagents" | "start_work">];
      const next = p.fields.draftId ? "your" : p.action === "follow_up" ? "this" : p.action === "snooze" ? "until" : null;
      const clash = lookalike(p.targets, verb, next, this.d.named(), this.d.settled?.() ?? []);
      if (clash) {
        this.d.store.putProposal({ ...p, state: "cancelled", result: "a name changed" });
        return { error: tooAlike(clash) };
      }
    }
    // A tap on Send is the yes, with the proposal on the screen. A spoken one counts as the user's settings say
    // (`Level`): any clear yes after it was proposed; only after the readback was heard in full; or never (tap only).
    // `refused` says why, for the call's receipt.
    if (by === "voice") {
      const level = p.fields.confirm ?? "readback";
      const spoken = this.d.spoken(conversationId);
      const user = this.d.lastUserTurn(conversationId);
      if (level === "tap") {
        return { error: "The user's settings carry this out only with a tap: tell them to tap Send on their phone to go ahead.", refused: "tap Send on your phone" };
      }
      if (level === "readback" && !heard(p, spoken, user.atSpoken)) {
        return { error: `The user has not heard the full readback yet. Say exactly this, then ask again: ${p.readback}`, refused: "Driver hadn't read it back yet" };
      }
      // Message groups already used the user's cutoff above; the names and dates must precede it too.
      if (user.atSpoken <= p.createdFrom || (level === "readback" && !heard({ mustHear: p.mustHear.filter((g) => g.message === undefined) }, spoken.slice(0, user.atSpoken)))) {
        return { error: `The user has not answered the readback yet. Ask them: ${p.readback} Shall I go ahead?`, refused: "you hadn't answered yet" };
      }
      if (!agrees(user.text)) {
        return { error: `The user has not clearly said yes. Ask them: ${p.readback} Shall I go ahead?`, refused: "you hadn't said yes" };
      }
    }
    // Claim it before the first await: a second confirm or a cancel now sees "executing".
    this.d.store.putProposal({ ...p, state: "executing" });
    return this.execute(p, retry);
  }

  /**
   * A change the user made with a tap on the phone, signed in: the tap is their yes, so there's no readback. Carried out
   * as an agreed proposal is (the same checks, keys and receipt), and kept as a tap (`TAP`) for the timeline.
   */
  async tap(action: TapAction, target: ProposalTarget, fields: Pick<Proposal["fields"], "until" | "message" | "keptId" | "draftId">, requestId?: string): Promise<Proposal> {
    const now = this.now();
    const p: Proposal = {
      id: tapId(requestId), conversationId: TAP, action, targets: [target], fields,
      readback: `${action} ${target.handle}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executing", createdAt: now, result: null,
    };
    return this.runTap(p, () => this.carryOut(p, false));
  }

  /**
   * A new thread started with a tap: a prompt for it, dictated or typed on the phone, sent with Send to its `new:`
   * target (`target`, as the phone sent it, so a retry is matched on exactly what was tapped). Checked as a dictated
   * start is (`proposeDraftStart`: the place and profile), then started once, as a yes would. One with no project yet
   * is started in a call, where Driver asks which. `keptId`: a prompt kept for later in a call, no longer kept once started.
   */
  async tapStart(target: string, message: string, requestId?: string, keptId?: string): Promise<Proposal | { error: string }> {
    const start = parseNewThread(target);
    if (!start) return { error: "That new thread couldn't be read, so nothing was started." };
    if (!start.placeId) return { error: "Nothing was started: it has no project yet. Choose one, or start it in a call." };
    if (!(spokenPlaces(this.d.places?.() ?? [])).some((x) => x.id === start.placeId)) return { error: "That project isn't reachable now (its computer may be asleep), or it's gone, so nothing was started." };
    const s = this.newThread({ placeId: start.placeId }, start.profile);
    if ("error" in s) return { error: "That new thread can't be started from here. Start it in a call instead." };
    const now = this.now();
    const p: Proposal = {
      id: tapId(requestId), conversationId: TAP, action: "start_work", targets: [],
      fields: { placeId: s.place.id, place: s.place.name, profile: s.profile, message, target, ...(keptId ? { keptId } : {}) },
      readback: `start a new thread in ${s.place.name}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executing", createdAt: now, result: null,
    };
    return this.runTap(p, () => this.start(p, false));
  }

  /** Keeps a tap, claimed already ("executing"), and carries it out; the same tap sent meanwhile joins this run. */
  private async runTap(p: Proposal, go: () => Promise<ToolResult>): Promise<Proposal> {
    this.d.store.putProposal(p);
    const run = go().then(() => this.d.store.proposal(p.id)!);
    this.tapping.set(p.id, run);
    try {
      return await run;
    } finally {
      this.tapping.delete(p.id);
    }
  }

  /** Taps being carried out now, by id: the same tap sent again joins its run rather than run twice. */
  private readonly tapping = new Map<string, Promise<Proposal>>();

  /** The tap the phone sent before with this request id, once it's done (its answer was lost, or it's sent twice at once); null if none. */
  earlierTap(requestId: string): { proposal: Proposal; done: Promise<Proposal> } | null {
    const p = this.d.store.proposal(tapId(requestId));
    return p ? { proposal: p, done: this.tapping.get(p.id) ?? Promise.resolve(p) } : null;
  }

  /** A tap the brain carries out itself (following a thread or not), kept like any tap for the timeline. */
  noted(action: "follow" | "unfollow", target: ProposalTarget): Proposal {
    const now = this.now();
    const p: Proposal = {
      id: `T-${randomUUID().slice(0, 8)}`, conversationId: TAP, action, targets: [target], fields: {},
      readback: `${action} ${target.handle}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executed", createdAt: now,
      result: action === "follow" ? `Following ${target.handle}.` : `Stopped following ${target.handle}.`,
    };
    this.d.store.putProposal(p);
    return p;
  }

  /** Sends an agreed proposal's commands, claimed already ("executing"), and records how it went. */
  private async carryOut(p: Proposal, retry: boolean): Promise<ToolResult> {
    // A tap's outcome is read on the phone, not said by Driver.
    const tapped = p.conversationId === TAP;
    // Re-read live targets after claiming the proposal, before dispatching any operation.
    let items: WorkItem[];
    try {
      items = await this.d.adapter.list();
    } catch {
      const error = retry
        ? "I couldn't check the threads right now. Part of this may already have gone through; try again when the connection is back."
        : tapped ? "Couldn't reach your threads just now, so nothing was changed. Try again." : "I couldn't check the threads just now, so I called this off. Please try again.";
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
      return { error };
    }
    for (const t of p.targets) {
      const key = `${p.id}:${t.itemId}`;
      if (this.d.store.operation(key)?.state === "done") continue;
      const item = items.find((i) => i.id === t.itemId);
      const connected = this.d.adapter.connected(t.itemId);
      if (retry && connected && ((p.action === "archive" && !item) ||
        ((p.action === "settle" || p.action === "settle_subagents") && item?.settled))) {
        this.d.store.beginOperation(p.id, t.itemId, toAction(p, t.itemId).kind, key);
        this.d.store.finishOperation(key, "done", null);
        continue;
      }
      // Legacy subagent proposals without parentId fail closed; their short expiry bounds this transition.
      const reason = !connected ? "is on a disconnected machine" : !item ? "no longer exists" :
        p.action === "unsettle" ? (item.settled ? null : "isn't settled") : item.settled ? "is already settled" :
        p.action === "settle" && item.status === "running" ? "is working again" :
        p.action === "settle_subagents" && !DONE.has(item.status) ? "is not finished now" :
        p.action === "settle_subagents" && (!t.parentId || item.parentId !== t.parentId) ? "no longer has the same parent" : null;
      if (reason) {
        const error = retry
          ? `${t.handle} ${reason}, so I can't safely retry it right now. Part of this may already have gone through; try again after checking the thread and its connection.`
          : tapped ? `${t.handle} ${reason}, so nothing was changed.` : `${t.handle} ${reason}, so I called this off without sending any commands.`;
        this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
        return { error };
      }
    }

    const actions: Action[] = p.targets.map((t) => toAction(p, t.itemId));
    let done = 0;
    const failures: { handle: string; error: string }[] = [];
    const unknown: string[] = [];
    await mapLimit(actions, 4, async (action, i) => {
      const key = `${p.id}:${p.targets[i].itemId}`;
      const prior = this.d.store.operation(key);
      const fresh = this.d.store.beginOperation(p.id, p.targets[i].itemId, action.kind, key);
      if (!fresh && this.d.store.operation(key)?.state === "done") {
        done++;
        return;
      }
      // Re-sending a key is safe: the adapter must make it idempotent (T3 dedupes by commandId).
      const reason = fresh ? await this.check([action]) : null;
      const r: Receipt = reason ? { ok: false as const, error: reason } : await this.d.adapter.execute(action, key).catch((e) => ({ ok: false as const, error: String(e), unknown: true }));
      if (r.ok) {
        this.d.store.finishOperation(key, "done", null);
        done++;
      } else if (r.unknown || prior?.state === "unknown") {
        this.d.store.finishOperation(key, "unknown", r.error);
        unknown.push(p.targets[i].handle);
      } else {
        this.d.store.finishOperation(key, "failed", r.error);
        failures.push({ handle: p.targets[i].handle, error: r.error });
      }
    });
    const state = unknown.length ? "unknown" : failures.length === 0 ? "executed" : done === 0 ? "failed" : "partial";
    const result = unknown.length
      ? tapped ? `Couldn't tell whether that went through: the connection dropped. Check ${unknown[0]} before trying again.`
        : `I couldn't confirm whether it went through for ${list([...new Set(unknown)].slice(0, 3))}: the connection dropped. Saying yes again retries it safely.`
      : receiptText(p, done, failures);
    this.d.store.putProposal({ ...p, state, result });
    this.d.log?.(`proposal ${p.id} ${p.action} → ${state} (${done}/${actions.length})`);
    return { done: state === "executed", result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
  }

  /**
   * Starts the proposal's new thread, once: the key is `<proposal>:start`, so a yes after a lost answer launches with the
   * same key and gets the same thread back. The place is checked live first. Once started, the thread is named in the
   * conversation as "your new thread in <project>" (or by its title, from before 8 November), counted as messaged there
   * (so `wait_for` takes it), and starred, so Driver calls back when it replies.
   */
  private async start(p: Proposal, retry: boolean): Promise<ToolResult> {
    // A tap's outcome is read on the phone, not said by Driver.
    const tapped = p.conversationId === TAP;
    const f = p.fields;
    const key = `${p.id}:start`;
    const place = (spokenPlaces(this.d.places?.() ?? [])).find((x) => x.id === f.placeId);
    const reason = !this.d.adapter.connected(f.placeId!) ? "is on a machine that isn't connected right now" : !place ? "is no longer in T3" :
      sayKey(place.name) !== sayKey(f.place!) ? `is now called ${place.name}` : null;
    if (reason) {
      const error = retry
        ? `${f.place} ${reason}, so I can't safely retry it now. The thread may already have been started; check T3 first.`
        : tapped ? `${f.place} ${reason}, so nothing was started.` : `${f.place} ${reason}, so I called this off without starting anything.`;
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
      return { error };
    }
    const prior = this.d.store.operation(key);
    const fresh = this.d.store.beginOperation(p.id, f.placeId!, "start_work", key);
    // A start proposed before 8 November keeps its title; any since lets the work system name the thread.
    const action: Action = { kind: "start_work", placeId: f.placeId!, ...(f.title ? { title: f.title } : {}), message: f.message!, profile: f.profile! };
    const name = f.title ?? newThreadName(f.place);
    const checked = fresh ? await this.check([action]) : null;
    const r: Receipt = checked ? { ok: false as const, error: checked } : await this.d.adapter.execute(action, key).catch((e) => ({ ok: false as const, error: String(e), unknown: true }));
    if (!r.ok) {
      if (prior?.state === "unknown") r.unknown = true;
      this.d.store.finishOperation(key, r.unknown ? "unknown" : "failed", r.error);
      const result = r.unknown
        ? tapped ? `Couldn't tell whether ${name} was started: the connection dropped. Check ${f.place} before trying again.`
          : `I couldn't confirm whether ${name} was started: the connection dropped. Saying yes again retries it safely.`
        : `Nothing was started. ${f.place} said: ${r.error}`;
      this.d.store.putProposal({ ...p, state: r.unknown ? "unknown" : "failed", result });
      this.d.log?.(`proposal ${p.id} start_work → ${r.unknown ? "unknown" : "failed"}`);
      return { done: false, result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
    }
    this.d.store.finishOperation(key, "done", null);
    const itemId = r.itemId ?? null;
    const result = f.title ? `Started ${f.title} in ${f.place}${itemId ? ", and starred it" : ""}.` : `Started ${name}${itemId ? ", and starred it" : ""}.`;
    this.d.store.putProposal({ ...p, state: "executed", result, fields: { ...f, ...(itemId ? { itemId } : {}) } });
    if (itemId) {
      // Named in this conversation as Driver called it ("your new thread in driver", "the new thread") until the work
      // system's name for it is in the briefing.
      if (!tapped) for (const n of new Set([name, name.replace(/^your /, ""), "new thread", "your new thread"])) this.d.store.alias(p.conversationId, nameKey(n), itemId);
      this.d.store.star(itemId, true);
      await this.d.started?.(itemId, { title: f.title ?? "Your new thread", group: f.place! }).catch((e) => this.d.log?.(`proposal ${p.id}: couldn't list the new thread (${String(e)})`));
    }
    this.d.log?.(`proposal ${p.id} start_work → executed`);
    return {
      done: true,
      result,
      // Not "Driver … calls back with its reply": on 3 November the voice read that out as it stood, or said "I'll call back
      // with its reply", which hangs up as a promise to (endPolicy) when the user was carrying on.
      instruction: "Tell the user this result in your own short words: it has started and is starred, so they'll hear its reply. You stay on the call: don't say you'll hang up or call back. Add no details that are not in it.",
    };
  }
}

/** A dictated reply or prompt is asked about as the call opens, whatever the level: a yes is the least it needs. */
const draftLevel = (level: Level): Level => (level === "none" ? "yes" : level);

/** A tap's id: from the phone's request id, so the same tap sent again is the same one, with the same keys. */
const tapId = (requestId?: string) => `T-${requestId ?? randomUUID().slice(0, 8)}`;

function toAction(p: Proposal, itemId: string): Action {
  switch (p.action) {
    case "follow_up":
      return { kind: "follow_up", itemId, message: p.fields.message! };
    case "snooze":
      return { kind: "snooze", itemId, until: p.fields.until! };
    case "archive":
      return { kind: "archive", itemId };
    case "unsnooze":
      return { kind: "unsnooze", itemId };
    case "unsettle":
      return { kind: "unsettle", itemId };
    default:
      return { kind: "settle", itemId };
  }
}

export function receiptText(p: Pick<Proposal, "action" | "targets" | "fields">, done: number, failures: { handle: string; error: string }[]): string {
  const total = p.targets.length;
  const verb = { follow_up: p.fields.draftId ? "Sent your reply to" : "Sent the message to", settle: "Settled", archive: "Archived", snooze: "Snoozed", settle_subagents: "Settled", unsnooze: "Unsnoozed", unsettle: "Unsettled" }[p.action] ?? "Did";
  const what =
    p.action === "settle_subagents"
      ? `${done} of ${total} finished subagent threads`
      : list(p.targets.filter((t) => !failures.some((f) => f.handle === t.handle)).map((t) => t.handle));
  if (failures.length === 0) {
    const suffix = p.action === "snooze" && p.fields.until ? ` until ${spokenDate(new Date(p.fields.until), Date.now()).text}` : "";
    return `${verb} ${p.action === "settle_subagents" ? `all ${total} finished subagent threads` : what}${suffix}.`;
  }
  const failed = `Failed for ${list(failures.slice(0, 3).map((f) => f.handle))}: ${failures[0].error}`;
  return done === 0 ? `Nothing changed. ${failed}` : `${verb} ${what}. ${failed}`;
}

/**
 * How a reply reached its thread, as `reply_sent.via` (contracts §5): a yes in a call is "voice"; a reply sent from the
 * phone says how in its request's `via` (Send tapped, held, on the lock screen, or "Driver, send it" in the reader).
 */
export type ReplyVia = "tap" | "hold" | "lock_screen" | "voice" | "kept";
const PHONE_VIAS: ReplyVia[] = ["tap", "hold", "lock_screen", "voice"];

/** A request's `via` as the phone sent it (contracts §3), "kept" for a kept reply, else (an older phone) "tap". */
export function tapVia(sent: unknown, kept = false): ReplyVia {
  return kept ? "kept" : PHONE_VIAS.find((v) => v === sent) ?? "tap";
}

/**
 * What a change that went through did, for analytics (contracts §5): a reply or a new thread is `reply_sent`, anything
 * else `thread_action`. `via` "voice": proposed in a call (agreed aloud or with Send); else the phone's tap. Nothing for
 * one that didn't go through.
 */
export function trackChange(track: Track, p: Proposal, via: ReplyVia, dictated = false) {
  if (p.state !== "executed" && p.state !== "partial") return;
  if (p.action === "follow_up" || p.action === "start_work") {
    track("reply_sent", { via, dictated: dictated || !!p.fields.draftId, new_thread: p.action === "start_work" });
    return;
  }
  const action = ({ settle: "settle", settle_subagents: "settle", snooze: "snooze", archive: "archive", unsnooze: "undo", unsettle: "undo", follow: "follow", unfollow: "unfollow" } as Record<string, string>)[p.action];
  if (action) track("thread_action", { action, via: via === "voice" ? "voice" : "tap", threads: p.targets.length });
}
