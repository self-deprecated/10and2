// The brain rings the phone (docs/launch/ring.md): a wait the user asked for ("call me back when it's done") is over
// with a real reply or question, and no phone is holding for it (the app was closed, or iOS ended it). The phone shows
// an incoming call (a VoIP push, CallKit); answering starts the call-back as a holding phone would. Declining costs
// nothing: the news is told at the next Start, as before.
//
// From the engine's stage 2 (docs/launch/engine.md §11, item 4) the ring is one channel of the reach policy: the engine
// (`RingChannel`) says where a wait's news goes as it would ring (told in a live call instead), and keeps the ring's
// delivery rows. A ring still sets `rungAt`, which is how an older brain knows it rang, so a rollback doesn't ring again.
// From stage 3.3 the engine also says whether the account's level lets a wait ring now (`allows`: Commute's one a day,
// docs/launch/engine.md §8), read at the ring itself, so a plan's change counts from the next ring.
import type { Track } from "./analytics.ts";
import { WAITING_FOR_YOU } from "./reach.ts";
import { testsTitle } from "./receipts.ts";
import { headOf } from "./rules.ts";
import type { Store } from "./store.ts";
import { describe, realClock, Stuck, type Clock, type Timer } from "./util.ts";
import { notBeforeAt, stillWorking, type Wait, type Waits } from "./waits.ts";
import { validZone } from "./zone.ts";

/** The phone's VoIP push token, and which of Apple's push services it's for (a development build's is the sandbox). */
export type Phone = { token: string; env: "sandbox" | "production"; at: number };

/**
 * The account's phone, one per account, from one install (stage 2a item 6). `token` is the VoIP token, kept under that
 * name so an older brain reads the same record and rings as before; a phone with only notifications has none, and reads
 * as no phone there. `alertToken`: its notifications' token; `notifications`: the app's Notifications switch with iOS's
 * permission granted (iOS hands out an alert token even when it's denied). `tz` and `car`: its zone and whether a 10 & 2
 * call or hold was through CarPlay, kept for stage 3. `writes`: the app registers the write categories (quick replies
 * and Reply…, Fable's 4-K), as each registration of a build that does says; an older build's notifications keep the
 * categories it has (`REPLY`, `QUESTION_OPEN`), so they keep their Call back.
 */
export type PhoneRecord = {
  token?: string;
  env: "sandbox" | "production";
  at: number;
  install?: string;
  alertToken?: string;
  notifications?: boolean;
  tz?: string;
  car?: boolean;
  writes?: boolean;
};

/** What `POST /api/phone` says: `install` is null from an older phone, which sends only its VoIP token. */
export type PhoneInput = { install: string | null; env: "sandbox" | "production"; token?: string; alertToken?: string; notifications?: boolean; tz?: string; car?: boolean; writes?: boolean };

/**
 * What one push asks the phone to show and start. A ring for a line in your rules (stage 3.4: example 11's escalation,
 * example 12's failure) belongs to no conversation: it names its news instead (`reachOut`), which its answer opens with
 * (`POST /api/session {mode: "callback", reachOut}`).
 */
export type Push = { caller: string; conversationId?: string; reachOut?: string };

/**
 * `gone`: Apple says the token is no longer the app's (uninstalled, or another build), so it's forgotten. `failed`:
 * Apple refused it for good. A push that may go through if sent again (Apple's 429 or 5xx, or no answer at all)
 * throws instead, `RetryablePush` or the network's own error: a wait's ring is then tried again, never spent on it.
 */
export type RingSend = (phone: Phone, push: Push) => Promise<"sent" | "gone" | "failed">;

/** Apple's answer to a push says to send it again later (429, 5xx). */
export class RetryablePush extends Error {}

/** How many times a wait's ring is tried again after pushes that may go through, before it counts as failed. */
export const RING_RETRIES = 3;

/**
 * The engine's part in a ring (engine.ts): where a wait's news goes as it would ring, and the ring's delivery rows.
 * Without one (a test of the Ringer alone), a wait rings as before stage 2.
 */
