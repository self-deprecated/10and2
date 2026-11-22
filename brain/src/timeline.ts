// The timeline (`GET /api/timeline`, contracts §3): what happened, newest first, in one stream. Replies arriving, calls
// with Driver and what changed in them, and what the user changed with a tap on the phone. Built only from what the
// brain keeps already: each thread's card (its latest reply), the conversations, their carried-out changes, and the
// taps (`TAP`). A thread's page is the same stream narrowed to it, with every one of its replies. From the engine's
// stage 3.9, Away's lines too: when it was turned on, until when, and how it ended (away.ts).
import { aged, ASKS, isNew, staleAfterDays } from "./briefing.ts";
import { awayLines, awayLog } from "./away.ts";
import { laterTimeline } from "./later.ts";
import { VIA_SAID } from "./later-lines.ts";
import { timelineRun, timelineStopped, timelineTimeout } from "./held-lines.ts";
import { privacyOf } from "./privacy.ts";
import { phoneZoneIn } from "./ring.ts";
import { tappedWords } from "./drafts.ts";
import { pastReplies } from "./reading.ts";
import type { ReadDeps } from "./reads.ts";
import { TAP, type Approved, type Proposal } from "./store.ts";
import type { AgendaItem, CallRecord } from "./voice/callview.ts";

/** What the phone and the desk page show of changes: the ones carried out or tried. */
export const SHOWN = new Set(["executed", "partial", "failed", "unknown"]);
export const KINDS = ["replies", "calls", "actions"] as const;
const PAGE = 30;
const MAX_PAGE = 100;
/** How many of the latest calls the timeline goes back through. */
const CALLS = 1000;

type Thread = { id: string; name: string; project: string };
/** A tap's thread: `id` is null only for a new thread started with a tap that isn't known (it failed, or its outcome was lost). */
type TapThread = Omit<Thread, "id"> & { id: string | null };
/** `approved`: how a send was agreed to in the call ("spoken yes", "tap", "Face ID"); none for any other change. */
type Change = { text: string; result: string | null; state: string; at: number; threads: string[]; approved?: string };

/** How a send was agreed to, as the Timeline says it (Fable's 4-F and 4-K): "(spoken yes)", "(tap)", "(Face ID)", "(lock screen)". */
export const APPROVED_SAID: Record<Approved, string> = { ...VIA_SAID, lock_screen: "lock screen" };

/** How a send (a reply or a new thread) was agreed to, in the Timeline's words; nothing for any other change, or one from before. */
const approvedOf = (p: Proposal) => ((p.action === "follow_up" || p.action === "start_work") && p.fields.approved ? { approved: APPROVED_SAID[p.fields.approved] } : {});

/**
 * A reply sent from a notification (Fable's 4-K: an answer's button, a quick reply, Reply…, Send now), as the Timeline
 * says it, the thread always named: "Sent to API: Carry on (lock screen)", "(Face ID)" where the phone asked for it.
 */
export function sentFromNote(thread: string, words: string, approved: Approved): string {
  return `Sent to ${thread}: ${words} (${APPROVED_SAID[approved]})`;
}
export type TimelineItem =
  | { kind: "reply"; id: string; at: number; thread: Thread; messageId: string; ask: string | null; summary: string | null; unread: boolean }
  | {
    kind: "call"; id: string; at: number; conversationId: string; startedAt: number; endedAt: number;
    /** The minutes its calls used, in seconds, as the phone showed them; null for a call no phone reported. */
    usedSeconds: number | null;
    title: string; changes: Change[]; agenda: AgendaItem[] | null;
  }
  /**
   * `approved`: how a send was agreed to ("tap", "Face ID", "lock screen", "spoken yes"); `line`: one sent from a
   * notification, in the brain's words ("Sent to API: Carry on (lock screen)"), which the phone shows as it is.
   */
  | { kind: "action"; id: string; at: number; action: string; thread: TapThread; until: string | null; state: string; result: string | null; text?: string; approved?: string; line?: string }
  /** Away (the engine's stage 3.9): "Away on until Monday 08:00", "Away ended: you wrote in Migration on Lattice". */
  | { kind: "away"; id: string; at: number; text: string }
  /** Sends and starts set up for later (stage 4b; Fable's 4-F): "Scheduled for API, 03:00 tomorrow: carry on (spoken yes)". */
  | { kind: "later"; id: string; at: number; text: string }
  /** Commands that wait (Fable's 4-H2): "Let terraform apply run in API (Face ID)", "Stopped terraform apply in API". */
  | { kind: "held"; id: string; at: number; text: string; thread: Thread };
export type TimelineQuery = { before: string | null; limit: number; project: string | null; kind: (typeof KINDS)[number] | null; thread: string | null };

