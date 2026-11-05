// Every change goes propose → spoken readback → heard gate → user's yes → confirm → receipt.
// The spike showed the voice model can drop or shorten the backend's readback, and thread text can
// try to steer the model, so the brain itself checks (1) that the readback's entities and the gist
// of any message were spoken after the proposal was made, and (2) that the user started a new turn
// after hearing it, and that turn agrees.
import { randomUUID } from "node:crypto";
import type { Action, Adapter, LaunchProfile, Place, Receipt, WorkItem } from "./adapter.ts";
import { DONE, type ClutterGroup } from "./briefing.ts";
import { DRAFT_MAX } from "./drafts.ts";
import { inGroup, isMark, keyWords, nameKey, norm, pick, resolve, sayKey, saysHead, speechTokens, spokenTitle, withGroup, type Named } from "./handles.ts";
import type { Proposal, Store } from "./store.ts";
import { mapLimit } from "./util.ts";

export type ProposeAction = "follow_up" | "settle" | "snooze" | "archive" | "settle_subagents" | "start_work";
/** `project`, `title` and `profile` are for start_work: where, what the new thread is called, and which launch profile. */
export type ProposeInput = {
  action: ProposeAction;
  handles: string[];
  message: string | null;
  until: string | null;
  project?: string | null;
  title?: string | null;
  profile?: string | null;
};
export type ToolResult = Record<string, unknown>;
/** The user's latest turn and how much the assistant had said when it began. */
export type UserTurn = { text: string; atSpoken: number };