export type RingChannel = {
  /** This wait's news went another way (told in a live call, or a notification in the ring's place): it doesn't ring. */
  dealt(w: Wait): boolean;
  /** Whether the account's level lets this wait ring now (stage 3.3): else its news is a notification, not a ring. */
  allows(w: Wait, now: number): boolean;
  /**
   * As the wait would ring, its grace over: "none" when nothing of its news is left untold (a question answered
   * meanwhile; the wait is over), "call" when a call is live, its news queued there instead; "later" when the call is
   * ending and took none of it (its goodbye is being said), so the wait is looked at again after the grace; else "ring".
   */
  route(w: Wait, now: number): Promise<"ring" | "call" | "later" | "none">;
  /**
   * The ring's attempt, written before the push: the facts it claims, one row each. None when each was rung for already
   * (another wait for the same fact rang): then nothing rings.
   */
  attempt(w: Wait, now: number): string[];
  /** Apple's answer, written after, on the facts the attempt claimed. */
  rang(keys: string[], result: "sent" | "gone" | "failed", now: number): void;
  /** The push didn't get an answer that counts (`RetryablePush`): the attempt's claims go, so the ring is tried again. */
  unclaim?(keys: string[]): void;
};

/**
 * How long a wait that's over is left for a holding phone to take before the brain rings: a holding phone's long poll
 * ends the moment the wait is over, and it asks again straight away, so a phone that hasn't asked in this long isn't
 * holding.
 */
export const RING_GRACE_MS = 6_000;

/**
 * The news a wait rings for: a reply, a failed run or a question seen (not a thread gone from the list), from a thread
 * the user asked about. A wait that ran out with a thread still working rings only when it was only for trouble (still
 * working is trouble, Fable's topic 7); any other is one notification, never a call. One agreed to as a notification
 * (`mode.notify`) never rings. A thread whose computer is offline as its time runs out isn't known to be still working,
 * so it never rings for that (its going offline was the call-back's own news: the Skeptic's finding on 3.6 to 3.8).
 */
export function ringingNews(w: Wait): Wait["replies"] {
  if (w.mode?.notify) return [];
  // A check-in (stage 3.8) calls with how each thread stands, whatever that is.
  if (w.mode?.checkIn !== undefined) return w.replies.filter((r) => !r.gone && r.asked !== false);
  const trouble = w.mode?.only === "trouble";
  if (!trouble && stillWorking(w).length) return [];
  return w.replies.filter((r) => (r.outcome === "finished" || r.outcome === "question" || r.outcome === "failed" || (trouble && r.outcome === "timed out" && !r.offline)) && !r.gone && r.asked !== false);
}

/**
 * Whether a wait that's over rings: one whose rule rings (one the user asked for, not starred threads at a goodbye),
 * with a reply or a question seen from a thread they asked about (a starred thread merged into the wait doesn't ring by
 * itself: `Watched.asked`).
 */
export function rings(w: Wait): boolean {
  return !!w.ready && headOf(w).ring && !w.rungAt && ringingNews(w).length > 0;
}

/** When a wait that's over may first ring: its not-before on the phone's clock (stage 3.6), else once it's over. */
const firstAt = (w: Wait, zone: string | undefined) => Math.max(w.readyAt ?? 0, notBeforeAt(w, zone) ?? 0);

/**
 * Whether a wait outlives the user's Stop (End on hold or in a call): one they asked for, while a phone can be rung
 * (Jordan, 14 November: "call back without me being on hold"), or while the lock screen shows its board (board.ts
 * `keeps`: the phone registered it just before its Stop; stage 5). Starred threads at a goodbye are still called off,
 * and with neither, a Stop calls everything off as before. Declining the ring calls it off.
 */
export function keepsThroughStop(ringer: Ringer | undefined, board?: { keeps(): boolean }): (w: Wait) => boolean {
  return ringer?.canRing() || board?.keeps() ? (w) => headOf(w).ring : () => false;
}

/**
 * What the incoming call shows as the caller (60 characters, what happened only; Fable, 3.6 topic 6): the thread, and
 * whether it replied, asks something, failed ("API failed", "API was stopped", from its status alone) or is still
 * working when a trouble watch ran out. Waiting for all: "Both threads are done", "All 3 threads are done", or, ended
 * early, the thread that did it. Several at once: "2 threads replied" (a question among them too, as before), "2
 * threads failed", "2 threads are still working", "2 threads want you" for a failure among other news. With thread
 * names hidden (Settings → Privacy → Show thread names), no name: "A thread replied". Stage 3.8 (Fable, topic 14): a
 * check-in says how it stands ("API is still working", "API replied", "API isn't running"; several, "2 of 3 threads are
 * done"); a deadline with several threads still working, how many were done ("1 of 3 threads are done"). A thread
 * still working as last seen on a computer offline then (the Skeptic's finding on 3.6 to 3.8) is never said to be: its
 * computer is ("Quartz is offline"; computer names are shown with thread names hidden), and it isn't done. A deadline
 * looked at late (the fourth review of 3.6 to 3.8): a thread done since it isn't still working, "API finished late" ("2
 * threads finished late"), and it counts as done now ("1 of 2 threads are done"). Stage 3.10: one thread's reply says
 * what its tests did when that's news (`testsTitle`). A thread holding a command for the user then (Commands that wait;
 * Fable's ruling on pass B1's review) is waiting for them, never still working: "API is waiting for you" ("2 threads are
 * waiting for you"), and among threads still working it's other news ("2 threads want you").
 */
