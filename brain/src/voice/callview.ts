// What the phone shows of a live call (`GET /api/calls/current`, contracts §3): the agenda Driver set out to cover, a
// receipt for each lookup and change (and each flag, refused yes, correction and hang-up), and the change waiting for
// the user's yes. Worked out from what the call keeps already: the briefing it opened with, the tools it ran (`tool`),
// what the brain did itself (`note`), the conversation's proposals and its turns. When the call ends, `final` is kept
// with the session, as the call's record in History and the Timeline. A call carried on in a new session (a rejoin, a
// call-back, back from a reading) keeps the conversation's view.
import { randomUUID } from "node:crypto";
import type { Briefing, BriefingView } from "../briefing.ts";
import { KEPT, NOT_DONE, spokenDate } from "../proposals.ts";
import type { Proposal, Store } from "../store.ts";
import { briefed } from "./prompts.ts";

export type CallState = "listening" | "thinking" | "talking" | "waiting";
export type AgendaItem = { threadId: string; name: string; project: string; status: "done" | "current" | "next"; outcome?: string; ask?: string };
export type ReceiptState = "proposed" | "executed" | "failed" | "cancelled" | "expired" | "unknown" | "kept";
/**
 * `kind`: a lookup, a change (a proposal, a star, a note), or the brain's own: a moment flagged for review, a spoken
 * yes it refused (`proposalId` the change it was for), a claim it corrected, or the call hung up or ended.
 */
export type ReceiptKind = "lookup" | "change" | "flag" | "refused" | "correction" | "call";
export type Receipt = { id: string; at: number; kind: ReceiptKind; threadId?: string; text: string; state?: ReceiptState; words?: string; proposalId?: string };
export type Pending = { proposalId: string; text: string; threadId?: string; expiresAt: number };
/** What a call leaves for History: its agenda as it ended (the item under way counts as done) and its receipts. */
export type CallRecord = { agenda: AgendaItem[]; receipts: Receipt[] };
export type CallSnapshot = { conversationId: string; state?: CallState; agenda: AgendaItem[]; receipts: Receipt[]; pending: Pending | null; next: string };

/** A thread a tool was about, as the tool found it. */
export type About = { itemId: string; handle: string; group: string };

/** The most threads the agenda starts with: the rest of the briefing is still there to ask about, and joins as it comes up. */
export const AGENDA_MAX = 8;
/**
 * The threads a call sets out to cover, in order: the briefing's (`briefed`), starred and waiting on the user first, at
 * most `AGENDA_MAX`. The spoken briefing (`POST /api/briefing`) covers the same list in the same order.
 */
export function agendaThreads(view: BriefingView, t: number): BriefingView["cards"] {
  const waiting = (c: { state: string }) => c.state === "needs_decision" || c.state === "blocked";
  const { shown } = briefed(view, t);
  return [...shown].sort((a, b) => Number(b.starred) - Number(a.starred) || Number(waiting(b)) - Number(waiting(a))).slice(0, AGENDA_MAX);
}

/** At most this much of what was said goes with a receipt (`words`). */
const WORDS_MAX = 800;

/**
 * A receipt as the view keeps it: the threads it's about, and for a change carried out, when, what the agenda says of it,
 * and the threads it went through for (each target's own operation: a change done for some only isn't done for all).
 */
type Kept = Receipt & { threads: string[]; done?: { at: number; outcome: string; threads: string[] } };

const list = (xs: string[], and = "and") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}`);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`);

/** The threads `list` looked at, by its filter, as a receipt says them. */
const LISTS: Record<string, string> = {
  waiting: "what's waiting on you", ready: "what's ready to apply", running: "what's running", snoozed: "your snoozed threads",
  starred: "the threads you follow", all: "your threads", settled: "your settled threads",
};

