// HTTP for the desk page (and later the phone): exchange an SDP offer for a session, stop it,
// and inspect the briefing and recent changes.
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { Files } from "./files.ts";
import { dirname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { attachConnectors, type ConnectorMachine } from "./connectors.ts";
import type { Config } from "./config.ts";
import { defaults, MAX_MINUTES_CAP, type Settings } from "./settings.ts";
import type { Beat, CallEvent, Calls } from "./calls.ts";
import { headTail } from "./briefing.ts";
import { TAP, type Proposal, type Seen, type Store } from "./store.ts";
import { markRead, newReplies, syncVisits } from "./reads.ts";
import { WatchedReplies } from "./updates.ts";
import { masked, pastReplies, prepare, prepareReply, type ReadingStyle } from "./reading.ts";
import { prepareBriefing, type BriefingWriter } from "./briefing-reading.ts";
import { CONVERSATION_VOICES, READING_VOICES } from "./voice/voices.ts";
import { holdAfter, namedItems, recordNames, setStar, type ToolDeps, type Watched } from "./voice/tools.ts";
import { attachSession, createWebRtcSession, type LiveConn, type OpenSocket } from "./voice/live.ts";
import { ROLL_LATE } from "./voice/endPolicy.ts";
import type { Hangups } from "./voice/hangups.ts";
import type { Recordings } from "./voice/recording.ts";
import type { Flags } from "./flags.ts";
import { buildSessionConfig, VoiceSession, type Conversations, type Opening, type ReadOut } from "./voice/session.ts";
import { CallView, type CallRecord } from "./voice/callview.ts";
import { describe, spokenHost } from "./util.ts";
import type { ConsentHolder, Props } from "./analytics.ts";
import { recentDrives, summarize, summaryText } from "./drives.ts";
import { assemble, DRAFT_MAX, draftStateOf, parseDraft, newThreadTarget, parseNewThread, tappedReply, tappedWords, wordCount, type Draft, type NewThread } from "./drafts.ts";
import { confirmOf, parseUntil, READBACK_ALL, tapVia, trackChange, type ConfirmLevels, type KeepReplies, type TapAction } from "./proposals.ts";
import { SHOWN, timeline, timelineQuery } from "./timeline.ts";

/** A session request that can't go ahead, for a reason the phone shows the user. */
class Refused extends Error {}

export type ServerDeps = ToolDeps & {
  conversations: Conversations;
  connectors?: ConnectorMachine[];
  /** Records every session as OpenAI creates it, and hangs it up until OpenAI confirms it's over. */
  hangups: Hangups;
  log: (m: string) => void;
  refresh: () => Promise<void>;
  /** Records each session's events, when recording is on. */
  recordings?: Recordings;
  /**
   * The account's analytics consent, which this server takes from each request as it arrives (contracts §5): Lattice's.
   * A cloud brain's object takes it itself, so it's not given there.
   */
  consent?: ConsentHolder;
  /** Whether this account keeps its own call audio (a tester who switched it on; the cloud only). */
  keepCallAudio?: () => boolean;
  /** Writes the moments the user flags in a call ("debug this") for review. */
  flags?: Flags;
  /** Creates the GPT-Live session; tests swap in a fake. */
  createSession?: typeof createWebRtcSession;
  /** Attaches the sideband to a session that exists (after a restart, `reattach`); tests swap in a fake. */
  attachSession?: (sessionId: string, log: (m: string) => void, track: { close: (id: string) => void }, openSocket: OpenSocket) => Promise<LiveConn>;
  /** Which brain this is (`brainRev`): reported with the state, and in each session's recording, flags and log. */
  brainRev?: string;
  /** Opens the sideband's WebSocket: `ws` on Node, the Worker's own in a Durable Object. Tests with `createSession` need none. */
  openSocket?: OpenSocket;
  /** Where the phone's logs are kept: next to the database on Lattice, in R2 in the cloud. Without, they're refused. */
  files?: Files;
  /** Where a session's recording is, for analytics (contracts §5): `r2:<key>` in the cloud; Lattice's when not given. */
  recordingRef?: (sessionId: string) => string;
  /** The caller was checked before the request got here (the cloud's Worker), so no access code is asked for. */
  authenticated?: boolean;
  /** A demo world (demo/world.ts): the machine its threads are on, as the phone shows it. */
  demo?: { machine: string };
  /**
   * The cloud's credit meter (contracts §4): each session's cumulative billed seconds, debited once each under the
   * allowance in the call's settings; `out` ends the call with a goodbye. Lattice and demo worlds have none.
   */
  meter?: { voice(sessionId: string, seconds: number, settings: Settings): { out: boolean } | Promise<{ out: boolean }> };
  /** A hard cap on every session (the cloud's anonymous demo drive): Driver says goodbye before it and the call ends at it. */
  capMs?: number;
  /** 10 & 2 Ops' registry of calls (calls.ts): the cloud's; Lattice has none. */
  calls?: Calls;
  /** The settings anything starting now goes by: the cloud's, from Ops (docs/launch/ops-app.md §4.3); else git's. */
  settings?: () => Settings;
  /** Writes the spoken briefing's script (`POST /api/briefing`); without it, or when it fails, it's put together from the cards. */
  writeBriefing?: BriefingWriter;
};

/** Makes a fresh demo world: each demo starts from the same workspace. */
export type DemoWorlds = () => Promise<ServerDeps & { close(): Promise<void> }>;

/** One world's API (the real brain's, or a demo's): every `/api/` route, past the access checks. */
type Api = {
  handle(req: Request, url: URL, body?: any): Promise<Response>;
  /** Ends its live session, if any: another world's is starting (one person, one live session). */
  closeActive(): void;
  /** After a restart: takes back the session the last run left live, if it can; returns the ids it took. */
  reattach(): Promise<string[]>;
  /** Whether this world has had conversation `id`. */
  knows(id: string): boolean;
  /** The live session in memory, for the registry's heartbeat; null when there's none. */
  heartbeat(): Beat | null;
  /** Ends session `id` if it's the live one (staff, from Ops); never another, such as the user's next call. */
  closeSession(id: string): "ended" | "not_current";
  close(): Promise<void>;
};

/** Room for a dictated reply (drafts.ts `DRAFT_MAX`) alongside the SDP offer. */
const MAX_BODY = 128 * 1024;
const CONVERSATION_ID = /^[\w-]{8,64}$/;
/** How long the phone's memory setting keeps notes when a client doesn't say (the desk page, older apps). */
const DEFAULT_MEMORY_DAYS = 3;
/**
 * A Start within this long of the last conversation's last session rejoins it, rather than begin a new one: the user
 * stopping and starting again, or a reading or dictation it handed off ending, isn't the end of a conversation.
 */
const REJOIN_MS = 30 * 60_000;
/** How long a refresh may hold the request before the caller gets the briefing as it stands. */
const REFRESH_WAIT_MS = 20_000;

/** What an error's status means, for the phone's logic (docs/launch/contracts.md §1); `error` is for people. */
const CODES: Record<number, string> = { 400: "bad_request", 401: "sign_in", 402: "out_of_credits", 403: "forbidden", 404: "not_found", 409: "refused", 429: "slow_down" };

function send(status: number, body: unknown): Response {
  const coded = status >= 400 && body && typeof body === "object" && !("code" in body) ? { ...body, code: CODES[status] ?? "server" } : body;
  return new Response(JSON.stringify(coded), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function readJson(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new Error("body too large");
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BODY) throw new Error("body too large");
  return JSON.parse(new TextDecoder().decode(body) || "{}");
}

/** A request's method and headers as the checks below read them, header names in lower case (as `node:http` has them). */
type Headed = { method?: string; headers: Record<string, string | string[] | undefined> };
const headed = (req: Request): Headed => ({ method: req.method, headers: Object.fromEntries(req.headers) });

function authorized(req: Headed, code: string): boolean {
  if (!code) return true;
  const given = Buffer.from(String(req.headers["x-driver-access"] ?? ""));
  const want = Buffer.from(code);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * A proxy in front of a loopback brain (Tailscale Serve) makes every tailnet request look local. Without an access
 * code those would be open, so the brain refuses them.
 */
export function proxiedWithoutCode(req: Pick<Headed, "headers">, code: string): boolean {
  return !code && (req.headers["x-forwarded-for"] !== undefined || req.headers["tailscale-user-login"] !== undefined);
}

/**
 * Any web page the user visits can POST to a loopback server. A JSON content type forces a CORS
 * preflight (which this server never approves), and browsers mark cross-site requests outright.
 */
export function sameSite(req: Headed): boolean {
  if (req.method !== "POST") return true;
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "cross-site" || site === "same-site") return false;
  return String(req.headers["content-type"] ?? "").startsWith("application/json");
}

/**
 * The phone's build, as it sends it with every request (`x-driver-build`, "1.4 (57)"), or null from an older phone or
 * the desk page. Only what a build can be made of, so it can't break a log line or a flag's Markdown.
 */
export const phoneBuildOf = (req: Pick<Headed, "headers">) =>
  String(req.headers["x-driver-build"] ?? "").replace(/[^\w.()+: -]/g, "").trim().slice(0, 64) || null;

/** Most of one test run's log kept: a phone stuck sending can't fill the disk. */
const TEST_LOG_MAX = 5 * 1024 * 1024;

/**
 * Appends lines `from` onwards (counted as the phone counts them) to a test run's log, skipping any it already has (a
 * retry after a lost answer). Returns how many lines it has, which is where the phone sends from next: after a gap,
 * nothing is added and the phone sends again from there. Readable only by the brain's user, like recordings.
 */
export async function appendTestLog(files: Files, path: string, from: number, text: string): Promise<number> {
  const kept = await files.read(path);
  if (!kept) await pruneTestLogs(files, path.slice(0, path.lastIndexOf("/")));
  const old = kept ? new TextDecoder().decode(kept) : "";
  const have = old ? old.split("\n").length - 1 : 0;
  const lines = text.split("\n");
  if (have < from || have >= from + lines.length || (have > 0 && (kept?.length ?? 0) > TEST_LOG_MAX)) return have;
  await files.write(path, old + lines.slice(have - from).map((l) => `${l}\n`).join(""));
  return from + lines.length;
}

/** Where each of the phone's logs is kept, among the brain's files. */
const LOG_DIRS: Record<string, string> = { "/api/diagnostics/reading-test": "reading-tests", "/api/diagnostics/log": "phone-logs" };

/** A new run's log: those older than a month go, and only the newest 200 runs are kept. */
async function pruneTestLogs(files: Files, dir: string, now = Date.now()) {
  const logs = (await files.list(dir)).filter((f) => f.path.endsWith(".log")).sort((a, b) => b.at - a.at);
  for (const [i, l] of logs.entries()) if (i >= 199 || now - l.at > 30 * 86_400_000) await files.remove(l.path);
}

/**
 * The phone's Fast mode (Settings → Fast mode): "conversations" puts the voice backend in it, "all" the rewrite a
 * reading waits on too. Anything else, and an older phone that sends nothing, is off.
 */
const fastOf = (body: any) => ({ conversations: body.fast === "conversations" || body.fast === "all", readings: body.fast === "all" });

/**
 * What a reply to a thread does in a call, dictated or worded by Driver (the phone's setting, `KeepReplies`). An older
 * phone, which sends nothing and can't show kept replies, gets "send", as before.
 */
const keepRepliesOf = (body: any): KeepReplies => (body.keepReplies === "ask" || body.keepReplies === "keep" ? body.keepReplies : "send");

/** The most kept replies one Send all sends. */
const SEND_ALL_MAX = 50;

/** How the phone asks for replies to be read: `style` is "adapted" or as written, `leadIn` "prompt" or "none". */
const styleOf = (body: any, style: unknown): ReadingStyle => ({
  skipCode: body.skipCode === true || body.skipCode === "true",
  adapted: style === "adapted",
  leadIn: body.leadIn === "prompt" ? "prompt" : "none",
  fast: fastOf(body).readings,
});

function api(cfg: Config, deps: ServerDeps): Api {
  const updates = new WatchedReplies(deps);
  const brainRev = deps.brainRev ?? "dev";
  /** The settings a call starting now gets. */
  const current = (): Settings => deps.settings?.() ?? defaults(cfg);
  /** A report to the registry: never stops anything. */
  const report = (event: CallEvent) => {
    try {
      deps.calls?.report(event);
    } catch (e) {
      deps.log(`voice ${event.sessionId}: couldn't report to the registry (${describe(e)})`);
    }
  };
  // One person, one live session: starting another closes the previous one. Creation is serialized. Each request
  // notes how many stops there have been (`stops`, counted by /api/session/stop and wait cancel) when it's accepted; a
  // stop after that, while it's queued, preparing or being created, ends its session as soon as it exists, before it
  // says anything.
  let active: { id: string; conversationId: string; session: VoiceSession; view: CallView } | null = null;
  let creating: Promise<unknown> = Promise.resolve();
  /**
   * What the phone shows of the call (`GET /api/calls/current`): `starting` while a session is being made (its agenda
   * shows as it connects), then the live one's. The conversation's view carries on in any session that carries the
   * conversation on (a rollover, a reconnect, a rejoin, a call-back, back from a reading or dictation); only a new
   * conversation is a new view (`viewFor`).
   */
  let starting: CallView | null = null;
  let lastView: CallView | null = null;
  /** Threads watched during a call that rolled over, for its next session (only a `resume` takes them). */
  const carried = new Map<string, Watched[]>();
  let stops = 0;

  /**
   * Call-back news not yet told, per conversation: a reconnect carries it again, and each reply is heard once the user
   * could hear it (`VoiceSession.expect`). Kept in the store, so a restart keeps it, for an hour at most; the user's
   * Stop and wait cancel drop it (unheard).
   */
  type Reply = Extract<Opening, { kind: "callback" }>["replies"][number];
  type Untold = { at: number; replies: { itemId: string; handle: string; seen: Seen; reply: Reply }[] };
  const UNTOLD_MS = 60 * 60_000;
  const untold = deps.store.untold<Untold["replies"][number]>();
  /** The store is a record for after a restart: a failed write is logged, and the news carries on in memory. */
  const saveUntold = (conversationId: string) => {
    try {
      deps.store.saveUntold(conversationId, untold.get(conversationId) ?? null);
    } catch (e) {
      deps.log(`voice ${conversationId}: couldn't save its call-back news (${describe(e)})`);
    }
  };
  const dropUntold = (conversationId?: string) => {
    for (const id of conversationId ? [conversationId] : [...untold.keys()]) {
      untold.delete(id);
      saveUntold(id);
    }
  };
  const fresh = (u: Untold | undefined) => !!u?.replies.length && Date.now() - u.at <= UNTOLD_MS;
  for (const [id, u] of untold) if (!fresh(u)) dropUntold(id);

  /**
   * A new conversation, a reconnect, a reopened one, or the call-back for a finished wait. A call-back's `created`
   * runs once its session exists: only then is the wait used up, so a call-back that fails to start loses nothing.
   *
   * A finished wait is told however the phone starts: as the call-back it asked for, a reconnect, a reopened
   * conversation, or a new conversation, when the phone lost track of the one it held for (it crashed, or the app was
   * closed, while holding). Then the session joins that conversation, so `conversationId` may change. That holds only
   * while the news is fresh (`READY_MS`, `UNTOLD_MS`), and never for `mode: "new"`, an explicitly fresh conversation.
   * Otherwise a session with no conversation rejoins the last one, if it was in use in the last `REJOIN_MS` and memory
   * is on (`memoryDays` > 0; 0 for a client that doesn't say, such as the desk page, whose new tab is a new conversation).
   */
  async function opening(conversationId: string | null, mode: unknown, accepted: number, memoryDays: number): Promise<{ conversationId: string | null; open: Opening; created?: () => void; news?: boolean }> {
    if (!conversationId && mode === "new") return { conversationId, open: { kind: "new" } };
    deps.waits.expire();
    const w = conversationId ? deps.waits.get(conversationId) : deps.waits.newestReady();
    if (w?.ready && w.replies.length) {
      if (w.conversationId !== conversationId) deps.log(`wait ${w.conversationId}: a new conversation was started; it's this wait's call-back instead`);
      conversationId = w.conversationId;
      const told = w.replies;
      const replies = await Promise.all(told.map((r) => readReply(w.conversationId, r.itemId, r.handle, r.outcome)));
      const open: Opening = { kind: "callback", replies };
      const id = conversationId;
      return {
        conversationId,
        open,
        news: true,
        created: () => {
          if (stops !== accepted) return; // stopped meanwhile
          const news = { at: Date.now(), replies: told.map((r, i) => ({ itemId: r.itemId, handle: r.handle, seen: r.seen, reply: replies[i] })) };
          const own = deps.waits.get(id) === w;
          // The wait becomes untold news in one transaction (a crash can't lose both). If that fails, this throws and
          // the session is ended: the wait is still there, for the next try.
          deps.store.callBackStarted(id, news, own);
          if (own) deps.waits.take(id);
          for (const [other, u] of untold) if (!fresh(u)) dropUntold(other);
          untold.set(id, news);
        },
      };
    }
    const joined = !conversationId;
    const recent = joined && memoryDays > 0 ? deps.store.lastConversation(Date.now() - REJOIN_MS) : null;
    if (!conversationId) {
      // Likewise news a call-back hadn't finished telling when the phone lost track of it (fresh only).
      const newest = [...untold].filter(([, u]) => fresh(u)).sort((a, b) => b[1].at - a[1].at)[0]?.[0];
      conversationId = newest ?? recent;
      if (!conversationId) return { conversationId: null, open: { kind: "new" } };
    }
    // The call-back dropped before the user heard all its news: the reconnect tells what's left.
    const pending = mode !== "continue" ? untold.get(conversationId) : undefined;
    if (pending) await retell(conversationId, pending);
    if (fresh(pending)) {
      if (joined) deps.log(`voice: a new conversation was started; it carries on ${conversationId}, whose call-back news is still to be told`);
      return { conversationId, open: { kind: "callback", replies: pending!.replies.map((r) => r.reply) }, news: true };
    }
    if (joined && recent) {
      deps.log(`voice: a new conversation was started; it rejoins ${recent}, in use in the last ${REJOIN_MS / 60_000} minutes`);
      return { conversationId: recent, open: { kind: "rejoin" } };
    }
    if (joined) return { conversationId: null, open: { kind: "new" } };
    return { conversationId, open: { kind: mode === "continue" || mode === "callback" ? "continue" : "resume" } };
  }

  /** A thread's reply for a call-back. One that can't be read now (T3 is down) never stops the session: it's `unread`. */
  async function readReply(conversationId: string, itemId: string, handle: string, outcome: string): Promise<Reply> {
    const rep = await deps.adapter.report(itemId).catch((e) => {
      deps.log(`wait ${conversationId}: couldn't read ${handle}'s reply (${describe(e)})`);
      return null;
    });
    // Only the start and end are ever spoken; keep no more than that.
    return rep
      ? { handle, outcome, report: { text: headTail(masked(rep.text), 1500), progress: rep.progress ? headTail(masked(rep.progress), 600) : null, question: rep.question } }
      : { handle, outcome, report: { text: "", progress: null, question: null }, unread: true };
  }

  /**
   * Before untold news is told again: a reply that couldn't be read is read now, and one the user has since heard in
   * full (Driver looked it up with `details`) is no longer news.
   */
  async function retell(conversationId: string, pending: Untold) {
    let changed = false;
    for (const r of [...pending.replies]) {
      if (!r.reply.unread) continue;
      const heard = deps.store.heard(conversationId, r.itemId);
      if (heard && heard.runAt >= r.seen.runAt && (r.seen.question == null || heard.question === r.seen.question)) {
        pending.replies = pending.replies.filter((x) => x !== r);
        changed = true;
        continue;
      }
      const reply = await readReply(conversationId, r.itemId, r.handle, r.reply.outcome);
      if (!reply.unread) {
        r.reply = reply;
        changed = true;
      }
    }
    if (!changed) return;
    if (!pending.replies.length && untold.get(conversationId) === pending) untold.delete(conversationId);
    saveUntold(conversationId);
  }

  /**
   * What a call-back session must tell: each reply is heard once the user could hear it, unless Stop dropped it. A reply
   * that couldn't be read isn't heard by being named: it stays untold until its contents are told (`details` marks
   * that), or it's read and told in a later session.
   */
  function newsFor(conversationId: string) {
    const pending = untold.get(conversationId);
    if (!pending) return [];
    return pending.replies.filter((r) => !r.reply.unread).map((r) => ({
      handle: r.handle,
      itemId: r.itemId,
      ...(r.seen.runAt ? { at: new Date(r.seen.runAt).toISOString() } : {}),
      said: () => {
        if (untold.get(conversationId) !== pending || !pending.replies.includes(r)) return;
        try {
          deps.store.markSeen(r.itemId, r.seen, conversationId);
        } catch (e) {
          deps.log(`voice ${conversationId}: couldn't record that ${r.handle}'s news was heard (${describe(e)})`);
        }
        pending.replies = pending.replies.filter((x) => x !== r);
        if (!pending.replies.length) untold.delete(conversationId);
        saveUntold(conversationId);
      },
    }));
  }

  /**
   * Back from the phone reading replies out: which it read, how many of each one's segments played to their end
   * (`heard`: "<reading>:<n>,…"; a skipped reply played none, whatever came after it), and what the user said to come
   * back. A reply heard to its end counts as heard in this conversation, once the session exists. `base` is the opening
   * the conversation would otherwise get: its call-back news is told too.
   */
  async function readingOpening(conversationId: string, body: any, base: Opening): Promise<{ open: Opening; heard: () => void }> {
    // A hand-off holds a few readings; more is a phone gone wrong, and each costs T3 a projection.
    const ids = String(body.readingIds ?? "").split(",").map((s) => s.trim()).filter((id) => /^[0-9a-f]{24}$/.test(id)).slice(0, 20);
    const marks: (() => void)[] = [];
    const played = new Map(String(body.heard ?? "").split(",").map((p) => p.trim().split(":")).filter((p) => p.length === 2).map(([id, n]) => [id, Math.max(0, Math.floor(Number(n)) || 0)]));
    const names = new Map(namedItems(deps.briefing).map((n) => [n.id, n.handle]));
    const read: ReadOut[] = [];
    for (const id of ids) {
      const r = deps.store.reading(id);
      if (!r) continue;
      const reply = ((await deps.adapter.replies?.(r.itemId).catch(() => null)) ?? []).find((x) => x.messageId === r.messageId);
      const parts = Math.min(played.get(id) ?? 0, r.segments);
      const heard = parts >= r.segments ? "all" : parts > 0 ? "part" : "none";
      read.push({ handle: names.get(r.itemId) ?? "that thread", heard, parts, of: r.segments, text: reply?.text ?? "", itemId: r.itemId, ...(reply ? { at: reply.at } : {}) });
      if (heard === "all" && reply) marks.push(() => deps.store.markSeen(r.itemId, { runAt: Date.parse(reply.at), question: null }, conversationId));
    }
    // A reply the user left unsent to come back: which thread (its name is ours, never the phone's), and how far along.
    const keptParts = Math.floor(Number(body.keptParts));
    const kept = typeof body.keptItemId === "string" && keptParts > 0
      ? { handle: names.get(body.keptItemId) ?? "a thread", parts: Math.min(keptParts, 99) }
      : undefined;
    return {
      open: { kind: "reading", read, said: typeof body.said === "string" ? body.said.slice(0, 500) : "", news: base.kind === "callback" ? base.replies : [], kept },
      heard: () => marks.forEach((m) => m()),
    };
  }

  /**
   * A dictated reply, put together and proposed in conversation `conversationId`, for Driver to ask the user to send, or
   * (`keep`, the user's setting) to ask whether to send it now or keep it for later, or kept for later at once. A new
   * thread's prompt is always asked about: there's no thread to keep it for. `reading` is what the phone read before it,
   * if anything. Refused (409) when it can't be sent: already sent, its thread gone, or too long.
   */
  async function dictatedOpening(conversationId: string, draft: Draft, reading: Extract<Opening, { kind: "reading" }>, keep: KeepReplies, confirm: ConfirmLevels): Promise<Opening> {
    const message = assemble(draft, (readingId) => {
      const r = deps.store.reading(readingId);
      const segments = deps.store.readingSegments(readingId);
      return r && segments ? { itemId: r.itemId, segments } : null;
    });
    if (message.length > DRAFT_MAX + 2000) throw new Refused("That reply is too long to send in one go.");
    // A new thread's prompt carries where to start it in its target; it's checked again as it's proposed.
    const start = parseNewThread(draft.itemId);
    const size = { draftId: draft.id, message, words: wordCount(draft), parts: draft.parts.length };
    const mode = start ? "send" : keep;
    const made = start ? await deps.proposals.proposeDraftStart(conversationId, { ...size, ...start }, confirm.start)
      : mode === "keep" ? deps.proposals.keepDraft(conversationId, { ...size, itemId: draft.itemId })
      : await deps.proposals.proposeDraft(conversationId, { ...size, itemId: draft.itemId }, confirm.reply);
    if ("error" in made) throw new Refused(made.error);
    const { proposal } = made;
    // The same draft kept before, back from the phone to be sent: it's this proposal now, and no longer kept.
    const old = mode !== "keep" ? deps.store.keptByDraft(draft.id) : null;
    if (old) deps.store.dropKept(old.id);
    const handle = start ? proposal.fields.title! : proposal.targets[0].handle;
    deps.log(`voice ${conversationId}: dictated ${start ? "prompt for a new thread" : "reply to"} ${handle}, ${draft.id}, is ${proposal.id}${mode === "keep" ? ", kept for later" : ""}`);
    const after = mode === "keep" ? { keep: "kept" as const } : mode === "ask" ? { keep: "ask" as const } : {};
    return { kind: "draft", draft: { handle, proposalId: proposal.id, readback: proposal.readback, ...(start ? { newThread: true } : {}), ...after }, read: reading.read, news: reading.news };
  }

  /**
   * What a session was made with, kept in the store so a brain restarted mid-call can take it back (`reattach`).
   * `memoryDays` 0 is memory off; otherwise notes older than that are wiped and the rest recalled. `settings`: the
   * snapshot the call started with (none in a session made before it was kept: the settings current then).
   */
  type Made = { memoryDays: number; voice: string; readingStyle?: ReadingStyle; readingVoice?: string; fast: boolean; phoneBuild: string | null; settings?: Settings; keepReplies?: KeepReplies; confirm?: ConfirmLevels };
  const settingsOf = (made: Made) => made.settings ?? current();

  /**
   * The call's `keepReplies`: the phone's, or for a request carrying a conversation on (it names one, and isn't a new
   * call) that doesn't say, the one its last session had, whatever the session opens with (a reconnect, a rollover, a
   * call-back's news still untold); else "send". Decided from the request: the opening may be a call-back for the same call.
   */
  function keepRepliesFor(body: any, conversationId: string): KeepReplies {
    const carriesOn = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) && body.mode !== "new";
    if (body.keepReplies !== undefined || !carriesOn) return keepRepliesOf(body);
    return keepRepliesOf({ keepReplies: (deps.store.lastResume(conversationId) as Made | null)?.keepReplies });
  }

  /**
   * The call's `confirm` levels, decided as `keepRepliesFor` is: the phone's (each kind it doesn't say, its default), or
   * for a request carrying a conversation on that doesn't send any, the ones its last session had; else the defaults
   * (an older phone).
   */
  function confirmFor(body: any, conversationId: string): ConfirmLevels {
    const carriesOn = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) && body.mode !== "new";
    if (body.confirm !== undefined || !carriesOn) return confirmOf(body.confirm);
    return confirmOf((deps.store.lastResume(conversationId) as Made | null)?.confirm);
  }

  /**
   * The call's view for a session in `conversationId`. One that carries the conversation on keeps its agenda and
   * receipts: the last view, if it's this conversation's, else one from the conversation's start and the record its
   * last session left (the brain restarted). Any other is a new call.
   */
  function viewFor(conversationId: string, carriesOn: boolean): CallView {
    if (!carriesOn) return new CallView(deps, conversationId, Date.now());
    if (lastView?.conversationId === conversationId) return lastView;
    const began = deps.store.conversation(conversationId)?.startedAt ?? Date.now();
    return new CallView(deps, conversationId, began, Date.now, deps.store.callView<CallRecord>(conversationId));
  }

  /** `voice`: the phone's choice, or null for the settings' default. */
  async function startSession(sdp: string, conversationId: string, open: Opening, memoryDays: number, accepted: number, voice: string | null, created?: () => void, news = false, readingStyle?: ReadingStyle, readingVoice?: string, fast = false, phoneBuild: string | null = null, keepReplies: KeepReplies = "send", confirm: ConfirmLevels = READBACK_ALL) {
    // 7 November: a call started again after hanging up lost its agenda and receipts on the phone.
    const view = viewFor(conversationId, open.kind !== "new");
    // A dictated reply kept for later as the call opened is closed already: its receipt is still this call's.
    if (open.kind === "draft") view.adopt(open.draft.proposalId);
    starting = view;
    try {
      active?.session.close({ kind: "replaced" });
      // A reading handed to the phone belongs to the session that hung up for it; a new one has moved on.
      deps.store.dropHandoff(conversationId);
      if (memoryDays > 0) deps.store.forgetBefore(Date.now() - memoryDays * 86_400_000);
      // The briefing about to be spoken names these threads; those names keep meaning them for the whole conversation.
      recordNames(deps, conversationId);
      // One snapshot of the settings for the whole call, taken in line with other starts.
      const snapshot = current();
      const settings: Made = { memoryDays, voice: voice ?? snapshot.voice, readingStyle, readingVoice, fast, phoneBuild, settings: snapshot, keepReplies, confirm };
      const config = buildSessionConfig(sessionOptions(settings), deps, conversationId, new Date(), open);
      const createStart = Date.now();
      const { sessionId, answerSdp, conn: live } = await (deps.createSession ?? createWebRtcSession)(cfg.apiKey, config, sdp, deps.log, {
        created: (id) => deps.hangups.created(id, conversationId),
        close: (id) => deps.hangups.close(id),
      }, deps.openSocket!);
      const createMs = Date.now() - createStart;
      const session = takeOn(live, sessionId, conversationId, open, settings, view, { created, news });
      try {
        deps.store.saveResume(sessionId, settings);
      } catch (e) {
        deps.log(`voice ${sessionId}: couldn't keep what a restart would need to take it back (${describe(e)})`);
      }
      const watching = carried.get(conversationId);
      carried.delete(conversationId);
      if (watching && open.kind === "resume") session.watch(watching);
      trackOf(sessionId, conversationId)("session_started", {
        opening: open.kind, fast, memory_days: memoryDays, voice: settings.voice, transport: "webrtc", config_version: snapshot.version, threads: namedItems(deps.briefing).length,
        starred: deps.store.stars().size, machines: machines().length, news: open.kind === "callback" ? open.replies.length : 0, create_ms: createMs,
      });
      report({ kind: "started", sessionId, at: Date.now(), opening: open.kind, phoneBuild, brainRev, configVersion: snapshot.version });
      deps.log(`voice ${sessionId}: started (conversation ${conversationId}${open.kind === "new" ? "" : `, ${open.kind}`}; brain ${brainRev}, phone ${phoneBuild ?? "unknown"})`);
      if (stops !== accepted) session.close({ kind: "stopped_before_start" });
      // A call-back speaks first: the user is waiting to hear what the thread said. So does coming back from a reading,
      // or with a dictated reply to send, and a new call: one that waits for the user can seem dead (Apple's reviewer
      // started one on 3 November and neither side spoke for a minute).
      // Unless speak-first is switched off for new calls (Ops), which then wait for the user as before 3 November.
      else if ((open.kind === "new" && snapshot.speakFirstNew) || open.kind === "callback" || open.kind === "reading" || open.kind === "draft") session.speakFirst();
      return { sdp: answerSdp, sessionId, conversationId };
    } finally {
      if (starting === view) starting = null;
    }
  }

  const sessionOptions = (s: Made) => {
    const { liveModel, backendModel, prompts, speakFirstNew } = settingsOf(s);
    return { liveModel, backendModel, prompts, speakFirstNew, voice: s.voice, transport: "webrtc" as const, captions: true, memoryDays: s.memoryDays, fast: s.fast, keepReplies: s.keepReplies, confirm: s.confirm };
  };
  /** Usage analytics for a session (contracts §5), with its ids on every event. */
  const trackOf = (sessionId: string, conversationId: string) => (event: string, props: Props = {}) =>
    deps.analytics?.track(event, { session_id: sessionId, conversation_id: conversationId, ...props }); // events-lint: forwards (each event is named where it's sent)

  /**
   * A live session becomes the brain's: its recording, its VoiceSession, the active one. Made just now, or (`startedAt`,
   * `recordingId`) taken back after a restart. If anything fails before a VoiceSession owns it, it's ended (the reaper
   * hangs it up until OpenAI confirms).
   */
  function takeOn(live: LiveConn, sessionId: string, conversationId: string, open: Opening, settings: Made, view: CallView, opts: { created?: () => void; news?: boolean; startedAt?: number; recordingId?: string } = {}): VoiceSession {
    const { memoryDays, readingStyle, readingVoice, fast, phoneBuild } = settings;
    const snapshot = settingsOf(settings);
    // The backend's instructions, built again from the briefing as it is then, when a refresh mid-session changes the threads' replies.
    const backendInstructions = () => (buildSessionConfig(sessionOptions(settings), deps, conversationId, new Date(), open) as any).delegation.responses.instructions as string;
    const recordingId = opts.recordingId ?? sessionId;
    const recording = record(recordingId, conversationId, open, phoneBuild, snapshot);
    const conn = recording?.wrap(live) ?? live;
    let session: VoiceSession;
    try {
      opts.created?.();
      session = new VoiceSession(conn, { sessionId, conversationId }, {
        ...deps,
        idleMs: snapshot.idleSeconds * 1000,
        maxMs: snapshot.maxMinutes * 60_000,
        startedAt: opts.startedAt,
        memory: memoryDays > 0,
        beforeClose: async (reason, watched) => {
          // A rollover: the phone asks why (`/api/wait`) and opens the next session in this conversation straight away.
          if (reason.kind === "rollover") {
            // Threads the user asked to hear about during the call are still watched in the next session.
            if (watched.length) carried.set(conversationId, watched);
            return deps.store.saveHandoff(conversationId, { handle: "", rollover: true });
          }
          return holdAfter(deps, conversationId, reason, watched);
        },
        news: opts.news ? newsFor(conversationId) : [],
        read: open.kind === "reading" || open.kind === "draft" ? open.read : [],
        record: recording?.note,
        // The recording is finished once stored (the session's hang-up starts closing it); 30 s at most, for a slow upload.
        recorded: recording ? () => Promise.race([recording.done, new Promise<void>((r) => setTimeout(r, 30_000))]) : undefined,
        readingStyle,
        readingVoice,
        fast,
        keepReplies: settings.keepReplies,
        confirm: settings.confirm,
        backendInstructions,
        said: open.kind === "reading" ? open.said : undefined,
        // The same reads as the phone's cue (`/api/updates`), shared: told during the call as soon as they're seen.
        updates,
        versions: { brainRev, phoneBuild, configVersion: snapshot.version },
        liveNotices: snapshot.liveNotices,
        track: trackOf(sessionId, conversationId),
        opening: open.kind,
        recordingRef: recording ? (deps.recordingRef?.(recordingId) ?? `lattice:sessions/${recordingId}.jsonl`) : undefined,
        usage: deps.meter ? (seconds) => deps.meter!.voice(sessionId, seconds, snapshot) : undefined,
        view,
      });
    } catch (e) {
      deps.log(`voice ${sessionId}: couldn't take the session on (${describe(e)}); hanging it up`);
      conn.terminate();
      throw e;
    }
    active = { id: sessionId, conversationId, session, view };
    lastView = view;
    void session.done.then((end) => {
      if (active?.id === sessionId) active = null;
      // The call's record for History and the Timeline: its agenda and receipts as it ended.
      try {
        deps.store.saveCallView(sessionId, view.final());
      } catch (e) {
        deps.log(`voice ${sessionId}: couldn't keep its agenda and receipts (${describe(e)})`);
      }
      report({ kind: "ended", sessionId, at: Date.now(), end: end.kind, billedS: end.billedSeconds, turns: end.turns, firstAudioMs: end.firstAudioMs, answerP50Ms: end.answerP50Ms });
    });
    return session;
  }

  /**
   * After a restart (Cloudflare resets a Durable Object now and then; 5 November, 11 minutes into a call): the newest
   * session the last run never ended, if it's still within its time cap, is attached again and carries on where it was,
   * its cap counted from when it began. Returns the ids taken back; the rest are for the reaper to hang up. What was said
   * in the gap, about a second, isn't heard by the brain.
   */
  async function reattach(): Promise<string[]> {
    let live: ReturnType<Store["liveSessions"]>;
    try {
      // Each session keeps its own cap (its settings); none can be longer than the cap's top.
      live = deps.store.liveSessions(Date.now() - Math.max(cfg.maxSessionMs, MAX_MINUTES_CAP * 60_000) - ROLL_LATE);
    } catch (e) {
      deps.log(`voice: couldn't read which sessions to take back (${describe(e)})`);
      return [];
    }
    const s = live.at(-1);
    if (!s || active) return [];
    const attach = deps.attachSession ?? ((id, log, track, open) => attachSession(cfg.apiKey, id, log, track, open));
    try {
      const conn = await attach(s.id, deps.log, { close: (id) => deps.hangups.close(id) }, deps.openSocket!);
      takeOn(conn, s.id, s.conversationId, { kind: "resume" }, s.resume as Made, viewFor(s.conversationId, true), { startedAt: s.startedAt, recordingId: `${s.id}.after-restart-${Date.now().toString(36)}` });
      deps.log(`voice ${s.id}: taken back after a restart (${Math.round((Date.now() - s.startedAt) / 1000)} s into the session)`);
      trackOf(s.id, s.conversationId)("session_reattached", { age_s: Math.round((Date.now() - s.startedAt) / 1000) });
      return [s.id];
    } catch (e) {
      deps.log(`voice ${s.id}: couldn't take it back after a restart (${describe(e)})`);
      return [];
    }
  }

  /** A session's recording, with what replaying it needs to begin with; none if recording is off or can't start. */
  function record(sessionId: string, conversationId: string, open: Opening, phoneBuild: string | null, settings: Settings) {
    try {
      return deps.recordings?.start(sessionId, {
        conversation: conversationId,
        brainRev,
        phoneBuild,
        configVersion: settings.version,
        opening: open.kind === "callback" ? { kind: open.kind, news: open.replies.map((r) => r.handle) } : { kind: open.kind },
        idleMs: settings.idleSeconds * 1000,
        maxMs: settings.maxMinutes * 60_000,
        // Not settled subagents: nothing names or acts on them, and they're most of a busy T3's threads.
        threads: deps.briefing.allItems().filter((i) => !(i.parentId && i.settled)),
        starred: [...deps.store.stars()],
        ...(deps.demo ? { demo: true } : {}),
      }, { audio: deps.keepCallAudio?.() ?? false });
    } catch (e) {
      deps.log(`voice ${sessionId}: couldn't start its recording (${describe(e)})`);
      return undefined;
    }
  }

  /** Every open top-level thread, newest first, with what the briefing knows and its star: the phone's picker. */
  function threadRows() {
    const stars = deps.store.stars();
    const cards = new Map(deps.briefing.view().cards.map((c) => [c.itemId, c]));
    return namedItems(deps.briefing)
      .map(({ id, handle, group, item }) => ({
        id, name: handle, group, status: item.status, updatedAt: item.updatedAt, starred: stars.has(id), snoozedUntil: item.snoozedUntil,
        state: cards.get(id)?.state ?? null, summary: cards.get(id)?.summary ?? null,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * A tap on the phone that changes a thread (contracts §3): carried out at once, the signed-in tap being the user's yes,
   * and kept for the timeline. An unsettle is of a settled thread; anything else of an open one. `fields`: a snooze's
   * `until`, a reply's `message` (and a kept reply's `keptId`, and its `draftId` if it was dictated).
   */
  async function tapped(body: any, action: TapAction, fields: { until?: string; message?: string; keptId?: string; draftId?: string } = {}): Promise<Response> {
    const again = earlierTap(body, (p) => p.action === action && p.targets[0]?.itemId === body.id && p.fields.until === fields.until && p.fields.message === fields.message);
    if (again) return again;
    const thread = typeof body.id === "string" ? namedItems(deps.briefing, action === "unsettle").find((n) => n.id === body.id) : undefined;
    if (!thread) return send(404, { error: action === "unsettle" ? "no such settled thread" : "no such open thread" });
    if (action === "settle" && thread.item.status === "running") return send(409, { error: `${thread.handle} is still working. Mark it done once it finishes.` });
    // An older connector can't undo a snooze or a settle, and one set to listen in only takes no replies: what the
    // thread's own computer can do.
    if (!(deps.adapter.actionsFor?.(thread.id) ?? deps.adapter.actions).includes(action)) {
      return send(409, { error: action === "follow_up" ? "Your computer only lets 10 & 2 listen in, so nothing was sent." : "Your computer can't do that yet. Update 10 & 2 on it, then try again." });
    }
    const p = await deps.proposals.tap(action, { itemId: thread.id, handle: thread.handle, group: thread.group }, fields, body.requestId);
    deps.log(`tap ${p.id} ${action} ${thread.id} → ${p.state}`);
    if (deps.analytics) trackChange(deps.analytics.track, p, tapVia(body.via, !!fields.keptId), body.dictated === true);
    return tapAnswer(p);
  }

  /** A tap's answer: what became of it, a sentence for the phone when it didn't go through. */
  const tapAnswer = (p: Proposal) =>
    p.state === "executed" ? send(200, { ok: true, state: p.state, result: p.result }) : send(p.state === "unknown" ? 502 : 409, { error: p.result ?? "Nothing was changed." });

  /**
   * The phone's id for a tap: sent again (its answer was lost, or twice at once), it's answered with the first's outcome,
   * if it's the same change (`same`). Null: a new tap. A malformed id is 400. Answered without waiting when it's new,
   * so the same tap sent twice at once finds the first one kept.
   */
  function earlierTap(body: any, same: (p: Proposal) => boolean): Response | Promise<Response> | null {
    if (body.requestId !== undefined && !(typeof body.requestId === "string" && CONVERSATION_ID.test(body.requestId))) return send(400, { error: "requestId must be 8 to 64 letters, digits, - or _" });
    const earlier = body.requestId ? deps.proposals.earlierTap(body.requestId) : null;
    if (!earlier) return null;
    if (!same(earlier.proposal)) return send(409, { error: "That tap was already used for another change. Try again." });
    return earlier.done.then(tapAnswer);
  }

  /** Answers being carried out now, by request id: the same tap sent again (a lost answer, a double tap) joins its run. */
  const answering = new Map<string, Promise<Proposal>>();

  /**
   * Send or Don't, tapped for proposal `id` (contracts §3, "In a call"): only for a change still waiting for a yes in the
   * live call. The signed-in tap is the user's yes or "don't": it's carried out (or called off) as the spoken one is, and
   * Driver is told so it can say so. `requestId` makes it safe to send again: the same id is answered with what became
   * of the proposal; the same id for another proposal or the other button is 409.
   */
  async function tappedAnswer(body: any, id: string, verb: "confirm" | "cancel"): Promise<Response> {
    const requestId = body.requestId;
    if (!(typeof requestId === "string" && CONVERSATION_ID.test(requestId))) return send(400, { error: "requestId must be 8 to 64 letters, digits, - or _" });
    const key = `answer:${requestId}`;
    const earlier = deps.store.get(key);
    if (earlier) {
      if (earlier !== `${verb}:${id}`) return send(409, { error: "That tap was already used for another change. Try again." });
      return answerOf(verb, await (answering.get(requestId) ?? deps.store.proposal(id)!));
    }
    const p = deps.store.proposal(id);
    if (!p || p.conversationId === TAP) return send(404, { error: "No such change." });
    if (!active || starting || active.conversationId !== p.conversationId) return send(409, { error: "That call has ended, so nothing was changed." });
    // Hanging up: the call can no longer tell the user what became of it.
    if (active.session.closing) return send(409, { error: "That call is ending, so nothing was changed." });
    // The id is this proposal's from here on, whatever the answer: sent again for another, it's refused.
    deps.store.set(key, `${verb}:${id}`);
    // Answered already, aloud or with a tap from another request: what became of it.
    if (p.state !== "proposed") return answerOf(verb, p);
    if (Date.now() > p.expiresAt) {
      deps.store.putProposal({ ...p, state: "expired" });
      return answerOf(verb, { ...p, state: "expired" });
    }
    const session = active.session;
    const track = trackOf(active.id, active.conversationId);
    const run = (async () => {
      if (verb === "confirm") await deps.proposals.confirm(p.conversationId, id, "tap");
      else deps.proposals.cancel(p.conversationId, id);
      const after = deps.store.proposal(id)!;
      deps.log(`tap ${requestId}: ${verb} ${id} → ${after.state}`);
      track("proposal_answered", { answer: verb === "confirm" ? "yes" : "no", via: "tap", action: p.action });
      if (verb === "confirm") trackChange(track, after, "voice");
      session.tapped(verb, after);
      return after;
    })();
    answering.set(requestId, run);
    try {
      return answerOf(verb, await run);
    } finally {
      answering.delete(requestId);
    }
  }

  /** What became of a proposal answered with a tap, as the phone shows it: like any tap's answer (`tapAnswer`). */
  function answerOf(verb: "confirm" | "cancel", p: Proposal): Response {
    const expired = "That waited too long for a yes, so nothing was changed. Ask Driver again.";
    if (p.state === "expired") return send(409, { error: expired });
    if (verb === "cancel") {
      if (p.state === "cancelled") return send(200, { ok: true, state: "cancelled", result: "Nothing was changed." });
      return send(409, { error: p.state === "executing" ? "It's already being carried out and can't be stopped now." : `Too late: ${p.result ?? "it already happened."}` });
    }
    switch (p.state) {
      case "executed":
      case "partial":
        return send(200, { ok: true, state: p.state, result: p.result });
      case "unknown":
        return send(502, { error: p.result ?? "Couldn't tell whether that went through." });
      case "executing":
        return send(409, { error: "That's already being carried out." });
      case "failed":
        return send(409, { error: p.result ?? "That didn't go through." });
      case "cancelled":
        // A sentence from carrying it out ("… so I called this off"), or a short reason: a name changed, a newer change.
        return send(409, { error: p.result === "a name changed" ? "A thread changed since Driver read this back, so nothing was changed. Ask Driver again." : p.result?.endsWith(".") ? p.result : "That was called off, so nothing was changed." });
      default:
        return send(409, { error: "Nothing was changed. Try again." });
    }
  }

  /** Kept replies being sent now: one is sent once at a time, and isn't changed or discarded meanwhile. */
  const sendingKept = new Set<string>();

  /**
   * Replies kept for later (contracts §3, "Kept replies"), newest first, as the phone's Not sent lists them: named as the
   * briefing names their threads now. One whose thread was settled since is listed, `settled`, for the user to decide;
   * one whose thread the briefing doesn't know is left out (still kept).
   */
  function keptRows() {
    const open = new Map(namedItems(deps.briefing).map((n) => [n.id, n]));
    const settled = new Map(namedItems(deps.briefing, true).map((n) => [n.id, n]));
    return deps.store.keptReplies().flatMap((k) => {
      const n = open.get(k.threadId) ?? settled.get(k.threadId);
      return n ? [{ id: k.id, threadId: k.threadId, threadName: n.handle, project: n.group, text: k.text, keptAt: k.keptAt, conversationId: k.conversationId, settled: !open.has(k.threadId) }] : [];
    });
  }

  /**
   * A kept reply sent with a tap (contracts §3, "Kept replies"): its text, or `text` (edited on the phone), to its
   * thread, as any tapped reply is (`tapped`: the same `requestId` rules and answers). Once it's gone through it's no
   * longer kept, and the same request again gets the first answer. A dictated one goes with its first line again.
   */
  async function sendKept(body: any, sent?: () => void): Promise<Response> {
    if (typeof body.keptId !== "string") return send(400, { error: "keptId is required" });
    if (body.requestId === undefined) return send(400, { error: "requestId is required" });
    const text = typeof body.text === "string" ? body.text.trim() : undefined;
    if (body.text !== undefined && !text) return send(400, { error: "Write a reply first." });
    if (text && text.length > DRAFT_MAX) return send(400, { error: "That reply is too long to send in one go." });
    const again = earlierTap(body, (p) => p.action === "follow_up" && p.fields.keptId === body.keptId && (text === undefined || tappedWords(p.fields.message ?? "") === text));
    if (again) {
      const answer = await again;
      // Sent, but no longer kept only if the brain stopped in between: it is now.
      if (answer.status === 200 && !sendingKept.has(body.keptId)) deps.store.dropKept(body.keptId);
      return answer;
    }
    const kept = deps.store.keptReply(body.keptId);
    if (!kept) return send(404, { error: "That reply isn't kept any more: it was sent or discarded." });
    if (typeof body.id === "string" && body.id !== kept.threadId) return send(400, { error: "That kept reply is for another thread." });
    if (sendingKept.has(kept.id)) return send(409, { error: "That reply is being sent right now." });
    if (namedItems(deps.briefing, true).some((n) => n.id === kept.threadId)) return send(409, { error: "That thread is done, so nothing was sent. Bring it back first, or discard the reply." });
    sendingKept.add(kept.id);
    try {
      const words = text ?? kept.text;
      const res = await tapped({ ...body, id: kept.threadId }, "follow_up", { message: kept.note ? `${kept.note}\n\n${words}` : words, keptId: kept.id, ...(kept.draftId ? { draftId: kept.draftId } : {}) });
      if (res.status === 200) {
        deps.store.dropKept(kept.id);
        sent?.();
      }
      return res;
    } finally {
      sendingKept.delete(kept.id);
    }
  }

  /** A new thread started with a tap (contracts §3, "Tap to send"): a dictated draft's `new:` target, and its prompt. */
  async function tappedStart(body: any, start: NewThread, message: string): Promise<Response> {
    const again = earlierTap(body, (p) => p.action === "start_work" && p.fields.target === newThreadTarget(start) && p.fields.message === message);
    if (again) return again;
    if (!(deps.adapter.actionsFor?.(start.placeId) ?? deps.adapter.actions).includes("start_work")) return send(409, { error: "Your computer only lets 10 & 2 listen in, so nothing was started." });
    const p = await deps.proposals.tapStart(start, message, body.requestId);
    if ("error" in p) return send(409, p);
    deps.log(`tap ${p.id} start_work ${start.placeId} → ${p.state}`);
    if (deps.analytics) trackChange(deps.analytics.track, p, tapVia(body.via), body.dictated === true);
    return tapAnswer(p);
  }

  /** The machines whose threads are in the briefing: this one, and every other one with threads ("…, on Quartz"). */
  function machines(): string[] {
    const others = deps.briefing.allItems().map((i) => / on (\w[\w-]*)$/.exec(i.group)?.[1]).filter((m): m is string => !!m);
    return [...new Set([deps.demo?.machine ?? spokenHost(), ...others])];
  }

  async function handle(req: Request, url: URL, pre?: any): Promise<Response> {
    {
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = pre ?? await readJson(req);
        if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=")) return send(400, { error: "sdp offer required" });
        const given = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
        // The phone's conversation voice; one GPT-Live doesn't have is ignored (the call's settings say which, then).
        const voice = (CONVERSATION_VOICES as readonly string[]).includes(body.voice) ? String(body.voice) : null;
        const memoryDays = body.memoryDays === undefined ? DEFAULT_MEMORY_DAYS : Math.min(Math.max(Math.round(Number(body.memoryDays)) || 0, 0), 30);
        // Taken now, before waiting in line: a stop from here on cancels this request.
        const accepted = stops;
        // How the phone reads replies aloud, should the user ask Driver to read one, and in which of OpenAI's voices
        // (none when it reads in its own).
        const readingStyle = styleOf(body, body.readingStyle);
        const readingVoice = (READING_VOICES as readonly string[]).includes(body.readingVoice) ? String(body.readingVoice) : undefined;
        // A reply the user dictated, back from the phone to be sent: it must have been heard back there in full.
        const draft = body.mode === "reading" && body.draft !== undefined ? parseDraft(body.draft) : null;
        if (body.mode === "reading" && body.draft !== undefined) {
          if (!draft) return send(400, { error: "That reply couldn't be read." });
          if (body.heardBack !== true && body.heardBack !== "true") return send(409, { error: "Hear the reply back before sending it." });
        }
        const run = creating.then(async () => {
          const { conversationId, open, created, news } = await opening(given, body.mode, accepted, body.memoryDays === undefined ? 0 : memoryDays);
          const id = conversationId ?? randomUUID();
          const reading = body.mode === "reading" ? await readingOpening(id, body, open) : null;
          let first = reading?.open ?? open;
          const confirm = confirmFor(body, id);
          if (draft && first.kind === "reading") first = await dictatedOpening(id, draft, first, keepRepliesOf(body), confirm);
          // The news must be in place before the session's first words, so `created` runs as the session is made.
          const started = await startSession(body.sdp, id, first, memoryDays, accepted, voice, created, news, readingStyle, readingVoice, fastOf(body).conversations, phoneBuildOf(headed(req)), keepRepliesFor(body, id), confirm);
          // What was read to the end counts as heard once there's a session to tell about it.
          reading?.heard();
          return started;
        });
        creating = run.catch(() => {});
        try {
          return send(200, await run);
        } catch (e) {
          const status = (e as { status?: unknown }).status;
          deps.analytics?.track("session_failed", { stage: e instanceof Refused ? "refused" : "create", http_status: typeof status === "number" ? status : null });
          if (e instanceof Refused) return send(409, { error: e.message });
          throw e;
        }
      }
      // What became of a reply the phone handed over to send: sent, maybe sent (its outcome was lost), or not.
      const draftAsked = req.method === "GET" && url.pathname.match(/^\/api\/drafts\/([\w-]{8,64})$/);
      if (draftAsked) return send(200, draftStateOf(deps.store, draftAsked[1]));
      if (req.method === "POST" && url.pathname === "/api/session/stop") {
        // The phone's call is over. Either way the session ends, with any session request not yet made, and the changes
        // proposed in it (the user didn't hear how they'd turn out). Only the user's Stop (`cancelWaits`) also calls
        // off the waits and the call-back news not yet told; any other ending (the car's audio went, an interruption,
        // a failure) keeps them, so the next session still tells them. Without `cancelWaits`, nothing is cancelled
        // that the user didn't ask to cancel.
        const body = await readJson(req);
        const user = body.cancelWaits === true || body.cancelWaits === "true";
        stops++;
        if (user) deps.waits.cancelAll();
        if (user) deps.store.dropHandoff();
        deps.proposals.cancelOpen(user ? "stopped by user" : "the call ended", user ? undefined : active?.conversationId ?? "");
        active?.session.close({ kind: user ? "user_stop" : "phone_end" });
        if (user) dropUntold();
        return send(200, { ok: true });
      }
      // The phone asks for this when it opens and when a session starts, so the briefing is current by the time it's
      // needed. It answers once the refresh is done, or after REFRESH_WAIT_MS with the briefing as it stands.
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        const done = deps.refresh().catch((e) => deps.log(`briefing: manual refresh failed: ${describe(e)}`));
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([done, new Promise((r) => (timer = setTimeout(r, REFRESH_WAIT_MS)))]);
        clearTimeout(timer);
        return send(200, { ok: true, updatedAt: deps.briefing.view().updatedAt });
      }
      if (req.method === "POST" && url.pathname === "/api/memory/forget") {
        deps.store.forgetAll();
        return send(200, { ok: true });
      }
      // The phone holds while a thread works: it long-polls here, then calls back when the wait is over.
      if (req.method === "GET" && url.pathname === "/api/wait") {
        const id = url.searchParams.get("conversation") ?? "";
        const seconds = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 25);
        // Hung up for the phone to read a reply out, or to record one in the user's words: which, unless the
        // conversation's wait is newer. (Every new session drops the hand-off, so one that's left is from the session that
        // just hung up; a wait may be older, kept through an interruption.) The phone asks for its reading
        // (`/api/readings`), which is being made already. A ready wait's news is told when the phone comes back.
        const handoff = deps.store.handoffAt(id);
        if (handoff && handoff.at >= (deps.waits.get(id)?.startedAt ?? 0)) {
          const h = handoff.handoff;
          // Only a phone that asks (`rollover=1`) knows "continue"; an older one hears the call ended, as it did before.
          if ("rollover" in h) return send(200, url.searchParams.get("rollover") === "1" ? { state: "continue" } : { state: "none" });
          return send(200, "dictate" in h ? { state: "dictating", handle: h.handle, itemId: h.dictate.itemId } : { state: "reading", handle: h.handle, reply: h.reply });
        }
        const w = await deps.waits.until(id, seconds * 1000);
        return send(200, w ? { state: w.ready ? "ready" : "waiting", handle: w.handle, outcome: w.ready } : { state: "none" });
      }
      if (req.method === "POST" && url.pathname === "/api/wait/cancel") {
        stops++;
        deps.waits.cancelAll();
        deps.store.dropHandoff();
        dropUntold();
        return send(200, { ok: true });
      }
      // The phone's thread picker: every open top-level thread, newest first, with what the briefing knows and the star.
      if (req.method === "GET" && url.pathname === "/api/threads") {
        return send(200, { threads: threadRows() });
      }
      if (req.method === "POST" && url.pathname === "/api/star") {
        const body = await readJson(req);
        const thread = typeof body.id === "string" ? namedItems(deps.briefing).find((n) => n.id === body.id) : undefined;
        if (!thread) return send(404, { error: "no such open thread" });
        const on = body.starred !== false && body.starred !== "false";
        // Only a change is a tap for the timeline: starring a starred thread again isn't.
        if (deps.store.stars().has(thread.id) !== on) {
          const p = deps.proposals.noted(on ? "follow" : "unfollow", { itemId: thread.id, handle: thread.handle, group: thread.group });
          if (deps.analytics) trackChange(deps.analytics.track, p, "tap");
        }
        setStar(deps, thread.item, on);
        return send(200, { ok: true });
      }
      // Snooze a thread until a time (an ISO date-time within 90 days), or wake it (`until: null`), with a tap.
      if (req.method === "POST" && url.pathname === "/api/snooze") {
        const body = await readJson(req);
        if (body.until === null) return tapped(body, "unsnooze");
        // A retried tap is judged as of the first one, so it still gets the first's answer once that time has passed.
        const first = typeof body.requestId === "string" ? deps.proposals.earlierTap(body.requestId)?.proposal.createdAt : undefined;
        const until = typeof body.until === "string" ? parseUntil(body.until, first ?? Date.now()) : null;
        if (!until) return send(400, { error: "until must be a future time within 90 days, or null to wake the thread" });
        return tapped(body, "snooze", { until: until.toISOString() });
      }
      // Settle a thread (the app's Done), or bring a settled one back (`settled: false`), with a tap.
      if (req.method === "POST" && url.pathname === "/api/settle") {
        const body = await readJson(req);
        return tapped(body, body.settled === false || body.settled === "false" ? "unsettle" : "settle");
      }
      // Send a thread a reply with a tap (the composer's Send): the user's own words, with no call and no readback.
      // Running threads take it as a spoken reply does: the work system has it.
      if (req.method === "POST" && url.pathname === "/api/reply") {
        const body = await readJson(req);
        // A reply kept for later in a call (Not sent): sent as it was kept, or as edited.
        if (body.keptId !== undefined) return sendKept(body, () => deps.analytics?.track("reply_kept", { action: "sent", count: 1 }));
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return send(400, { error: "Write a reply first." });
        if (text.length > DRAFT_MAX) return send(400, { error: "That reply is too long to send in one go." });
        // Always a request id: a reply sent twice (a retry, a double tap) must go out once.
        if (body.requestId === undefined) return send(400, { error: "requestId is required" });
        // A dictated draft's new thread ("new:…", drafts.ts): started with this as its first prompt.
        const start = typeof body.id === "string" ? parseNewThread(body.id) : null;
        if (start) return tappedStart(body, start, text);
        return tapped(body, "follow_up", { message: tappedReply(text, typeof body.quote === "string" ? body.quote : null) });
      }
      // Replies kept for later in calls (the phone's Not sent): listed, edited before sending, discarded, or all sent.
      if (req.method === "GET" && url.pathname === "/api/kept") return send(200, { kept: keptRows() });
      if (req.method === "POST" && url.pathname === "/api/kept/send") {
        const body = await readJson(req);
        const items: unknown[] | null = Array.isArray(body.items) ? body.items : null;
        if (!items?.length || items.length > SEND_ALL_MAX) return send(400, { error: `items must list 1 to ${SEND_ALL_MAX} kept replies` });
        // One after another, each a reply tap of its own: one that doesn't go through doesn't stop the rest.
        const results = [];
        let sent = 0;
        for (const item of items) {
          const one: any = item && typeof item === "object" ? item : {};
          let status: number;
          let answer: any;
          try {
            const res = await sendKept(one, () => sent++);
            status = res.status;
            answer = await res.json();
          } catch (e) {
            deps.log(`kept ${String(one.keptId)}: sending it failed (${describe(e)})`);
            [status, answer] = [502, { error: "Couldn't tell whether that went through. Check the thread before sending it again." }];
          }
          results.push({
            keptId: typeof one.keptId === "string" ? one.keptId : null, ok: status === 200, state: status === 200 ? answer.state : status === 502 ? "unknown" : "unsent",
            ...(answer.result ? { result: answer.result } : {}), ...(answer.error ? { error: answer.error } : {}),
          });
        }
        if (sent) deps.analytics?.track("reply_kept", { action: "sent", count: sent });
        return send(200, { results });
      }
      const keptOne = url.pathname.match(/^\/api\/kept\/([\w-]{1,64})$/);
      if (keptOne && req.method === "PUT") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return send(400, { error: "Write a reply first." });
        if (text.length > DRAFT_MAX) return send(400, { error: "That reply is too long to send in one go." });
        if (sendingKept.has(keptOne[1])) return send(409, { error: "That reply is being sent right now." });
        if (!deps.store.editKept(keptOne[1], text)) return send(404, { error: "That reply isn't kept any more: it was sent or discarded." });
        deps.analytics?.track("reply_kept", { action: "edited", count: 1 });
        return send(200, { ok: true });
      }
      // Discarded; one that's gone already is too (a retry after a lost answer).
      if (keptOne && req.method === "DELETE") {
        if (sendingKept.has(keptOne[1])) return send(409, { error: "That reply is being sent right now." });
        if (deps.store.keptReply(keptOne[1])) deps.analytics?.track("reply_kept", { action: "deleted", count: 1 });
        deps.store.dropKept(keptOne[1]);
        return send(200, { ok: true });
      }
      // What happened, newest first: replies, calls and taps, in pages (timeline.ts).
      if (req.method === "GET" && url.pathname === "/api/timeline") {
        const q = timelineQuery(url);
        if ("error" in q) return send(400, q);
        const page = await timeline(deps, q);
        return page ? send(200, page) : send(404, { error: "no such thread" });
      }
      // The live call as the phone shows it (polled about every second): its agenda, receipts and the change waiting
      // for a yes. Receipts only new or changed since `since`, an earlier answer's `next`.
      if (req.method === "GET" && url.pathname === "/api/calls/current") {
        const view = starting ?? active?.view;
        if (!view) return send(404, { error: "No call is live." });
        const state = !starting && active ? active.session.liveState() : undefined;
        return send(200, view.snapshot(url.searchParams.get("since"), state));
      }
      // The change waiting for the user's yes in the live call, answered with a tap: Send (confirm) or Don't (cancel).
      const answered = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/([\w-]{1,64})\/(confirm|cancel)$/);
      if (answered) return tappedAnswer(await readJson(req), answered[1], answered[2] as "confirm" | "cancel");
      // The account, on a brain without accounts (Lattice): no meter, so no credits. The cloud answers this itself.
      if (req.method === "GET" && url.pathname === "/api/account") {
        const machines = deps.adapter.connectionStatus?.() ?? [{ name: deps.adapter.name, connected: deps.adapter.connected() }];
        return send(200, { userId: "lattice", mode: "lattice", credits: null, allowance: null, machines, rev: brainRev });
      }
      // Local cues during a call use this read-only path, with no GPT-Live events or classification work.
      if (req.method === "GET" && url.pathname === "/api/updates") {
        // `done`: changes carried out in the last 30 s, so the phone plays its tone once for each, and only for those.
        return send(200, { ...(await updates.snapshot()), done: deps.proposals.recentlyDone() });
      }
      // The replies new to the user: each thread's latest, until it's read out in full or opened in T3.
      if (req.method === "GET" && url.pathname === "/api/inbox") {
        void syncVisits(deps);
        return send(200, { replies: await newReplies(deps) });
      }
      // A thread's replies, newest first, to pick an earlier one to hear.
      if (req.method === "GET" && url.pathname === "/api/replies") {
        const thread = namedItems(deps.briefing).find((n) => n.id === url.searchParams.get("id"));
        if (!thread) return send(404, { error: "no such open thread" });
        return send(200, { replies: await pastReplies(deps, thread.id) });
      }
      if (req.method === "GET" && url.pathname === "/api/voices") {
        return send(200, { conversation: CONVERSATION_VOICES, reading: READING_VOICES, conversationDefault: current().voice, readingDefault: "marin" });
      }
      // Replies to read out in full: the given threads' latest, or every reply new to the user, as spoken segments.
      // With `announce` (several read in a row: "Read new replies"), each starts with whose reply it is.
      if (req.method === "POST" && url.pathname === "/api/readings") {
        const body = await readJson(req);
        const ids = typeof body.ids === "string" && body.ids.trim() ? body.ids.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
        const style = styleOf(body, body.style);
        // One thread's particular reply: an earlier one.
        if (typeof body.messageId === "string" && ids?.length === 1) {
          if (!namedItems(deps.briefing).some((n) => n.id === ids[0])) return send(404, { error: "no such open thread" });
          const reading = await prepareReply(deps, ids[0], body.messageId, style);
          return reading ? send(200, { readings: [reading] }) : send(404, { error: "no such reply" });
        }
        const announce = body.announce === true || body.announce === "true";
        return send(200, { readings: await prepare(deps, ids, announce ? { ...style, announce } : style) });
      }
      // The briefing, on demand: an intro, then a part for each thread a call would cover, as a reading whose segments
      // carry their thread's id; the same cards give the same reading. Its audio is any reading's (below).
      if (req.method === "POST" && url.pathname === "/api/briefing") {
        const body = await readJson(req);
        const hour = Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : undefined;
        return send(200, await prepareBriefing(deps, { fast: fastOf(body).readings, skipCode: body.skipCode !== false && body.skipCode !== "false", hour }));
      }
      const segmentAudio = req.method === "GET" && url.pathname.match(/^\/api\/readings\/([0-9a-f]{24})\/(\d{1,4})$/);
      if (segmentAudio) {
        const text = deps.store.readingSegments(segmentAudio[1])?.[Number(segmentAudio[2])]?.text;
        if (text === undefined) return send(404, { error: "no such reading or segment" });
        const voice = url.searchParams.get("voice") ?? "marin";
        if (!(READING_VOICES as readonly string[]).includes(voice)) return send(400, { error: "unknown voice" });
        if (!deps.speech) return send(503, { error: "speech isn't set up on this brain" });
        let outOfCredits: string | null = null;
        const audio = await deps.speech.audio(text, voice).catch((e) => {
          // The cloud's meter refuses to make audio the account can't pay for (contracts §4); kept audio still plays.
          if ((e as { code?: unknown }).code === "out_of_credits") outOfCredits = (e as Error).message;
          else deps.log(`speech: ${describe(e)}`);
          return null;
        });
        if (outOfCredits) return send(402, { error: outOfCredits, code: "out_of_credits" });
        if (!audio) return send(502, { error: "The reading voice failed; try again or use the phone's voice" });
        return new Response(new Uint8Array(audio), { status: 200, headers: { "content-type": "audio/aac", "content-length": String(audio.length), "cache-control": "private, no-store" } });
      }
      // The reader played `messageId` (the thread's latest reply) to the end.
      if (req.method === "POST" && url.pathname === "/api/read") {
        const body = await readJson(req);
        if (typeof body.id !== "string" || typeof body.messageId !== "string") return send(400, { error: "id and messageId required" });
        const conversationId = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
        const r = await markRead(deps, body.id, body.messageId, conversationId);
        return send("error" in r ? 409 : 200, r);
      }
      // The phone sends logs as it goes, so nobody has to copy them off it: the reading test's (milestone 3, step 0), and
      // its own.
      const logDir = req.method === "POST" && LOG_DIRS[url.pathname];
      if (logDir) {
        if (!deps.files) return send(503, { error: "this brain keeps no logs" });
        const body = await readJson(req);
        const from = Number(body.from);
        if (typeof body.run !== "string" || !CONVERSATION_ID.test(body.run) || !Number.isInteger(from) || from < 0 || typeof body.text !== "string") {
          return send(400, { error: "run, from and text required" });
        }
        return send(200, { lines: await appendTestLog(deps.files, `${logDir}/${body.run}.log`, from, body.text) });
      }
      if (req.method === "GET" && url.pathname === "/api/conversations") {
        // The latest drives, newest first, each with what Driver did in it (drives.ts), for the top of History.
        const names = new Map([...namedItems(deps.briefing, true), ...namedItems(deps.briefing)].map((n) => [n.id, n.handle]));
        const drives = recentDrives(deps.store).slice(-5).reverse()
          .map((d) => ({ start: d.start, end: d.end, summary: summaryText(summarize(deps.store, d, names)) }));
        return send(200, { conversations: deps.store.conversations(50), drives });
      }
      const one = req.method === "GET" && url.pathname.match(/^\/api\/conversations\/([\w-]{1,64})$/);
      if (one) {
        const id = one[1];
        const c = deps.store.conversation(id);
        if (!c) return send(404, { error: "no such conversation" });
        const entries = [
          ...deps.store.turns(id).map((t) => ({ kind: t.role === "user" ? "you" : "driver", text: t.text, at: t.at })),
          ...deps.store
            .proposalsFor(id)
            .filter((p) => SHOWN.has(p.state))
            .map((p) => ({ kind: "change", text: p.readback, result: p.result, state: p.state, at: deps.store.carriedOutAt(p.id) ?? p.createdAt })),
        ].sort((a, b) => a.at - b.at);
        // The call as the phone showed it when it ended: its agenda and receipts (null for calls before 7 November).
        const record = deps.store.callView<CallRecord>(id);
        return send(200, { id, ...c, entries, agenda: record?.agenda ?? null, receipts: record?.receipts ?? null });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const view = deps.briefing.view(await deps.adapter.list().catch(() => undefined));
        return send(200, {
          updatedAt: view.updatedAt,
          readFailures: view.readFailures,
          opener: view.opener,
          cards: view.cards.map(({ itemId, handle, title, group, state, summary, ask, suggested, status, unread }) => ({ itemId, handle, title, group, state, summary, ask, suggested, status, unread })),
          unread: view.cards.filter((c) => c.unread).length,
          clutter: { total: view.clutterTotal, groups: view.clutter.map(({ parent, group, count }) => ({ parent, group, count })) },
          snoozed: view.snoozed,
          proposals: deps.store.recentProposals(10).map(({ id, action, targets, readback, state, result, createdAt }) => ({
            id, action, targets: targets.length > 5 ? `${targets.length} threads` : targets.map((t) => t.handle), readback, state, result, createdAt,
          })),
          memory: deps.store.memories(20),
          following: threadRows().filter((t) => t.starred),
          machines: machines(),
          activeSession: active?.id ?? null,
          // Sessions whose hang-up failed and that OpenAI hasn't confirmed over: they may still be billing.
          billingAlert: deps.hangups.alert(),
          // How much of the last week's answering was in Fast mode, for Settings → Fast mode.
          fastUsage: { days: 7, ...deps.store.answersSince(Date.now() - 7 * 86_400_000) },
          // Which brain is answering, so the phone can show what's actually running.
          version: { rev: brainRev },
        });
      }
      return send(404, { error: "not found" });
    }
  }

  return {
    handle,
    reattach,
    closeActive: () => active?.session.close({ kind: "replaced" }),
    knows: (id) => deps.store.conversation(id) !== null,
    heartbeat: () => (active ? { sessionId: active.id, ...active.session.stats() } : null),
    closeSession: (id) => {
      if (active?.id !== id) return "not_current";
      active.session.close({ kind: "ended_by_staff" });
      return "ended";
    },
    close: async () => {
      active?.session.close({ kind: "shutdown" });
      await active?.session.done;
    },
  };
}