export function callerOf(w: Wait, names = true): string {
  const total = w.items.length;
  if (w.mode?.checkIn !== undefined) {
    const told = w.replies.filter((r) => !r.gone);
    if (total > 1) return `${told.filter((r) => r.outcome === "finished" || r.outcome === "failed").length} of ${total} threads are done`;
    const r = told[0] ?? w.replies[0];
    const who = names ? r.handle : "A thread";
    if (r.outcome === "never started") return `${who} isn't running`;
  }
  if (w.mode?.deadline !== undefined && total > 1) {
    const ran = stillWorking(w).filter((r) => !r.gone);
    const still = ran.filter((r) => !r.offline && !r.late && !r.held).length;
    const done = total - ran.length + ran.filter((r) => r.late).length;
    if (still > 1 || (still && done)) return done > 0 ? `${done} of ${total} threads are done` : `${still} threads are still working`;
  }
  const news = w.replies.filter((r) => r.outcome !== "never started" && !r.gone && !r.offline);
  if (!news.length) {
    const off = [...new Set(w.replies.flatMap((r) => (r.offline && !r.gone ? [r.offline] : [])))];
    if (off.length) return off.length === 1 ? `${off[0]} is offline` : `${off.length} computers are offline`;
  }
  const early = news.filter((r) => r.outcome === "failed" || r.outcome === "question");
  const all = w.mode?.until === "all" && !w.mode.only && w.items.length > 1;
  if (all && !early.length && news.length > 1 && !stillWorking(w).length) return news.length === 2 ? "Both threads are done" : `All ${news.length} threads are done`;
  const told = all && early.length ? early : news;
  if (told.length > 1) {
    const n = told.length;
    if (told.every((r) => r.late)) return `${n} threads finished late`;
    if (told.every((r) => r.held)) return `${n} threads are ${WAITING_FOR_YOU}`;
    if (told.every((r) => r.outcome === "timed out" && !r.held)) return `${n} threads are still working`;
    if (told.every((r) => r.outcome === "failed")) return `${n} threads failed`;
    if (told.some((r) => r.outcome === "failed" || r.outcome === "timed out")) return `${n} threads want you`;
    return `${n} threads replied`;
  }
  const r = told[0] ?? w.replies[0];
  const who = names ? r.handle : "A thread";
  if (r.outcome === "failed") return r.stopped ? `${who} was stopped` : `${who} failed`;
  if (r.outcome === "timed out") return r.late ? `${who} finished late` : r.held ? `${who} is ${WAITING_FOR_YOU}` : `${who} is still working`;
  if (r.outcome === "question") return `${who} asks something`;
  // Stage 3.10 (Fable, 3.10-C): what its tests did, from the computer ("API's tests pass", "API replied, but its tests
  // failed"); else, as ever, "API replied".
  return r.tests ? testsTitle(names ? r.handle : null, r.tests) : `${who} replied`;
}

/**
 * The test call (Settings → Calls → Call me back → Test call; stage 5, Fable's topic 8, from `spike/ring-ready`): the
 * phone shows it as any call, and answering it there says one line in the iPhone's own voice, which offers to go on:
 * staying on the line, the phone starts a call of its own, as a Start (the review of stage 5). It never opens a call
 * into its own conversation (the brain refuses a session for it, so even a phone that doesn't know it uses no minutes),
 * and it isn't a wait's: it comes on every level, isn't Commute's call-back of the day, and leaves no delivery rows, so
 * no missed call follows it.
 */
