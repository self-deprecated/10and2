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
import { headTail } from "./briefing.ts";
import type { Seen } from "./store.ts";
import { markRead, newReplies, syncVisits } from "./reads.ts";
import { WatchedReplies } from "./updates.ts";
import { masked, pastReplies, prepare, prepareReply, type ReadingStyle } from "./reading.ts";
import { CONVERSATION_VOICES, READING_VOICES } from "./voice/speech.ts";
import { holdAfter, namedItems, recordNames, setStar, type ToolDeps } from "./voice/tools.ts";
import { createWebRtcSession, type OpenSocket } from "./voice/live.ts";
import type { Hangups } from "./voice/hangups.ts";
import type { Recordings } from "./voice/recording.ts";
import type { Flags } from "./flags.ts";
import { buildSessionConfig, VoiceSession, type Conversations, type Opening, type ReadOut } from "./voice/session.ts";
import { describe, spokenHost } from "./util.ts";
import type { Props } from "./analytics.ts";
import { recentDrives, summarize, summaryText } from "./drives.ts";
import { assemble, DRAFT_MAX, draftStateOf, parseDraft, parseNewThread, wordCount, type Draft } from "./drafts.ts";

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
  /** Whether this account keeps its own call audio (a tester who switched it on; the cloud only). */
  keepCallAudio?: () => boolean;
  /** Writes the moments the user flags in a call ("debug this") for review. */
  flags?: Flags;
  /** Creates the GPT-Live session; tests swap in a fake. */
  createSession?: typeof createWebRtcSession;
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
   * The cloud's credit meter (contracts §4): each session's cumulative billed seconds, debited once each; `out` ends the
   * call with a goodbye. Lattice and demo worlds have none.
   */
  meter?: { voice(sessionId: string, seconds: number): { out: boolean } | Promise<{ out: boolean }> };
};

/** Makes a fresh demo world: each demo starts from the same workspace. */
export type DemoWorlds = () => Promise<ServerDeps & { close(): Promise<void> }>;

