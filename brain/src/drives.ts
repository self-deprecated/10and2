// Drives: what the user did with Driver in one stretch, and what has happened since. A drive is the brain's own record
// of sessions: one starting within 30 minutes of the last one's end is the same drive, and so is a conversation carrying
// on within 90 (a call-back after a wait, coming back from a reading or a dictation). Everything said about a drive is
// built in code from the ledger and the live thread list, never written by a model.
import type { WorkItem } from "./adapter.ts";
import type { BriefingView } from "./briefing.ts";
import type { Store } from "./store.ts";

export const DRIVE_GAP_MS = 30 * 60_000;
export const CARRY_ON_MS = 90 * 60_000;

export type SessionSpan = { conversationId: string; startedAt: number; endedAt: number | null };
export type Drive = { start: number; end: number; conversations: string[] };

/** Sessions (any order) grouped into drives, oldest first. A session still open (or lost in a crash) ends as it starts. */
export function drives(sessions: SessionSpan[]): Drive[] {
  const out: Drive[] = [];
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    const last = out.at(-1);
    const end = Math.max(s.startedAt, s.endedAt ?? s.startedAt);
    if (last && continues(last, s.conversationId, s.startedAt)) {
      last.end = Math.max(last.end, end);
      if (!last.conversations.includes(s.conversationId)) last.conversations.push(s.conversationId);
    } else {
      out.push({ start: s.startedAt, end, conversations: [s.conversationId] });
    }
  }
  return out;
}

/** Whether a session starting at `at` in `conversationId` belongs to `drive`. */
export const continues = (drive: Drive, conversationId: string | null, at: number) =>
  at - drive.end <= DRIVE_GAP_MS || (conversationId !== null && drive.conversations.includes(conversationId) && at - drive.end <= CARRY_ON_MS);

/** The drives of the last month, oldest first. */
export const recentDrives = (store: Store, now = Date.now()) => drives(store.sessionsSince(now - 30 * 86_400_000));

export type DriveSummary = {
  start: number;
  end: number;
  /** Each change's receipt: "Started Launch profiles in driver, on Quartz, and starred it." */
  changes: string[];
  /** Threads whose news or reply the user heard. */
  heard: string[];
  notes: string[];
  /** Threads Driver is still watching for this drive. */
  waiting: string[];
};

/** What a drive did, from the ledger: `names` says threads as they're named now; one not named any more is left out. */
export function summarize(store: Store, drive: Drive, names: Map<string, string>): DriveSummary {
  const inDrive = (at: number) => at >= drive.start - 60_000 && at <= drive.end + 60_000;
  const changes = drive.conversations
    .flatMap((c) => store.proposalsFor(c))
    .filter((p) => (p.state === "executed" || p.state === "partial") && p.result && inDrive(store.carriedOutAt(p.id) ?? p.createdAt))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => p.result!);
  const heardIds = new Set([...store.heardBetween(drive.conversations, drive.start, drive.end + 60_000), ...store.readsBetween(drive.start, drive.end + 60_000)]);
  const waits = store.waits().filter((w) => drive.conversations.includes(w.conversationId) && !w.ready);
  return {
    start: drive.start,
    end: drive.end,
    changes,
    heard: [...heardIds].map((id) => names.get(id)).filter((n): n is string => !!n),
    notes: store.notesBetween(drive.start, drive.end + 60_000),
    waiting: waits.map((w) => w.handle),
  };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const when = (at: number) => `${new Date(at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ${time(at)}`;

/** A drive's summary as sentences, or null when nothing happened in it. */
export function summaryText(s: DriveSummary): string | null {
  const parts = [
    ...s.changes,
    s.heard.length ? `Heard from ${list(s.heard)}.` : "",
    s.notes.length ? `Remembered: ${s.notes.map((n) => n.replace(/[.!?]+$/, "")).join("; ")}.` : "",
    s.waiting.length ? `Still waiting on ${list(s.waiting)}.` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** The threads the user acted on in a drive: started or sent a message (said or dictated). */
function actedOn(store: Store, drive: Drive): string[] {
  const ids = drive.conversations
    .flatMap((c) => store.proposalsFor(c))
    .filter((p) => p.state === "executed" && (p.action === "follow_up" || p.action === "start_work"))
    .flatMap((p) => (p.action === "start_work" ? (p.fields.itemId ? [p.fields.itemId] : []) : p.targets.map((t) => t.itemId)));
  return [...new Set(ids)];
}

/**
 * What happened since the last drive ended: first the threads the user acted on in it (which replied, are asking
 * something, are still working, or have nothing new), then how many other threads have new replies since. Null when
 * there's nothing to say.
 */
export function sinceText(store: Store, last: Drive, items: WorkItem[], view: BriefingView, names: Map<string, string>): string | null {
  const acted = actedOn(store, last);
  const lines = acted.flatMap((id) => {
    const item = items.find((i) => i.id === id);
    const name = names.get(id);
    if (!item || !name || item.settled) return [];
    if (item.pendingQuestion) return [`${name} is waiting on the user`];
    if (item.status === "running") return [`${name} is still working`];
    if (item.lastRunAt && Date.parse(item.lastRunAt) > last.end) return [`${name} has replied`];
    return [`${name} has nothing new`];
  });
  const others = view.cards.filter((c) => c.unread && c.reply && Date.parse(c.reply.at) > last.end && !acted.includes(c.itemId)).length;
  if (!lines.length && !others) return null;
  return [
    `Since the user's last drive with Driver (it ended ${when(last.end)}):`,
    lines.length ? `${list(lines)}.` : "",
    others ? `${others} other ${others === 1 ? "thread has a new reply" : "threads have new replies"} since then (in the briefing).` : "",
    "This is the first conversation of a new drive: in your first answer, unless the user asks something else, sum this up in a sentence or two, starting with the threads they acted on.",
  ].filter(Boolean).join(" ");
}

/**
 * The drive block of a session's briefing: what this drive has done so far, or, for the first session of a new drive,
 * what happened since the last one. `memoryStart`: nothing from before it (the memory window, Forget now).
 */
export function driveBlock(store: Store, conversationId: string, now: number, memoryStart: number, live: { items: WorkItem[]; view: BriefingView; names: Map<string, string> }): string | null {
  const all = recentDrives(store, now);
  const last = all.at(-1);
  if (!last || last.end < memoryStart) return null;
  if (continues(last, conversationId, now)) {
    const text = summaryText(summarize(store, last, live.names));
    return text ? `What Driver has done on this drive so far (since ${time(last.start)}), from its own record: ${text} Say this when the user asks what they got done.` : null;
  }
  return sinceText(store, last, live.items, live.view, live.names);
}