export const TEST_RING: Push = { caller: "This is how 10 & 2 calls", conversationId: "ring-test" };
/** One test call per this long, whatever the phone asks. */
export const TEST_RING_EVERY_MS = 30_000;
/** How long after the tap it comes: time to lock the phone or pocket it, so it rings as it will for real. */
export const TEST_RING_IN_MS = 10_000;
/**
 * What asking for a test call did: `ringing` (it comes in `TEST_RING_IN_MS`, timed through `due`, so the cloud's alarm
 * sends it from an object that slept meanwhile), or why it won't: `no phone` registered, `too soon` after the last,
 * `unavailable` without a push key.
 */
export type TestRing = "ringing" | "no phone" | "too soon" | "unavailable";
/** The last test call asked for, and when it's to be sent while it's on its way: kept, so an eviction keeps it. */
const TEST_KEY = "ring_test";

const PHONE_KEY = "ring_phone";
const CAR_KEY = "ring_car_at";
const ENVS: readonly unknown[] = ["sandbox", "production"];

/**
 * The zone the phone last sent (its record's `tz`), if it's one this runtime knows, else null: where every time said or
 * shown is read (docs/launch/engine.md §7, Time zones; stage 3.8), the voice's "now" and a snooze's date included.
 */
export function phoneZoneIn(store: Pick<Store, "get">): string | null {
  try {
    return validZone(JSON.parse(store.get(PHONE_KEY) ?? "null")?.tz);
  } catch {
    return null;
  }
}

/** Whether the phone's latest call was in the car (CarPlay or the car's Bluetooth, as its record says), or false. */
export function phoneInCarIn(store: Pick<Store, "get">): boolean {
  try {
    return JSON.parse(store.get(PHONE_KEY) ?? "null")?.car === true;
  } catch {
    return false;
  }
}

export class Ringer {
  private readonly waits: Waits;
  private readonly store: Store;
  private readonly send: RingSend | null;
  private readonly log: (m: string) => void;
  private readonly track: Track;
  private readonly clock: Clock;
  private readonly names: () => boolean;
  /** The engine's part, once it's made (engine.ts sets it). */
  channel: RingChannel | null = null;
  /** Long polls (`/api/wait`) in flight, per conversation, and when the last one ended. */
  private readonly asking = new Map<string, number>();
  private readonly asked = new Map<string, number>();
  /** Waits a call that's ending couldn't take (`route` said "later"): not looked at again before this. */
  private readonly later = new WeakMap<Wait, number>();
  private timer: Timer | null = null;
  /** When `timer` fires (Infinity for none). */
  private timerAt = Infinity;
  private ticking: Promise<void> | null = null;
  private readonly changes = new Set<() => void>();
  /** Due times a tick left due: none wakes it again before its backoff (docs/launch/engine.md §7; util.ts `Stuck`). */
  private readonly stuck: Stuck;
  /** Each wait's pushes that may go through if sent again, so far (`RING_RETRIES`). */
  private readonly retried = new WeakMap<Wait, number>();
  /** Closed (`close`): a demo world thrown away. */
  private closed = false;

  /** Without `send` (a brain with no push key), a phone can register but nothing rings. `names`: Privacy's switch. */
  constructor(deps: { waits: Waits; store: Store; send?: RingSend; log: (m: string) => void; track?: Track; clock?: Clock; names?: () => boolean }) {
    this.waits = deps.waits;
    this.store = deps.store;
    this.send = deps.send ?? null;
    this.log = deps.log;
    this.track = deps.track ?? (() => {});
    this.clock = deps.clock ?? realClock;
    this.names = deps.names ?? (() => true);
    this.stuck = new Stuck("ring", deps.log, deps.store, this.clock.now());
    deps.waits.held = (id) => this.holdingFor().includes(id);
    deps.waits.zone = () => this.record()?.tz ?? null;
    deps.waits.onChange(() => this.soon());
  }

  /** The account's phone record as kept, or null. */
  record(): PhoneRecord | null {
    try {
      const p = JSON.parse(this.store.get(PHONE_KEY) ?? "null");
      if (!p || typeof p !== "object" || !ENVS.includes(p.env)) return null;
      return p.token === undefined || typeof p.token === "string" ? p : { ...p, token: undefined };
    } catch {
      return null;
    }
  }

