// Which replies are new to the user: the latest reply of each briefed thread, until it's been read out to them in full
// in Driver or they opened the thread in the system (see briefing.ts `isNew`). Reading one in full also marks the
// thread read in the system, retried until it's taken.
import type { Adapter } from "./adapter.ts";
import type { Briefing } from "./briefing.ts";
import type { Store } from "./store.ts";
import { describe } from "./util.ts";

export type ReadDeps = { adapter: Adapter; briefing: Briefing; store: Store; log: (m: string) => void };

/** The threads with a reply new to the user, newest first, as the phone lists them. */
export async function newReplies(deps: Pick<ReadDeps, "adapter" | "briefing">) {
  const live = await deps.adapter.list().catch(() => undefined);
  return deps.briefing
    .view(live)
    .cards.filter((c) => c.unread)
    .map((c) => ({ id: c.itemId, name: c.handle, group: c.group, status: c.status, finishedAt: c.reply!.at, messageId: c.reply!.messageId, summary: c.summary }));
}

/**
 * The user heard `messageId`, the thread's latest reply, in full (`conversationId`: during that conversation). Refused
 * when the thread has a different reply by now, so a newer one is never marked read unheard. One the briefing hasn't
 * caught up with yet is caught up first.
 */
export async function markRead(deps: ReadDeps, itemId: string, messageId: string, conversationId: string | null): Promise<{ ok: true } | { error: string }> {
  const card = () => deps.briefing.view().cards.find((c) => c.itemId === itemId)?.reply;
  if (card()?.messageId !== messageId && (await deps.adapter.replies?.(itemId).catch(() => null))?.[0]?.messageId === messageId) {
    await deps.briefing.refresh([itemId]);
  }
  const reply = card();
  if (!reply) return { error: "no reply to mark read for that thread" };
  if (reply.messageId !== messageId) return { error: "that thread has a newer reply" };
  // What T3 is told the user has seen: the thread as it is now, if no run has finished since this reply (its state
  // when the reply was read can predate the reply's own run ending); otherwise as it was then.
  const live = (await deps.adapter.list().catch(() => [])).find((i) => i.id === itemId);
  const caughtUp = live && (!live.lastRunAt || Date.parse(live.lastRunAt) <= Date.parse(reply.at) + 1000);
  deps.store.markRead(itemId, { ...reply, watermark: caughtUp ? live.updatedAt : reply.watermark });
  // Heard in full is heard: a starred thread doesn't call back with it, and it isn't news again in this conversation.
  deps.store.markSeen(itemId, { runAt: Date.parse(reply.at), question: null }, conversationId);
  void syncVisits(deps);
  return { ok: true };
}

let syncing: Promise<void> | null = null;

/** Tells the system about every reply read in full that it hasn't taken yet. One pass at a time. */
export function syncVisits(deps: ReadDeps): Promise<void> {
  syncing ??= (async () => {
    for (const v of deps.store.pendingVisits()) {
      // One key per reply and watermark: T3 counts a retry once, and takes a later watermark for the same reply.
      const r = await deps.adapter.markRead?.(v.itemId, v.watermark, `driver-visit:${v.messageId}:${Date.parse(v.watermark)}`).catch((e) => ({ ok: false as const, error: describe(e) }));
      if (r === undefined || r === "unsupported" || r.ok) deps.store.visitDone(v.itemId, v.messageId, v.watermark);
      else deps.log(`reads: couldn't mark ${v.itemId} read (${r.error}); will try again`);
    }
  })()
    // Callers don't wait for this: a store that fails is logged, never an unhandled rejection.
    .catch((e) => deps.log(`reads: couldn't send the reads to the system (${describe(e)})`))
    .finally(() => (syncing = null));
  return syncing;
}
