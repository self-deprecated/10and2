// Read-only news for the phone's local cue, and for a live voice session's mid-call notices. This never changes a voice
// session or a heard/read watermark.
import type { Adapter, ReplyRef, WorkItem } from "./adapter.ts";
import { briefable, isNew } from "./briefing.ts";
import { spokenTitle } from "./handles.ts";
import type { Store } from "./store.ts";
import { mapLimit } from "./util.ts";

export type ReplyUpdate = { itemId: string; messageId: string; finishedAt: string; name: string; group: string };
export type Updates = { watching: string[]; replies: ReplyUpdate[]; unavailable: string[] };
/** A thread's latest finished reply as read live, with the start of its text (credentials not yet masked). */
export type LiveReply = { item: WorkItem; reply: ReplyRef; text: string; question: string | null };

/** A thread's last report as last read: which reply it is, and enough of its text to tell its gist once masked. */
type Latest = { version: string; checked: number; reply: ReplyRef | null; text: string; question: string | null };
/** How much of a reply's text is kept: more than is ever told, so masking sees a credential whole before it's cut. */
const TEXT_MAX = 4000;
/** A cached report no poll has asked for in this long is dropped. */
const FORGET_MS = 10 * 60_000;

/** Latest unheard reply per watched thread. Stars, heard marks and read marks are durable in Store; the cache is
 * only an optimization. Read actual reply identities rather than run completions (a failed run may have no reply).
 * Bypass the briefing's classification/debounce, and share overlapping polls: the phone's and a live session's read
 * each thread's report once between them. */
export class WatchedReplies {
  private cache = new Map<string, Latest>();
  /** Reports being read now, so polls that overlap share one read. */
  private reading = new Map<string, Promise<Latest>>();
  private pending: Promise<Updates> | null = null;

  private deps: { adapter: Adapter; store: Store };

  constructor(deps: { adapter: Adapter; store: Store }) { this.deps = deps; }

  snapshot(now = Date.now()): Promise<Updates> {
    this.pending ??= this.read(now).finally(() => { this.pending = null; });
    return this.pending;
  }

  /**
   * The latest finished reply of each of `ids`, with its text, from the same reads and cache as `snapshot`: what a live
   * session tells during the call (`VoiceSession`). Threads that aren't briefed, can't be reached or whose report can't
   * be read are left out; whether a reply is news is the caller's to judge.
   */
  async replies(ids: string[], now = Date.now()): Promise<LiveReply[]> {
    const { adapter } = this.deps;
    const items = new Map((await adapter.list()).map((i) => [i.id, i]));
    const out: LiveReply[] = [];
    await mapLimit(ids, 4, async (id) => {
      const item = items.get(id);
      if (!item || !briefable(item) || !adapter.connected(id)) return;
      const latest = await this.latest(item, now).catch(() => null);
      if (latest?.reply && adapter.connected(id)) out.push({ item, reply: latest.reply, text: latest.text, question: latest.question });
    });
    return out;
  }

  /**
   * `item`'s last report: read again when its run completion changes, and at most every 30 s otherwise. Progress and
   * metadata changes don't require fetching the same finished report again. A periodic retry also catches a report
   * arriving just after its completion event, and adapters without completion dates.
   */
  private latest(item: WorkItem, now: number): Promise<Latest> {
    const version = item.lastRunAt ?? item.updatedAt;
    const cached = this.cache.get(item.id);
    if (cached && cached.version === version && now - cached.checked < 30_000) return Promise.resolve(cached);
    let reading = this.reading.get(item.id);
    if (!reading) {
      reading = this.deps.adapter.report(item.id)
        .then((report) => {
          const latest = { version, checked: now, reply: report.text.trim() ? report.reply ?? null : null, text: report.text.slice(0, TEXT_MAX), question: report.question };
          this.cache.set(item.id, latest);
          return latest;
        })
        .finally(() => this.reading.delete(item.id));
      this.reading.set(item.id, reading);
    }
    return reading;
  }

  private async read(now: number): Promise<Updates> {
    const { adapter, store } = this.deps;
    const stars = store.starsSeen();
    const items = new Map((await adapter.list()).map((i) => [i.id, i]));
    const replies: ReplyUpdate[] = [];
    const unavailable: string[] = [];
    for (const [id, c] of this.cache) if (now - c.checked > FORGET_MS) this.cache.delete(id);
    await mapLimit([...stars.keys()], 4, async (id) => {
      if (!adapter.connected(id)) { unavailable.push(id); return; }
      const item = items.get(id);
      if (!item || !briefable(item)) return;
      if (item.lastRunAt && Date.parse(item.lastRunAt) <= stars.get(id)!.runAt) return;
      let cached: Latest;
      try {
        cached = await this.latest(item, now);
      } catch {
        unavailable.push(id);
        return;
      }
      if (!adapter.connected(id)) { unavailable.push(id); return; }
      const reply = cached.reply;
      // Reading/hearing or unstarring while the report was fetched wins over this poll.
      const seen = store.starsSeen().get(id);
      if (!seen || !reply || !(Date.parse(reply.at) > seen.runAt)) return;
      if (!isNew(reply, store.reads().get(id), item.visitedAt)) return;
      replies.push({ itemId: id, messageId: reply.messageId, finishedAt: new Date(reply.at).toISOString(), name: spokenTitle(item.title), group: item.group });
    });
    const watching = [...store.stars()];
    return {
      watching,
      replies: replies.filter((r) => watching.includes(r.itemId)).sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt) || a.itemId.localeCompare(b.itemId)),
      // An unavailable machine isn't an empty inbox: the phone keeps its last known entries for these threads.
      unavailable: unavailable.filter((id) => watching.includes(id)),
    };
  }
}