const EXPIRY_MS = 120_000;
/** An outcome lost to a dropped connection may be retried (same keys) for a while longer. */
const RETRY_MS = 10 * 60_000;
const MAX_TARGETS = 10;

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
  /** A new thread was started: let the briefing know it, so it can be named straight away. */
  started?: (itemId: string) => Promise<void>;
  /** Everything the assistant has said aloud in this conversation. */
  spoken: (conversationId: string) => string;
  lastUserTurn: (conversationId: string) => UserTurn;
  now?: () => number;
  log?: (m: string) => void;
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
      // Only an empty message prefix may carry into the immediately following utterance.
      const parts = spoken.slice(g.from).split(/(\uE000|\bshall\s+i\s+go\s+ahead\b)/i);
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
const NO = /\b(no|nope|don't|do not|wait|hold on|hang on|stop|cancel|never ?mind|not yet|actually|not|maybe|perhaps|I guess|I think|probably|unsure|hm+|but|unless|except|only if|instead|rather)\b/i;
/** The user's own words must agree: the model's judgement alone is not consent (thread text can inject). */
export const agrees = (said: string) => {
  const s = messageText(said).replace(/\bno (problem|worries)\b/gi, "");
  return YES.test(s) && !NO.test(s);
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
export function pickPlace(spoken: string, places: Place[]): { place: Place } | { error: string } {
  if (!places.length) return { error: "Driver can't see any projects right now: their machines may be unreachable. Say so." };
  const words = spoken.replace(/\b(project|repo|repository|machine)\b/gi, " ").trim();
  const named = places.map((p) => ({ id: p.id, handle: p.name, group: "", title: p.name.replace(/, on [\w-]+$/, "") }));
  const r = words ? resolve(words, named) : { kind: "none" as const };
  if (r.kind === "match") return { place: places.find((p) => p.id === r.item.id)! };
  if (r.kind === "ambiguous") return { error: `"${spoken}" could mean ${list(r.options.map((o) => o.handle))}. Ask the user which.` };
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

  async propose(conversationId: string, input: ProposeInput): Promise<ToolResult> {
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
      const start = this.newThread({ project: input.project ?? "" }, input.title ?? "", input.profile ?? null);
      if ("error" in start) return start;
      const message = (input.message ?? "").trim();
      const bad = badMessage(message);
      if (bad) return { error: bad };
      Object.assign(fields, { placeId: start.place.id, place: start.place.name, title: start.title, profile: start.profile, message });
      // Title, place and profile are heard word for word, as one clause up to "with this message"; the message as a follow-up's.
      readback = `${start.head}, with this message: "${message}"`;
      entities.push({ words: [], need: 0, head: nameTokens(start.head), next: "with" });
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
      ? [{ kind: "start_work", placeId: fields.placeId!, title: fields.title!, message: fields.message!, profile: fields.profile! }]
      : targets.map((t) => toAction({ action: input.action, fields } as Proposal, t.itemId));
    const reason = await this.check(actions);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };

    // A new proposal replaces any still open in this conversation, so "yes" can't land on a stale one.
    // If it changes nothing but the message, the names and verb already spoken still count (the voice
    // model often starts reading before a revision lands); the message itself never carries over.
    let entitiesFrom = createdFrom;
    const sameEntities = (o: Proposal) =>
      o.action === input.action && o.fields.until === fields.until && o.fields.placeId === fields.placeId &&
      o.fields.title === fields.title && o.fields.profile?.name === fields.profile?.name &&
      JSON.stringify(o.targets.map((t) => t.itemId).sort()) === JSON.stringify(targets.map((t) => t.itemId).sort());
    for (const old of this.d.store.openProposals(conversationId)) {
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
      state: "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    return {
      proposal_id: p.id,
      readback,
      instruction: "Say the readback word for word, then ask \"Shall I go ahead?\" and stop. Nothing has happened yet.",
    };
  }

  /**
   * Where a new thread starts, what it's called and with which profile, from the user's words (`project`) or, for a
   * dictated start, the place it was dictated for (`placeId`). `head` is the readback up to its message, all heard word
   * for word.
   */
  newThread(where: { project: string } | { placeId: string }, rawTitle: string, asked: string | null): { place: Place; title: string; profile: LaunchProfile; head: string } | { error: string } {
    const profiles = this.d.profiles ?? [];
    const named = asked?.trim().replace(/\s+profile$/i, "");
    const profile = named ? profiles.find((p) => nameKey(p.name) === nameKey(named)) : profiles[0];
    if (!profile) return { error: profiles.length ? `There's no ${named} profile; there are ${list(profiles.map((p) => p.name))}. Ask the user which.` : "Driver has no launch profiles set up." };
    const places = this.d.places?.() ?? [];
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
    const title = spokenTitle(rawTitle);
    if (!keyWords(title).length) return { error: "Give the new thread a short title of a few words, from what the user asked for." };
    if (title.length > 80 || /\bthis\s+message\b|\bshall\s+i\b|\byour\s+dictated\b/i.test(title)) return { error: "Give the new thread a shorter, plain title of a few words." };
    // Two places said alike ("agent-hearth" and "agent hearth" on one machine) can't be told apart by any readback.
    const twin = places.find((o) => o.id !== place.id && sayKey(o.name) === sayKey(place.name));
    if (twin) return { error: tooAlike({ target: place.name, other: twin.name }) };
    return { place, title, profile, head: `Start a new thread called ${title}, in ${place.name}, with the ${profile.name} profile` };
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
   * A new thread's opening prompt, dictated on the phone and heard back there in full: a start to agree to, read back
   * as one said aloud is, with "your dictated prompt" in place of the message. Sent once, like a dictated reply.
   */
  async proposeDraftStart(conversationId: string, d: { draftId: string; placeId: string; title: string; profile: string; message: string; words: number; parts: number }): Promise<{ proposal: Proposal } | { error: string }> {
    const current = this.preparing(conversationId);
    const now = this.now();
    if (!this.d.adapter.actions.includes("start_work")) return { error: "This system can't start work." };
    if (d.message.length > DRAFT_MAX + 2000) return { error: "That prompt is too long to send." };
    const again = this.draftAgain(conversationId, d.draftId, now, "prompt");
    if (again) return again;
    const start = this.newThread({ placeId: d.placeId }, d.title, d.profile);
    if ("error" in start) return start;
    const reason = await this.check([{ kind: "start_work", placeId: start.place.id, title: start.title, message: d.message, profile: start.profile }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    for (const old of this.d.store.openProposals(conversationId)) this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    const createdFrom = this.d.spoken(conversationId).length;
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: "start_work",
      targets: [],
      fields: { placeId: start.place.id, place: start.place.name, title: start.title, profile: start.profile, message: d.message, draftId: d.draftId },
      readback: `${start.head}, with your dictated prompt, ${size(d.words, d.parts)}.`,
      mustHear: [{ words: [], need: 0, from: createdFrom, head: nameTokens(start.head), next: "with" }],
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
  async proposeDraft(conversationId: string, d: { draftId: string; itemId: string; message: string; words: number; parts: number }): Promise<{ proposal: Proposal } | { error: string }> {
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
      fields: { message: d.message, draftId: d.draftId },
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

  async confirm(conversationId: string, id: string): Promise<ToolResult> {
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
    const spoken = this.d.spoken(conversationId);
    const user = this.d.lastUserTurn(conversationId);
    if (!heard(p, spoken, user.atSpoken)) {
      return { error: `The user has not heard the full readback yet. Say exactly this, then ask again: ${p.readback}` };
    }
    // Message groups already used the user's cutoff above; the names and dates must precede it too.
    if (user.atSpoken <= p.createdFrom || !heard({ mustHear: p.mustHear.filter((g) => g.message === undefined) }, spoken.slice(0, user.atSpoken))) {
      return { error: `The user has not answered the readback yet. Ask them: ${p.readback} Shall I go ahead?` };
    }
    if (!agrees(user.text)) {
      return { error: `The user has not clearly said yes. Ask them: ${p.readback} Shall I go ahead?` };
    }
    // Claim it before the first await: a second confirm or a cancel now sees "executing".
    this.d.store.putProposal({ ...p, state: "executing" });
    if (p.action === "start_work") return this.start(p, retry);

    // Re-read live targets after claiming the proposal, before dispatching any operation.
    let items: WorkItem[];
    try {
      items = await this.d.adapter.list();
    } catch {
      const error = retry
        ? "I couldn't check the threads right now. Part of this may already have gone through; try again when the connection is back."
        : "I couldn't check the threads just now, so I called this off. Please try again.";
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
      const reason = !connected ? "is on a disconnected machine" : !item ? "no longer exists" : item.settled ? "is already settled" :
        p.action === "settle" && item.status === "running" ? "is working again" :
        p.action === "settle_subagents" && !DONE.has(item.status) ? "is not finished now" :
        p.action === "settle_subagents" && (!t.parentId || item.parentId !== t.parentId) ? "no longer has the same parent" : null;
      if (reason) {
        const error = retry
          ? `${t.handle} ${reason}, so I can't safely retry it right now. Part of this may already have gone through; try again after checking the thread and its connection.`
          : `${t.handle} ${reason}, so I called this off without sending any commands.`;
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
      ? `I couldn't confirm whether it went through for ${list([...new Set(unknown)].slice(0, 3))}: the connection dropped. Saying yes again retries it safely.`
      : receiptText(p, done, failures);
    this.d.store.putProposal({ ...p, state, result });
    this.d.log?.(`proposal ${p.id} ${p.action} → ${state} (${done}/${actions.length})`);
    return { done: state === "executed", result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
  }

  /**
   * Starts the proposal's new thread, once: the key is `<proposal>:start`, so a yes after a lost answer launches with the
   * same key and gets the same thread back. The place is checked live first. Once started, the thread is named in the
   * conversation by its title, counted as messaged there (so `wait_for` takes it), and starred.
   */
  private async start(p: Proposal, retry: boolean): Promise<ToolResult> {
    const f = p.fields;
    const key = `${p.id}:start`;
    const place = (this.d.places?.() ?? []).find((x) => x.id === f.placeId);
    const reason = !this.d.adapter.connected(f.placeId!) ? "is on a machine that isn't connected right now" : !place ? "is no longer in T3" :
      sayKey(place.name) !== sayKey(f.place!) ? `is now called ${place.name}` : null;
    if (reason) {
      const error = retry
        ? `${f.place} ${reason}, so I can't safely retry it now. The thread may already have been started; check T3 first.`
        : `${f.place} ${reason}, so I called this off without starting anything.`;
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
      return { error };
    }
    const prior = this.d.store.operation(key);
    const fresh = this.d.store.beginOperation(p.id, f.placeId!, "start_work", key);
    const action: Action = { kind: "start_work", placeId: f.placeId!, title: f.title!, message: f.message!, profile: f.profile! };
    const checked = fresh ? await this.check([action]) : null;
    const r: Receipt = checked ? { ok: false as const, error: checked } : await this.d.adapter.execute(action, key).catch((e) => ({ ok: false as const, error: String(e), unknown: true }));
    if (!r.ok) {
      if (prior?.state === "unknown") r.unknown = true;
      this.d.store.finishOperation(key, r.unknown ? "unknown" : "failed", r.error);
      const result = r.unknown
        ? `I couldn't confirm whether ${f.title} was started: the connection dropped. Saying yes again retries it safely.`
        : `Nothing was started. ${f.place} said: ${r.error}`;
      this.d.store.putProposal({ ...p, state: r.unknown ? "unknown" : "failed", result });
      this.d.log?.(`proposal ${p.id} start_work → ${r.unknown ? "unknown" : "failed"}`);
      return { done: false, result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
    }
    this.d.store.finishOperation(key, "done", null);
    const itemId = r.itemId ?? null;
    const result = `Started ${f.title} in ${f.place}${itemId ? ", and starred it" : ""}.`;
    this.d.store.putProposal({ ...p, state: "executed", result, fields: { ...f, ...(itemId ? { itemId } : {}) } });
    if (itemId) {
      this.d.store.alias(p.conversationId, nameKey(f.title!), itemId);
      this.d.store.star(itemId, true);
      await this.d.started?.(itemId).catch((e) => this.d.log?.(`proposal ${p.id}: couldn't list the new thread (${String(e)})`));
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

function toAction(p: Proposal, itemId: string): Action {
  switch (p.action) {
    case "follow_up":
      return { kind: "follow_up", itemId, message: p.fields.message! };
    case "snooze":
      return { kind: "snooze", itemId, until: p.fields.until! };
    case "archive":
      return { kind: "archive", itemId };
    default:
      return { kind: "settle", itemId };
  }
}

export function receiptText(p: Pick<Proposal, "action" | "targets" | "fields">, done: number, failures: { handle: string; error: string }[]): string {
  const total = p.targets.length;
  const verb = { follow_up: p.fields.draftId ? "Sent your reply to" : "Sent the message to", settle: "Settled", archive: "Archived", snooze: "Snoozed", settle_subagents: "Settled" }[p.action] ?? "Did";
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
