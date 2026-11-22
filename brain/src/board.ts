// The board (docs/launch/engine.md §2, §6, §11 stage 5 piece 4; Fable's decisions for stage 5, topics 9 and 10; from
// spike/watch-board): ending a call on hold while something is watched leaves the call's Live Activity on the lock screen
// as a board of each thread watched (working since 9:00, replied, asks something), kept current by the brain through Live
// Activity pushes with the app closed and the microphone off. Pure `boardOf` makes it from the waits and the threads;
// `Boards` keeps the phone's activity, sends the board when it changes (at most once a minute, at once for a reply or a
// question), and ends it when nothing is watched.
//
// What it shows follows Privacy, read at each push: with Show thread names off it only counts ("Watching 3 · 1 wants
// you", rows "Question 13:49"); on, each row is its thread, and a thread that asks something is named first ("API asks")
// with a tap opening it. Never what a thread said, nor the question it asks or its options (the review of stage 5: a
// locked phone shows a Live Activity whole, where a notification hides its preview until unlock), until Jordan says
// otherwise (docs/launch/engine.md §12). Every word on it is built here; the phone composes none.
import type { Adapter, WorkItem } from "./adapter.ts";
import type { Track } from "./analytics.ts";
import { PRIVACY_DEFAULT, type Privacy } from "./privacy.ts";
import type { Store } from "./store.ts";
import { describe, realClock, type Clock, type Timer } from "./util.ts";
import { START_GRACE_MS, type Wait, type Watched, type Waits } from "./waits.ts";

/** What a thread is doing, most urgent first: the order rows are shown in. */
export const WORDS = ["asks", "replied", "working", "idle", "offline"] as const;
export type Word = (typeof WORDS)[number];
/**
 * One thread on the board: its name (only with names shown), what it's doing, and since when (Unix seconds; working:
 * since it was asked; a reply or a question: since it came). The phone counts the minutes itself, so passing time needs
 * no push.
 */
export type Row = { name?: string; word: Word; since: number };
/**
 * The Live Activity's state as the iPhone decodes it (ios/Shared/DriverActivity.swift `ContentState`): `status` is the
 * headline; `open`, the thread a tap on the board opens when it's about one, or the one that asks (else Watching). The
 * phone also reads a `question` with its options, which the brain never sends (§12: the question's words stay off a lock
 * screen).
 */
export type BoardState = { status: string; live: false; board: Row[]; open?: string };

export const MAX_ROWS = 8;
/** A name's most characters (as the eye counts them) and bytes, so 8 rows stay far inside Apple's 4 KB. */
export const NAME_MAX = 32;
export const NAME_BYTES = 96;
/** At most one routine update this often; a reply or a question goes at once. */
export const BOARD_EVERY_MS = 60_000;
/** An unchanged board is sent again this often, so its stale date moves on while the brain is keeping it current. */
export const BOARD_REFRESH_MS = 10 * 60_000;
/** The lock screen marks the board as maybe out of date if nothing comes in this long (two refreshes missed, nearly). */
export const BOARD_STALE_MS = 15 * 60_000;
/** Nothing left to watch, with news on it not yet heard: it stays this long, or until 10 & 2 is opened (Fable, topic 9). */
export const BOARD_NEWS_STAYS_MS = 4 * 3_600_000;

// After a thread's name, one wording each: the headline about one thread ("API is idle") and the row ("idle").
const SAID: Record<Word, string> = { asks: "asks something", replied: "replied", working: "is working", idle: "is idle", offline: "is offline" };

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Cut between characters as the eye sees them (never inside an emoji), with "…", to `max` characters and `most` bytes. */
function cut(text: string, max = NAME_MAX, most = NAME_BYTES): string {
  const t = text.trim().replace(/\s+/g, " ");
  const chars = [...graphemes.segment(t)].map((g) => g.segment);
  if (chars.length <= max && bytes(t) <= most) return t;
  let out = "";
  for (const c of chars.slice(0, max - 1)) {
    if (bytes(`${out}${c}…`) > most) break;
    out += c;
  }
  return `${out.trimEnd()}…`;
}
const seconds = (ms: number) => Math.floor(ms / 1000);

/** A row, its thread, and what makes it news (a reply or a question, told apart from any earlier one), if it is. */
type Ranked = { row: Row & { name: string }; itemId: string; news: string | null };

