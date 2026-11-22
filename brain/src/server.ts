// HTTP for the desk page (and later the phone): exchange an SDP offer for a session, stop it,
// and inspect the briefing and recent changes.
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { Files } from "./files.ts";
import { dirname, join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { attachConnectors, type ConnectorMachine } from "./connectors.ts";
import type { Config } from "./config.ts";
import { defaults, MAX_MINUTES_CAP, type Settings } from "./settings.ts";
import type { Beat, CallEvent, Calls } from "./calls.ts";
import { headTail, offlineOf, setStaleAfterDays, staleAfterDays, staleAfterOf } from "./briefing.ts";
import { TAP, type KeptReply, type Proposal, type Seen, type Store } from "./store.ts";
import { markRead, newReplies, syncVisits } from "./reads.ts";
import { WatchedReplies } from "./updates.ts";
import { docIdOf, inRange, masked, pastReplies, prepare, prepareDocument, prepareReply, type DocumentsReading, type ReadingStyle } from "./reading.ts";
import { BRIEFING_ITEM, briefingHeard, prepareBriefing, type BriefingWriter } from "./briefing-reading.ts";
import { briefingReadings } from "./brief-me.ts";
import { REALTIME_READER } from "./models.ts";
import { CONVERSATION_VOICES, READING_VOICES, REALTIME_READING_VOICES } from "./voice/voices.ts";
import { isReadingOff, type Speech } from "./voice/speech.ts";
import { awaitingSubagents, holdAfter, namedItems, recordNames, setNotify, setStar, type ToolDeps, type Watched } from "./voice/tools.ts";
import { followNewFrom, followNewOf, isNotify, notifyOf, setFollowNew } from "./follow.ts";
import { NOT_FROM_NOTE } from "./levels.ts";
import { wakeWordOf } from "./voice/wakeWord.ts";
import { newThreadPromptOf, threadNamesOf, type NewThreadPrompt, type ThreadNames } from "./voice/prompts.ts";
import { attachSession, createWebRtcSession, type LiveConn, type OpenSocket } from "./voice/live.ts";
import { ROLL_LATE } from "./voice/endPolicy.ts";
import { endsCall, type EndReason } from "./voice/endReason.ts";
import type { Hangups } from "./voice/hangups.ts";
import type { Recordings } from "./voice/recording.ts";
import type { Flags } from "./flags.ts";
import { buildSessionConfig, heldTold, speaksFirst, VoiceSession, type Conversations, type Greeting, type KeptDraft, type Opening, type OpeningNews, type ReadOut } from "./voice/session.ts";
import { CallView, type CallRecord } from "./voice/callview.ts";
import { describe, spokenHost } from "./util.ts";
import { LET_RUN, NO_LONGER as HELD_NO_LONGER, toldNo } from "./held-lines.ts";
import type { Receipt } from "./adapter.ts";
import { offlineFor } from "./offline.ts";
import { passOver, passReplied, testsFirst, testsOf, type PassRun } from "./receipts.ts";
import { newThreadDefaultsOf, placeParts, spokenPlaces, type NewThreadDefaults } from "./places.ts";
import { codingModels } from "./thread-models.ts";
import type { ConsentHolder, Props } from "./analytics.ts";
import { recentDrives, summarize, summaryText } from "./drives.ts";
import { assemble, dictatedParts, DRAFT_MAX, draftStateOf, isNewThread, mentionedPlaces, newThreadName, parseDraft, parseNewThread, placedTarget, REPLY_PARTS_MAX, tappedReplies, tappedReply, tappedWords, wordCount, type Draft, type NewThread } from "./drafts.ts";
import { ANSWERED as ANSWERED_NOTE, approvedOf, confirmOf, MOVED_ON, parseUntil, placeOptions, READBACK_ALL, tapVia, trackChange, WRITE_OFFLINE, type ConfirmLevels, type KeepReplies, type TapAction } from "./proposals.ts";
import { accessLine } from "./later-lines.ts";
import { SHOWN, timeline, timelineQuery } from "./timeline.ts";
import { merge, ownOf, parseOwn, STORE_KEY as VOCABULARY_KEY } from "./vocabulary.ts";
import type { RecordSpend } from "./spend.ts";
import { keepsThroughStop, TEST_RING, TEST_RING_IN_MS, type PhoneInput, type Ringer } from "./ring.ts";
import type { Choices, Engine } from "./engine.ts";
import type { Boards } from "./board.ts";
import { armable, CARD, SHEET, SIRI_NOTES_OFF, WHENS } from "./watch-card.ts";
import { helloNews, notWrittenLine, type ReachOut } from "./reach.ts";
import { headOf } from "./rules.ts";
import type { Wait } from "./waits.ts";
import { spokenLength, validZone } from "./zone.ts";
import { confirmUnder, privacyFrom, privacyOf, setPrivacy } from "./privacy.ts";
import { isAt, NO_LONGER_WAITING, type At } from "./faceid.ts";
import { rulesRoute } from "./rules-routes.ts";

/**
 * What a 503 says while the reading voice is switched off (settings `readingEngine`): the phone reads it in its own
 * voice, and shows this under a voice sample.
 */
export const READING_OFF = "The natural voice is off for now; your phone's voice reads instead.";

/** A session request that can't go ahead, for a reason the phone shows the user. */
class Refused extends Error {}

/** Answering the test call as a call (a phone that doesn't know it): refused, real or demo, with this. */
const TEST_CALL_ANSWERED = "That was a test call. Call me back is working.";

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
   * The cloud's minutes meter (contracts §4): each session's cumulative billed seconds, debited once each under the
   * allowance and rates in the call's settings, faster in fast mode (`fast`: the backend in the priority tier); `out`
   * ends the call with a goodbye. Lattice and demo worlds have none.
   */
  meter?: { voice(sessionId: string, seconds: number, settings: Settings, fast: boolean): { out: boolean } | Promise<{ out: boolean }> };
  /**
   * A hard cap on every session (the cloud's anonymous demo drive): Driver says goodbye before it and the call ends at it.
   * By session (a signed-in free demo call's, set by the host once the session is made): read at each of its checks.
   */
  capMs?: number | ((sessionId: string) => number | undefined);
  /** Records what each session costs (spend.ts): its billed seconds and its backend's tokens, in the account's store. */
  spent?: RecordSpend;
  /** 10 & 2 Ops' registry of calls (calls.ts): the cloud's; Lattice has none. */
  calls?: Calls;
  /** The settings anything starting now goes by: the cloud's, from Ops (docs/launch/ops-app.md §4.3); else git's. */
  settings?: () => Settings;
  /** Writes the spoken briefing's script (`POST /api/briefing`); without it, or when it fails, it's put together from the cards. */
  writeBriefing?: BriefingWriter;
  /**
   * Each reading voice's sample (`GET /api/voices/sample`), free to the user: the cloud's is on Driver's key, kept once
   * for every account. Without it, `speech` makes them (Lattice: its own key, its own cache).
   */
  samples?: Pick<Speech, "audio">;
  /** Rings the phone when a wait it isn't holding for is over (ring.ts): the cloud's, with a push key. */
  ringer?: Ringer;
  /** The engine (engine.ts): following, reach-outs and their deliveries. The real brain's; demo worlds have none. */
  engine?: Engine;
  /** Keeps the lock screen's board current while something is watched (board.ts, stage 5): the cloud's, with a push key. */
  boards?: Boards;
  /**
   * Whether this account may use Fast mode now (the cloud's: its plan's level or its own key, cloud/src/plan.ts
   * `Level.fastMode`): without, the phone's Fast mode is ignored. Lattice has none, so it's always allowed there.
   */
  fastMode?: () => boolean;
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
  /** Whether this world has had conversation `id`, or a watch waits to call into it. */
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
/** How far back `GET /api/usage` counts. */
const USAGE_DAYS = 30;
/**
 * A Start within this long of the last conversation's last session rejoins it, rather than begin a new one: the user
 * stopping and starting again, or a reading or dictation it handed off ending, isn't the end of a conversation.
 */
const REJOIN_MS = 30 * 60_000;
/** How long a refresh may hold the request before the caller gets the briefing as it stands. */
const REFRESH_WAIT_MS = 20_000;
/** How long bringing the briefing up to date (`Briefing.catchUp`, no model call) may hold a call's start. */
const CATCH_UP_MS = 3_000;

/** What an error's status means, for the phone's logic (docs/launch/contracts.md §1); `error` is for people. */
const CODES: Record<number, string> = { 400: "bad_request", 401: "sign_in", 402: "out_of_credits", 403: "forbidden", 404: "not_found", 409: "refused", 429: "slow_down" };

function send(status: number, body: unknown): Response {
  const coded = status >= 400 && body && typeof body === "object" && !("code" in body) ? { ...body, code: CODES[status] ?? "server" } : body;
  return new Response(JSON.stringify(coded), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * The sheet's choices in a request (`POST /api/rules`, `PUT /api/rules/:id`; docs/launch/engine.md §11 stage 5), each
 * only when given, or why they can't be read.
 */
export function choicesOf(body: any): Choices | string {
  const c: Choices = {};
  if (body.when !== undefined) {
    if (!(WHENS as readonly unknown[]).includes(body.when)) return "when must be replies, tests, fails or trouble";
    c.when = body.when;
  }
  if (body.then !== undefined) {
    if (body.then !== "call" && body.then !== "notify") return "then must be call or notify";
    c.then = body.then;
  }
  if (body.notBefore !== undefined) {
    if (body.notBefore !== null && !(typeof body.notBefore === "number" && Number.isFinite(body.notBefore))) return "notBefore must be a time (ms since 1970) or null";
    c.notBefore = body.notBefore;
  }
  if (body.forMs !== undefined) {
    if (!(typeof body.forMs === "number" && Number.isFinite(body.forMs) && body.forMs >= 60_000)) return "forMs must be a length of a minute or more (ms)";
    c.forMs = body.forMs;
  }
  return c;
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
 * reading waits on too. Anything else, an older phone that sends nothing, and an account whose level hasn't it
 * (`allowed`, `ServerDeps.fastMode`), is off.
 */
const fastOf = (body: any, allowed: boolean) => ({ conversations: allowed && (body.fast === "conversations" || body.fast === "all"), readings: allowed && body.fast === "all" });

/**
 * What a reply to a thread does in a call, dictated or worded by Driver (the phone's setting, `KeepReplies`). An older
 * phone, which sends nothing and can't show kept replies, gets "send", as before.
 */
const keepRepliesOf = (body: any): KeepReplies => (body.keepReplies === "ask" || body.keepReplies === "keep" ? body.keepReplies : "send");

/**
 * An alert token: any even number of hex digits up to 512, since a Simulator's are longer than a phone's and Apple says
 * not to assume a length (docs/launch/engine.md §11, item 6).
 */
const alertTokenOf = (x: unknown) => (typeof x === "string" && /^(?:[0-9a-f]{2}){1,256}$/i.test(x) ? x : null);

/**
 * The phone's IANA zone ("Europe/Copenhagen"), as it sends it with `/api/phone` and `/api/session`; undefined for none,
 * and for one this runtime doesn't know, so the last good one is kept (stage 3.8; Fable, topic 15).
 */
const tzOf = (x: unknown) => validZone(x) ?? undefined;

/** `POST /api/phone`'s body as the record takes it, or why it can't be. */
function phoneInputOf(body: any, install: string | null, token: string | null): PhoneInput | string {
  if (body.env !== "sandbox" && body.env !== "production") return "a push token and its environment (sandbox or production)";
  if (body.install !== undefined && !install) return "install must be the app's own id";
  const alertToken = alertTokenOf(body.alertToken);
  if (body.alertToken !== undefined && !alertToken) return "alertToken must be the phone's alert token (hex)";
  if (body.token !== undefined && !token) return "token must be the phone's VoIP token (hex)";
  if (!token && !alertToken) return "a push token and its environment (sandbox or production)";
  if (!install && !token) return "a push token and its environment (sandbox or production)";
  const tz = tzOf(body.tz);
  return {
    install, env: body.env, ...(token ? { token } : {}), ...(alertToken ? { alertToken } : {}),
    ...(typeof body.notifications === "boolean" ? { notifications: body.notifications } : {}), ...(tz ? { tz } : {}), ...(typeof body.car === "boolean" ? { car: body.car } : {}),
    // Whether this build registers the write categories (Fable's 4-K): each registration says, so a build without them
    // (an older one, or one put back) is sent today's.
    ...(install ? { writes: body.writes === true } : {}),
  };
}

/** How Driver opens a new call (the phone's setting, `Greeting`): "hello" unless the phone asks for "news" (21 November). */
const greetingOf = (body: any): Greeting => (body.greeting === "news" ? "news" : "hello");

/** The most kept replies one Send all sends. */
const SEND_ALL_MAX = 50;

/** How linked documents are handled with readings: "offer" (default), "after", or "off". */
const documentsOf = (v: unknown): DocumentsReading => (v === "after" || v === "off" ? v : "offer");

/** How the phone asks for replies to be read: `style` is "adapted" or as written, `leadIn` "prompt" or "none". */
const styleOf = (body: any, style: unknown, fastAllowed: boolean): ReadingStyle => ({
  skipCode: body.skipCode === true || body.skipCode === "true",
  adapted: style === "adapted",
  leadIn: body.leadIn === "prompt" ? "prompt" : "none",
  fast: fastOf(body, fastAllowed).readings,
  ...(body.documents !== undefined ? { documents: documentsOf(body.documents) } : {}),
});

/**
 * One world's API: the real brain's, or a demo world's. `own`: the user's own store, for what's theirs in a demo world
 * too (how long a question may wait before it's stale, `GET /api/account`).
 */
function api(cfg: Config, deps: ServerDeps, own: Pick<Store, "get"> = deps.store): Api {
  const updates = new WatchedReplies(deps);
  const brainRev = deps.brainRev ?? "dev";
  /** Fast mode may be used now: the account's level (`ServerDeps.fastMode`), and never in a demo world. */
  const fastAllowed = () => !deps.demo && (deps.fastMode?.() ?? true);
  /** The settings a call starting now gets. */
  const current = (): Settings => deps.settings?.() ?? defaults(cfg);
  /**
   * The phone is showing the briefing (a page of it): what changed while nobody looked is summarized, in the background,
   * and the next look has it (briefing.ts `look`).
   */
  const look = () => void deps.briefing.look().catch((e) => deps.log(`briefing: refresh failed: ${describe(e)}`));
  /** The briefing brought up to date (`Briefing.catchUp`), or as it stands after `CATCH_UP_MS`: never fails a call. */
  const caughtUp = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = deps.briefing.catchUp().catch((e) => deps.log(`briefing: couldn't bring it up to date before the call (${describe(e)})`));
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, CATCH_UP_MS)))]);
    clearTimeout(timer);
  };
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
  // Privacy is the account's own, in a demo world too: a send waiting for Face ID is kept by it (proposals.ts `keepUntapped`).
  deps.proposals.faceid = () => privacyOf(own).security === "faceid";
  /**
   * Where the phone is in the live call (stage 2b), as its call-board poll last said (`GET /api/calls/current?at=`): the
   * Face ID lines are chosen by it. Forgotten as each session starts, so a call never takes the last one's.
   */
  let phoneAt: At | null = null;
  // Locked, the line points at "Approve to send": with no notification able to go (Notifications off, or no phone to send
  // it to) the place isn't used, and today's lines are said.
  deps.proposals.at = () => (!active ? null : phoneAt === "locked" && !deps.engine?.notifies() ? null : phoneAt);
  // Where a tap the call asks for is (Commands that wait's Let it run, a schedule's): the place as the phone said it,
  // locked too, whatever can be sent.
  deps.proposals.place = () => (active ? phoneAt : null);
  // "Approve to send" (stage 2b): the engine's notification, for a send waiting for Face ID.
  deps.proposals.approve = (a) => void deps.engine?.approve(a).catch((e) => deps.log(`engine: couldn't send Approve to send (${describe(e)})`));
  // The engine tells a fact in the live call through its own arrival queue (engine.ts `LiveCall`).
  deps.engine?.useCall(() => {
    const a = active;
    return a ? { conversationId: a.conversationId, tell: (f, said) => a.session.tellFact(f, said) } : null;
  });
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
  async function opening(conversationId: string | null, mode: unknown, accepted: number, memoryDays: number, reachOut: string | null = null): Promise<{ conversationId: string | null; open: Opening; created?: () => void; news?: boolean; heard?: Heard[] }> {
    if (!conversationId && mode === "new") return { conversationId, ...await withNews({ kind: "new" }) };
    deps.waits.expire();
    // A ring answered, or Call back on a notification (docs/launch/engine.md §3, Where a ring opens): the reach-out's
    // rule's conversation, else a new one, with every untold reach-out as its news. One whose wait is still ready there
    // opens as that wait's call-back, as today, and tells the rest of that news after the wait's own. A demo world has no
    // engine: its call-back is stage 1's, its wait's own news, and nothing else's.
    let untoldNews: ReachOut[] = [];
    if (mode === "callback" && deps.engine) {
      const news = await deps.engine.callBack(reachOut);
      // An offline call's missed-call Call back opens the conversation it rang (`rangFor`).
      const own = reachOut ? (news?.[0].rangFor ?? news?.[0].conversationId) : undefined;
      const ready = own ? deps.waits.get(own) : null;
      if (reachOut && news && !(ready?.ready && ready.replies.length)) return callBackOf(own ?? randomUUID(), news, accepted);
      if (own) conversationId = own;
      untoldNews = news ?? [];
      // A ring answered for a computer gone offline while this call-back watched (stage 3.7): the call-back goes on, so its
      // wait isn't over; the call tells that news, and every other untold, as Call back on its notification would.
      const here = conversationId ? deps.waits.get(conversationId) : null;
      // One down time is shared by every call-back watching there: the conversation it rang, or any of theirs (the
      // fourth review of 3.6 to 3.8), not only the first call-back's.
      const engine = deps.engine;
      // Likewise a ring answered for a held command, or a holding phone that took one (stage 4c): its hold first.
      const held = conversationId ? engine.heldIn(conversationId) : [];
      if (conversationId && (held.length || untoldNews.some((r) => engine.offlineIn(r, conversationId!))) && !(here?.ready && here.replies.length)) return callBackOf(conversationId, [...held, ...untoldNews], accepted);
    }
    const w = conversationId ? deps.waits.get(conversationId) : deps.waits.newestReady();
    if (w?.ready && w.replies.length) {
      if (w.conversationId !== conversationId) deps.log(`wait ${w.conversationId}: a new conversation was started; it's this wait's call-back instead`);
      conversationId = w.conversationId;
      const told = w.replies;
      // A call-back's other untold news, each fact once: what isn't the wait's own.
      const mine = new Set(untoldNews.length ? (deps.engine?.factsOf(w) ?? []) : []);
      const rest = untoldNews.filter((r) => !mine.has(r.key));
      // How long it watched a thread still working, and how many of its threads are done when it waited for all (3.6).
      const waited = spokenLength(headOf(w).lifetime.watchMs);
      const all = w.mode?.until === "all" && !w.mode.only && w.items.length > 1 ? { done: told.filter((r) => r.outcome === "finished").length, total: w.items.length } : undefined;
      // A check-in's thread not running since it was asked "isn't running" (stage 3.8), not "never started working"; a
      // deadline's done since it, looked at late, its reply (the fourth review of 3.6 to 3.8), never "still working".
      const outcome = (r: (typeof told)[number]) => (r.stopped ? "stopped" : r.late ? "finished" : r.midRun ? "passing" : w.mode?.checkIn !== undefined && r.outcome === "never started" ? "idle" : r.outcome);
      // A held command whose thread this wait tells as holding it already: its line once (stage 4c).
      const others = (await Promise.all(rest.map((r) => newsReplies(w.conversationId, r)))).flat().filter((o) => !o.reply.held || !told.some((t) => t.held && t.itemId === o.itemId));
      const replies = [
        // Working as last seen on a computer offline then: not known, nothing read (the Skeptic's finding on 3.6 to 3.8).
        // What its tests did, from the computer (stage 3.10), said first, word for word.
        // Holding a command for the user, and holding it still: its hold's line (Fable's ruling on pass B1's review).
        ...(await Promise.all(told.map((r) => (r.offline ? unknownReply(r.handle, r.offline) : (r.held ? heldReply(r.handle, r.itemId) : null) ?? readReply(w.conversationId, r.itemId, r.handle, outcome(r), { ...(r.outcome === "timed out" && !r.late ? { waited } : {}), ...(all ? { all } : {}), ...(r.tests ? { first: testsFirst(r.handle, r.tests) } : {}) }, r.tests?.run))))),
        ...others.map((o) => o.reply),
      ];
      const open: Opening = { kind: "callback", replies };
      const id = conversationId;
      return {
        conversationId,
        open,
        news: true,
        created: () => {
          if (stops !== accepted) return; // stopped meanwhile
          const whose = [...told.map((r) => ({ itemId: r.itemId, handle: r.handle, seen: r.seen })), ...others.map(({ itemId, handle, seen }) => ({ itemId, handle, seen }))];
          const news = { at: Date.now(), replies: whose.map((r, i) => ({ ...r, reply: replies[i] })) };
          const own = deps.waits.get(id) === w;
          // The wait becomes untold news, and the call-back owns the rest it tells, in one transaction (a crash can't
          // keep one without the other). If that fails, this throws and the session is ended: the wait is still there,
          // for the next try, and so is every other, in memory too (owning drops them there only once it's kept). None
          // of the rest is the wait's own (`mine`), so owning it never drops this wait.
          const facts = own ? (deps.engine?.factsOf(w) ?? []) : [];
          deps.store.callBackStarted(id, news, own, rest.length ? () => deps.engine?.owned(rest.map((r) => r.key)) : undefined)?.();
          if (own) deps.waits.take(id);
          // The call-back owns its wait's facts' reach-outs now, once the wait is taken: nothing else delivers them.
          deps.engine?.owned(facts)();
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
      if (!conversationId) return { conversationId: null, ...await withNews({ kind: "new" }) };
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
      return { conversationId: recent, ...await withNews({ kind: "rejoin" }, recent) };
    }
    if (joined) return { conversationId: null, ...await withNews({ kind: "new" }) };
    return { conversationId, open: { kind: mode === "continue" || mode === "callback" ? "continue" : "resume" } };
  }

  /**
   * What hearing an opening's news marks, once the voice has said it in full (`VoiceSession.expect`), in the conversation
   * the call is in (a new call's is made after its opening). `quiet`: the quiet opening's, told only by what's said once
   * the user has spoken.
   */
  type Heard = { handle: string; itemId?: string; at?: string; said: (conversationId: string) => void; quiet?: true };

  /**
   * The engine's untold news a call the voice opens tells first (stage 2b; Fable's 2b topic 3), read now: the first three
   * in full, the rest counted; each told only once it's said (`heard`, the voice's `expect` proof, as a call-back's), so
   * what's counted, or not said, opens the next call until its 24 hours. None without an engine.
   */
  async function untoldNews(conversationId: string | null): Promise<{ news: OpeningNews; heard: Heard[] } | null> {
    const all = await deps.engine?.openingNews().catch((e) => (deps.log(`engine: couldn't read the untold news (${describe(e)})`), [])) ?? [];
    if (!all.length) return null;
    const shown = all.slice(0, 3);
    const parts = await Promise.all(shown.map((r) => newsReplies(conversationId ?? "", r)));
    const items = shown.map((r, i) => ({ replies: parts[i].map((x) => x.reply), why: deps.engine!.whyOf(r), question: r.kind === "question", handle: r.news.handle }));
    const heard = shown.map((r, i): Heard => ({
      handle: r.news.handle,
      ...(r.kind !== "offline" ? { itemId: r.news.itemId } : {}),
      ...(r.news.seen.runAt ? { at: new Date(r.news.seen.runAt).toISOString() } : {}),
      said: (heardIn) => {
        try {
          deps.store.db.transaction(() => {
            // A computer gone offline is no thread's reply: nothing of a thread is marked heard by it (stage 3.7).
            if (r.kind !== "offline") for (const x of parts[i]) deps.store.markSeen(x.itemId, x.seen, heardIn);
            return deps.engine!.owned([r.key]);
          })();
        } catch (e) {
          deps.log(`voice: couldn't record that ${r.news.handle}'s news was heard (${describe(e)})`);
        }
      },
    }));
    deps.log(`voice: the call opens with untold news: ${shown.map((r) => r.news.handle).join(", ")}${all.length > 3 ? `, and ${all.length - 3} more` : ""}`);
    return { news: { items, more: all.length - shown.length, hello: helloNews(all.map((r) => ({ handle: r.news.handle, question: r.kind === "question" }))) }, heard };
  }

  /** A new or rejoined call's opening with the untold news it tells first, if there's any (`untoldNews`). */
  async function withNews(open: Extract<Opening, { kind: "new" | "rejoin" }>, conversationId: string | null = null): Promise<{ open: Opening; heard?: Heard[] }> {
    const told = await untoldNews(conversationId);
    return told ? { open: { ...open, news: told.news }, heard: told.heard } : { open };
  }

  /**
   * A call-back opened from reach-outs (`reachOut`), in `conversationId`: their news, read now, told as a call-back's,
   * as one the user opened from a notification (`notified`: nothing was waited for). Once the session exists they move
   * into its untold news in one transaction, owned by it.
   */
  async function callBackOf(conversationId: string, news: NonNullable<Awaited<ReturnType<Engine["callBack"]>>>, accepted: number) {
    // A hold's line told once, though its own news and a watch's that ran out on it both have it (stage 4c).
    const parts = (await Promise.all(news.map((r) => newsReplies(conversationId, r)))).flat().filter((p, i, all) => !p.reply.held || all.findIndex((q) => q.reply.held === p.reply.held) === i);
    const replies = parts.map((p) => p.reply);
    deps.log(`voice: a call-back for ${news.map((r) => r.news.handle).join(", ")} opens ${conversationId}`);
    return {
      conversationId,
      open: { kind: "callback", replies, notified: true } satisfies Opening,
      news: true,
      created: () => {
        if (stops !== accepted) return; // stopped meanwhile
        const told = { at: Date.now(), replies: parts };
        // Memory follows once the transaction is kept: the waits elsewhere whose news this took go only then.
        deps.store.db.transaction(() => {
          deps.store.saveUntold(conversationId, told);
          return deps.engine!.owned(news.map((r) => r.key));
        })();
        for (const [other, u] of untold) if (!fresh(u)) dropUntold(other);
        untold.set(conversationId, told);
      },
    };
  }

  /**
   * A reach-out's news as a call-back tells it, each thread's: one, for most; a check-in's (stage 3.8), how each of its
   * threads stood at its time, each read now.
   */
  async function newsReplies(conversationId: string, r: ReachOut): Promise<{ itemId: string; handle: string; seen: Seen; reply: Reply }[]> {
    const check = r.news.check;
    if (!check) return [{ itemId: r.news.itemId, handle: r.news.handle, seen: r.news.seen, reply: await newsReply(conversationId, r) }];
    const outcome = { working: "timed out", held: "timed out", replied: "finished", failed: "failed", stopped: "stopped", asks: "question", idle: "idle" } as const;
    return Promise.all(check.standing.map(async (t) => ({
      itemId: t.itemId, handle: t.handle, seen: { runAt: 0, question: null },
      reply: t.offline ? unknownReply(t.handle, t.offline) : (t.state === "held" ? heldReply(t.handle, t.itemId) : null)
        ?? await readReply(conversationId, t.itemId, t.handle, outcome[t.state], (t.state === "working" || t.state === "held") && check.waitedMs ? { waited: spokenLength(check.waitedMs) } : {}),
    })));
  }

  /**
   * A thread working as last seen on a computer offline then (the Skeptic's finding on 3.6 to 3.8): told as not known,
   * with nothing read from a computer that can't answer.
   */
  function unknownReply(handle: string, machine: string): Reply {
    return { handle, outcome: "unknown", machine, report: { text: "", progress: null, question: null } };
  }

  /**
   * A thread holding a command for the user when its watch ran out or its check-in came, and holding it still (Fable's
   * ruling on pass B1's review): told by its hold's own line (Engine's `heldLine`), never as still working, with nothing
   * read. Null once it holds none: then as still working, as before.
   */
  function heldReply(handle: string, itemId: string): Reply | null {
    const held = deps.engine?.heldLine(itemId);
    return held ? { handle, outcome: "held", held, report: { text: "", progress: null, question: null } } : null;
  }

  /**
   * A reach-out's news as a call-back tells it: a thread's reply, read now; a computer gone offline (stage 3.7), the
   * engine's own words for it as things stand now, with nothing read from a computer that can't answer.
   */
  function newsReply(conversationId: string, r: ReachOut): Promise<Reply> {
    // A held command a call-back rang for (stage 4c; Fable's ruling on pass B1's review): its hold's line.
    const hold = r.kind === "held" ? heldReply(r.news.handle, r.news.itemId) : null;
    if (hold) return Promise.resolve(hold);
    if (r.kind === "offline" && r.news.offline && deps.engine) {
      const backAfter = r.back !== undefined ? offlineFor(r.back - r.news.offline.since) : undefined;
      return Promise.resolve({
        handle: r.news.handle, outcome: "offline", report: { text: "", progress: null, question: null },
        offline: { ...deps.engine.offlineSaid(r, conversationId), ...(backAfter ? { backAfter } : {}) },
      });
    }
    // Threads still working when it ran out, all on computers offline then: the first, as not known.
    const off = r.news.still?.offline?.find((x) => x.handle === r.news.handle);
    if (off) return Promise.resolve(unknownReply(off.handle, off.machine));
    const holding = r.news.still?.held?.find((x) => x.handle === r.news.handle);
    const held = holding && !r.news.still?.late?.includes(holding.handle) ? heldReply(holding.handle, holding.itemId) : null;
    if (held) return Promise.resolve(held);
    const [outcome, more] = outcomeOf(r);
    return readReply(conversationId, r.news.itemId, r.news.handle, outcome, { ...more, ...(r.news.tests ? { first: testsFirst(r.news.handle, r.news.tests) } : {}) }, r.news.tests?.run);
  }

  /** What a reach-out's news is, as a call-back tells it (stage 3.6: a failed or stopped run, a thread still working). */
  function outcomeOf(r: ReachOut): [string, { waited?: string }?] {
    if (r.kind === "question") return ["question"];
    if (r.news.still) return r.news.still.late?.includes(r.news.handle) ? ["finished"] : ["timed out", { waited: spokenLength(r.news.still.waitedMs) }];
    // A tests watch's pass while the thread still works (stage 3.10).
    if (r.news.tests?.running) return ["passing"];
    return [r.news.status ?? "finished"];
  }

  /**
   * A thread's reply for a call-back. One that can't be read now (T3 is down) never stops the session: it's `unread`.
   * `pass`: a tests watch's mid-run pass's run (the review of 45ec9eccdf6f, F6).
   */
  async function readReply(conversationId: string, itemId: string, handle: string, outcome: string, more: Pick<Reply, "waited" | "all" | "first"> = {}, pass?: PassRun): Promise<Reply> {
    const rep = await deps.adapter.report(itemId).catch((e) => {
      deps.log(`wait ${conversationId}: couldn't read ${handle}'s reply (${describe(e)})`);
      return null;
    });
    // A tests watch's pass mid-run told after its run ended (a missed call's Call back, kept for the next call): "it's
    // still working" is no longer true, so it's told as that run's end, its first sentence from the run's checks now (B,
    // or C to G), with its reply (Fable's finding on 3.10: what it says must be true when it says it). How it ended
    // decides (Fable on 3.9 and 3.10): failed or stopped, it's told as that, and waiting on a question, as the question,
    // each with no first sentence, as a tests watch tells a thread that ends that way (3.10-D). Its own run's end, never
    // another run's (the review of 45ec9eccdf6f, F6): over though another run has begun (`passOver`), and told by that run's
    // reply and checks; with the report's reply another run's, its tests not known (G) and its reply not read here.
    if (outcome === "passing" && rep) {
      const item = (await deps.adapter.list().catch(() => [])).find((i) => i.id === itemId);
      if (item && passOver(pass, item, rep)) {
        const { first: _first, ...rest } = more;
        const ended = item.status === "waiting" || item.pendingQuestion ? "question" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "stopped" : null;
        if (ended) [outcome, more] = [ended, rest];
        else if (passReplied(pass, rep)) [outcome, more] = ["finished", { ...rest, first: testsFirst(handle, testsOf(rep.checks, { watch: true, readable: rep.checksUnread !== true })!) }];
        else return { handle, outcome: "finished", report: { text: "", progress: null, question: null }, unread: true, ...rest, first: testsFirst(handle, { state: "unknown", watch: true }) };
      }
    }
    // The run's checks, from the computer (stage 3.10), told as one clause: a tests watch's pass while the thread still
    // works, the run still going's so far (it has no reply yet); else the reply's run's.
    const checks = outcome === "passing" ? rep?.running : rep?.checks;
    // Only the start and end are ever spoken; keep no more than that.
    return rep
      ? { handle, outcome, report: { text: outcome === "passing" ? "" : headTail(masked(rep.text), 1500), progress: rep.progress ? headTail(masked(rep.progress), 600) : null, question: rep.question, ...(checks ? { checks } : {}) }, ...more }
      : { handle, outcome, report: { text: "", progress: null, question: null }, unread: true, ...more };
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
          // A computer gone offline is no thread's reply: nothing of a thread is marked heard by it (stage 3.7).
          if (r.reply.outcome !== "offline") deps.store.markSeen(r.itemId, r.seen, conversationId);
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
  /** `heldSeconds`: the phone was on hold that long before coming back (up to a day). */
  const heldOf = (body: any): { held?: number } => {
    const s = Math.floor(Number(body.heldSeconds));
    return Number.isFinite(s) && s >= 0 && body.heldSeconds !== undefined && body.heldSeconds !== "" ? { held: Math.min(s, 86_400) } : {};
  };

  async function readingOpening(conversationId: string, body: any, base: Opening): Promise<{ open: Opening; heard: () => void; told: Heard[] }> {
    // A hand-off holds a few readings; more is a phone gone wrong, and each costs T3 a projection.
    const ids = String(body.readingIds ?? "").split(",").map((s) => s.trim()).filter((id) => /^[0-9a-f]{24}$/.test(id)).slice(0, 20);
    const marks: (() => void)[] = [];
    const played = new Map(String(body.heard ?? "").split(",").map((p) => p.trim().split(":")).filter((p) => p.length === 2).map(([id, n]) => [id, Math.max(0, Math.floor(Number(n)) || 0)]));
    const names = new Map(namedItems(deps.briefing).map((n) => [n.id, n.handle]));
    const read: ReadOut[] = [];
    for (const id of ids) {
      const r = deps.store.reading(id);
      if (!r) continue;
      const parts = Math.min(played.get(id) ?? 0, r.segments);
      const heard = parts >= r.segments ? "all" : parts > 0 ? "part" : "none";
      const docId = docIdOf(r.messageId);
      if (docId) {
        const doc = await deps.adapter.readDocument?.(r.itemId, docId).catch(() => null);
        const handle = names.get(r.itemId) ?? "that thread";
        read.push({ handle: doc ? `${handle} (${doc.name})` : handle, heard, parts, of: r.segments, text: doc?.text ?? "", itemId: r.itemId });
        continue;
      }
      // Every reply it read, for several in a row (kept by their range): the voice model is told them all.
      const all = inRange((await deps.adapter.replies?.(r.itemId).catch(() => null)) ?? [], r.messageId);
      const reply = all.length ? { at: all.at(-1)!.at, text: all.map((p) => p.text).join("\n\n"), ...(all.length > 1 ? { texts: all.map((p) => p.text) } : {}) } : undefined;
      read.push({ handle: names.get(r.itemId) ?? "that thread", heard, parts, of: r.segments, text: reply?.text ?? "", ...(reply?.texts ? { texts: reply.texts } : {}), itemId: r.itemId, ...(reply ? { at: reply.at } : {}) });
      if (heard === "all" && reply) marks.push(() => deps.store.markSeen(r.itemId, { runAt: Date.parse(reply.at), question: null }, conversationId));
    }
    // A reply the user left unsent to come back: kept here when its words came (`keepLeftUnsent`), else which thread
    // (its name is ours, never the phone's) and how far along, still only on the phone.
    const keptParts = Math.floor(Number(body.keptParts));
    const kept = keepLeftUnsent(conversationId, body) ?? (typeof body.keptItemId === "string" && keptParts > 0
      ? { handle: names.get(body.keptItemId) ?? "a thread", parts: Math.min(keptParts, 99) }
      : undefined);
    // The engine's untold news (stage 2b; Fable's 2b topic 3), after what this opening asks, as `opening.meanwhile` tells
    // a call-back's: the first three, each told once said.
    const untold = base.kind === "callback" ? null : await untoldNews(conversationId);
    return {
      open: { kind: "reading", read, said: typeof body.said === "string" ? body.said.slice(0, 500) : "", news: base.kind === "callback" ? base.replies : untold?.news.items.flatMap((i) => i.replies) ?? [], kept, ...heldOf(body) },
      heard: () => marks.forEach((m) => m()),
      told: untold?.heard ?? [],
    };
  }

  /**
   * A reply the user was dictating or writing and came back to the call without sending (`keptDraft`, the phone's
   * draft as `parseDraft` reads it): kept for later at once, as a new thread's prompt is (`newThreadOpening`), so it's
   * in Drafts and the backend can send it by its kept id. 9 November: only its thread came back, so "send it" found
   * nothing to send and took another kept prompt instead. `keptId`: the kept reply the phone carried on with (dictating
   * to the thread again), whose words these replace. Null when there's nothing to keep, or it can't be (its thread
   * settled or gone, already sent, too long): it stays on the phone, as before.
   */
  function keepLeftUnsent(conversationId: string, body: any): KeptDraft | null {
    const draft = body.keptDraft !== undefined ? parseDraft(body.keptDraft) : null;
    if (!draft || isNewThread(draft.itemId) || draftStateOf(deps.store, draft.id).state === "sent") return null;
    const target = namedItems(deps.briefing).find((n) => n.id === draft.itemId);
    if (!target) return null;
    const message = assemble(draft, () => null);
    if (message.length > DRAFT_MAX + 2000) return null;
    const { note, text } = dictatedParts(message);
    const before = typeof body.keptId === "string" ? deps.store.keptReply(body.keptId) : null;
    const kept = deps.store.keepReply({
      id: before?.threadId === draft.itemId ? before.id : `K-${randomUUID().slice(0, 8)}`, threadId: draft.itemId, threadName: target.handle,
      project: target.group, text, note, draftId: draft.id, conversationId, keptAt: Date.now(),
    });
    deps.log(`voice ${conversationId}: a reply to ${target.handle} left unsent, ${draft.id}, kept as ${kept.id}`);
    return { handle: target.handle, parts: draft.parts.length, keptId: kept.id, words: wordCount(draft) };
  }

  /**
   * A dictated reply, put together and proposed in conversation `conversationId`, for Driver to ask the user to send, or
   * (`keep`, the user's setting) to ask whether to send it now or keep it for later, or kept for later at once. A new
   * thread's prompt is `newThreadOpening`'s. `reading` is what the phone read before it, if anything. Refused (409) when
   * it can't be sent: already sent, its thread gone, or too long.
   */
  async function dictatedOpening(conversationId: string, draft: Draft, reading: Extract<Opening, { kind: "reading" }>, keep: KeepReplies, confirm: ConfirmLevels): Promise<Opening> {
    const message = assemble(draft, (readingId) => {
      const r = deps.store.reading(readingId);
      const segments = deps.store.readingSegments(readingId);
      return r && segments ? { itemId: r.itemId, segments } : null;
    });
    if (message.length > DRAFT_MAX + 2000) throw new Refused("That reply is too long to send in one go.");
    const start = parseNewThread(draft.itemId);
    if (isNewThread(draft.itemId)) {
      if (!start) throw new Refused("That prompt couldn't be read.");
      return newThreadOpening(conversationId, draft, message, start, reading);
    }
    const size = { draftId: draft.id, message, words: wordCount(draft), parts: draft.parts.length };
    const made = keep === "keep" ? deps.proposals.keepDraft(conversationId, { ...size, itemId: draft.itemId })
      : await deps.proposals.proposeDraft(conversationId, { ...size, itemId: draft.itemId }, confirm.reply);
    if ("error" in made) throw new Refused(made.error);
    const { proposal } = made;
    // The same draft kept before, back from the phone to be sent: it's this proposal now, and no longer kept.
    const old = keep !== "keep" ? deps.store.keptByDraft(draft.id) : null;
    if (old) deps.store.dropKept(old.id);
    const handle = proposal.targets[0].handle;
    deps.log(`voice ${conversationId}: dictated reply to ${handle}, ${draft.id}, is ${proposal.id}${keep === "keep" ? ", kept for later" : ""}`);
    const after = keep === "keep" ? { keep: "kept" as const } : keep === "ask" ? { keep: "ask" as const } : {};
    return { kind: "draft", draft: { handle, proposalId: proposal.id, readback: proposal.readback, ...after }, read: reading.read, news: reading.news };
  }

  /**
   * A new thread's opening prompt, dictated and brought back to the call (Dictate ends in Talk): kept for later at once,
   * so nothing is lost whatever happens in the call (it's in Drafts), and Driver asks whether to start it or keep it,
   * and which project only if it doesn't know: the one named before dictating, or else one named in it, to confirm. The
   * phone drops its own copy once the call has it. `send_kept` starts it.
   */
  function newThreadOpening(conversationId: string, draft: Draft, message: string, start: NewThread, reading: Extract<Opening, { kind: "reading" }>): Opening {
    if (draftStateOf(deps.store, draft.id).state === "sent") throw new Refused("That prompt has already been sent.");
    const place = spokenPlaces(deps.adapter.places?.() ?? []).find((p) => p.id === start.placeId) ?? null;
    const { note, text } = dictatedParts(message);
    const kept = deps.store.keepReply({
      id: `K-${randomUUID().slice(0, 8)}`, threadId: draft.itemId, threadName: place?.name ?? "", project: place?.name ?? "", text, note,
      draftId: draft.id, conversationId, keptAt: Date.now(),
    });
    const open = promptOpening(kept, start, wordCount(draft), reading);
    const t = open.kind === "draft" ? open.draft.newThread : undefined;
    const suggested = typeof t === "object" ? t.suggested : [];
    deps.log(`voice ${conversationId}: dictated prompt for a new thread${place ? ` in ${place.name}` : ""}, ${draft.id}, kept as ${kept.id}${suggested.length ? `; ${typeof t === "object" && t.named ? "named before as" : "it mentions"} ${suggested.join(", ")}` : ""}`);
    return open;
  }

  /** The opening that asks about kept prompt `kept` (`newThreadOpening`): where to start it, or keep it for later. */
  function promptOpening(kept: KeptReply, start: NewThread, words: number, reading: Pick<Extract<Opening, { kind: "reading" }>, "read" | "news">): Opening {
    const places = spokenPlaces(deps.adapter.places?.() ?? []);
    const place = places.find((p) => p.id === start.placeId) ?? null;
    // A project named before dictating but not settled ("driver", on two machines): which of its places; else one it mentions.
    const options = place || !start.named ? [] : placeOptions(start.named, deps.adapter.places?.() ?? []);
    const named = options.length ? start.named! : null;
    const suggested = place ? [] : options.length ? options : mentionedPlaces(kept.text, places);
    return {
      kind: "draft",
      draft: { handle: newThreadName(place?.name), proposalId: null, readback: "", newThread: { keptId: kept.id, words, place: place?.name ?? null, suggested, ...(named ? { named } : {}) } },
      read: reading.read,
      news: reading.news,
    };
  }

  /**
   * A new thread's prompt this conversation kept as a dictation came back (`newThreadOpening`) in the last hour, still
   * kept, that the user hasn't said a word since: the call that was to ask about it never got going. Then a call carried
   * on in the conversation asks about it. 14 November: back from a dictation on a weak signal the call didn't connect,
   * and Continue opened with no word of the prompt, so the backend started it on "do you still have my message?".
   */
  function unaskedPrompt(conversationId: string): Opening | null {
    const kept = deps.store.keptReplies().find((k) => k.conversationId === conversationId && k.draftId && isNewThread(k.threadId));
    const start = kept && Date.now() - kept.keptAt <= UNTOLD_MS ? parseNewThread(kept.threadId) : null;
    if (!kept || !start || deps.store.turns(conversationId).some((t) => t.role === "user" && t.at >= kept.keptAt)) return null;
    deps.log(`voice ${conversationId}: carried on with ${kept.id}, a new thread's prompt not yet asked about: asking about it`);
    return promptOpening(kept, start, kept.text.split(/\s+/).filter(Boolean).length, { read: [], news: [] });
  }


  /**
   * What a session was made with, kept in the store so a brain restarted mid-call can take it back (`reattach`).
   * `memoryDays` 0 is memory off; otherwise notes older than that are wiped and the rest recalled. `settings`: the
   * snapshot the call started with (none in a session made before it was kept: the settings current then).
   */
  type Made = { memoryDays: number; voice: string; readingStyle?: ReadingStyle; readingVoice?: string; fast: boolean; phoneBuild: string | null; settings?: Settings; keepReplies?: KeepReplies; confirm?: ConfirmLevels; wakeWord?: string; threadNames?: ThreadNames; promptsBack?: boolean; greeting?: Greeting; newThreadPrompt?: NewThreadPrompt; newThreadDefaults?: NewThreadDefaults };
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

  /** The call's `newThreadPrompt`, decided as `keepRepliesFor` is; else "ask" (an older phone sends none). */
  function newThreadPromptFor(body: any, conversationId: string): NewThreadPrompt {
    const carriesOn = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) && body.mode !== "new";
    if (body.newThreadPrompt !== undefined || !carriesOn) return newThreadPromptOf(body.newThreadPrompt);
    return newThreadPromptOf((deps.store.lastResume(conversationId) as Made | null)?.newThreadPrompt);
  }

  /** The call's `newThreadDefaults` (Settings → New threads), decided as `newThreadPromptFor` is; else none. */
  function newThreadDefaultsFor(body: any, conversationId: string): NewThreadDefaults {
    const carriesOn = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) && body.mode !== "new";
    if (body.newThreadDefaults !== undefined || !carriesOn) return newThreadDefaultsOf(body.newThreadDefaults);
    return newThreadDefaultsOf((deps.store.lastResume(conversationId) as Made | null)?.newThreadDefaults);
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
  async function startSession(sdp: string, conversationId: string, open: Opening, memoryDays: number, accepted: number, voice: string | null, created?: () => void, news = false, readingStyle?: ReadingStyle, readingVoice?: string, fast = false, phoneBuild: string | null = null, keepReplies: KeepReplies = "send", confirm: ConfirmLevels = READBACK_ALL, wakeWord?: string, promptsBack = false, greeting: Greeting = "news", newThreadPrompt: NewThreadPrompt = "ask", newThreadDefaults?: NewThreadDefaults, threadNames: ThreadNames = "called", heard: Heard[] = []) {
    // 7 November: a call started again after hanging up lost its agenda and receipts on the phone.
    const view = viewFor(conversationId, open.kind !== "new");
    // A dictated reply kept for later as the call opened is closed already: its receipt is still this call's.
    if (open.kind === "draft" && open.draft.proposalId) view.adopt(open.draft.proposalId);
    starting = view;
    // A new session, a new place: the phone says where it is with its next poll (stage 2b).
    phoneAt = null;
    try {
      active?.session.close({ kind: "replaced" });
      // A reading handed to the phone belongs to the session that hung up for it; a new one has moved on.
      deps.store.dropHandoff(conversationId);
      if (memoryDays > 0) deps.store.forgetBefore(Date.now() - memoryDays * 86_400_000);
      // The briefing about to be spoken names these threads; those names keep meaning them for the whole conversation.
      recordNames(deps, conversationId);
      // One snapshot of the settings for the whole call, taken in line with other starts.
      const snapshot = current();
      const settings: Made = { memoryDays, voice: voice ?? snapshot.voice, readingStyle, readingVoice, fast, phoneBuild, settings: snapshot, keepReplies, confirm, wakeWord, threadNames, promptsBack, greeting, newThreadPrompt, newThreadDefaults };
      const config = buildSessionConfig(sessionOptions(settings), deps, conversationId, new Date(), open);
      const createStart = Date.now();
      const { sessionId, answerSdp, conn: live } = await (deps.createSession ?? createWebRtcSession)(cfg.apiKey, config, sdp, deps.log, {
        created: (id) => deps.hangups.created(id, conversationId),
        close: (id) => deps.hangups.close(id),
      }, deps.openSocket!);
      const createMs = Date.now() - createStart;
      // The untold news is told only through a note that carries it: none when the call waits for the user (speak-first
      // off in Ops), whose note has none. The quiet opening's line names it without telling it, so it's told only by
      // what's said once the user has spoken (`quiet`).
      const speaks = speaksFirst(open.kind, snapshot.speakFirstNew);
      const quiet = open.kind === "new" && greeting === "hello";
      const told = !speaks ? [] : heard.map((h) => (quiet ? { ...h, quiet: true as const } : h));
      const session = takeOn(live, sessionId, conversationId, open, settings, view, { created, news, heard: told });
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
        starred: deps.store.stars().size, machines: machines().length, news: open.kind === "callback" ? open.replies.length : (open.kind === "new" || open.kind === "rejoin") && open.news ? open.news.items.length + open.news.more : 0, create_ms: createMs,
      });
      report({ kind: "started", sessionId, at: Date.now(), opening: open.kind, phoneBuild, brainRev, configVersion: snapshot.version });
      deps.log(`voice ${sessionId}: started (conversation ${conversationId}${open.kind === "new" ? "" : `, ${open.kind}`}; brain ${brainRev}, phone ${phoneBuild ?? "unknown"})`);
      if (stops !== accepted) session.close({ kind: "stopped_before_start" });
      // A call-back speaks first: the user is waiting to hear what the thread said. So does coming back from a reading,
      // or with a dictated reply to send, and a call the user started, new or rejoined: one that waits for the user can
      // seem dead (`speaksFirst`). Unless speak-first is switched off (Ops): those then wait, as before 3 November.
      else if (speaksFirst(open.kind, snapshot.speakFirstNew)) session.speakFirst();
      return { sdp: answerSdp, sessionId, conversationId };
    } finally {
      if (starting === view) starting = null;
    }
  }

  const sessionOptions = (s: Made) => {
    const { liveModel, backendModel, prompts, speakFirstNew } = settingsOf(s);
    return { liveModel, backendModel, prompts, speakFirstNew, voice: s.voice, transport: "webrtc" as const, captions: true, memoryDays: s.memoryDays, fast: s.fast, keepReplies: s.keepReplies, confirm: s.confirm, wakeWord: s.wakeWord, greeting: s.greeting, newThreadPrompt: s.newThreadPrompt, newThreadDefaults: s.newThreadDefaults, threadNames: s.threadNames };
  };
  /** Usage analytics for a session (contracts §5), with its ids on every event. */
  const trackOf = (sessionId: string, conversationId: string) => (event: string, props: Props = {}) =>
    deps.analytics?.track(event, { session_id: sessionId, conversation_id: conversationId, ...props }); // events-lint: forwards (each event is named where it's sent)

  /**
   * A live session becomes the brain's: its recording, its VoiceSession, the active one. Made just now, or (`startedAt`,
   * `recordingId`) taken back after a restart. If anything fails before a VoiceSession owns it, it's ended (the reaper
   * hangs it up until OpenAI confirms).
   */
  function takeOn(live: LiveConn, sessionId: string, conversationId: string, open: Opening, settings: Made, view: CallView, opts: { created?: () => void; news?: boolean; startedAt?: number; recordingId?: string; heard?: Heard[] } = {}): VoiceSession {
    const { memoryDays, readingStyle, readingVoice, fast, phoneBuild } = settings;
    const snapshot = settingsOf(settings);
    // The backend's instructions, built again from the briefing as it is then, when a refresh mid-session changes the threads' replies.
    const backendInstructions = () => (buildSessionConfig(sessionOptions(settings), deps, conversationId, new Date(), open) as any).delegation.responses.instructions as string;
    const recordingId = opts.recordingId ?? sessionId;
    const recording = record(recordingId, conversationId, open, phoneBuild, snapshot);
    const conn = recording?.wrap(live) ?? live;
    // Why it was closing, if it was: a rollover or a hand-off whose connection drops before OpenAI's word still carries
    // the conversation on, though it ends as a dropped connection.
    let closing: EndReason | null = null;
    let session: VoiceSession;
    try {
      opts.created?.();
      const cap = deps.capMs;
      session = new VoiceSession(conn, { sessionId, conversationId }, {
        ...deps,
        capMs: typeof cap === "function" ? () => cap(sessionId) : cap,
        idleMs: snapshot.idleSeconds * 1000,
        maxMs: snapshot.maxMinutes * 60_000,
        startedAt: opts.startedAt,
        memory: memoryDays > 0,
        beforeClose: async (reason, watched) => {
          closing = reason;
          // A rollover: the phone asks why (`/api/wait`) and opens the next session in this conversation straight away.
          if (reason.kind === "rollover") {
            // Threads the user asked to hear about during the call are still watched in the next session.
            if (watched.length) carried.set(conversationId, watched);
            return deps.store.saveHandoff(conversationId, { handle: "", rollover: true });
          }
          // A hold (the tool saved it already; a pause the phrase check heard, here): the phone holds whether or not a
          // thread is watched for a call-back, which `holdAfter` arranges after it.
          if (reason.kind === "paused" && !deps.store.handoff(conversationId)) deps.store.saveHandoff(conversationId, { handle: "", hold: true });
          return holdAfter(deps, conversationId, reason, watched);
        },
        news: [...(opts.news ? newsFor(conversationId) : []), ...(opts.heard ?? []).map((h) => ({ ...h, said: () => h.said(conversationId) }))],
        read: open.kind === "reading" || open.kind === "draft" ? open.read : [],
        held: heldTold(open),
        record: recording?.note,
        // The recording is finished once stored (the session's hang-up starts closing it); 30 s at most, for a slow upload.
        recorded: recording ? () => Promise.race([recording.done, new Promise<void>((r) => setTimeout(r, 30_000))]) : undefined,
        readingStyle,
        readingVoice,
        fast,
        keepReplies: settings.keepReplies,
        confirm: settings.confirm,
        wakeWord: settings.wakeWord,
        promptsBack: settings.promptsBack,
        newThreadPrompt: settings.newThreadPrompt,
        newThreadDefaults: settings.newThreadDefaults,
        backendInstructions,
        said: open.kind === "reading" ? open.said : undefined,
        // The same reads as the phone's cue (`/api/updates`), shared: told during the call as soon as they're seen.
        updates,
        versions: { brainRev, phoneBuild, configVersion: snapshot.version },
        liveNotices: snapshot.liveNotices,
        track: trackOf(sessionId, conversationId),
        opening: open.kind,
        recordingRef: recording ? (deps.recordingRef?.(recordingId) ?? `lattice:sessions/${recordingId}.jsonl`) : undefined,
        usage: deps.meter ? (seconds) => deps.meter!.voice(sessionId, seconds, snapshot, fast) : undefined,
        liveModel: snapshot.liveModel,
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
      // The call is over and the phone's stop, if it comes, finds no session to end (the time limit, a dropped
      // connection, the server closing it): its end is the call's end for its proposals, before its record is kept.
      try {
        // Not while another session carries the same conversation on (the phone rejoined it while this one was still
        // closing): that call's proposals are its own.
        if (endsCall(closing?.kind ?? end.kind) && active?.conversationId !== conversationId) deps.proposals.callEnded(conversationId);
      } catch (e) {
        deps.log(`voice ${sessionId}: couldn't end its proposals with the call (${describe(e)})`);
      }
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
    const now = Date.now();
    const stars = deps.store.stars();
    const set = deps.store.threadNotifies();
    const cards = new Map(deps.briefing.view().cards.map((c) => [c.itemId, c]));
    const purposes = deps.store.purposeLines();
    return namedItems(deps.briefing)
      .map(({ id, handle, group, item }) => ({
        // `project` is the group without its computer, so the phone's filter has one entry per project.
        id, name: handle, group, project: item.project ?? group, machine: item.machine ?? null, status: item.status, updatedAt: item.updatedAt, starred: stars.has(id), snoozedUntil: item.snoozedUntil,
        state: cards.get(id)?.state ?? null, summary: cards.get(id)?.summary ?? null,
        // What it was started for (purposes.ts), the line under its name on its page; null until one is written.
        purpose: purposes.get(id) ?? null,
        // The question it asks now, by its work system's id, or null: the phone takes away a question's notification
        // once its thread no longer asks it (docs/launch/engine.md §11, stage 2, Answered elsewhere).
        questionId: item.pendingQuestion ? item.questionId ?? null : null,
        // A command it holds until you let it run from the phone (Commands that wait; Fable's 4-H2): its card on the thread,
        // on every level. Null otherwise.
        held: item.gate && item.questionId ? { questionId: item.questionId, command: item.gate.command, matched: item.gate.matched, since: item.gate.since } : null,
        // Its own notifications (docs/launch/engine.md §11, 3.1): its page's picker, Settings' Threads set by hand, and
        // the crossed bell by a followed thread set to Nothing.
        notify: notifyOf(set.get(id)?.notify, stars.has(id)),
        // Its computer offline past the grace, since when it was last heard from (ms), else null (stage 3.7; Fable, topic
        // 12): the phone's row says "Quartz offline · was running" rather than running.
        offlineSince: offlineOf(deps.adapter, id, now)?.since ?? null,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * A tap on the phone that changes a thread (contracts §3): carried out at once, the signed-in tap being the user's yes,
   * and kept for the timeline. An unsettle is of a settled thread; anything else of an open one. `fields`: a snooze's
   * `until`, a reply's `message` (and a kept reply's `keptId`, and its `draftId` if it was dictated).
   */
  async function tapped(body: any, action: TapAction, fields: { until?: string; message?: string; keptId?: string; draftId?: string; questionId?: string; afterReply?: string } = {}): Promise<Response> {
    // From a notification: an answer to its question, or a write after its reply (a quick reply or Reply…, Fable's 4-K).
    const noted = !!(fields.questionId || fields.afterReply);
    const answer = noted ? (p: Proposal) => answerWithNote(p, body.typed === true) : tapAnswer;
    // A question's tap: whatever the brain answers, refusals included, the phone puts the line after the tap in its
    // notification's place, so from now on nothing is there for "Already answered." to replace (engine.ts `tapping`).
    if (fields.questionId && typeof body.id === "string") deps.engine?.tapping(body.id, fields.questionId);
    const again = earlierTap(body, (p) => p.action === action && p.targets[0]?.itemId === body.id && p.fields.until === fields.until && p.fields.message === fields.message && p.fields.questionId === fields.questionId && p.fields.afterReply === fields.afterReply, answer);
    if (again) return again;
    // Answering from a notification is Road Trip's and up (docs/launch/engine.md §8, §12 5): a button left on an old
    // notification after a downgrade is refused, with no level named; the app answers it on every level.
    if (noted && deps.engine && !deps.engine.limits().answerFromNotification) return notFromNote();
    const thread = typeof body.id === "string" ? namedItems(deps.briefing, action === "unsettle").find((n) => n.id === body.id) : undefined;
    // A question's thread that's gone or done has moved on from it too; so has a reply's (its words kept in Drafts while
    // it's still listed, settled).
    if (!thread && fields.afterReply) return notWritten(body, fields.afterReply, "moved_on");
    if (!thread) return send(404, { error: action === "unsettle" ? "no such settled thread" : "no such open thread", ...(fields.questionId ? { note: ANSWERED_NOTE, named: false } : {}) });
    if (action === "settle" && thread.item.status === "running") return send(409, { error: `${thread.handle} is still working. Mark it done once it finishes.` });
    // An older connector can't undo a snooze or a settle, and one set to listen in only takes no replies: what the
    // thread's own computer can do.
    if (!(deps.adapter.actionsFor?.(thread.id) ?? deps.adapter.actions).includes(action)) {
      const error = action === "follow_up" ? "Your computer only lets 10 & 2 listen in, so nothing was sent." : "Your computer can't do that yet. Update 10 & 2 on it, then try again.";
      return send(409, { error, ...(fields.questionId ? { note: error, named: false } : {}) });
    }
    // How it was agreed to, kept with a send (the Timeline's "how each send was approved").
    const how = action === "follow_up" ? approvedOf(body) : {};
    const p = await deps.proposals.tap(action, { itemId: thread.id, handle: thread.handle, group: thread.group }, { ...fields, ...how }, body.requestId);
    deps.log(`tap ${p.id} ${action} ${thread.id} → ${p.state}`);
    if (deps.analytics) trackChange(deps.analytics.track, p, tapVia(body.via, !!fields.keptId), body.dictated === true);
    // The user answered the question: its news was heard (engine.ts `tapped`).
    if (fields.questionId && (p.state === "executed" || p.state === "unknown")) deps.engine?.tapped(thread.id, fields.questionId);
    // Sent from a notification (Fable's 4-K), or it may have gone (its outcome not known: Fable, 4-K's review): its
    // reply's news was had, and the thread's next reply notifies once.
    if (noted && (p.state === "executed" || p.state === "unknown")) deps.engine?.wrote(thread.id, fields.afterReply ?? null, fields.questionId);
    // Not sent after a reply it has moved on from (typed words), or with its computer offline (any words): kept in Drafts.
    if (fields.afterReply && p.state === "cancelled" && (p.result === WRITE_OFFLINE || (p.result === MOVED_ON && body.typed === true))) keepWritten(body, thread);
    // Typed words answering a question, with its computer offline (Fable, 4-K's review): kept there too.
    if (typedOffline(p, body.typed === true)) keepWritten(body, thread);
    return answer(p);
  }

  /**
   * A write from a reply's notification that didn't go (Fable's 4-K), its words kept in Drafts under its thread, by its
   * request id, so the same request again keeps one.
   */
  function keepWritten(body: any, thread: { id: string; handle: string; group: string }) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return;
    const id = `K-W${createHash("sha256").update(String(body.requestId)).digest("hex").slice(0, 16)}`;
    deps.store.keepReply({ id, threadId: thread.id, threadName: thread.handle, project: thread.group, text, note: null, draftId: null, conversationId: TAP, keptAt: Date.now() });
    deps.log(`tap ${String(body.requestId)}: a write from a notification didn't go; kept as ${id}`);
  }

  /**
   * The answer to a write from a reply's notification refused before it reached the proposals (its thread gone from the
   * open threads): 409 with the line for its notification's place (`notWrittenLine`), its words kept in Drafts when its
   * thread is still listed (settled) and they were typed.
   */
  function notWritten(body: any, reachOut: string, why: "moved_on" | "offline"): Response {
    const r = deps.store.reachOut(reachOut);
    const settled = namedItems(deps.briefing, true).find((n) => n.id === body.id);
    const typed = body.typed === true && !!settled;
    if (typed) keepWritten(body, settled!);
    const names = privacyOf(own).names;
    const note = notWrittenLine({ why, thread: settled?.handle ?? r?.news.handle ?? "", names: names && !!(settled ?? r), machine: null, computers: 1, typed });
    return send(409, { error: why === "moved_on" ? MOVED_ON : WRITE_OFFLINE, note, named: names && !!(settled ?? r) });
  }

  /**
   * Typed words answering a question (Reply…) not sent because its computer is offline: kept in Drafts (Fable, 4-K's
   * review). Known by the refusal's own mark (`offline`), never by its words (the skeptic, 4-K's second review).
   */
  function typedOffline(p: Proposal, typed: boolean): boolean {
    return typed && !!p.fields.questionId && p.state === "cancelled" && p.fields.offline === true;
  }

  /** A notification's button tapped on a level that doesn't answer from one: nothing sent, the line naming no level. */
  const notFromNote = () => send(403, { error: NOT_FROM_NOTE, code: "forbidden", note: NOT_FROM_NOTE, named: false });

  /** A tap's answer: what became of it, a sentence for the phone when it didn't go through. */
  const tapAnswer = (p: Proposal, more: object = {}) =>
    p.state === "executed" ? send(200, { ok: true, state: p.state, result: p.result, ...more }) : send(p.state === "unknown" ? 502 : 409, { error: p.result ?? "Nothing was changed.", ...more });

  /**
   * A tap on one of a question's options (a notification's button): the tap's answer, with `note`, the line the phone
   * shows in the notification's place (docs/launch/engine.md §11, stage 2, After a tap). With thread names hidden
   * (Privacy) it names none. `named`: whether it names the thread, so a phone whose names were hidden since (the answer
   * on its way) shows one of its own that doesn't (ios/Driver/Notes.swift `line`).
   */
  const answerWithNote = (p: Proposal, typed = false) => {
    // The level changed while it was prepared (Proposals' last look before it goes): refused as one tapped after it.
    if (p.state === "cancelled" && p.result === NOT_FROM_NOTE) return notFromNote();
    const names = privacyOf(own).names;
    // A write after a reply (Fable's 4-K) the thread has moved on from, or its computer offline, or typed words
    // answering a question with its computer offline: the line for its notification's place, which says whether its
    // words are in Drafts (they are when typed, or offline).
    const offlineAnswer = typedOffline(p, typed);
    if ((p.fields.afterReply && p.state === "cancelled" && (p.result === MOVED_ON || p.result === WRITE_OFFLINE)) || offlineAnswer) {
      const offline = p.result === WRITE_OFFLINE || offlineAnswer;
      const item = deps.briefing.allItems().find((i) => i.id === p.targets[0]?.itemId);
      const computers = deps.adapter.connectionStatus?.().length || new Set(deps.briefing.allItems().map((i) => i.machine ?? "")).size;
      const note = notWrittenLine({ why: offline ? "offline" : "moved_on", thread: p.targets[0]?.handle ?? "", names, machine: item?.machine ?? null, computers, typed });
      return tapAnswer(p, { note, named: names && !offline });
    }
    const to = names ? ` to ${p.targets[0]?.handle ?? "your thread"}` : "";
    const refused = p.result ?? "Nothing was sent.";
    const naming = p.targets.some((t) => refused.includes(t.handle));
    // Typed words that went, names hidden: none of them on the lock screen ("Sent.", as the iPhone's own line; Fable's
    // 4-0 (5), the skeptic, 4-K's second review).
    const note = p.state === "executed" ? (typed && !names ? "Sent." : `Sent${to}: ${p.fields.message ?? ""}`)
      : p.state === "unknown" ? `Sent${to}, but it may not have arrived.`
      // A refusal that names the thread (a receipt's "Failed for API: …") doesn't, with names hidden.
      : !names && naming ? "Nothing was sent."
      : refused;
    return tapAnswer(p, { note, named: names && (p.state === "executed" || p.state === "unknown" || naming) });
  };

  /**
   * The phone's id for a tap: sent again (its answer was lost, or twice at once), it's answered with the first's outcome,
   * if it's the same change (`same`). Null: a new tap. A malformed id is 400. Answered without waiting when it's new,
   * so the same tap sent twice at once finds the first one kept.
   */
  function earlierTap(body: any, same: (p: Proposal) => boolean, answer: (p: Proposal) => Response = tapAnswer): Response | Promise<Response> | null {
    if (body.requestId !== undefined && !(typeof body.requestId === "string" && CONVERSATION_ID.test(body.requestId))) return send(400, { error: "requestId must be 8 to 64 letters, digits, - or _" });
    const earlier = body.requestId ? deps.proposals.earlierTap(body.requestId) : null;
    if (!earlier) return null;
    if (!same(earlier.proposal)) return send(409, { error: "That tap was already used for another change. Try again." });
    return earlier.done.then((p) => answer(p));
  }

  /** Answers being carried out now, by request id: the same tap sent again (a lost answer, a double tap) joins its run. */
  const answering = new Map<string, Promise<Proposal>>();

  /**
   * Send or Don't, tapped for proposal `id` (contracts §3, "In a call"): only for a change still waiting for a yes in the
   * live call. The signed-in tap is the user's yes or "don't": it's carried out (or called off) as the spoken one is, and
   * Driver is told so it can say so. `requestId` makes it safe to send again: the same id is answered with what became
   * of the proposal; the same id for another proposal or the other button is 409.
   */
  async function tappedAnswer(body: any, id: string, verb: "confirm" | "cancel", via: "call" | "approve" = "call"): Promise<Response> {
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
      session.tapped(verb, after, via);
      return after;
    })();
    answering.set(requestId, run);
    try {
      return answerOf(verb, await run);
    } finally {
      answering.delete(requestId);
    }
  }

  /**
   * Face ID, asked on the phone's screen by itself for proposal `id` waiting in the live call, didn't see the user: it
   * failed, or nobody was seen within 15 s of its sheet (stage 2b; Fable's 2b topic 6). The send is kept in Drafts as
   * "Waiting for your Face ID", and the voice says "I couldn't see you…". Cancel on the sheet isn't this. Nothing is sent.
   */
  function unseenAnswer(id: string): Response {
    const p = deps.store.proposal(id);
    if (!p || p.conversationId === TAP) return send(404, { error: "No such change." });
    if (!active || starting || active.conversationId !== p.conversationId || active.session.closing) return send(409, { error: "That call has ended." });
    if (p.state !== "proposed") return send(409, { error: NO_LONGER_WAITING });
    const kept = deps.proposals.unseen(id);
    if (!kept) return send(409, { error: NO_LONGER_WAITING });
    active.session.unseen(p);
    return send(200, { ok: true, keptId: kept.id });
  }

  /**
   * "Approve to send" answered from its notification (stage 2b; Fable's 2b topic 7), `id` its send's: during the call a
   * proposal still waiting there (`P-…`), Approve its Send, Don't send its Don't, which the voice tells ("Sent.", "Not
   * sent."); after it, a reply or prompt kept waiting for Face ID (`K-…`, or a proposal kept since), Approve sending it
   * as Send in Drafts does, Don't send leaving it in Drafts as an ordinary draft. The phone asked for Face ID before an
   * Approve. One no longer waiting: "That's no longer waiting, so nothing was sent." The answer is a tap's (`note`).
   */
  async function approvalAnswer(body: any, id: string): Promise<Response> {
    const approve = body.approve === true;
    const p = /^P-/.test(id) ? deps.store.proposal(id) : null;
    if (p && p.state === "proposed" && p.conversationId !== TAP) {
      if (!active || starting || active.conversationId !== p.conversationId || active.session.closing) return send(409, { error: NO_LONGER_WAITING, note: NO_LONGER_WAITING, named: false });
      const res = await tappedAnswer(body, id, approve ? "confirm" : "cancel", "approve");
      if (res.status !== 200) return res;
      const answer = (await res.json()) as Record<string, unknown>;
      return send(200, { ...answer, note: approve ? typeof answer.result === "string" ? answer.result : "Sent." : "Nothing was sent.", named: false });
    }
    // A proposal kept since (its 120 s, the call's end, the car) is its kept reply now.
    const keptId = p?.state === "cancelled" && p.fields.keptId ? p.fields.keptId : /^K-/.test(id) ? id : null;
    const kept = keptId ? deps.store.keptReply(keptId) : null;
    // Don't send leaves the words in Drafts as an ordinary draft, whether or not it was still waiting: never lost.
    if (kept && !approve && !sendingKept.has(kept.id)) {
      if (kept.waiting) deps.store.keepReply({ ...kept, waiting: undefined });
      deps.log(`kept ${kept.id}: Don't send on Approve to send; it stays in Drafts`);
      return send(200, { ok: true, state: "kept", note: "Nothing was sent.", named: false });
    }
    // The same Approve again (a lost answer, a double tap): answered as the first, never sent twice (`earlierTap`).
    const again = approve && keptId && typeof body.requestId === "string" && deps.proposals.earlierTap(body.requestId);
    if (again) return sendKept({ ...body, keptId, via: "lock_screen" });
    if (!kept || kept.waiting !== "faceid" || sendingKept.has(kept.id)) return send(409, { error: NO_LONGER_WAITING, note: NO_LONGER_WAITING, named: false });
    return sendKept({ ...body, keptId: kept.id, via: "lock_screen" }, () => deps.analytics?.track("reply_kept", { action: "sent", count: 1 }));
  }

  /** What became of a proposal answered with a tap, as the phone shows it: like any tap's answer (`tapAnswer`). */
  function answerOf(verb: "confirm" | "cancel", p: Proposal): Response {
    const expired = "That waited too long for a yes, so nothing was changed. Ask again.";
    if (p.state === "expired") return send(409, { error: expired });
    if (verb === "cancel") {
      if (p.state === "cancelled") return send(200, { ok: true, state: "cancelled", result: "Nothing was changed." });
      return send(409, { error: p.state === "executing" ? "It's already being carried out and can't be stopped now." : `Too late: ${p.result ?? "it already happened."}` });
    }
    switch (p.state) {
      case "executed":
      case "partial":
      // Set up for later (stage 4b): agreed to with Schedule; nothing is sent until its time.
      case "scheduled":
        return send(200, { ok: true, state: p.state, result: p.result });
      case "unknown":
        return send(502, { error: p.result ?? "Couldn't tell whether that went through." });
      case "executing":
        return send(409, { error: "That's already being carried out." });
      case "failed":
        return send(409, { error: p.result ?? "That didn't go through." });
      case "cancelled":
        // A sentence from carrying it out ("… so I called this off"), or a short reason: a name changed, a newer change.
        return send(409, { error: p.result === "a name changed" ? "A thread changed since it was read back, so nothing was changed. Ask again." : p.result?.endsWith(".") ? p.result : "That was called off, so nothing was changed." });
      default:
        return send(409, { error: "Nothing was changed. Try again." });
    }
  }

  /** Kept replies being sent now: one is sent once at a time, and isn't changed or discarded meanwhile. */
  const sendingKept = new Set<string>();

  /**
   * Replies kept for later (contracts §3, "Kept replies"), newest first, as the phone's Drafts lists them: named as the
   * briefing names their threads now. One whose thread was settled since is listed, `settled`, for the user to decide;
   * one whose thread the briefing doesn't know is left out (still kept).
   */
  function keptRows() {
    const open = new Map(namedItems(deps.briefing).map((n) => [n.id, n]));
    const settled = new Map(namedItems(deps.briefing, true).map((n) => [n.id, n]));
    return deps.store.keptReplies().flatMap((k) => {
      // A new thread's prompt: named by its project, if it has one yet ("" for none), with the access it starts with.
      // `waiting: "faceid"`: kept because it waited for Send with Face ID and wasn't tapped (Drafts: "Waiting for your Face ID").
      const waiting = k.waiting ? { waiting: k.waiting } : {};
      if (isNewThread(k.threadId)) {
        // The access a tap on Send would start it with (`tapStart`'s profile), shown before it's started.
        const profile = deps.proposals.profileOf(parseNewThread(k.threadId)?.profile ?? null);
        const access = "error" in profile ? {} : { access: accessLine(profile.runtimeMode) };
        return [{ id: k.id, threadId: k.threadId, threadName: k.threadName, project: k.project, text: k.text, keptAt: k.keptAt, conversationId: k.conversationId, settled: false, ...waiting, ...access }];
      }
      const n = open.get(k.threadId) ?? settled.get(k.threadId);
      return n ? [{ id: k.id, threadId: k.threadId, threadName: n.handle, project: n.group, text: k.text, keptAt: k.keptAt, conversationId: k.conversationId, settled: !open.has(k.threadId), ...waiting }] : [];
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
    const again = earlierTap(body, (p) => (p.action === "follow_up" || p.action === "start_work") && p.fields.keptId === body.keptId && (text === undefined || tappedWords(p.fields.message ?? "") === text));
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
      const message = kept.note ? `${kept.note}\n\n${words}` : words;
      // A new thread's prompt, kept in a call: started where it says (one with no project yet is refused, to start by voice).
      const res = isNewThread(kept.threadId) ? await tappedStart(body, kept.threadId, message, kept.id)
        : await tapped({ ...body, id: kept.threadId }, "follow_up", { message, keptId: kept.id, ...(kept.draftId ? { draftId: kept.draftId } : {}) });
      if (res.status === 200) {
        deps.store.dropKept(kept.id);
        sent?.();
      }
      return res;
    } finally {
      sendingKept.delete(kept.id);
    }
  }

  /**
   * A thread's drafts sent as one message (contracts §3, "Drafts sent as one"): `parts`, each the user's words and the
   * paragraph they answer if they picked one, put together in the order given (`tappedReplies`) and sent as any tapped
   * reply is (`tapped`: the same `requestId` rules and answers). A part with `keptId` is a reply kept for later in a
   * call, to this thread, as the phone shows it: no longer kept once the message has gone through, and a dictated
   * one's first line starts the message.
   */
  async function sendParts(body: any): Promise<Response> {
    const given: unknown[] | null = Array.isArray(body.parts) ? body.parts : null;
    if (!given?.length || given.length > REPLY_PARTS_MAX) return send(400, { error: `parts must list 1 to ${REPLY_PARTS_MAX} replies` });
    if (body.requestId === undefined) return send(400, { error: "requestId is required" });
    if (typeof body.id !== "string" || isNewThread(body.id)) return send(400, { error: "parts are replies to an open thread" });
    const parts: { text: string; quote: string | null }[] = [];
    const keptIds: string[] = [];
    for (const one of given as any[]) {
      const text = typeof one?.text === "string" ? one.text.trim() : "";
      if (!text) return send(400, { error: "Write a reply first." });
      parts.push({ text, quote: typeof one.quote === "string" ? one.quote : null });
      if (one.keptId !== undefined) {
        if (typeof one.keptId !== "string" || keptIds.includes(one.keptId)) return send(400, { error: "keptId must be a kept reply's id, once" });
        keptIds.push(one.keptId);
      }
    }
    const message = tappedReplies(parts);
    if (message.length > DRAFT_MAX) return send(400, { error: "That reply is too long to send in one go." });
    // The same words to the same thread: a kept reply's first line is on the message that went, and gone with the reply.
    const again = earlierTap(body, (p) => p.action === "follow_up" && p.targets[0]?.itemId === body.id && tappedWords(p.fields.message ?? "") === tappedWords(message));
    if (again) {
      const answer = await again;
      // Sent, but still kept only if the brain stopped in between: not any more.
      if (answer.status === 200) for (const id of keptIds) if (!sendingKept.has(id)) deps.store.dropKept(id);
      return answer;
    }
    const kept = keptIds.map((id) => deps.store.keptReply(id));
    if (kept.some((k) => !k)) return send(404, { error: "That reply isn't kept any more: it was sent or discarded." });
    if (kept.some((k) => k!.threadId !== body.id)) return send(400, { error: "That kept reply is for another thread." });
    if (keptIds.some((id) => sendingKept.has(id))) return send(409, { error: "That reply is being sent right now." });
    if (namedItems(deps.briefing, true).some((n) => n.id === body.id)) return send(409, { error: "That thread is done, so nothing was sent. Bring it back first, or discard the reply." });
    for (const id of keptIds) sendingKept.add(id);
    try {
      const note = kept.find((k) => k!.note)?.note;
      const res = await tapped(body, "follow_up", { message: note ? `${note}\n\n${message}` : message });
      if (res.status === 200) {
        for (const id of keptIds) deps.store.dropKept(id);
        if (keptIds.length) deps.analytics?.track("reply_kept", { action: "sent", count: keptIds.length });
      }
      return res;
    } finally {
      for (const id of keptIds) sendingKept.delete(id);
    }
  }

  /**
   * A new thread started with a tap (contracts §3, "Tap to send"): a dictated draft's `new:` target (`target`), and its
   * prompt. `keptId`: it was kept for later in a call, and is no longer once it's started.
   */
  async function tappedStart(body: any, given: string, message: string, keptId?: string): Promise<Response> {
    // A project picked on the phone (Drafts' picker, `placeId`): the same new thread, started there.
    const target = typeof body.placeId === "string" && body.placeId ? placedTarget(given, body.placeId) ?? given : given;
    const again = earlierTap(body, (p) => p.action === "start_work" && p.fields.target === target && p.fields.message === message);
    if (again) return again;
    const start = parseNewThread(target);
    if (start?.placeId && !(deps.adapter.actionsFor?.(start.placeId) ?? deps.adapter.actions).includes("start_work")) return send(409, { error: "Your computer only lets 10 & 2 listen in, so nothing was started." });
    const p = await deps.proposals.tapStart(target, message, body.requestId, keptId, approvedOf(body));
    if ("error" in p) return send(409, p);
    deps.log(`tap ${p.id} start_work ${p.fields.placeId} → ${p.state}`);
    if (deps.analytics) trackChange(deps.analytics.track, p, tapVia(body.via), body.dictated === true);
    return tapAnswer(p);
  }

  /** The machines whose threads are in the briefing: this one, and every other one with threads ("…, on Quartz"). */
  /** `POST /api/rules`' answers that set a watch, by request id, the latest few: the same tap sent again gets the same. */
  type Ruled = { requestId: string; target: string; status: number; answer: Record<string, unknown>; at: number };
  const RULED_KEY = "rule_requests";
  const ruledBefore = (): Ruled[] => {
    try {
      const a = JSON.parse(deps.store.get(RULED_KEY) ?? "[]");
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  const ruling = new Map<string, { target: string; run: Promise<{ status: number; answer: Record<string, unknown> }> }>();

  /**
   * `POST /api/rules` (docs/launch/engine.md §11 stage 5; Fable's topics 4, 6 and 7): a watch made by hand on thread
   * `id` (a thread's page, or Siri with `via: "siri"`), or the call's card's OK (`card`, the id the call's view gave it),
   * each with the sheet's choices. `requestId` makes it safe to send again: the same id for the same thread or card is
   * answered as it was the first time, for another 409. Only what set a watch is kept: a refusal (Call me back and
   * Notifications both off, a thread with nothing to wait for) may be tried again with the same id once it's sorted.
   */
  async function setRule(body: any): Promise<Response> {
    const requestId = body.requestId;
    if (!(typeof requestId === "string" && CONVERSATION_ID.test(requestId))) return send(400, { error: "requestId must be 8 to 64 letters, digits, - or _" });
    const target = typeof body.card === "string" ? `card:${body.card}` : `thread:${String(body.id)}`;
    const taken = { error: "That tap was already used for another change. Try again." };
    const earlier = ruledBefore().find((a) => a.requestId === requestId);
    if (earlier) return earlier.target === target ? send(earlier.status, earlier.answer) : send(409, taken);
    const going = ruling.get(requestId);
    if (going && going.target !== target) return send(409, taken);
    const run = going?.run ?? makeRule(body).then((r) => {
      if (r.status === 200) deps.store.set(RULED_KEY, JSON.stringify([...ruledBefore(), { requestId, target, ...r, at: Date.now() }].slice(-50)));
      return r;
    }).finally(() => ruling.delete(requestId));
    if (!going) ruling.set(requestId, { target, run });
    const r = await run;
    return send(r.status, r.answer);
  }

  async function makeRule(body: any): Promise<{ status: number; answer: Record<string, unknown> }> {
    const choices = choicesOf(body);
    if (typeof choices === "string") return { status: 400, answer: { error: choices } };
    // The card's OK: the live call's own, set as a yes to its readback is (VoiceSession `tappedCard`).
    if (typeof body.card === "string") {
      if (!active || starting || active.session.closing) return { status: 409, answer: { error: CARD.ended } };
      const r = await active.session.tappedCard(body.card, choices);
      // `kept`: a change made on its sheet the brain can't make; nothing set, and the card still waits.
      return "error" in r ? { status: 409, answer: { error: r.error, ...(r.kept ? { kept: true } : {}) } } : { status: 200, answer: { ok: true, ...r } };
    }
    const engine = deps.engine;
    const siri = body.via === "siri";
    const thread = typeof body.id === "string" ? namedItems(deps.briefing).find((n) => n.id === body.id) : undefined;
    if (!thread) return { status: 404, answer: { error: "That thread isn't open any more." } };
    // Every world has an engine, a demo's too (stage 5); a brain built without one has no watches to make.
    if (!engine) return { status: 404, answer: { error: "not found" } };
    // Nothing can reach the phone (Call me back and Notifications off, or with Call me back on today's call-back used and
    // Notifications off): no line promises a call or a notification (Fable, topic 7), for a watch already there too, which
    // stays. Each names only a switch that's off (the second and third reviews of stage 5): for a watch there that asks
    // for a notification with Notifications off while a call can be made, Notifications.
    const neither = { status: 409, answer: { error: engine.keptLine(siri) } };
    const notesOff = { status: 409, answer: { error: siri ? SIRI_NOTES_OFF : SHEET.watchedNotesOff } };
    const answer = (w: Wait) => ({ status: 200, answer: { ok: true, id: headOf(w).id, line: engine.setLineOf(w, thread.handle, siri), rule: engine.watching().find((r) => r.id === headOf(w).id) ?? null } });
    const already = (w: Wait) => (engine.reachOf(w) !== "kept" ? answer(w) : engine.reach() === "kept" ? neither : notesOff);
    if (engine.reach() === "kept") return neither;
    // One per thread (Fable, topic 6): one already there is the answer.
    const before = engine.watchOn(thread.id);
    if (before) return already(before);
    const live = await deps.adapter.list().catch(() => null);
    const item = live?.find((i) => i.id === thread.id) ?? thread.item;
    let connected = false;
    try {
      connected = !!live?.some((i) => i.id === thread.id) && deps.adapter.connected(thread.id);
    } catch {}
    const patient = awaitingSubagents(item, live ?? []);
    const now = Date.now();
    const can = armable({ item, handle: thread.handle, connected, patient }, now);
    if ("refused" in can) return { status: 409, answer: { error: can.refused } };
    // Looked at again after the computers answered: another for the thread may have got in meanwhile.
    const meanwhile = engine.watchOn(thread.id);
    if (meanwhile) return already(meanwhile);
    const made = engine.watchOne(`watch-${randomUUID()}`, { item, handle: thread.handle, since: can.since, patient }, choices, siri ? "siri" : "app", now);
    if ("line" in made) return { status: 409, answer: { error: made.line } };
    deps.log(`watch: ${headOf(made).id} set by ${siri ? "Siri" : "the app"} on ${thread.id}`);
    return answer(made);
  }

  function machines(): string[] {
    const others = deps.briefing.allItems().map((i) => / on (\w[\w-]*)$/.exec(i.group)?.[1]).filter((m): m is string => !!m);
    return [...new Set([deps.demo?.machine ?? spokenHost(), ...others])];
  }

  async function handle(req: Request, url: URL, pre?: any): Promise<Response> {
    {
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = pre ?? await readJson(req);
        if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=")) return send(400, { error: "sdp offer required" });
        // The test call (ring.ts `TEST_RING`) has nothing to answer: a phone that doesn't know it opens no call, uses no minutes.
        if (body.conversationId === TEST_RING.conversationId) return send(409, { error: TEST_CALL_ANSWERED });
        // The phone ended the lock screen's board as it started this call (its `LiveActivity.start`), whether or not the
        // call gets going: it isn't kept current any more, and no `end` goes to it as the call takes the wait.
        deps.boards?.forget();
        const given = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
        // The phone's conversation voice; one GPT-Live doesn't have is ignored (the call's settings say which, then).
        const voice = (CONVERSATION_VOICES as readonly string[]).includes(body.voice) ? String(body.voice) : null;
        const memoryDays = body.memoryDays === undefined ? DEFAULT_MEMORY_DAYS : Math.min(Math.max(Math.round(Number(body.memoryDays)) || 0, 0), 30);
        // Taken now, before waiting in line: a stop from here on cancels this request.
        const accepted = stops;
        // Where the phone is (its zone, CarPlay), kept on its record for stage 3 (docs/launch/engine.md §11, item 6).
        deps.ringer?.situate(tzOf(body.tz), typeof body.car === "boolean" ? body.car : undefined);
        // A ring answered, or Call back on a notification: the ring that led here is connecting (engine.ts, item 8).
        const reachOut = typeof body.reachOut === "string" && body.reachOut.length <= 200 ? body.reachOut : null;
        if (body.mode === "callback") deps.engine?.connecting(given, reachOut);
        // How the phone reads replies aloud, should the user ask Driver to read one, and in which of OpenAI's voices
        // (none when it reads in its own).
        const readingStyle = styleOf(body, body.readingStyle, fastAllowed());
        const readingVoice = (READING_VOICES as readonly string[]).includes(body.readingVoice) ? String(body.readingVoice) : undefined;
        // A reply the user dictated, back from the phone to be sent: it must have been heard back there in full.
        const draft = body.mode === "reading" && body.draft !== undefined ? parseDraft(body.draft) : null;
        if (body.mode === "reading" && body.draft !== undefined) {
          if (!draft) return send(400, { error: "That reply couldn't be read." });
          // A new thread's prompt comes back to the call as the dictation ends, to be kept and asked about (`dictatedOpening`).
          if (!isNewThread(draft.itemId) && body.heardBack !== true && body.heardBack !== "true") return send(409, { error: "Hear the reply back before sending it." });
        }
        const run = creating.then(async () => {
          // The briefing brought up to date before the opening is built from it: on staging a call opened telling a
          // question that had gone 13 s before, its thread's change still waiting to be read (the stage 3 staging run).
          await caughtUp();
          const { conversationId, open, created, news, heard } = await opening(given, body.mode, accepted, body.memoryDays === undefined ? 0 : memoryDays, reachOut);
          const id = conversationId ?? randomUUID();
          const reading = body.mode === "reading" ? await readingOpening(id, body, open) : null;
          let first = reading?.open ?? open;
          if (!reading && (open.kind === "continue" || open.kind === "resume" || open.kind === "rejoin")) first = unaskedPrompt(id) ?? first;
          // The untold news this opening tells (stage 2b), marked told only once said: none if the opening became another.
          const told = reading ? reading.told : first === open ? heard ?? [] : [];
          // At Face ID every time (Privacy) a reply and a start go only with Send on the phone, whatever it sent.
          const confirm = confirmUnder(confirmFor(body, id), privacyOf(own));
          if (draft && first.kind === "reading") first = await dictatedOpening(id, draft, first, keepRepliesOf(body), confirm);
          // The news must be in place before the session's first words, so `created` runs as the session is made.
          const started = await startSession(body.sdp, id, first, memoryDays, accepted, voice, created, news, readingStyle, readingVoice, fastOf(body, fastAllowed()).conversations, phoneBuildOf(headed(req)), keepRepliesFor(body, id), confirm, wakeWordOf(body), body.newThreads === "talk", greetingOf(body), newThreadPromptFor(body, id), newThreadDefaultsFor(body, id), threadNamesOf(body), told);
          // What was read to the end counts as heard once there's a session to tell about it.
          reading?.heard();
          // The reply left unsent is kept here now: the phone drops its own copy.
          const kept = reading?.open.kind === "reading" ? reading.open.kept?.keptId : undefined;
          return kept ? { ...started, keptId: kept } : started;
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
        // A call-back the user asked for outlives their Stop when the phone can be rung (ring.ts): it rings instead; or
        // while the lock screen shows its board (board.ts), which the phone registered just before this stop.
        if (user) deps.waits.cancelAll(keepsThroughStop(deps.ringer, deps.boards));
        if (user) deps.store.dropHandoff();
        // With no live session, any other ending ends no proposals: a session that ended by itself kept what waits for
        // Face ID as it ended (`endsCall`), and one that rolled over or handed off carries its conversation on, a change
        // waiting for a yes with it. The phone names no conversation, and the last one to end may not be this call's.
        deps.proposals.cancelOpen(user ? "stopped by user" : "the call ended", user ? undefined : active?.conversationId ?? "");
        // `handoff`: the phone went from the call to a mode of its own (the call screen's Dictate), which the user was
        // there for, like the brain's own hand-off.
        const focus = () => active?.view.snapshot(null).agenda?.find((i) => i.status === "current")?.name ?? "the thread in focus";
        active?.session.close(user ? { kind: "user_stop" } : body.handoff === "dictating" ? { kind: "dictating", handle: focus() } : { kind: "phone_end" });
        if (user) dropUntold();
        return send(200, { ok: true });
      }
      // The phone asks for this when it opens and when a session starts, so the briefing is current by the time it's
      // needed. It answers once the refresh is done, or after REFRESH_WAIT_MS with the briefing as it stands.
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        // The user is looking: what changed is summarized now, and as it changes for a while (briefing.ts `looking`).
        deps.briefing.looking();
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
        // Ready only once it may reach the user: not before its not-before (stage 3.6). A watch longer than an hour that
        // has held an hour, or one over before its not-before, lets the holding phone go when its news can reach them
        // another way (Fable, topic 7; `Engine.letGo`): `hold` with `letGo`, how ("call" or "notify"), and `handle`, so
        // the phone ends its hold "Still watching API. 10 & 2 will call when there's news." (or, for "notify", "Still
        // watching API. You'll get a notification when there's news.", Fable's topic 7; an older phone reads a hold
        // with nothing to call back about, which its own limit ends); `none` to a phone that doesn't hold.
        const answerOf = (w: Wait, holds: boolean) => {
          // Its threads' computer gone offline while it watches (stage 3.7; Fable, topic 11): the holding phone takes it
          // as it takes a reply, and calls back with its opening; the wait goes on.
          const offline = !w.ready ? deps.engine?.offlineFor(w.conversationId) : null;
          if (offline) return { state: "ready", handle: offline.news.handle, outcome: "offline" };
          // A thread holding a command for the user (stage 4c): taken as a question is, and the wait goes on.
          const held = !w.ready ? deps.engine?.heldFor(w.conversationId) : null;
          if (held) return { state: "ready", handle: held.news.handle, outcome: "held" };
          const early = deps.waits.early(w);
          if (w.ready && !early) return { state: "ready", handle: w.handle, outcome: w.ready };
          if (deps.waits.heldAnHour(w) || early) {
            const letGo = deps.engine ? deps.engine.letGo(w) : deps.ringer?.canRing() ? "call" : null;
            if (letGo) return holds ? { state: "hold", handle: w.handle, letGo } : { state: "none" };
          }
          return { state: "waiting", handle: w.handle, outcome: null };
        };
        const id = url.searchParams.get("conversation") ?? "";
        const seconds = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 25);
        // Hung up for the phone to read a reply out, or to record one in the user's words: which, unless the
        // conversation's wait is newer. (Every new session drops the hand-off, so one that's left is from the session that
        // just hung up; a wait may be older, kept through an interruption.) The phone asks for its reading
        // (`/api/readings`), which is being made already. A ready wait's news is told when the phone comes back.
        // `handoff=1`, from a phone in the call: answers the moment this conversation hands off to the phone (`reading`,
        // `dictating`), so the phone closes the call and starts at once, rather than after the hang-up and another ask;
        // `none` after `wait`, and the phone asks again while the call is on (docs/launch/voice-speed.md).
        // `hold=1`: this phone holds as a mode (`hold`); an older one is told the call ended, as it was before.
        const holds = url.searchParams.get("hold") === "1";
        if (url.searchParams.get("handoff") === "1") {
          const handedOff = () => {
            const h = deps.store.handoff(id);
            if (h && "hold" in h) return holds ? { state: "hold" } : null;
            if (h && "dictate" in h) return { state: "dictating", handle: h.handle, itemId: h.dictate.itemId };
            if (h && "reply" in h) return { state: "reading", handle: h.handle, reply: h.reply };
            return null;
          };
          const now = handedOff();
          if (now || !seconds) return send(200, now ?? { state: "none" });
          let stop = () => {};
          const told = await new Promise<object | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), seconds * 1000);
            const off = deps.store.onHandoff((c) => {
              const answer = c === id ? handedOff() : null;
              if (answer) resolve(answer);
            });
            req.signal?.addEventListener("abort", () => resolve(null), { once: true });
            stop = () => (clearTimeout(timer), off());
          });
          stop();
          return send(200, told ?? { state: "none" });
        }
        // `onhold=1`: the phone is on hold (confirmed). Whatever it was handed (a reading, a dictation) is over, and the
        // hold lasts while it asks. Without a hand-off the brain has let go (a Stop, a new call): the answer says so.
        if (holds && url.searchParams.get("onhold") === "1") deps.store.keepHold(id);
        // While it asks, this phone is holding: the brain doesn't ring it (ring.ts).
        const asked = deps.ringer?.holding(id);
        try {
          const handoff = deps.store.handoffAt(id);
          if (handoff && handoff.at >= (deps.waits.get(id)?.startedAt ?? 0)) {
            const h = handoff.handoff;
            // Only a phone that asks (`rollover=1`) knows "continue"; an older one hears the call ended, as it did before.
            if ("rollover" in h) return send(200, url.searchParams.get("rollover") === "1" ? { state: "continue" } : { state: "none" });
            // On hold: a wait (a call-back armed, whenever it began) says what's watched, and ends the long poll when it's
            // ready; without one, the hold goes on.
            if ("hold" in h) {
              const w = deps.waits.get(id) ? await deps.waits.until(id, seconds * 1000) : await deps.waits.started(id, seconds * 1000);
              return send(200, w ? answerOf(w, holds) : { state: holds ? "hold" : "none" });
            }
            return send(200, "dictate" in h ? { state: "dictating", handle: h.handle, itemId: h.dictate.itemId } : { state: "reading", handle: h.handle, reply: h.reply });
          }
          const w = await deps.waits.until(id, seconds * 1000);
          return send(200, w ? answerOf(w, holds) : { state: "none" });
        } finally {
          asked?.();
        }
      }
      // The phone that rings when a wait it isn't holding for is over (ring.ts): its VoIP push token, and whether it's
      // a development build's (Apple's sandbox) or TestFlight's and the App Store's. DELETE: signed out, or ringing off.
      // From stage 2a (docs/launch/engine.md §11, item 6) one record per account from one install: its VoIP token, its
      // alert token and whether Notifications are on (which makes following's rule), its zone and CarPlay audio. An
      // older phone sends only its VoIP token, and no install.
      if (url.pathname === "/api/phone" && deps.ringer) {
        const body = await readJson(req);
        const token = typeof body.token === "string" && /^[0-9a-f]{64,200}$/i.test(body.token) ? body.token : null;
        const install = typeof body.install === "string" && /^[\w-]{8,64}$/.test(body.install) ? body.install : null;
        if (req.method === "POST") {
          const input = phoneInputOf(body, install, token);
          if (typeof input === "string") return send(400, { error: input });
          deps.ringer.registerPhone(input);
          // `notifications`: whether following's rule is on; an older phone (no install) gets today's answer.
          return send(200, { ok: true, rings: deps.ringer.canRing(), ...(install ? { notifications: !!deps.engine?.following() } : {}) });
        }
        if (req.method === "DELETE") {
          // A token of one kind, forgotten only if the install matches, and the token too when one is named (a phone
          // relaunched before iOS gave its token again names none: this install's own); else (an older phone) as before.
          if (install && (body.kind === "voip" || body.kind === "alert")) {
            const which = body.token === undefined ? null : body.kind === "voip" ? token : alertTokenOf(body.token);
            if (body.token === undefined || which) deps.ringer.forgetToken(install, body.kind, which);
          } else deps.ringer.forget(token ?? undefined);
          return send(200, { ok: true });
        }
      }
      // Settings → Calls → Call me back → Test call (stage 5, Fable's topic 8): calls the registered phone once, in
      // `seconds`, or says why not (ring.ts `test`).
      if (req.method === "POST" && url.pathname === "/api/phone/test" && deps.ringer) {
        const result = deps.ringer.test();
        return send(200, result === "ringing" ? { ok: true, result, seconds: TEST_RING_IN_MS / 1000 } : { ok: true, result });
      }
      // Watching (docs/launch/engine.md §2; stage 2a item 9): each call-back still watching, as a sentence and the time
      // left, and Stop, which also drops what it queued and hasn't sent.
      // Stage 5 (Fable's topics 3, 5 and 6): `form`, the sheet for a new watch on a thread, its name the phone's.
      if (req.method === "GET" && url.pathname === "/api/rules") return send(200, { rules: deps.engine?.watching() ?? [], ...(deps.engine ? { form: deps.engine.newForm() } : {}) });
      // A watch made by hand, by Siri, or the call's card's OK (stage 5): `setRule`.
      if (req.method === "POST" && url.pathname === "/api/rules") return setRule(await readJson(req));
      const ruleOne = req.method === "DELETE" && url.pathname.match(/^\/api\/rules\/([\w-]{1,120})$/);
      if (ruleOne) {
        if (!deps.engine?.stop(ruleOne[1])) return send(404, { error: SHEET.gone });
        return send(200, { ok: true });
      }
      // The sheet's OK on a watch that's set (stage 5; Fable's topics 3 and 5): Watching's Change, the hold's card.
      const ruleChange = req.method === "PUT" && url.pathname.match(/^\/api\/rules\/([\w-]{1,120})$/);
      if (ruleChange) {
        const choices = choicesOf(await readJson(req));
        if (typeof choices === "string") return send(400, { error: choices });
        const live = choices.when === "tests" ? await deps.adapter.list().catch(() => []) : undefined;
        const r = deps.engine?.change(ruleChange[1], choices, live) ?? { status: 404 as const, line: SHEET.gone };
        return "row" in r ? send(200, { ok: true, rule: r.row }) : send(r.status, { error: r.line });
      }
      // The board (board.ts; stage 5, Fable's topic 9): the Live Activity the phone is leaving on the lock screen as a
      // call on hold ends, its push token and Apple's service for it, and whether the car's audio is on (then there's no
      // board: never something to read while driving). Sent before the call's stop, so a wait the user asked for
      // outlives their End (`keepsThroughStop`). `board`: it's kept current (this brain can push and something is
      // watched), with `state`, which the phone shows at once; otherwise the phone ends its activity. DELETE: the phone
      // took it back (Hide, a call or a reading, gone from the lock screen); nothing watched is stopped by it.
      // A brain with no push key (Lattice, a demo world) keeps none.
      if (url.pathname === "/api/activity") {
        const body = await readJson(req);
        const token = typeof body.token === "string" && /^[0-9a-f]{64,400}$/i.test(body.token) ? body.token : null;
        if (req.method === "POST") {
          if (!token || (body.env !== "sandbox" && body.env !== "production")) return send(400, { error: "an activity push token and its environment (sandbox or production)" });
          const state = (await deps.boards?.register(token, body.env, body.car === true || body.car === "true")) ?? null;
          return send(200, state ? { ok: true, board: true, state } : { ok: true, board: false });
        }
        if (req.method === "DELETE") {
          deps.boards?.forget(token ?? undefined);
          return send(200, { ok: true });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/wait/cancel") {
        stops++;
        deps.waits.cancelAll(keepsThroughStop(deps.ringer, deps.boards));
        deps.store.dropHandoff();
        dropUntold();
        return send(200, { ok: true });
      }
      // The phone's thread picker: every open top-level thread, newest first, with what the briefing knows and the star.
      if (req.method === "GET" && url.pathname === "/api/threads") {
        look();
        return send(200, { threads: threadRows() });
      }
      // Commands that wait (docs/launch/engine.md §11 stage 4; Fable's 4-H2): Let it run (after Face ID or with the phone
      // unlocked, as Privacy's Commands that wait says, checked on the phone) or Stop it, for that hold only. On every
      // level: the hold is the computer's. Never a follow-up: only this lets it run.
      if (req.method === "POST" && url.pathname === "/api/held") {
        const body = await readJson(req);
        const thread = typeof body.id === "string" ? namedItems(deps.briefing).find((n) => n.id === body.id) : undefined;
        if (!thread) return send(404, { error: "no such open thread" });
        if (typeof body.hold !== "string" || !body.hold || body.hold.length > 200 || typeof body.letRun !== "boolean") return send(400, { error: "hold and letRun are required" });
        const how = body.how === "faceid" || body.how === "unlocked" ? body.how : undefined;
        if (body.letRun && !how) return send(400, { error: "how is required to let it run: faceid or unlocked" });
        if (!deps.adapter.answerHold) return send(409, { error: HELD_NO_LONGER, line: HELD_NO_LONGER });
        const undo = deps.engine?.answeringHold(thread.item, body.hold, body.letRun, how) ?? (() => {});
        const r = await deps.adapter.answerHold(thread.id, body.hold, body.letRun).catch((e): Receipt => ({ ok: false, unknown: true, error: describe(e) }));
        if (r === "unsupported" || (!r.ok && !r.unknown)) {
          undo();
          const error = r === "unsupported" || r.error === HELD_NO_LONGER || /^No longer waiting/.test(r.error) ? HELD_NO_LONGER : r.error;
          return send(409, { error, line: error });
        }
        deps.log(`held ${thread.id}: ${body.letRun ? "let run" : "stopped"} from the phone${r.ok ? "" : " (may not have arrived)"}`);
        // Its end is seen at once, so the line in its notification's place says how it ended.
        deps.engine?.changed();
        if (!r.ok) return send(502, { error: r.error, line: r.error });
        return send(200, { ok: true, line: body.letRun ? LET_RUN : toldNo(thread.handle) });
      }
      if (req.method === "POST" && url.pathname === "/api/star") {
        const body = await readJson(req);
        const thread = typeof body.id === "string" ? namedItems(deps.briefing).find((n) => n.id === body.id) : undefined;
        if (!thread) return send(404, { error: "no such open thread" });
        const on = body.starred !== false && body.starred !== "false";
        // Undo of a follow puts back the setting the follow replaced, as the phone had it (docs/launch/engine.md §11, 3.1):
        // only unfollowing.
        if (body.notify !== undefined && (on || !isNotify(body.notify))) return send(400, { error: "notify is for unfollowing: rules, both, questions or nothing" });
        // Only a change is a tap for the timeline: starring a starred thread again isn't.
        if (deps.store.stars().has(thread.id) !== on) {
          const p = deps.proposals.noted(on ? "follow" : "unfollow", { itemId: thread.id, handle: thread.handle, group: thread.group });
          if (deps.analytics) trackChange(deps.analytics.track, p, "tap");
        }
        setStar(deps, thread.item, on, body.notify);
        // Only `ok`, as before 3.1: the phones of stage 2a and main decode the answer as `[String: Bool]`, so a string
        // in it would fail them on a follow that went through. The thread's setting after it is `GET /api/threads`'.
        return send(200, { ok: true });
      }
      // A thread's own notifications, set by hand (its page, Settings → Notifications): never its star.
      const notifyOne = url.pathname.match(/^\/api\/threads\/([^/]{1,300})\/notify$/);
      if (notifyOne && req.method === "PUT") {
        const body = await readJson(req);
        let id: string;
        try {
          id = decodeURIComponent(notifyOne[1]);
        } catch {
          return send(404, { error: "no such open thread" });
        }
        const thread = namedItems(deps.briefing).find((n) => n.id === id);
        if (!thread) return send(404, { error: "no such open thread" });
        if (!isNotify(body.notify)) return send(400, { error: "notify must be rules, both, questions or nothing" });
        setNotify(deps, thread.item, body.notify);
        return send(200, { ok: true, notify: body.notify });
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
        // A thread's drafts, sent as one message.
        if (body.parts !== undefined) return sendParts(body);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return send(400, { error: "Write a reply first." });
        if (text.length > DRAFT_MAX) return send(400, { error: "That reply is too long to send in one go." });
        // Always a request id: a reply sent twice (a retry, a double tap) must go out once.
        if (body.requestId === undefined) return send(400, { error: "requestId is required" });
        // A dictated draft's new thread ("new:…", drafts.ts): started with this as its first prompt.
        if (typeof body.id === "string" && isNewThread(body.id)) return tappedStart(body, body.id, text);
        // A tap on one of a question's own options (a notification's button, `via: lock_screen`): that question's only.
        const questionId = typeof body.questionId === "string" && body.questionId.length > 0 && body.questionId.length <= 200 ? body.questionId : undefined;
        // A quick reply or Reply…'s words on a reply's notification (Fable's 4-K): after that reply (its reach-out) only.
        const afterReply = typeof body.afterReply === "string" && body.afterReply.length > 0 && body.afterReply.length <= 300 ? body.afterReply : undefined;
        if (body.afterReply !== undefined && (!afterReply || questionId)) return send(400, { error: "afterReply must be a reply notification's reachOut, without questionId" });
        return tapped(body, "follow_up", { message: tappedReply(text, typeof body.quote === "string" ? body.quote : null), ...(questionId ? { questionId } : {}), ...(afterReply ? { afterReply } : {}) });
      }
      // Replies kept for later in calls (the phone's Drafts): listed, edited before sending, discarded, or all sent.
      if (req.method === "GET" && url.pathname === "/api/kept") return send(200, { kept: keptRows() });
      // What the account has done with the app in the last 30 days: the paywall's header (the look, 12 November).
      if (req.method === "GET" && url.pathname === "/api/usage") return send(200, { days: USAGE_DAYS, ...deps.store.usage(Date.now() - USAGE_DAYS * 86_400_000) });
      // Where a new thread can start (Drafts' picker for a prompt with no project yet), most recently active first.
      if (req.method === "GET" && url.pathname === "/api/places") {
        const places = (deps.adapter.actions.includes("start_work") ? spokenPlaces(deps.adapter.places?.() ?? []) : [])
          .filter((p) => (deps.adapter.actionsFor?.(p.id) ?? deps.adapter.actions).includes("start_work"))
          .sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""));
        // Each with its project, machine and coding app, for Settings → New threads' lists; and every coding model they
        // offer, once per name and provider, under its heading, for its Coding model (a name and provider: each place's
        // own list is matched when a thread starts, thread-models.ts).
        return send(200, { places: places.map((p) => ({ id: p.id, name: p.name, activeAt: p.activeAt, ...placeParts(p) })), codingModels: codingModels(places) });
      }
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
        look();
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
        // Where the phone is (stage 2b): car, locked, ear or screen; anything else (`unknown`: headphones, the ear not
        // told from the screen) not known from now on. None given (an older phone): as it was.
        const at = url.searchParams.get("at");
        if (at !== null) phoneAt = isAt(at) ? at : null;
        const state = !starting && active ? active.session.liveState() : undefined;
        return send(200, view.snapshot(url.searchParams.get("since"), state));
      }
      // The change waiting for the user's yes in the live call, answered with a tap: Send (confirm) or Don't (cancel).
      const answered = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/([\w-]{1,64})\/(confirm|cancel)$/);
      if (answered) return tappedAnswer(await readJson(req), answered[1], answered[2] as "confirm" | "cancel");
      // Face ID asked on the phone's screen for the change waiting in the live call didn't see the user (stage 2b).
      const unseen = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/([\w-]{1,64})\/unseen$/);
      if (unseen) return unseenAnswer(unseen[1]);
      // "Approve to send", answered from its notification (stage 2b): Approve or Don't send.
      const approval = req.method === "POST" && url.pathname.match(/^\/api\/approvals\/([\w-]{1,64})$/);
      if (approval) return approvalAnswer(await readJson(req), approval[1]);
      // The account, on a brain without accounts (Lattice): no meter, so no credits. The cloud answers this itself.
      if (req.method === "GET" && url.pathname === "/api/account") {
        const machines = deps.adapter.connectionStatus?.() ?? [{ name: deps.adapter.name, connected: deps.adapter.connected() }];
        // `engine`: this brain runs the engine (every account, since stage 3.3's levels), so the phone shows Notifications,
        // Privacy's rows and Watching; `callMeBack`, whether it can ring the phone (Lattice has no push key) and the day's.
        // `answerFromNotification`: the level answers from a notification (Fable's 4-K: Settings → Notifications → Quick
        // replies is greyed without it).
        return send(200, { userId: "lattice", mode: "lattice", credits: null, allowance: null, machines, staleAfterDays: staleAfterDays(own), privacy: privacyOf(own), followNew: followNewOf(own).choice, engine: !!deps.engine, ...(deps.engine ? { callMeBack: deps.engine.callMeBack(), answerFromNotification: deps.engine.limits().answerFromNotification, ...deps.engine.accountRules() } : {}), board: !!deps.boards?.shows(), rev: brainRev });
      }
      // Local cues during a call use this read-only path, with no GPT-Live events or classification work.
      if (req.method === "GET" && url.pathname === "/api/updates") {
        // `done`: changes carried out in the last 30 s, so the phone plays its tone once for each, and only for those.
        return send(200, { ...(await updates.snapshot()), done: deps.proposals.recentlyDone() });
      }
      // The replies new to the user: each thread's latest, until it's read out in full or opened in T3.
      if (req.method === "GET" && url.pathname === "/api/inbox") {
        look();
        void syncVisits(deps);
        return send(200, { replies: await newReplies(deps) });
      }
      // A thread's replies, newest first, to pick an earlier one to hear (and any linked documents on the latest reply).
      if (req.method === "GET" && url.pathname === "/api/replies") {
        const thread = namedItems(deps.briefing).find((n) => n.id === url.searchParams.get("id"));
        if (!thread) return send(404, { error: "no such open thread" });
        // Its replies that are news as the list is asked for: one coming while it's fetched isn't in what's shown.
        const news = deps.engine?.untoldReplies(thread.id) ?? [];
        const [replies, rep] = await Promise.all([pastReplies(deps, thread.id), deps.adapter.report(thread.id).catch(() => null)]);
        // The app opened on the thread: the replies it shows were seen (a followed reply leaves following's batch).
        deps.engine?.opened(thread.id, news, replies[0]?.finishedAt ?? null);
        return send(200, { replies, ...(rep?.docs?.length ? { docs: rep.docs } : {}) });
      }
      if (req.method === "GET" && url.pathname === "/api/voices") {
        const settings = current();
        // The voices the account's engine has: the replacement lacks fable, nova and onyx (it reads them in marin), so
        // they aren't offered; a phone that saved one keeps it, and hears marin.
        const reading = settings.readingEngine === REALTIME_READER ? REALTIME_READING_VOICES : READING_VOICES;
        return send(200, { conversation: CONVERSATION_VOICES, reading, conversationDefault: settings.voice, readingDefault: "marin", sample: settings.sampleText });
      }
      // A reading voice saying the same few words as every other (Ops' `sampleText`), to hear it before choosing it.
      // Free (contracts §4).
      if (req.method === "GET" && url.pathname === "/api/voices/sample") {
        const voice = url.searchParams.get("voice") ?? "";
        if (!(READING_VOICES as readonly string[]).includes(voice)) return send(400, { error: "unknown voice" });
        const samples = deps.samples ?? deps.speech;
        if (!samples) return send(503, { error: "speech isn't set up on this brain" });
        let off = false;
        const audio = await samples.audio(current().sampleText, voice).catch((e) => ((off = isReadingOff(e)) || deps.log(`voice sample: ${describe(e)}`), null));
        // Switched off (settings `readingEngine`): nothing is made, and the phone says why.
        if (off) return send(503, { error: READING_OFF });
        if (!audio) return send(502, { error: "Couldn't play that voice. Try again." });
        return new Response(new Uint8Array(audio), { status: 200, headers: { "content-type": "audio/aac", "content-length": String(audio.length), "cache-control": "private, max-age=86400" } });
      }
      // Replies to read out in full: the given threads' latest, or every reply new to the user, as spoken segments.
      // With `announce` (several read in a row: "Read new replies"), each starts with whose reply it is.
      if (req.method === "POST" && url.pathname === "/api/readings") {
        const body = await readJson(req);
        const ids = typeof body.ids === "string" && body.ids.trim() ? body.ids.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
        const style = styleOf(body, body.style, fastAllowed());
        // A briefing (stage 4; Fable's 4-I): one made ahead (a notification's Hear it, fetched `ahead` in the background
        // too), one a call made to read in full, or the latest (Hear my briefing), one reading per thread.
        if (typeof body.messageId === "string" && ids?.length === 1 && ids[0] === BRIEFING_ITEM) {
          const ahead = body.ahead === true || body.ahead === "true";
          const readings = await briefingReadings(deps, body.messageId, { ahead, skipCode: style.skipCode, fast: style.fast });
          return readings ? send(200, { readings }) : send(404, { error: "That briefing isn't kept any more." });
        }
        // One thread's linked document, asked for directly by `docId`.
        if (typeof body.docId === "string" && ids?.length === 1) {
          if (!namedItems(deps.briefing).some((n) => n.id === ids[0])) return send(404, { error: "no such open thread" });
          const reading = await prepareDocument(deps, ids[0], body.docId, style);
          return reading ? send(200, { readings: [reading] }) : send(404, { error: "no such document" });
        }
        // One thread's particular reply (or a `doc:<docId>` handoff from `read_aloud`).
        if (typeof body.messageId === "string" && ids?.length === 1) {
          if (!namedItems(deps.briefing).some((n) => n.id === ids[0])) return send(404, { error: "no such open thread" });
          const reading = await prepareReply(deps, ids[0], body.messageId, style);
          if (!reading) return send(404, { error: docIdOf(body.messageId) ? "no such document" : "no such reply" });
          const list = [reading];
          if (style.documents === "after" && !docIdOf(body.messageId)) {
            const primary = reading.docs?.find((d) => d.offer === "primary");
            if (primary) {
              const docReading = await prepareDocument(deps, ids[0], primary.id, style);
              if (docReading) list.push(docReading);
            }
          }
          return send(200, { readings: list });
        }
        const announce = body.announce === true || body.announce === "true";
        const prepared = await prepare(deps, ids, announce ? { ...style, announce } : style);
        if (style.documents !== "after") return send(200, { readings: prepared });
        const withDocs = [];
        for (const r of prepared) {
          withDocs.push(r);
          const primary = r.docs?.find((d) => d.offer === "primary");
          if (primary) {
            const docReading = await prepareDocument(deps, r.itemId, primary.id, style);
            if (docReading) withDocs.push(docReading);
          }
        }
        return send(200, { readings: withDocs });
      }
      // The user's own words to read back in the reading voice (a dictated reply, before it's sent): kept as a reading,
      // one segment per part the phone plays, so its audio is any reading's (below), metered and kept the same way.
      // The same words make the same reading, so hearing them again costs nothing.
      if (req.method === "POST" && url.pathname === "/api/readings/text") {
        const body = await readJson(req);
        const parts: unknown = body.segments;
        if (!Array.isArray(parts) || !parts.length || parts.length > 200 || !parts.every((p) => typeof p === "string" && p.trim() && p.length <= 2000)
          || (parts as string[]).join("").length > DRAFT_MAX) {
          return send(400, { error: "segments: 1–200 non-empty strings, within a reply's length" });
        }
        const segments = (parts as string[]).map((text, paragraph) => ({ text: text.trim(), paragraph }));
        const id = createHash("sha256").update(JSON.stringify(["text", segments])).digest("hex").slice(0, 24);
        deps.store.putReading(id, "", "", JSON.stringify({ text: true }), segments);
        return send(200, { reading: { id, segments } });
      }
      // The briefing, on demand: an intro, then a part for each thread a call would cover, as a reading whose segments
      // carry their thread's id; the same cards give the same reading. Its audio is any reading's (below).
      if (req.method === "POST" && url.pathname === "/api/briefing") {
        look();
        const body = await readJson(req);
        const hour = Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : undefined;
        return send(200, await prepareBriefing(deps, { fast: fastOf(body, fastAllowed()).readings, skipCode: body.skipCode !== false && body.skipCode !== "false", hour }));
      }
      const segmentAudio = req.method === "GET" && url.pathname.match(/^\/api\/readings\/([0-9a-f]{24})\/(\d{1,4})$/);
      if (segmentAudio) {
        const text = deps.store.readingSegments(segmentAudio[1])?.[Number(segmentAudio[2])]?.text;
        if (text === undefined) return send(404, { error: "no such reading or segment" });
        const voice = url.searchParams.get("voice") ?? "marin";
        if (!(READING_VOICES as readonly string[]).includes(voice)) return send(400, { error: "unknown voice" });
        if (!deps.speech) return send(503, { error: "speech isn't set up on this brain" });
        let outOfCredits: string | null = null;
        let off = false;
        const audio = await deps.speech.audio(text, voice).catch((e) => {
          // The cloud's meter refuses to make audio the account can't pay for (contracts §4); kept audio still plays.
          if ((e as { code?: unknown }).code === "out_of_credits") outOfCredits = (e as Error).message;
          else if (isReadingOff(e)) off = true;
          else deps.log(`speech: ${describe(e)}`);
          return null;
        });
        if (outOfCredits) return send(402, { error: outOfCredits, code: "out_of_credits" });
        // The reading voice is switched off (settings `readingEngine`): nothing is made; the phone reads it in its own.
        if (off) return send(503, { error: READING_OFF });
        if (!audio) return send(502, { error: "The reading voice failed; try again or use the phone's voice" });
        // The minutes making it used, once (made ahead, or for this request), so a call's playback can count them.
        const used = deps.speech.charge(text, voice);
        return new Response(new Uint8Array(audio), {
          status: 200,
          headers: { "content-type": "audio/aac", "content-length": String(audio.length), "cache-control": "private, no-store", ...(used ? { "x-driver-used-seconds": String(used) } : {}) },
        });
      }
      // The reader played `messageId` (the thread's latest reply) to the end.
      if (req.method === "POST" && url.pathname === "/api/read") {
        const body = await readJson(req);
        if (typeof body.id !== "string" || typeof body.messageId !== "string") return send(400, { error: "id and messageId required" });
        // A thread's part of the briefing (`messageId` the briefing's id): its summary is heard, nothing is read.
        if (body.briefing === true) {
          const r = briefingHeard(deps.store, body.id, body.messageId);
          return send("error" in r ? 404 : 200, r);
        }
        // Finishing a linked document never marks the thread's reply read.
        if (docIdOf(body.messageId)) return send(200, { ok: true, skipped: true });
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
      // The minutes a call used, as the phone showed them when it ended: the Timeline shows the same number.
      const used = req.method === "PUT" && url.pathname.match(/^\/api\/conversations\/([\w-]{1,64})\/used$/);
      if (used) {
        const body = await readJson(req);
        if (typeof body.call !== "string" || !/^[\w-]{1,64}$/.test(body.call) || !Number.isInteger(body.seconds) || body.seconds < 0 || body.seconds > 86_400) {
          return send(400, { error: "call (an id) and seconds (0 to 86,400) required" });
        }
        if (!deps.store.conversation(used[1])) return send(404, { error: "no such conversation" });
        deps.store.setCallUsed(used[1], body.call, body.seconds);
        return send(200, { usedSeconds: deps.store.usedSeconds().get(used[1]) ?? 0 });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        look();
        const view = deps.briefing.view(await deps.adapter.list().catch(() => undefined));
        return send(200, {
          updatedAt: view.updatedAt,
          readFailures: view.readFailures,
          opener: view.opener,
          cards: view.cards.map(({ itemId, handle, title, group, state, summary, ask, answers, suggested, status, unread, unheard }) => ({ itemId, handle, title, group, state, summary, ask, answers: answers ?? [], suggested, status, unread, unheard })),
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
    // Another world's call is starting, or this one is closing (a mode switched, the world closed): a session still
    // being made here counts as stopped too (`stops`), so it's hung up as soon as it exists, never a second live call.
    closeActive: () => {
      stops++;
      active?.session.close({ kind: "replaced" });
    },
    // A watch made by hand opens a conversation of its own (`watch-…`) with nothing said in it yet: answering its call
    // carries on this world too (a demo's, stage 5), not a fresh one.
    knows: (id) => deps.store.conversation(id) !== null || deps.waits.get(id) !== null,
    heartbeat: () => (active ? { sessionId: active.id, ...active.session.stats() } : null),
    closeSession: (id) => {
      if (active?.id !== id) return "not_current";
      active.session.close({ kind: "ended_by_staff" });
      return "ended";
    },
    close: async () => {
      stops++;
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
 * any after a reset) gets a fresh world: every demo starts from the same workspace, and an old one's runs stop. While
 * the current one has a watch open or a call to make (`awaited`), a fresh Start joins it instead, as a new conversation
 * there, so the watch isn't thrown away (the second review of stage 5: make a watch, then try a call).
 */
/** A world with a watch open, or a call still to make (stage 5): starting a demo afresh would throw them away. */
export const awaited = (d: Pick<ServerDeps, "waits" | "ringer">) =>
  d.waits.all().some((w) => !w.ready || d.waits.early(w)) || (d.ringer?.due() ?? null) !== null;

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
      world = { api: api(cfg, made, deps.store), deps: made };
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
      // The user's vocabulary (vocabulary.ts): theirs whether or not the phone is in demo mode, so always the real store.
      if (req.method === "GET" && url.pathname === "/api/vocabulary") return send(200, { words: merge(ownOf(deps.store)) });
      if (req.method === "PUT" && url.pathname === "/api/vocabulary") {
        const own = parseOwn(await readJson(req));
        if (typeof own === "string") return send(400, { error: own });
        deps.store.set(VOCABULARY_KEY, JSON.stringify(own));
        return send(200, { words: merge(own) });
      }
      // How long a question may wait on the user before its thread is stale (briefing.ts `aged`): the user's own setting,
      // demo mode or not, so always the real store. It shows at once in what the briefing gives.
      if (req.method === "PUT" && url.pathname === "/api/account/stale-after") {
        const days = staleAfterOf(await readJson(req).catch(() => null));
        if (days === undefined) return send(400, { error: "days must be 3, 7, 14, 30 or null" });
        setStaleAfterDays(deps.store, days);
        return send(200, { ok: true, staleAfterDays: days });
      }
      // Settings → Privacy (docs/launch/engine.md §2): thread names on the lock screen, and how 10 & 2 checks it's you
      // before sending. The account's own, demo mode or not, so always the real store.
      if (req.method === "PUT" && url.pathname === "/api/account/privacy") {
        const p = privacyFrom(await readJson(req).catch(() => null), privacyOf(deps.store));
        if (!p) return send(400, { error: "names must be true or false, and security none, unlocked or faceid" });
        setPrivacy(deps.store, p);
        // A board on the lock screen follows it from its next push (names hidden or shown, the buttons' level).
        void deps.boards?.update();
        return send(200, { ok: true, privacy: p });
      }
      // Your rules, Quiet for a while and the Focus filter (docs/launch/engine.md §11, 3.4): the account's own, demo
      // mode or not, so always the real engine.
      const ruled = await rulesRoute(deps.engine, req, url.pathname, () => readJson(req));
      if (ruled) return send(ruled.status, ruled.body);
      // Settings → Notifications → Follow new threads (docs/launch/engine.md §11, 3.1): which new threads are followed.
      // The account's own, demo mode or not, so always the real store.
      if (req.method === "PUT" && url.pathname === "/api/account/follow-new") {
        const choice = followNewFrom(await readJson(req).catch(() => null));
        if (!choice) return send(400, { error: "choice must be never, started or every" });
        setFollowNew(deps.store, choice, Date.now());
        return send(200, { ok: true, followNew: choice });
      }

      const starting = req.method === "POST" && url.pathname === "/api/session";
      if (!demo || cfg.demo === "off" || !wantsDemo(cfg, h)) {
        if (starting) world?.api.closeActive();
        return await real.handle(req, url);
      }
      if (!starting) return await (await demoWorld(false)).handle(req, url);
      const body = await readJson(req);
      // Not a fresh demo either (Apple's reviewer is always in one): the test call opens no call.
      if (body.conversationId === TEST_RING.conversationId) return send(409, { error: TEST_CALL_ANSWERED });
      const given = typeof body.conversationId === "string" && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
      const carriesOn = !!given && !!world?.api.knows(given);
      if (!carriesOn) {
        // A new conversation: whatever one the phone kept is another world's (or an older demo's).
        delete body.conversationId;
        if (body.mode !== "reading") body.mode = "new";
      }
      // A fresh demo, unless this one has a watch open or a call to make: then a new conversation in it.
      const target = await demoWorld(!carriesOn && !(world && awaited(world.deps)));
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