/** One world's API (the real brain's, or a demo's): every `/api/` route, past the access checks. */
type Api = {
  handle(req: Request, url: URL, body?: any): Promise<Response>;
  /** Ends its live session, if any: another world's is starting (one person, one live session). */
  closeActive(): void;
  /** Whether this world has had conversation `id`. */
  knows(id: string): boolean;
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
/** What the phone and the desk page show of a conversation's changes: the ones that were carried out or tried. */
const SHOWN = new Set(["executed", "partial", "failed", "unknown"]);

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
  // One person, one live session: starting another closes the previous one. Creation is serialized. Each request
  // notes how many stops there have been (`stops`, counted by /api/session/stop and wait cancel) when it's accepted; a
  // stop after that, while it's queued, preparing or being created, ends its session as soon as it exists, before it
  // says anything.
  let active: { id: string; conversationId: string; session: VoiceSession } | null = null;
  let creating: Promise<unknown> = Promise.resolve();
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
      read.push({ handle: names.get(r.itemId) ?? "that thread", heard, parts, of: r.segments, text: reply?.text ?? "" });
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
   * A dictated reply, put together and proposed in conversation `conversationId`, for Driver to ask the user to send.
   * `reading` is what the phone read before it, if anything. Refused (409) when it can't be sent: already sent, its
   * thread gone, or too long.
   */
  async function dictatedOpening(conversationId: string, draft: Draft, reading: Extract<Opening, { kind: "reading" }>): Promise<Opening> {
    const message = assemble(draft, (readingId) => {
      const r = deps.store.reading(readingId);
      const segments = deps.store.readingSegments(readingId);
      return r && segments ? { itemId: r.itemId, segments } : null;
    });
    if (message.length > DRAFT_MAX + 2000) throw new Refused("That reply is too long to send in one go.");
    // A new thread's prompt carries where to start it in its target; it's checked again as it's proposed.
    const start = parseNewThread(draft.itemId);
    const size = { draftId: draft.id, message, words: wordCount(draft), parts: draft.parts.length };
    const made = start ? await deps.proposals.proposeDraftStart(conversationId, { ...size, ...start }) : await deps.proposals.proposeDraft(conversationId, { ...size, itemId: draft.itemId });
    if ("error" in made) throw new Refused(made.error);
    const { proposal } = made;
    const handle = start ? proposal.fields.title! : proposal.targets[0].handle;
    deps.log(`voice ${conversationId}: dictated ${start ? "prompt for a new thread" : "reply to"} ${handle}, ${draft.id}, is ${proposal.id}`);
    return { kind: "draft", draft: { handle, proposalId: proposal.id, readback: proposal.readback, ...(start ? { newThread: true } : {}) }, read: reading.read, news: reading.news };
  }

  /** `memoryDays` 0 is memory off; otherwise notes older than that are wiped and the rest recalled. */
  async function startSession(sdp: string, conversationId: string, open: Opening, memoryDays: number, accepted: number, voice: string, created?: () => void, news = false, readingStyle?: ReadingStyle, readingVoice?: string, fast = false, phoneBuild: string | null = null) {
    active?.session.close({ kind: "replaced" });
    // A reading handed to the phone belongs to the session that hung up for it; a new one has moved on.
    deps.store.dropHandoff(conversationId);
    if (memoryDays > 0) deps.store.forgetBefore(Date.now() - memoryDays * 86_400_000);
    // The briefing about to be spoken names these threads; those names keep meaning them for the whole conversation.
    recordNames(deps, conversationId);
    const options = { liveModel: cfg.liveModel, backendModel: cfg.backendModel, voice, transport: "webrtc" as const, captions: true, memoryDays, fast };
    const config = buildSessionConfig(options, deps, conversationId, new Date(), open);
    // The same, built again from the briefing as it is then, when a refresh mid-session changes the threads' replies.
    const backendInstructions = () => (buildSessionConfig(options, deps, conversationId, new Date(), open) as any).delegation.responses.instructions as string;
    const createStart = Date.now();
    const { sessionId, answerSdp, conn: live } = await (deps.createSession ?? createWebRtcSession)(cfg.apiKey, config, sdp, deps.log, {
      created: (id) => deps.hangups.created(id, conversationId),
      close: (id) => deps.hangups.close(id),
    }, deps.openSocket!);
    const createMs = Date.now() - createStart;
    const recording = record(sessionId, conversationId, open, phoneBuild);
    const conn = recording?.wrap(live) ?? live;
    // Usage analytics for this session (contracts §5), with its ids on every event.
    const track = (event: string, props: Props = {}) => deps.analytics?.track(event, { session_id: sessionId, conversation_id: conversationId, ...props });
    // The session exists and bills: if anything from here fails before a VoiceSession owns it, end it (the reaper
    // hangs it up until OpenAI confirms).
    let session: VoiceSession;
    try {
      created?.();
      session = new VoiceSession(conn, { sessionId, conversationId }, {
        ...deps,
        idleMs: cfg.idleMs,
        maxMs: cfg.maxSessionMs,
        memory: memoryDays > 0,
        beforeClose: (reason, watched) => holdAfter(deps, conversationId, reason, watched),
        news: news ? newsFor(conversationId) : [],
        record: recording?.note,
        // The recording is finished once stored (the session's hang-up starts closing it); 30 s at most, for a slow upload.
        recorded: recording ? () => Promise.race([recording.done, new Promise<void>((r) => setTimeout(r, 30_000))]) : undefined,
        readingStyle,
        readingVoice,
        fast,
        backendInstructions,
        said: open.kind === "reading" ? open.said : undefined,
        // The same reads as the phone's cue (`/api/updates`), shared: told during the call as soon as they're seen.
        updates,
        versions: { brainRev, phoneBuild },
        track,
        opening: open.kind,
        recordingRef: recording ? (deps.recordingRef?.(sessionId) ?? `lattice:sessions/${sessionId}.jsonl`) : undefined,
        usage: deps.meter ? (seconds) => deps.meter!.voice(sessionId, seconds) : undefined,
      });
    } catch (e) {
      deps.log(`voice ${sessionId}: couldn't take the session on (${describe(e)}); hanging it up`);
      conn.terminate();
      throw e;
    }
    active = { id: sessionId, conversationId, session };
    void session.done.then(() => {
      if (active?.id === sessionId) active = null;
    });
    track("session_started", {
      opening: open.kind, fast, memory_days: memoryDays, voice, transport: "webrtc", threads: namedItems(deps.briefing).length,
      starred: deps.store.stars().size, machines: machines().length, news: open.kind === "callback" ? open.replies.length : 0, create_ms: createMs,
    });
    deps.log(`voice ${sessionId}: started (conversation ${conversationId}${open.kind === "new" ? "" : `, ${open.kind}`}; brain ${brainRev}, phone ${phoneBuild ?? "unknown"})`);
    if (stops !== accepted) session.close({ kind: "stopped_before_start" });
    // A call-back speaks first: the user is waiting to hear what the thread said. So does coming back from a reading,
    // or with a dictated reply to send, and a new call: one that waits for the user can seem dead (Apple's reviewer
    // started one on 3 November and neither side spoke for a minute).
    else if (open.kind === "new" || open.kind === "callback" || open.kind === "reading" || open.kind === "draft") session.speakFirst();
    return { sdp: answerSdp, sessionId, conversationId };
  }

  /** A session's recording, with what replaying it needs to begin with; none if recording is off or can't start. */
  function record(sessionId: string, conversationId: string, open: Opening, phoneBuild: string | null) {
    try {
      return deps.recordings?.start(sessionId, {
        conversation: conversationId,
        brainRev,
        phoneBuild,
        opening: open.kind === "callback" ? { kind: open.kind, news: open.replies.map((r) => r.handle) } : { kind: open.kind },
        idleMs: cfg.idleMs,
        maxMs: cfg.maxSessionMs,
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
        // The phone's conversation voice; one GPT-Live doesn't have is ignored.
        const voice = (CONVERSATION_VOICES as readonly string[]).includes(body.voice) ? String(body.voice) : cfg.voice;
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
          if (draft && first.kind === "reading") first = await dictatedOpening(id, draft, first);
          // The news must be in place before the session's first words, so `created` runs as the session is made.
          const started = await startSession(body.sdp, id, first, memoryDays, accepted, voice, created, news, readingStyle, readingVoice, fastOf(body).conversations, phoneBuildOf(headed(req)));
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
        setStar(deps, thread.item, body.starred !== false && body.starred !== "false");
        return send(200, { ok: true });
      }
      // Local cues during a call use this read-only path, with no GPT-Live events or classification work.
      if (req.method === "GET" && url.pathname === "/api/updates") {
        return send(200, await updates.snapshot());
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
        return send(200, { conversation: CONVERSATION_VOICES, reading: READING_VOICES, conversationDefault: cfg.voice, readingDefault: "marin" });
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
        return send(200, { id, ...c, entries });
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
    closeActive: () => active?.session.close({ kind: "replaced" }),
    knows: (id) => deps.store.conversation(id) !== null,
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
      // Who usage analytics are about, and whether they may be sent at all (contracts §5): one person, demo or not.
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