/** The query from the URL, or what's wrong with it. */
export function timelineQuery(url: URL): TimelineQuery | { error: string } {
  const q = (k: string) => url.searchParams.get(k) || null;
  const kind = q("kind");
  if (kind !== null && !(KINDS as readonly string[]).includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
  const before = q("before");
  if (before !== null && !/^\d+~./.test(before)) return { error: "before must be a cursor from an earlier page's next" };
  const asked = Math.floor(Number(q("limit") ?? PAGE));
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : PAGE, 1), MAX_PAGE);
  return { before, limit, project: q("project"), kind: kind as TimelineQuery["kind"], thread: q("thread") };
}

/** The start of what the user wrote, for a line in the timeline: up to 12 words. */
function firstWords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 12 ? words.join(" ") : `${words.slice(0, 12).join(" ")}…`;
}

/** The threads a change was about, as top-level ids: a new thread once started, a tidy's parents, else its targets. */
const threadsOf = (p: Proposal) =>
  p.action === "start_work" ? (p.fields.itemId ? [p.fields.itemId] : [])
    : [...new Set(p.targets.map((t) => (p.action === "settle_subagents" ? t.parentId ?? t.itemId : t.itemId)))];

/** One page of the timeline, newest first, and the cursor for the next (null at the end). Null: no such thread. */
export async function timeline(deps: ReadDeps, q: TimelineQuery): Promise<{ items: TimelineItem[]; next: string | null } | null> {
  const { store, briefing } = deps;
  const items = new Map(briefing.allItems().filter((i) => i.parentId === null).map((i) => [i.id, i]));
  if (q.thread !== null && !items.has(q.thread)) return null;
  const names = new Map([...briefing.names(true), ...briefing.names()]);
  /** A thread as it's called now; one gone from the list as it was called when the change was made. */
  const threadOf = (id: string, was?: { handle: string; group?: string }): Thread => {
    const i = items.get(id);
    return { id, name: names.get(id) ?? i?.title ?? was?.handle ?? "", project: i?.group ?? was?.group ?? "" };
  };
  // A project is asked for as `/api/threads` names it: without its computer ("expo": on every computer), or as an older
  // phone has it, with ("expo, on Quartz").
  const inProject = (t: TapThread) => t.project === q.project || (t.id !== null && items.get(t.id)?.project === q.project);
  const wanted = (t: TapThread) => (q.thread === null || t.id === q.thread) && (q.project === null || inProject(t));
  const out: TimelineItem[] = [];

  if (q.kind === null || q.kind === "replies") {
    const reads = store.reads();
    // Opened in the system since the last refresh: the live list's visits, as the Inbox reads them (`newReplies`).
    const visited = new Map((await deps.adapter.list().catch(() => [...items.values()])).map((i) => [i.id, i.visitedAt]));
    const cards = new Map(store.cards().map((c) => [c.itemId, c]));
    // The stream has each briefed thread's latest reply, with its card; a thread's page has all its replies, whatever
    // its state, the earlier ones saying how they begin (as the reply picker does).
    const threads = q.thread === null ? [...cards.keys()] : [q.thread];
    // A question asks only while it counts on Home: one gone stale with age (the account's setting) has no ask here
    // either, so it gets no dot and no answers to tap.
    const staleAfter = staleAfterDays(store);
    const now = Date.now();
    for (const id of threads) {
      const i = items.get(id);
      const card = cards.get(id);
      if (!i || !wanted(threadOf(id))) continue;
      const all = q.thread === null ? [] : await pastReplies(deps, id).catch(() => []);
      const refs = all.length ? all.map((r) => ({ messageId: r.messageId, at: r.finishedAt, firstSentence: r.firstSentence })) : card?.reply ? [{ ...card.reply, firstSentence: "" }] : [];
      refs.forEach((r) => {
        const latest = card?.reply?.messageId === r.messageId;
        out.push({
          kind: "reply", id: `reply:${id}:${r.messageId}`, at: Date.parse(r.at), thread: threadOf(id), messageId: r.messageId,
          ask: latest && ASKS.has(aged(card!, i, null, now, staleAfter).state) ? card!.ask : null, summary: latest ? card!.summary : r.firstSentence || null,
          // Every reply the user hasn't heard, not only the newest: hearing that one marks the rest heard too.
          unread: isNew({ runId: null, messageId: r.messageId, at: r.at }, reads.get(id), visited.has(id) ? visited.get(id) : i.visitedAt),
        });
      });
    }
  }

  const changes = q.kind === "replies" ? [] : store.proposalsIn([...SHOWN]);
  /** Each call's change, for when it was carried out: looked up only for the calls on the page. */
  const proposalOf = new Map<Change, Proposal>();
  if (q.kind === null || q.kind === "calls") {
    const byCall = Map.groupBy(changes.filter((p) => p.conversationId !== TAP), (p) => p.conversationId);
    const ended = store.lastActivity();
    const used = store.usedSeconds();
    for (const c of store.conversations(CALLS)) {
      const endedAt = ended.get(c.id) ?? c.lastActive;
      const made = (byCall.get(c.id) ?? []).map((p) => ({ p, threads: threadsOf(p).map((id) => threadOf(id, p.targets.find((t) => t.itemId === id))) }));
      // Narrowed to a thread or a project, a call shows only the changes it made there, and isn't shown without one.
      const kept = q.thread === null && q.project === null ? made : made.filter((m) => m.threads.some(wanted));
      if (!kept.length && (q.thread !== null || q.project !== null)) continue;
      out.push({
        kind: "call", id: `call:${c.id}`, at: endedAt, conversationId: c.id, startedAt: c.startedAt, endedAt, usedSeconds: used.get(c.id) ?? null, title: c.title, agenda: null,
        changes: kept.map(({ p, threads }) => {
          const change = { text: p.readback, result: p.result, state: p.state, at: p.createdAt, threads: threads.map((t) => t.id), ...approvedOf(p) };
          proposalOf.set(change, p);
          return change;
        }),
      });
    }
  }
  if (q.kind === null || q.kind === "actions") {
    for (const p of changes) {
      if (p.conversationId !== TAP) continue;
      const target = p.targets[0];
      // A new thread started with a tap is listed as "start", with the thread once it's known (its id null until then).
      const started = p.action === "start_work";
      const was = { handle: p.fields.title ?? "New thread", group: p.fields.place ?? "" };
      const thread: TapThread | null = started ? (p.fields.itemId ? threadOf(p.fields.itemId, was) : { id: null, name: was.handle, project: was.group }) : target ? threadOf(target.itemId, target) : null;
      if (!thread || !wanted(thread)) continue;
      // A reply sent with a tap is listed as "reply", and a start as "start", each with its first words.
      const what = started ? { action: "start", text: firstWords(p.fields.message ?? "") }
        : p.action === "follow_up" ? { action: "reply", text: firstWords(tappedWords(p.fields.message ?? "")) } : { action: p.action };
      // Sent from a notification: its own line, how it was agreed to in it.
      const noted = p.action === "follow_up" && p.fields.noted && p.fields.approved && p.state === "executed" ? { line: sentFromNote(thread.name, tappedWords(p.fields.message ?? ""), p.fields.approved) } : {};
      out.push({ kind: "action", id: `action:${p.id}`, at: p.createdAt, ...what, thread, until: p.fields.until ?? null, state: p.state, result: p.result, ...approvedOf(p), ...noted });
    }
    // Away's lines (Fable, 3.9-G): only in the whole stream, not a thread's or a project's. Thread names follow Privacy's
    // switch, computers' only when the account has more than one; times on the phone's clock.
    if (q.thread === null && q.project === null) {
      const computers = deps.adapter.connectionStatus?.().length || new Set(briefing.allItems().map((i) => i.machine ?? "")).size;
      const words = { names: privacyOf(store).names, computers, zone: phoneZoneIn(store) ?? "UTC" };
      for (const e of awayLog(store)) for (const l of awayLines(e, words)) out.push({ kind: "away", id: `away:${e.id}:${l.key}`, at: l.at, text: l.text });
      for (const l of laterTimeline(store, computers || 1)) out.push({ kind: "later", id: `later:${l.key}`, at: l.at, text: l.text });
    }
    // Commands that wait (Fable's 4-H2): how each held command ended, by the phone or with no answer; a thread's page too.
    for (const r of store.reachOuts()) {
      if (r.kind !== "held" || !r.news.held) continue;
      const thread = threadOf(r.news.itemId, { handle: r.news.handle });
      if (!wanted(thread)) continue;
      const end = r.ended?.end ?? (r.answer ? (r.answer.run ? "run" : "stop") : null);
      const text = end === "run" ? timelineRun(r.news.held.matched, thread.name, r.answer?.how ?? "faceid")
        : end === "stop" ? timelineStopped(r.news.held.matched, thread.name)
        : end === "timeout" ? timelineTimeout(r.news.held.matched, thread.name) : null;
      if (text) out.push({ kind: "held", id: `held:${r.key}`, at: r.answer?.at ?? r.ended?.at ?? r.at, text, thread });
    }
  }

  const cursor = (i: TimelineItem) => `${i.at}~${i.id}`;
  const [bAt, bId] = q.before === null ? [Infinity, ""] : [Number(q.before.slice(0, q.before.indexOf("~"))), q.before.slice(q.before.indexOf("~") + 1)];
  const page = out
    .filter((i) => i.at < bAt || (i.at === bAt && i.id < bId))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const shown = page.slice(0, q.limit);
  for (const i of shown) {
    if (i.kind !== "call") continue;
    for (const c of i.changes) c.at = store.carriedOutAt(proposalOf.get(c)!.id) ?? c.at;
    // The agenda as the call ended: what it covered and decided, and what it left for later (none before 7 November).
    i.agenda = store.callView<CallRecord>(i.conversationId)?.agenda ?? null;
  }
  return { items: shown, next: page.length > q.limit ? cursor(shown.at(-1)!) : null };
}