/** The receipt for a tool that ran, or null: a tool refused (an unclear name) or one that's no lookup or change. */
export function receiptOf(name: string, args: any, result: Record<string, unknown>, about: About[]): Omit<Kept, "id" | "at"> | null {
  if (!result || typeof result !== "object" || "error" in result) return null;
  const threads = about.map((a) => a.itemId);
  const names = list(about.map((a) => a.handle));
  switch (name) {
    case "list": {
      const project = typeof args?.project === "string" && args.project.trim() ? ` in ${args.project.trim()}` : "";
      if (args?.rundown === true) return { kind: "lookup", text: `Went through ${Number(result.count) || 0} threads${project}`, threads: [] };
      return { kind: "lookup", text: `Looked at ${LISTS[args?.filter] ?? "your threads"}${project}`, threads: [] };
    }
    case "details":
      return { kind: "lookup", text: `Looked up ${names}`, threads };
    case "read_aloud":
      return { kind: "lookup", text: `Reading ${names}'s reply aloud`, threads };
    case "wait_for": {
      if (result.alreadyReplied) {
        const replied = about.filter((a) => a.handle === result.handle);
        return { kind: "lookup", text: `Looked up ${list(replied.map((a) => a.handle))}: it has replied`, threads: replied.map((a) => a.itemId) };
      }
      const or = list(about.map((a) => a.handle), "or");
      return { kind: "lookup", text: result.watching ? `Watching for ${or} to reply` : `Calling you back when ${or} replies`, threads };
    }
    case "star":
      return { kind: "change", state: "executed", text: `${args?.starred === false ? "Stopped following" : "Following"} ${names}`, threads };
    case "remember":
      return { kind: "change", state: "executed", text: "Noted for your next drives", threads: [] };
    case "dictate":
      return result.dictating ? { kind: "call", text: typeof args?.handle === "string" && args.handle.trim() && !(typeof args?.project === "string" && args.project.trim()) ? "Hung up to take your reply" : "Hung up to take your prompt", threads } : null;
    case "end_session":
      return result.ending ? { kind: "call", text: "Ended the call", threads: [] } : null;
    case "hold":
      return result.holding ? { kind: "call", text: "Put the call on hold", threads: [] } : null;
  }
  return null;
}

/** A proposal as the user glances at it: what it will do, the start of a message in quotes. */
export function glance(p: Proposal): string {
  const quote = p.fields.message ? `: “${cut(p.fields.message.replace(/\s+/g, " ").trim(), 80)}”` : "";
  if (p.action === "follow_up") return `Send your reply to ${p.targets[0]?.handle ?? "the thread"}${quote}`;
  if (p.action === "start_work") return p.fields.title ? `Start ${p.fields.title} in ${p.fields.place}${quote}` : `Start a new thread in ${p.fields.place}${quote}`;
  return p.readback.replace(/\.$/, "");
}

/** What the agenda says of a thread once a change to it went through. */
function outcomeOf(p: Proposal): string {
  switch (p.action) {
    case "follow_up":
      return "Sent your reply";
    case "snooze":
      return p.fields.until ? `Snoozed until ${spokenDate(new Date(p.fields.until), p.createdAt).text}` : "Snoozed";
    case "start_work":
      return "Started";
    case "archive":
      return "Archived";
    default:
      return "Settled";
  }
}

/** A proposal's state, as a receipt shows it: one past its time without a yes is expired; one under way is still proposed. */
function stateOf(p: Proposal, now: number): ReceiptState {
  switch (p.state) {
    case "proposed":
      return now > p.expiresAt ? "expired" : "proposed";
    case "executing":
      return "proposed";
    case "executed":
    case "partial":
      return "executed";
    default:
      return p.state;
  }
}

/** The top-level threads a change is about: its targets, or the thread it started. Tidying subagents is about none. */
const threadsOf = (p: Proposal) =>
  p.action === "start_work" ? (p.fields.itemId ? [p.fields.itemId] : []) : p.action === "settle_subagents" ? [] : p.targets.map((t) => t.itemId);

export class CallView {
  /** Says which view a cursor is from: one from another call starts over. */
  private readonly key = randomUUID().slice(0, 8);
  private readonly planned: string[];
  /** Every thread's name and project, as the agenda says it. */
  private readonly known = new Map<string, { name: string; project: string; ask?: string }>();
  private readonly lookups: Kept[] = [];
  private readonly words = new Map<string, string | null>();
  /** When each change carried out was, and the threads it went through for: looked up once. */
  private readonly carriedOut = new Map<string, { at: number; threads: string[] }>();
  /**
   * Proposals open as the call began (a dictated reply proposed as it opened), and any it's given (`adopt`: one kept as
   * it opened): its own, however they end.
   */
  private readonly openAtStart: Set<string>;
  /** The cursor: each receipt's revision, bumped whenever what it says changes. */
  private rev = 0;
  private readonly revs = new Map<string, { rev: number; said: string }>();

  private readonly deps: { store: Store; briefing: Briefing };
  readonly conversationId: string;
  private readonly from: number;
  private readonly now: () => number;

