// Demo mode's work system: the fixed workspace in workspace.ts, held in memory. Every action succeeds and changes only
// this copy; a follow-up or new work starts a run that "replies" seconds later, so waits, call-backs, mid-call notices
// and readings all happen as they would with real agents. Nothing here touches a machine, a file or the network: the
// only outside call is `write`, given by whoever builds it, for replies the script doesn't have.
//
// Runtime-neutral (no Node imports, time and timers through a `Clock`), so it runs on Lattice and in a Durable Object.
import type { Action, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "../adapter.ts";
import type { Clock, Timer } from "../util.ts";
import { DEMO_MACHINE, FOLLOW_UP_SECONDS, NEW_WORK_SECONDS, THREADS, type DemoCard, type DemoThread, type Scripted } from "./workspace.ts";

/** What a reply the script doesn't have is written from: the thread, its last reply and what the user asked. */
export type WriteInput = { title: string; project: string; lastReply: string | null; message: string; newThread: boolean };
export type Writer = (input: WriteInput) => Promise<{ text: string; card: DemoCard }>;

type Run = { prompt: string; progress: string; summary: string; timer: Timer; reply: () => Promise<{ text: string; card: DemoCard }> };
type Question = NonNullable<DemoThread["question"]>;
type Thread = {
  item: WorkItem;
  /** Newest first, each with what the briefing says of it. */
  replies: (PastReply & { card: DemoCard })[];
  question: Question | null;
  next: Scripted[];
  run: Run | null;
  /** Follow-ups sent while it was working, run after it in turn (a follow-up never interrupts). */
  queue: string[];
  archived: boolean;
};

const MIN = 60_000;
/** A reply the writer hasn't finished by the time the run should end gets this long more, then the stock reply. */
const WRITE_GRACE_MS = 8_000;
const plain = (s: string) => s.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A reply for words the script didn't foresee, when there's no writer or it failed. */
export function stockReply(message: string, newThread: boolean, title: string): { text: string; card: DemoCard } {
  const asked = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return newThread
    ? {
      text: `I've made a start on ${title}. I read through the project, wrote a short plan, and did the first step: the groundwork is in and its tests pass. Nothing is committed yet. Do you want me to carry on with the rest of the plan?`,
      card: { state: "needs_decision", summary: `It made a start on ${title} and is asking whether to carry on.`, ask: "Carry on with the rest of the plan?", suggested: "follow_up" },
    }
    : {
      text: `Done. You asked: "${asked}". I made that change, ran the tests, and they all pass. It's committed on a branch, not merged, so you can look it over first. Want me to merge it?`,
      card: { state: "ready_to_apply", summary: "It made the change you asked for; tests pass, and it's ready to merge.", ask: null, suggested: "follow_up" },
    };
}

export class DemoAdapter implements Adapter {
  readonly name = "demo";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  private readonly threads = new Map<string, Thread>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private readonly clock: Clock;
  private readonly write?: Writer;
  private readonly log: (m: string) => void;
  private seq = 0;
  private closed = false;

  constructor(opts: { clock: Clock; write?: Writer; log?: (m: string) => void }) {
    this.clock = opts.clock;
    this.write = opts.write;
    this.log = opts.log ?? (() => {});
    const now = this.clock.now();
    const at = (agoMin: number) => new Date(now - agoMin * MIN).toISOString();
    for (const t of THREADS) {
      const replies = t.replies.map((r, i) => ({ runId: `${t.id}-run-${t.replies.length - i}`, messageId: `${t.id}-reply-${t.replies.length - i}`, at: at(r.agoMin), text: r.text, prompt: r.prompt, card: r.card }));
      const last = replies[0];
      const updated = t.running ? Math.min(t.running.startedAgoMin, t.replies[0].agoMin) : t.replies[0].agoMin;
      const item: WorkItem = {
        id: t.id,
        title: t.title,
        group: t.project,
        status: t.status,
        updatedAt: at(updated),
        settled: t.settled ?? false,
        snoozedUntil: t.snoozedDays ? new Date(now + t.snoozedDays * 1440 * MIN).toISOString() : null,
        parentId: t.parent ?? null,
        pendingQuestion: !!t.question,
        lastRunAt: last.at,
        questionId: t.question?.id ?? null,
        visitedAt: t.visited ? at(updated) : null,
        wroteAt: at(t.wroteAgoMin ?? t.running?.startedAgoMin ?? t.replies[0].agoMin),
      };
      const thread: Thread = { item, replies, question: t.question ?? null, next: t.next ?? [], run: null, queue: [], archived: false };
      this.threads.set(t.id, thread);
      const r = t.running;
      if (r) this.begin(thread, r.prompt, { progress: r.progress, summary: r.summary, ms: r.finishesInSec * 1000, reply: async () => ({ text: r.text, card: r.card }) });
    }
  }

  connected() { return !this.closed; }
  connectionStatus() { return [{ name: DEMO_MACHINE, connected: !this.closed }]; }

  async list(): Promise<WorkItem[]> {
    const now = this.clock.now();
    return [...this.threads.values()].filter((t) => !t.archived).map((t) => ({
      ...t.item,
      snoozedUntil: t.item.snoozedUntil && Date.parse(t.item.snoozedUntil) > now ? t.item.snoozedUntil : null,
    }));
  }

  places(): Place[] {
    const active = new Map<string, string>();
    for (const t of this.threads.values()) if ((active.get(t.item.group) ?? "") < t.item.updatedAt) active.set(t.item.group, t.item.updatedAt);
    return [...active].map(([name, activeAt]) => ({ id: `demo-place-${name}`, name, activeAt }));
  }

  async report(id: string): Promise<Report> {
    const t = this.thread(id);
    const last = t.replies[0];
    const q = t.question;
    return {
      text: last?.text ?? "",
      progress: t.run?.progress ?? null,
      question: q ? `${q.text} Options: ${q.options.map((o) => o.label).join(" / ")}.` : null,
      reply: last ? { runId: last.runId, messageId: last.messageId, at: last.at } : null,
    };
  }

  async replies(id: string): Promise<PastReply[]> {
    return this.thread(id).replies.map(({ card: _, ...r }) => ({ ...r }));
  }

  /** What the briefing says of a thread as it is now: demo mode's classifier (see world.ts). */
  cardFor(id: string): DemoCard | null {
    const t = this.threads.get(id);
    if (!t) return null;
    if (t.run) return { state: "running", summary: t.run.summary, ask: null, suggested: "none" };
    return t.replies[0]?.card ?? null;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    const done = this.receipts.get(key);
    if (done) return done;
    const receipt = this.apply(action);
    this.receipts.set(key, receipt);
    return receipt;
  }

  private apply(action: Action): Receipt {
    const now = new Date(this.clock.now()).toISOString();
    if (action.kind === "start_work") {
      const place = this.places().find((p) => p.id === action.placeId);
      const id = `demo-new-${++this.seq}`;
      const item: WorkItem = {
        id, title: action.title, group: place?.name ?? action.placeId.replace(/^demo-place-/, ""), status: "running", updatedAt: now, settled: false, snoozedUntil: null,
        parentId: null, pendingQuestion: false, lastRunAt: null, questionId: null, visitedAt: null, wroteAt: now,
      };
      const thread: Thread = { item, replies: [], question: null, next: [], run: null, queue: [], archived: false };
      this.threads.set(id, thread);
      this.begin(thread, action.message, this.planned(thread, action.message, true));
      this.log(`demo: started ${action.title} in ${item.group}`);
      this.emit([id]);
      return { ok: true, itemId: id };
    }
    const t = this.threads.get(action.itemId);
    if (!t || t.archived) return { ok: false, error: "That thread is gone." };
    if (action.kind === "follow_up") {
      if (t.run) t.queue.push(action.message);
      else this.begin(t, action.message, this.planned(t, action.message, false));
      t.item.wroteAt = now;
    } else if (action.kind === "settle") t.item.settled = true;
    else if (action.kind === "snooze") t.item.snoozedUntil = action.until;
    else if (action.kind === "unsnooze") t.item.snoozedUntil = null;
    else if (action.kind === "unsettle") t.item.settled = false;
    else if (action.kind === "archive") t.archived = true;
    t.item.updatedAt = now;
    this.log(`demo: ${action.kind} ${t.item.title}`);
    this.emit([t.item.id]);
    return { ok: true };
  }

  async markRead(itemId: string, watermark: string): Promise<Receipt> {
    const t = this.threads.get(itemId);
    if (t && (t.item.visitedAt ?? "") < watermark) t.item.visitedAt = watermark;
    return { ok: true };
  }

  watch(onChange: (ids: string[], urgent: boolean) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.threads.values()) if (t.run) this.clock.clear(t.run.timer);
    this.listeners.clear();
  }

  private thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t || t.archived) throw new Error(`no thread ${id}`);
    return t;
  }

  /**
   * What a follow-up (or new work's first message) gets: the answer to the thread's question when it picks an option
   * or the words fit one, a scripted reply whose words match, or else one written for it (`write`), started now so it's
   * ready when the run ends; the stock reply if that fails or is late.
   */
  private planned(t: Thread, message: string, newThread: boolean): { progress: string; summary: string; ms: number; reply: () => Promise<{ text: string; card: DemoCard }> } {
    const said = plain(message);
    const option = t.question?.options.find((o) => plain(o.label) === said) ?? t.question?.options.find((o) => o.reply.when.test(message));
    const scripted = option?.reply ?? t.next.find((s) => s.when.test(message));
    const ms = (newThread ? NEW_WORK_SECONDS : FOLLOW_UP_SECONDS) * 1000;
    const gist = message.replace(/\s+/g, " ").trim();
    const summary = newThread ? `It's just started on ${t.item.title}.` : `It's working on your follow-up: ${gist.length > 80 ? `${gist.slice(0, 80)}…` : gist}`;
    if (scripted) return { progress: scripted.progress, summary, ms, reply: async () => ({ text: scripted.text, card: scripted.card }) };
    const stock = stockReply(message, newThread, t.item.title);
    const written = this.write?.({ title: t.item.title, project: t.item.group, lastReply: t.replies[0]?.text ?? null, message, newThread })
      .catch((e) => {
        this.log(`demo: couldn't write a reply for ${t.item.title} (${e instanceof Error ? e.message : e}); using the stock one`);
        return stock;
      });
    return {
      progress: newThread ? "Reading through the project and planning the first step." : "Working on it: reading the code involved.",
      summary,
      ms,
      reply: () => (written ? Promise.race([written, new Promise<typeof stock>((r) => this.clock.setTimeout(() => r(stock), WRITE_GRACE_MS).unref())]) : Promise.resolve(stock)),
    };
  }

  private begin(t: Thread, prompt: string, plan: { progress: string; summary: string; ms: number; reply: Run["reply"] }) {
    if (t.question) {
      t.question = null;
      t.item.pendingQuestion = false;
      t.item.questionId = null;
    }
    t.item.status = "running";
    t.item.updatedAt = new Date(this.clock.now()).toISOString();
    const run: Run = { prompt, progress: plan.progress, summary: plan.summary, reply: plan.reply, timer: this.clock.setTimeout(() => void this.finish(t, run), plan.ms) };
    // A demo's runs never keep the process up.
    run.timer.unref();
    t.run = run;
  }

  private async finish(t: Thread, run: Run) {
    const { text, card } = await run.reply();
    if (this.closed || t.run !== run) return;
    const n = t.replies.length + 1;
    const at = new Date(this.clock.now()).toISOString();
    t.replies.unshift({ runId: `${t.item.id}-run-${n}`, messageId: `${t.item.id}-reply-${n}`, at, text, prompt: run.prompt, card });
    t.run = null;
    t.item.status = "completed";
    t.item.lastRunAt = at;
    t.item.updatedAt = at;
    this.log(`demo: ${t.item.title} replied`);
    const queued = t.queue.shift();
    if (queued !== undefined) this.begin(t, queued, this.planned(t, queued, false));
    this.emit([t.item.id]);
  }

  /** Every change is worth briefing at once: classifying a demo thread costs nothing. */
  private emit(ids: string[]) {
    for (const l of this.listeners) l(ids, true);
  }
}