function rowOf(w: Wait, it: Watched, item: WorkItem | undefined, offline: boolean, now: number): Ranked {
  const asked = it.startedAt ?? w.startedAt;
  const row = (word: Word, from = asked, news: string | null = null): Ranked => ({
    row: { name: it.handle, word, since: seconds(from) }, itemId: it.itemId, news,
  });
  if (!item || offline) return row("offline");
  const changed = Date.parse(item.updatedAt) || now;
  if (item.pendingQuestion && !(it.heardQuestion != null && it.heardQuestion === item.questionId)) return row("asks", changed, `${it.itemId}:asks:${item.questionId ?? ""}`);
  if (item.status === "running") return row("working");
  if (it.sawRunning || (item.lastRunAt != null && Date.parse(item.lastRunAt) > it.since)) {
    return row("replied", item.lastRunAt ? Date.parse(item.lastRunAt) : changed, `${it.itemId}:replied:${item.lastRunAt ?? ""}`);
  }
  // A follow-up just sent may take a moment to show as running (waits.ts `START_GRACE_MS`).
  return row(it.patient || now - asked < START_GRACE_MS ? "working" : "idle");
}

/** Every thread watched for the user (not starred threads at a goodbye, nor ones merged into a wait without asking). */
function ranked(waits: Wait[], items: WorkItem[], now: number, offline: (itemId: string) => boolean): Ranked[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const rows: Ranked[] = [];
  for (const w of waits.filter((x) => !x.auto).sort((a, b) => a.startedAt - b.startedAt)) {
    for (const it of w.items) {
      if (it.asked === false || seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      rows.push(rowOf(w, it, byId.get(it.itemId), offline(it.itemId), now));
    }
  }
  return rows.sort((a, b) => WORDS.indexOf(a.row.word) - WORDS.indexOf(b.row.word));
}

/**
 * The headline (Fable, topic 9). Several: "Watching 3 · 1 wants you" (questions; "2 want you"), with no question but
 * replies "Watching 3 · 1 replied", else "Watching 3". One, names shown: "API asks something", "API replied", "API is
 * working", "API is idle", "API is offline"; names hidden: "A thread asks something", "A thread replied", "Watching 1".
 */
export function headline(rows: { word: Word; name?: string }[], names: boolean): string {
  if (rows.length === 1) {
    const [{ word, name }] = rows;
    if (names && name) return `${name} ${SAID[word]}`;
    return word === "asks" ? "A thread asks something" : word === "replied" ? "A thread replied" : "Watching 1";
  }
  const asks = rows.filter((r) => r.word === "asks").length;
  const replied = rows.filter((r) => r.word === "replied").length;
  if (asks) return `Watching ${rows.length} · ${asks} ${asks === 1 ? "wants" : "want"} you`;
  if (replied) return `Watching ${rows.length} · ${replied} replied`;
  return `Watching ${rows.length}`;
}

/** `names`: Privacy's Show thread names (off: counts only); `offline`, a thread's computer gone past its grace. */
export type BoardOptions = { names?: boolean; offline?: (itemId: string) => boolean };

/**
 * The board and its news: every reply and question on it, the rows past `MAX_ROWS` included. With names shown, the
 * first thread that asks something heads it ("API asks") and a tap opens that thread, where the question is read; its
 * words and options are never on the board.
 */
function made(rows: Ranked[], opts: BoardOptions): { state: BoardState; news: string[] } | null {
  if (!rows.length) return null;
  const names = opts.names ?? PRIVACY_DEFAULT.names;
  const news = rows.flatMap((r) => (r.news ? [r.news] : []));
  const shown = rows.slice(0, MAX_ROWS).map((r) => (names ? { ...r.row, name: cut(r.row.name) } : { word: r.row.word, since: r.row.since }));
  const asks = names ? rows.find((r) => r.row.word === "asks") : undefined;
  const status = asks ? `${cut(asks.row.name)} asks` : headline(rows.map((r) => ({ word: r.row.word, name: cut(r.row.name) })), names);
  const open = asks?.itemId ?? (rows.length === 1 ? rows[0].itemId : undefined);
  return { state: { status, live: false, board: shown, ...(open ? { open } : {}) }, news };
}

/**
 * The board for the threads in every wait the user asked for (not starred threads at a goodbye), open or over, as they
 * are now: the most urgent first, at most `MAX_ROWS`; counts only unless `names`. Null when nothing is watched.
 */
export function boardOf(waits: Wait[], items: WorkItem[], now: number, opts: BoardOptions = {}): BoardState | null {
  return made(ranked(waits, items, now, opts.offline ?? (() => false)), opts)?.state ?? null;
}

/** The phone's Live Activity that shows the board: its push token, and Apple's service for it. */
export type Activity = { token: string; env: "sandbox" | "production"; at: number };
/**
 * `urgent`: a new reply or question, which Apple delivers at once (priority 10); the rest may wait for a good moment.
 * `stays`: an `end`'s time on the lock screen after it, in ms (0: it goes at once).
 */
export type BoardPush = { event: "update" | "end"; state: BoardState; urgent: boolean; stays?: number };
export type BoardSend = (activity: Activity, push: BoardPush) => Promise<"sent" | "gone" | "failed">;
/**
 * What the phone's activity last got and when, its news, and whether a change is being held back for the minute: in the
 * store, so a brain woken from hibernation (the cloud's evicts it) neither sends the same board again nor takes old news
 * for new.
 */
type Sent = { state: BoardState; at: number; news: string[]; held: boolean };

const ACTIVITY_KEY = "board_activity";
const SENT_KEY = "board_sent";

export class Boards {
  private readonly waits: Waits;
  private readonly adapter: Pick<Adapter, "list">;
  private readonly store: Store;
  private readonly send: BoardSend | null;
  private readonly privacy: () => Privacy;
  private readonly log: (m: string) => void;
  private readonly track: Track;
  private readonly clock: Clock;
  private readonly scheduled: () => void;
  private timer: Timer | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;

  /**
   * Without `send` (no push key, Lattice) nothing is registered. `privacy`: Privacy's settings now (names). `scheduled`:
   * `due` may have changed (the cloud sets its alarm by it). A wait changing, or a machine's report, looks.
   */
  constructor(deps: {
    waits: Waits; adapter: Pick<Adapter, "list"> & Partial<Pick<Adapter, "watch">>; store: Store; send?: BoardSend; privacy?: () => Privacy;
    log: (m: string) => void; track?: Track; clock?: Clock; scheduled?: () => void;
  }) {
    this.waits = deps.waits;
    this.adapter = deps.adapter;
    this.store = deps.store;
    this.send = deps.send ?? null;
    this.privacy = deps.privacy ?? (() => PRIVACY_DEFAULT);
    this.log = deps.log;
    this.track = deps.track ?? (() => {});
    this.clock = deps.clock ?? realClock;
    this.scheduled = deps.scheduled ?? (() => {});
    deps.waits.onChange(() => void this.update());
    deps.adapter.watch?.(() => void this.update());
  }

  /** Whether a registered activity would get the board: this brain can push (every level has it, §8). */
  shows(): boolean {
    return !!this.send;
  }

  /** A board is on the lock screen: the waits the user asked for outlive their End, as for a phone that can be rung. */
  keeps(): boolean {
    return this.shows() && !!this.activity();
  }

  activity(): Activity | null {
    return this.stored<Activity>(ACTIVITY_KEY, (a) => typeof a.token === "string" && (a.env === "sandbox" || a.env === "production"));
  }

  private sent(): Sent | null {
    return this.stored<Sent>(SENT_KEY, (s) => typeof s.at === "number" && Array.isArray(s.news) && !!s.state);
  }

  private stored<T>(key: string, ok: (v: any) => boolean): T | null {
    try {
      const v = JSON.parse(this.store.get(key) ?? "null");
      return v && ok(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** The board as things are now. */
  private async board(): Promise<{ state: BoardState; news: string[] } | null> {
    const watched = this.waits.all().filter((w) => !w.auto);
    if (!watched.length) return null;
    const items = await this.adapter.list().catch(() => [] as WorkItem[]);
    const rows = ranked(watched, items, this.clock.now(), (id) => this.waits.offline(id) != null);
    return made(rows, { names: this.privacy().names });
  }

  /**
   * The Live Activity the phone is leaving on the lock screen as a call ends: the board it should show now, which the
   * phone puts there itself, and is kept current from now on. Null, and nothing kept, when nothing is watched, or this
   * brain doesn't keep a board, or the phone is in the car (`car`: CarPlay's audio is on): it's never something to read
   * while driving, so the End there is as without one (a call-back rings, if it can).
   */
  async register(token: string, env: "sandbox" | "production", car = false): Promise<BoardState | null> {
    if (!this.shows() || car) return null;
    const board = await this.board();
    if (!board) return null;
    this.store.set(ACTIVITY_KEY, JSON.stringify({ token, env, at: this.clock.now() } satisfies Activity));
    this.save({ state: board.state, at: this.clock.now(), news: board.news, held: false });
    // No token in the log, nor any of it (the review of stage 5).
    this.log(`board: an activity to keep current (${env}): ${board.state.board.length} rows`);
    this.scheduled();
    return board.state;
  }

  /** The phone took the activity back (a call started, the board's Hide, gone from the lock screen): nothing more is sent. */
  forget(token?: string) {
    const had = this.activity();
    if (!had || (token && had.token !== token)) return;
    this.store.set(ACTIVITY_KEY, "null");
    this.store.set(SENT_KEY, "null");
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
    this.log("board: no activity to keep current");
    this.scheduled();
  }

  /** When the board next wants a look, for the cloud's alarm: a change held back, or the refresh. Null without one. */
  due(now = this.clock.now()): number | null {
    if (!this.send || !this.activity()) return null;
    const sent = this.sent();
    if (!sent) return now;
    return Math.max(now, sent.at + (sent.held ? BOARD_EVERY_MS : BOARD_REFRESH_MS));
  }

  /** Something may have changed (a wait, a machine's report, Privacy, the alarm): the board is sent if it did. */
  update(): Promise<void> {
    this.dirty = true;
    return (this.running ??= this.drain());
  }

  /**
   * Looks until nothing has asked again. `running` is let go in the same step as the last look for `dirty`, so an ask
   * that comes after it starts a new drain rather than joining one that's ending (a `.finally` after the loop let it be
   * lost: the spike's).
   */
  private async drain() {
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.once().catch((e) => this.log(`board: couldn't update (${describe(e)})`));
      }
    } finally {
      this.running = null;
    }
  }

  private save(sent: Sent) {
    this.store.set(SENT_KEY, JSON.stringify(sent));
  }

  private async once() {
    const activity = this.activity();
    if (!activity || !this.send) return;
    const now = this.clock.now();
    const sent = this.sent();
    const board = await this.board();
    // Nothing watched any more (called back, stopped, run out): it leaves the lock screen, staying a while with news on
    // it not yet heard (a call or a reading would have taken the board already).
    if (!board) {
      const last = sent?.state ?? { status: "Watching 0", live: false as const, board: [] };
      const stays = last.board.some((r) => r.word === "asks" || r.word === "replied") ? BOARD_NEWS_STAYS_MS : 0;
      await this.push(activity, { event: "end", state: last, urgent: false, stays });
      this.forget(activity.token);
      return;
    }
    const keep = { news: board.news };
    const same = !!sent && JSON.stringify(sent.state) === JSON.stringify(board.state);
    if (same && now - sent.at < BOARD_REFRESH_MS) {
      // Nothing to show (news past what the board shows, as counts only): the next change isn't news.
      if (sent.held || sent.news.join() !== board.news.join()) this.save({ ...sent, ...keep, held: false });
      return;
    }
    // News goes at once; so do names hidden in Privacy (a name left on a lock screen after the user hid it can't wait).
    const hidden = !!sent?.state.board.some((r) => r.name) && !board.state.board.some((r) => r.name);
    const urgent = !same && (hidden || board.news.some((k) => !sent?.news.includes(k)));
    const wait = sent ? sent.at + BOARD_EVERY_MS - now : 0;
    if (!urgent && wait > 0) {
      if (!sent!.held) {
        this.save({ ...sent!, held: true });
        this.scheduled();
      }
      this.timer ??= this.clock.setTimeout(() => {
        this.timer = null;
        void this.update();
      }, wait);
      this.timer.unref();
      return;
    }
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
    this.save({ state: board.state, at: now, held: false, ...keep });
    await this.push(activity, { event: "update", state: board.state, urgent });
    this.scheduled();
  }

  private async push(activity: Activity, push: BoardPush) {
    const result = await this.send!(activity, push).catch((e) => {
      this.log(`board: couldn't send (${describe(e)})`);
      return "failed" as const;
    });
    // Never the headline in the log: it may name a thread.
    this.log(`board ${push.event}${push.urgent ? " (now)" : ""}: ${push.state.board.length} rows: ${result}`);
    this.track("board_sent", { push: push.event, urgent: push.urgent, result, rows: push.state.board.length });
    if (result === "gone") this.forget(activity.token);
  }
}