  /**
   * `from`: when the call began; its proposals are those made since, and those still open then (a dictated reply proposed
   * as it opened). The agenda is the briefing's threads as the call opens, starred and waiting on the user first.
   * `prior`: the record of the conversation's call so far, for a session that carries it on when the view itself is
   * gone (the brain restarted): its agenda, and its receipts other than its proposals (worked out again from `from`).
   */
  constructor(deps: { store: Store; briefing: Briefing }, conversationId: string, from: number, now: () => number = Date.now, prior: CallRecord | null = null) {
    this.deps = deps;
    this.conversationId = conversationId;
    this.from = from;
    this.now = now;
    this.openAtStart = new Set(deps.store.openProposals(conversationId).filter((p) => p.expiresAt >= from).map((p) => p.id));
    const order = agendaThreads(deps.briefing.view(), from);
    for (const c of order) this.known.set(c.itemId, { name: c.handle, project: c.group, ...(c.ask ? { ask: c.ask } : {}) });
    for (const a of prior?.agenda ?? []) if (!this.known.has(a.threadId)) this.known.set(a.threadId, { name: a.name, project: a.project, ...(a.ask ? { ask: a.ask } : {}) });
    this.planned = prior?.agenda.length ? prior.agenda.map((a) => a.threadId) : order.map((c) => c.itemId);
    for (const r of prior?.receipts ?? []) {
      if (deps.store.proposal(r.id)?.conversationId === conversationId) continue;
      const { words, ...rest } = r;
      this.lookups.push({ ...rest, threads: r.threadId ? [r.threadId] : [] });
      this.words.set(r.id, words ?? null);
    }
  }

  /** A proposal made for this call as it opened (a dictated reply kept for later): its receipt is the call's. */
  adopt(proposalId: string) {
    this.openAtStart.add(proposalId);
  }

  /**
   * A tool the call ran, and the threads it found: its receipt, if it's a lookup, a change or a hang-up. A spoken yes
   * the brain refused is a receipt too (`refused`: why, in the user's terms), about the change it was for.
   */
  tool(name: string, args: any, result: Record<string, unknown>, about: About[]) {
    if (name === "confirm" && typeof result?.refused === "string") {
      const p = this.deps.store.proposal(String(args?.proposal_id ?? ""));
      if (p?.conversationId === this.conversationId) {
        this.lookups.push({ id: this.nextId(), at: this.now(), kind: "refused", text: `${NOT_DONE[p.action] ?? "Not done"}: ${result.refused}`, threads: threadsOf(p), proposalId: p.id });
      }
      return;
    }
    const r = receiptOf(name, args, result, about);
    if (!r) return;
    for (const a of about) if (!this.known.has(a.itemId)) this.known.set(a.itemId, { name: a.handle, project: a.group });
    this.lookups.push({ ...r, id: this.nextId(), at: this.now() });
  }

  /** A receipt of the brain's own: a moment flagged for review, or a claim it corrected. */
  note(r: { kind: "flag" | "correction" | "call"; text: string; threadId?: string }) {
    const { threadId, ...rest } = r;
    this.lookups.push({ ...rest, id: this.nextId(), at: this.now(), threads: threadId ? [threadId] : [] });
  }

  private nextId() {
    return `R-${this.key}-${this.lookups.length + 1}`;
  }

  /** The call as it stands; receipts only those new or changed since cursor `since` (an earlier `next`). */
  snapshot(since: string | null = null, state?: CallState): CallSnapshot {
    const now = this.now();
    const all = this.receipts(now);
    const [key, n] = (since ?? "").split(".");
    const after = key === this.key && /^\d+$/.test(n ?? "") ? Number(n) : 0;
    const receipts: Receipt[] = [];
    for (const k of all) {
      const shown = this.shown(k);
      const said = JSON.stringify(shown);
      const was = this.revs.get(k.id);
      if (was?.said !== said) this.revs.set(k.id, { rev: ++this.rev, said });
      if (this.revs.get(k.id)!.rev > after) receipts.push(shown);
    }
    const open = this.deps.store.openProposals(this.conversationId).filter((p) => now <= p.expiresAt).at(-1);
    const pending = open ? { proposalId: open.id, text: glance(open), ...(threadsOf(open).length === 1 ? { threadId: threadsOf(open)[0] } : {}), expiresAt: open.expiresAt } : null;
    return { conversationId: this.conversationId, ...(state ? { state } : {}), agenda: this.agendaOf(all), receipts, pending, next: `${this.key}.${this.rev}` };
  }

  /** The call's record, as it ended: the thread under way counts as covered. */
  final(): CallRecord {
    const all = this.receipts(this.now());
    return { agenda: this.agendaOf(all).map((i) => (i.status === "current" ? { ...i, status: "done" } : i)), receipts: all.map((k) => this.shown(k)) };
  }