  /**
   * When the phone last said its audio was CarPlay's, with a call or a registration (stage 3.4, example 9: "driving" is
   * a 10 & 2 call or hold through CarPlay in the last 30 minutes). Kept beside the record, not in it.
   */
  carAt(): number | null {
    const at = Number(this.store.get(CAR_KEY));
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  /** The phone that rings: the record, when it has a VoIP token. */
  phone(): Phone | null {
    const p = this.record();
    return p && typeof p.token === "string" ? (p as Phone) : null;
  }

  /** Whether a wait that's over would ring now: this brain can push, and a phone registered. */
  canRing(): boolean {
    return !!this.send && !!this.phone();
  }

  /** Whether this brain can ring a phone at all (a push key): Lattice can't, so the app offers no Call me back there. */
  canPush(): boolean {
    return !!this.send;
  }

  /**
   * Calls the registered phone once with `TEST_RING`, `TEST_RING_IN_MS` from now, so the user hears how a call comes
   * through (their Focus, the car, AirPods) before relying on it. At most one each `TEST_RING_EVERY_MS`. The level isn't
   * asked (Fable's topic 8: every level, never Commute's one a day). A refusal is tracked at once; a call, with Apple's
   * answer, once it's sent (`tick`).
   */
  test(now = this.clock.now()): TestRing {
    const last = this.tested()?.asked;
    const result: TestRing = !this.send ? "unavailable" : !this.phone() ? "no phone" : last !== undefined && now >= last && now - last < TEST_RING_EVERY_MS ? "too soon" : "ringing";
    if (result !== "ringing") {
      this.log(`ring test: ${result}`);
      this.track("ring_test", { result });
      return result;
    }
    this.store.set(TEST_KEY, JSON.stringify({ asked: now, at: now + TEST_RING_IN_MS }));
    this.log(`ring test: calling in ${TEST_RING_IN_MS / 1000} s`);
    this.soon();
    return result;
  }

  /** The last test call asked for, and `at`, when it's to be sent, while it's on its way. */
  private tested(): { asked: number; at?: number } | null {
    try {
      const t = JSON.parse(this.store.get(TEST_KEY) ?? "null");
      return t && Number.isFinite(t.asked) ? { asked: t.asked, ...(Number.isFinite(t.at) ? { at: t.at } : {}) } : null;
    } catch {
      return null;
    }
  }

  /**
   * The test call, once its time has come: to the phone the account has by then, if any. Claimed before the push, so a
   * tick that crashes or overlaps never sends it twice.
   */
  private async sendTest(now: number) {
    const t = this.tested();
    if (t?.at === undefined || now < t.at) return;
    this.store.set(TEST_KEY, JSON.stringify({ asked: t.asked }));
    const phone = this.phone();
    const result = !this.send || !phone ? "no phone" : await this.send(phone, TEST_RING).catch((e) => {
      this.log(`ring: couldn't ring (${describe(e)})`);
      return "failed" as const;
    });
    this.log(`ring test: ${result}`);
    this.track("ring_test", { result });
    if (result === "gone") this.forgetVoip(phone!.token);
  }

  /** Calls `l` whenever the phone record changes (following's rule is made and ended by it). */
  onPhone(l: () => void): () => void {
    this.changes.add(l);
    return () => this.changes.delete(l);
  }

  private keep(p: PhoneRecord | null) {
    this.store.set(PHONE_KEY, p ? JSON.stringify(p) : "null");
    for (const l of [...this.changes]) l();
    // A not-before is read in the phone's zone now (the fourth review of 3.6 to 3.8): flown east, it rings sooner.
    this.soon();
  }

  /** The phone that rings, replacing any other: one per account for now (the one signed in last). An older phone's way. */
  register(token: string, env: "sandbox" | "production") {
    const had = this.phone();
    if (had?.token === token && had.env === env && !this.record()?.install) return;
    this.keep({ token, env, at: this.clock.now() } satisfies Phone);
    this.log(`ring: a phone can be rung (${env}, ${token.slice(0, 8)}…)`);
  }

  /**
   * A phone registers (stage 2a item 6): the same install merges its tokens and updates its zone, car and Notifications;
   * another install (or an older phone, with none) replaces the record whole.
   */
  registerPhone(p: PhoneInput): PhoneRecord {
    if (!p.install) {
      if (p.token) this.register(p.token, p.env);
      return this.record() ?? { env: p.env, at: this.clock.now() };
    }
    const had = this.record();
    const now = this.clock.now();
    const fresh = { ...(p.token ? { token: p.token } : {}), ...(p.alertToken ? { alertToken: p.alertToken } : {}), ...(p.notifications !== undefined ? { notifications: p.notifications } : {}), ...(p.tz ? { tz: p.tz } : {}), ...(p.car !== undefined ? { car: p.car } : {}), ...(p.writes !== undefined ? { writes: p.writes } : {}) };
    const next: PhoneRecord = had?.install === p.install ? { ...had, env: p.env, at: now, ...fresh } : { env: p.env, at: now, install: p.install, ...fresh };
    if (next.token === undefined) delete next.token;
    if (p.car === true) this.store.set(CAR_KEY, String(now));
    this.keep(next);
    this.log(`ring: phone ${p.install.slice(0, 8)}… registered (${p.env}${next.token ? ", rings" : ""}${next.alertToken ? `, notifications ${next.notifications ? "on" : "off"}` : ""})`);
    return next;
  }

  /**
   * One of the phone's tokens is no longer to be used (`DELETE /api/phone {install, kind, token?}`): forgotten only if
   * it's this install's record, and with `token`, only if it's still that token; so turning ringing off keeps
   * notifications, and a late DELETE from an old phone can't clear a new one's. Without a token (null: a phone that
   * doesn't know it now, relaunched before iOS gave it again), this install's own token of that kind. That's safe: the
   * account's own signed-in request, about the account's own record, only while it's this install's; the same request
   * could replace the record whole by registering another install.
   */
  forgetToken(install: string, kind: "voip" | "alert", token: string | null): boolean {
    const had = this.record();
    const has = kind === "voip" ? had?.token : had?.alertToken;
    if (!had || had.install !== install || !has || (token !== null && has !== token)) return false;
    const next: PhoneRecord = { ...had };
    if (kind === "voip") delete next.token;
    else {
      delete next.alertToken;
      next.notifications = false;
    }
    this.keep(next.token || next.alertToken ? next : null);
    this.log(`ring: phone ${install.slice(0, 8)}… forgot its ${kind === "voip" ? "VoIP" : "alert"} token`);
    return true;
  }

  /**
   * A demo world's Ringer (demo/world.ts) takes the account's phone as the account's own brain has it, sent with each
   * request (stage 5): the demo's watches call and notify the phone the account would. Kept only when it changed.
   */
  mirror(p: PhoneRecord | null) {
    if (JSON.stringify(this.record()) === JSON.stringify(p)) return;
    this.keep(p);
  }

  /** Stops its timer and rings no more: a demo world being thrown away. */
  close() {
    this.closed = true;
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
  }

  /** Signed out, or the phone turned ringing off: nothing rings until a phone registers again. */
  forget(token?: string) {
    const had = this.record();
    if (!had || (token && had.token !== token)) return;
    this.keep(null);
    this.log("ring: no phone to ring");
  }

  /**
   * Apple refused the VoIP token: nothing rings until a phone registers again. A phone's notifications (an install's
   * alert token) stay; an older phone's record goes whole, as before.
   */
  private forgetVoip(token: string) {
    const had = this.record();
    if (!had?.install || !had.alertToken) return this.forget(token);
    if (had.token !== token) return;
    const next: PhoneRecord = { ...had };
    delete next.token;
    this.keep(next);
    this.log("ring: Apple no longer takes the phone's VoIP token; forgotten, its notifications kept");
  }

  /**
   * Where the phone is, as it says with each call it starts (`POST /api/session`): its zone and whether it's through
   * CarPlay, kept on its record for stage 3 (nothing in 2a uses them). Without a record (neither Call me back nor
   * Notifications on), there's nothing to keep them on.
   */
  situate(tz: string | undefined, car: boolean | undefined) {
    const had = this.record();
    if (had && car === true) this.store.set(CAR_KEY, String(this.clock.now()));
    if (!had || ((tz === undefined || had.tz === tz) && (car === undefined || had.car === car))) return;
    this.keep({ ...had, ...(tz !== undefined ? { tz } : {}), ...(car !== undefined ? { car } : {}) });
  }

  /** Apple refused the alert token: only it is forgotten. */
  forgetAlert(token: string) {
    const had = this.record();
    if (!had || had.alertToken !== token) return;
    const next: PhoneRecord = { ...had };
    delete next.alertToken;
    next.notifications = false;
    this.keep(next.token ? next : null);
    this.log("ring: Apple no longer takes the phone's alert token; forgotten");
  }

  /**
   * A phone holding for `conversationId` is asking (`/api/wait`); call the result when its ask ends. One that starts to
   * hold wakes the waits' listeners, so the engine sets its times again: a computer whose offline news only a holding
   * phone would take is checked exactly from then (`Engine.offlineTimes`).
   */
  holding(conversationId: string): () => void {
    const fresh = !this.holdingFor().includes(conversationId);
    this.asking.set(conversationId, (this.asking.get(conversationId) ?? 0) + 1);
    if (fresh) this.waits.wake();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.asking.get(conversationId) ?? 1) - 1;
      if (n > 0) this.asking.set(conversationId, n);
      else this.asking.delete(conversationId);
      this.asked.set(conversationId, this.clock.now());
      this.soon();
    };
  }

  /** The conversations a phone is holding for now, or asked about within the grace. */
  holdingFor(now = this.clock.now()): string[] {
    return [...new Set([...this.asking.keys(), ...[...this.asked].filter(([, at]) => now - at < RING_GRACE_MS).map(([id]) => id)])];
  }

  /** A wait that may ring: it rings, no phone is asking about it, its news didn't go another way, and the level lets it. */
  private ringable(w: Wait, now = this.clock.now()) {
    return rings(w) && !this.asking.has(w.conversationId) && !this.channel?.dealt(w) && (this.channel?.allows(w, now) ?? true);
  }

  /** Not yet: a wait's not-before (stage 3.6) is still ahead, so it waits for it to ring. */
  private early(w: Wait, now: number) {
    return now < firstAt(w, this.record()?.tz);
  }

  /**
   * When a wait that's over may ring, if one is waiting for its grace to pass: for the cloud's alarm. A time a tick left
   * due, no sooner than its backoff (`Stuck`).
   */
  due(now = this.clock.now()): number | null {
    // The test call on its way too: its own time, sent at the tick that reaches it.
    const test = this.tested()?.at;
    const times = [...this.stuck.hold(this.times(now)), ...(test !== undefined ? [test] : [])];
    return times.length ? Math.max(now, Math.min(...times)) : null;
  }

  /** Each ringable wait's time to ring, those already past included, before any backoff. */
  private times(now: number): number[] {
    if (!this.send || !this.phone()) return [];
    // A conversation a phone is asking about is left out: the ask's end looks again (`holding`).
    const zone = this.record()?.tz;
    return this.waits.all().filter((w) => this.ringable(w, now)).map((w) => Math.max((w.readyAt ?? now) + RING_GRACE_MS, (this.asked.get(w.conversationId) ?? 0) + RING_GRACE_MS, this.later.get(w) ?? 0, notBeforeAt(w, zone) ?? 0));
  }

  /** Rings for every wait that's over, rings, and that no phone took within the grace. One ring at a time. */
  tick(now = this.clock.now()): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.ticking ??= this.ring(now).finally(() => {
      this.ticking = null;
      // What this tick left due waits out a backoff before it wakes the Ringer again.
      try {
        this.stuck.woke(this.times(this.clock.now()), now, this.clock.now());
      } catch (e) {
        this.log(`ring: couldn't tell what's due (${describe(e)})`);
      }
    }));
  }

  private async ring(now: number) {
    await this.sendTest(now);
    if (!this.send || !this.phone()) return;
    for (const w of this.waits.all()) {
      // Each ring is awaited: a wait taken or replaced meanwhile isn't the conversation's any more, and is left alone.
      if (this.waits.get(w.conversationId) !== w || !this.ringable(w, now)) continue;
      if (now - (w.readyAt ?? now) < RING_GRACE_MS || now - (this.asked.get(w.conversationId) ?? 0) < RING_GRACE_MS || now < (this.later.get(w) ?? 0) || this.early(w, now)) continue;
      // In a live call the news is told there (the engine queues it), never by ringing the phone that's in the call;
      // and a question answered meanwhile isn't rung for.
      const way = this.channel ? await this.channel.route(w, now) : "ring";
      if (way === "call") {
        this.log(`ring ${w.conversationId}: a call is on; told in the call instead`);
        continue;
      }
      if (way === "later") {
        // Never into a call's goodbye (the phone in it would end the ring at once), and not again and again meanwhile.
        this.later.set(w, this.clock.now() + RING_GRACE_MS);
        this.log(`ring ${w.conversationId}: a call is ending; it rings after it`);
        continue;
      }
      if (way === "none") {
        this.log(`ring ${w.conversationId}: its news was answered or told meanwhile; nothing to ring for`);
        continue;
      }
      // The engine looked at the threads: a wait taken, replaced or held for meanwhile is left alone. It rings the phone
      // the account has now (another install may have taken the record meanwhile), and with none nothing is spent. One
      // instant, read after every await, for whether the level lets it, its attempt rows and its marker: a ring whose
      // look crossed midnight is the new day's, as Commute counts it (`ringsToday` reads the rows' time). Its
      // not-before is read again too, in the zone the phone is in now (the fourth review of 3.6 to 3.8: a phone that
      // flew west while the threads were looked at is still before it there): no attempt is spent, and it rings at that
      // time.
      const at = this.clock.now();
      if (this.waits.get(w.conversationId) !== w || !this.ringable(w, at) || this.early(w, at)) continue;
      const phone = this.phone();
      if (!phone) return;
      // Its marker (`rungAt`, how an older brain knows it rang) and its attempt rows in one transaction (§3's attempt): a
      // crash can't keep one without the other. With each of its facts rung for already, nothing is claimed or rung.
      const claimed = this.store.db.transaction(() => {
        const keys = this.channel ? this.channel.attempt(w, at) : null;
        if (!keys || keys.length) this.store.saveWait({ ...w, rungAt: at });
        return keys;
      });
      if (claimed && !claimed.length) {
        this.log(`ring ${w.conversationId}: its news was rung for already; it doesn't ring again`);
        continue;
      }
      w.rungAt = at;
      const caller = callerOf(w, this.names());
      const tries = this.retried.get(w) ?? 0;
      const result = await this.send(phone, { caller, conversationId: w.conversationId }).catch((e) => {
        this.log(`ring: couldn't ring (${describe(e)})`);
        return tries < RING_RETRIES ? ("retry" as const) : ("failed" as const);
      });
      if (result === "retry") {
        // Apple didn't answer for good: the ring isn't spent, and is tried again after its backoff (`Stuck`).
        this.retried.set(w, tries + 1);
        this.store.db.transaction(() => {
          this.channel?.unclaim?.(claimed ?? []);
          if (this.waits.get(w.conversationId) === w) this.store.saveWait({ ...w, rungAt: undefined });
        });
        w.rungAt = undefined;
        this.log(`ring ${w.conversationId}: not delivered; it's tried again`);
        continue;
      }
      this.log(`ring ${w.conversationId}: ${caller}: ${result}`);
      this.channel?.rang(claimed ?? [], result, this.clock.now());
      this.track("ring_sent", { conversation_id: w.conversationId, result, env: phone.env, wait_s: Math.round((at - w.startedAt) / 1000) });
      if (result === "gone") this.forgetVoip(phone.token);
    }
  }

  /**
   * Rings the phone the account has now for something that isn't a wait that's over (the engine's: a computer gone
   * offline in a call-back that goes on, stage 3.7), into `conversationId`. The engine keeps its delivery rows; `rungAt`
   * isn't set, so the wait's own reply still rings. "failed" with no phone or no push key: nothing is spent.
   */
  async call(into: string | { reachOut: string }, caller: string): Promise<"sent" | "gone" | "failed"> {
    const phone = this.phone();
    if (!this.send || !phone) return "failed";
    const push: Push = typeof into === "string" ? { caller, conversationId: into } : { caller, reachOut: into.reachOut };
    const result = await this.send(phone, push).catch((e) => {
      this.log(`ring: couldn't ring (${describe(e)})`);
      return "failed" as const;
    });
    this.log(`ring ${push.conversationId ?? push.reachOut}: ${caller}: ${result}`);
    if (result === "gone") this.forgetVoip(phone.token);
    return result;
  }

  /**
   * Looks again once the grace has passed, while the brain is awake; the cloud's alarm covers a brain that sleeps. As
   * the engine's timer does, it moves earlier for a wait due sooner, so one wait held to its backoff (`Stuck`) holds no
   * other's ring; and a tick that threw still sets the next one (what it left due waits out its backoff).
   */
  private soon() {
    if (!this.send || this.closed) return;
    const at = this.due();
    if (at === null || at >= this.timerAt) return;
    if (this.timer) this.clock.clear(this.timer);
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.tick()
        .catch((e) => this.log(`ring: couldn't look at what rings (${describe(e)})`))
        .then(() => this.soon());
    }, at - this.clock.now() + 50);
    this.timer.unref();
  }
}