/**
 * Whether a request is for demo mode: every request, on a brain that only demos (`DRIVER_DEMO=only`), or one the phone
 * sends with `x-driver-mode: demo` (Settings → Demo mode). An account's mode will decide this once there are accounts.
 */
export const wantsDemo = (cfg: Pick<Config, "demo">, req: Pick<Headed, "headers">) =>
  cfg.demo === "only" || String(req.headers["x-driver-mode"] ?? "") === "demo";

/**
 * The HTTP server: health, the desk page, the access checks, then each `/api/` request to its world. Without `demo`
 * (or with `DRIVER_DEMO=off`) that's always the real brain's; with it, a demo request goes to the current demo world.
 * A demo session that doesn't carry on a conversation of the current world (a fresh Start, the first in demo mode, or
 * any after a reset) gets a fresh world: every demo starts from the same workspace, and an old one's runs stop.
 */
export function createBrain(cfg: Config, deps: ServerDeps, demo?: DemoWorlds) {
  const real = api(cfg, deps);
  let world: { api: Api; deps: Awaited<ReturnType<DemoWorlds>> } | null = null;
  let making: Promise<unknown> = Promise.resolve();
  /** The current demo world, or (`fresh`) a new one in its place. Made one at a time. */
  const demoWorld = (fresh: boolean): Promise<Api> => {
    const next = making.then(async () => {
      if (world && !fresh) return world.api;
      const old = world;
      const made = await demo!();
      world = { api: api(cfg, made), deps: made };
      if (old) void old.api.close().then(() => old.deps.close()).catch((e) => deps.log(`demo: closing the last demo failed: ${describe(e)}`));
      deps.log(old ? "demo: a fresh demo" : "demo: the first demo");
      return world.api;
    });
    making = next.catch(() => {});
    return next;
  };

  /** Every request: through `node:http` on Lattice (`startServer`), from the Worker in the cloud. */
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const h = headed(req);
    try {
      // Unauthenticated connection health, without thread content or credentials.
      if (req.method === "GET" && url.pathname === "/health") {
        const health = deps.briefing.health();
        const machines = deps.adapter.connectionStatus?.() ?? [{ name: deps.adapter.name, connected: deps.adapter.connected() }];
        return send(200, {
          ok: deps.adapter.connected(), machines, briefingCheckedAt: health.checkedAt, briefingStale: health.stale,
        });
      }
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
      if (!sameSite(h)) return send(403, { error: "cross-site request refused" });
      // In the cloud the Worker has already checked who's calling (contracts.md §1).
      if (!deps.authenticated) {
        if (proxiedWithoutCode(h, cfg.accessCode)) return send(403, { error: "set DRIVER_ACCESS_CODE to use the brain through a proxy" });
        if (!authorized(h, cfg.accessCode)) return send(401, { error: "access code required" });
      }
      // The account's consent, as the request arrives, before anything here waits (contracts §5). One place: here on
      // Lattice; a cloud brain's object has taken it already.
      deps.consent?.heard(h.headers["x-driver-analytics"]);
      // Settings → Privacy → Share usage analytics, said outright: only this shares again after an `off`. Its ticket is
      // taken now; reading the body waits, and a change meanwhile (any `off`, a later one of these) wins.
      if (req.method === "PUT" && url.pathname === "/api/analytics") {
        if (!deps.consent) return send(404, { error: "not found" });
        const ticket = deps.consent.next();
        const body = await readJson(req);
        if (typeof body.share !== "boolean") return send(400, { error: "share must be true or false" });
        deps.consent.set(body.share, ticket);
        return send(200, { ok: true, share: body.share });
      }
      // Who usage analytics are about (contracts §5): one person, demo or not.
      deps.analytics?.heard(h.headers["x-driver-analytics"], phoneBuildOf(h));

      const starting = req.method === "POST" && url.pathname === "/api/session";
      if (!demo || cfg.demo === "off" || !wantsDemo(cfg, h)) {
        if (starting) world?.api.closeActive();
        return await real.handle(req, url);
      }
      if (!starting) return await (await demoWorld(false)).handle(req, url);
      const body = await readJson(req);
      const given = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
      const carriesOn = !!given && !!world?.api.knows(given);
      if (!carriesOn) {
        // A new demo: whatever conversation the phone kept is another world's (or an older demo's).
        delete body.conversationId;
        if (body.mode !== "reading") body.mode = "new";
      }
      const target = await demoWorld(!carriesOn);
      real.closeActive();
      return await target.handle(req, url, body);
    } catch (e) {
      deps.log(`http ${req.method} ${url.pathname}: ${describe(e)}`);
      deps.analytics?.exception("server", e, { route: url.pathname.replace(/\/[\w-]{8,}(?=\/|$)/g, "/:id"), ...(wantsDemo(cfg, h) ? { mode: "demo" } : {}) });
      return send(500, { error: "Something went wrong. Try again." });
    }
  }
  return {
    handle,
    /** After a restart: takes the real brain's live session back (`Api.reattach`). The reaper hangs up the rest. */
    reattach: () => real.reattach(),
    /** This brain's live session, real or demo, for the registry's heartbeat. */
    heartbeat: () => real.heartbeat() ?? world?.api.heartbeat() ?? null,
    /** Ends session `id`, in whichever world it's live; "not_current" when it isn't (`Api.closeSession`). */
    closeSession: (id: string) => (real.closeSession(id) === "ended" ? "ended" : (world?.api.closeSession(id) ?? "not_current")),
    /** Ends this brain's live call, real or demo: one of the same person's is starting elsewhere (the cloud's demo object). */
    closeActive: () => {
      real.closeActive();
      world?.api.closeActive();
    },
    close: async () => {
      await Promise.all([real.close(), world?.api.close()]);
      await world?.deps.close();
    },
  };
}

/** The brain on Lattice: `createBrain`'s requests over `node:http`, plus the desk page. */
export function startServer(cfg: Config, deps: ServerDeps, demo?: DemoWorlds) {
  const brain = createBrain(cfg, deps, demo);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        // The desk page, next to the sources (Lattice only: the cloud serves no page).
        return res.end(readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url).href)));
      }
      const response = await brain.handle(toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      deps.log(`http ${req.method} ${req.url}: ${describe(e)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Something went wrong. Try again.", code: "server" }));
    }
  });
  const connectors = attachConnectors(server, deps.connectors ?? []);
  server.listen(cfg.port, cfg.host, () => deps.log(`driver brain on http://${cfg.host}:${cfg.port}`));
  return {
    close: async () => {
      await brain.close();
      connectors.close();
      server.close();
    },
  };
}

/** A `node:http` request as a fetch `Request`; its body streams through, so `readJson`'s limit still holds. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}