  private shown(k: Kept): Receipt {
    const { threads, done: _, ...r } = k;
    const words = this.words.get(k.id);
    return { ...r, ...(threads.length === 1 ? { threadId: threads[0] } : {}), ...(words ? { words } : {}) };
  }

  /** Every receipt, oldest first: the lookups, and the call's proposals as they stand now. */
  private receipts(now: number): Kept[] {
    const changes = this.deps.store.proposalsFor(this.conversationId)
      .filter((p) => p.createdAt >= this.from || this.openAtStart.has(p.id))
      .map((p): Kept => {
        const state = stateOf(p, now);
        const done = p.state === "executed" || p.state === "partial";
        for (const t of p.targets) if (!this.known.has(t.itemId)) this.known.set(t.itemId, { name: t.handle, project: t.group ?? "" });
        if (p.fields.itemId && !this.known.has(p.fields.itemId)) this.known.set(p.fields.itemId, { name: p.fields.title ?? "New thread", project: p.fields.place ?? "" });
        // A reply kept for later: nothing was sent, but the thread is dealt with for now.
        if (p.state === "cancelled" && p.result === KEPT) {
          return { id: p.id, at: p.createdAt, kind: "change", text: `Kept your reply to ${p.targets[0]?.handle ?? "the thread"}`, state: "kept", threads: threadsOf(p), done: { at: p.createdAt, outcome: "Reply kept", threads: threadsOf(p) } };
        }
        // A change tried says how it went (its receipt); one not carried out says what it was.
        const tried = done || p.state === "failed" || p.state === "unknown";
        return {
          id: p.id, at: p.createdAt, kind: "change", text: tried && p.result ? p.result : glance(p), state, threads: threadsOf(p),
          ...(done ? { done: { ...this.carriedOutOf(p), outcome: outcomeOf(p) } } : {}),
        };
      });
    const all = [...this.lookups, ...changes].sort((a, b) => a.at - b.at);
    this.wordsFor(all);
    return all;
  }

  private carriedOutOf(p: Proposal): { at: number; threads: string[] } {
    if (!this.carriedOut.has(p.id)) {
      const threads = p.state === "partial" ? threadsOf(p).filter((t) => this.deps.store.operation(`${p.id}:${t}`)?.state === "done") : threadsOf(p);
      this.carriedOut.set(p.id, { at: this.deps.store.carriedOutAt(p.id) ?? p.createdAt, threads });
    }
    return this.carriedOut.get(p.id)!;
  }

  /**
   * What was said that led to each receipt, for the desk view: the turns since the receipt before it, up to four. Worked
   * out once for each receipt, from the turns kept by then (a turn is kept when the backend is handed it).
   */
  private wordsFor(all: Kept[]) {
    if (all.every((k) => this.words.has(k.id))) return;
    const turns = this.deps.store.turns(this.conversationId).filter((t) => t.at >= this.from);
    all.forEach((k, i) => {
      if (this.words.has(k.id)) return;
      const after = i > 0 ? all[i - 1].at : -Infinity;
      const said = turns.filter((t) => t.at > after && t.at <= k.at).slice(-4).map((t) => `${t.role === "user" ? "You" : "10 & 2"}: ${t.text}`);
      this.words.set(k.id, said.length ? cut(said.join("\n"), WORDS_MAX) : null);
    });
  }

  /**
   * The agenda: the threads planned, then any other the call came to (in the order it did). The latest receipt about a
   * thread makes it current, and the one before done; a change to it carried out since makes it done, with its outcome.
   * Coming back to a thread makes it current again.
   */
  private agendaOf(all: Kept[]): AgendaItem[] {
    const order = [...this.planned];
    /** The latest receipt's threads: each is current unless its change went through (so a failed target stays current). */
    let current = new Set<string>();
    /** When each thread last became current, and its latest change carried out. */
    const since = new Map<string, number>();
    const done = new Map<string, { at: number; outcome: string }>();
    for (const k of all) {
      if (k.threads.length) current = new Set(k.threads);
      for (const t of k.threads) {
        if (!order.includes(t)) order.push(t);
        since.set(t, k.at);
        if (k.done?.threads.includes(t) && k.done.at >= (done.get(t)?.at ?? -Infinity)) done.set(t, k.done);
      }
    }
    return order.map((id) => {
      const info = this.known.get(id) ?? { name: "", project: "" };
      const d = done.get(id);
      const status = current.has(id) && !(d && d.at >= since.get(id)!) ? "current" : since.has(id) ? "done" : "next";
      return { threadId: id, name: info.name, project: info.project, status, ...(d ? { outcome: d.outcome } : {}), ...(info.ask ? { ask: info.ask } : {}) };
    });
  }
}
