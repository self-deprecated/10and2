// The timeline (`GET /api/timeline`, contracts §3): what happened, newest first, in one stream. Replies arriving, calls
// with Driver and what changed in them, and what the user changed with a tap on the phone. Built only from what the
// brain keeps already: each thread's card (its latest reply), the conversations, their carried-out changes, and the
// taps (`TAP`). A thread's page is the same stream narrowed to it, with every one of its replies.
import { isNew } from "./briefing.ts";
import { tappedWords } from "./drafts.ts";
import { pastReplies } from "./reading.ts";
import type { ReadDeps } from "./reads.ts";
import { TAP, type Proposal } from "./store.ts";
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
type Change = { text: string; result: string | null; state: string; at: number; threads: string[] };
export type TimelineItem =
  | { kind: "reply"; id: string; at: number; thread: Thread; messageId: string; ask: string | null; summary: string | null; unread: boolean }
  | { kind: "call"; id: string; at: number; conversationId: string; startedAt: number; endedAt: number; title: string; changes: Change[]; agenda: AgendaItem[] | null }
  | { kind: "action"; id: string; at: number; action: string; thread: TapThread; until: string | null; state: string; result: string | null; text?: string };
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
  const wanted = (t: TapThread) => (q.thread === null || t.id === q.thread) && (q.project === null || t.project === q.project);
  const out: TimelineItem[] = [];

  if (q.kind === null || q.kind === "replies") {
    const reads = store.reads();
    // Opened in the system since the last refresh: the live list's visits, as the Inbox reads them (`newReplies`).
    const visited = new Map((await deps.adapter.list().catch(() => [...items.values()])).map((i) => [i.id, i.visitedAt]));
    const cards = new Map(store.cards().map((c) => [c.itemId, c]));
    // The stream has each briefed thread's latest reply, with its card; a thread's page has all its replies, whatever
    // its state, the earlier ones saying how they begin (as the reply picker does).
    const threads = q.thread === null ? [...cards.keys()] : [q.thread];
    for (const id of threads) {
      const i = items.get(id);
      const card = cards.get(id);
      if (!i || !wanted(threadOf(id))) continue;
      const all = q.thread === null ? [] : await pastReplies(deps, id).catch(() => []);
      const refs = all.length ? all.map((r) => ({ messageId: r.messageId, at: r.finishedAt, firstSentence: r.firstSentence })) : card?.reply ? [{ ...card.reply, firstSentence: "" }] : [];
      refs.forEach((r, n) => {
        const latest = card?.reply?.messageId === r.messageId;
        out.push({
          kind: "reply", id: `reply:${id}:${r.messageId}`, at: Date.parse(r.at), thread: threadOf(id), messageId: r.messageId,
          ask: latest ? card!.ask : null, summary: latest ? card!.summary : r.firstSentence || null,
          unread: n === 0 && isNew({ runId: null, messageId: r.messageId, at: r.at }, reads.get(id), visited.has(id) ? visited.get(id) : i.visitedAt),
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
    for (const c of store.conversations(CALLS)) {
      const endedAt = ended.get(c.id) ?? c.lastActive;
      const made = (byCall.get(c.id) ?? []).map((p) => ({ p, threads: threadsOf(p).map((id) => threadOf(id, p.targets.find((t) => t.itemId === id))) }));
      // Narrowed to a thread or a project, a call shows only the changes it made there, and isn't shown without one.
      const kept = q.thread === null && q.project === null ? made : made.filter((m) => m.threads.some(wanted));
      if (!kept.length && (q.thread !== null || q.project !== null)) continue;
      out.push({
        kind: "call", id: `call:${c.id}`, at: endedAt, conversationId: c.id, startedAt: c.startedAt, endedAt, title: c.title, agenda: null,
        changes: kept.map(({ p, threads }) => {
          const change = { text: p.readback, result: p.result, state: p.state, at: p.createdAt, threads: threads.map((t) => t.id) };
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
      out.push({ kind: "action", id: `action:${p.id}`, at: p.createdAt, ...what, thread, until: p.fields.until ?? null, state: p.state, result: p.result });
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
