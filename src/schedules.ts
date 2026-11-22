// Sends and starts set up for later, held and run by this computer (docs/launch/engine.md §5, "Sends and starts for
// later: held and run by the computer"; §11 stage 4a). The yes is given in a call or on the phone; the brain hands the
// schedule here at once (`set_schedules`, the computer's full set), and this computer keeps it in connector.db, runs it
// at its time under its own policy and checks, and says what happened in its view. The cloud never fires one.
//
// Stop always wins: a schedule fires only while the link to 10 & 2 is up, heard from in the last 75 s, and the last set
// the brain sent on it was applied (link.ts `fireable`), so a Stop sent while this computer slept cancels it before
// anything late can go. A set is applied in one synchronous transaction, and a row becomes `firing` only in the same
// transaction as the Ledger's record of its dispatch, and only if it's still `waiting` (`Ledger.execute`'s `claim`).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Action, Receipt, WorkItem } from "./contract.ts";
import { actionHash, type Ledger } from "./ledger.ts";
import type { How, Local } from "./local.ts";
import { allows, rulesOf, withinCeiling, type Policy } from "./policy.ts";
import { actionOf, text } from "./protocol.ts";
import { describe } from "./util.ts";

/** One send or start set up for later, as the brain hands it over (contracts.md §2). */
export type Schedule = {
  v: 1;
  /** "R-<rule>-<n>:<itemId>" or "R-<rule>-<n>:start": also the Ledger's key when it fires. */
  id: string;
  /** `follow_up` or `start_work`; a start carries its title (made at the yes) and its whole profile. */
  action: Action;
  /** An instant (UTC), or "when that thread on this computer finishes" (a chain), not before `notBefore`. */
  when: { at: string } | { after: { itemId: string; lastRunAt: string | null }; notBefore?: string };
  /** Nothing fires after it: `at` + 2 h, or the rule's own end; at most 74 h from when it's handed over. */
  until: string;
  /** The target as it was at the yes: what the checks at firing compare with. */
  guard: { agreedAt: string; running: boolean; lastRunAt: string | null; questionId: string | null };
  /** The card's sentence, for `10and2 status` and the log. */
  said: string;
  /** The phone's zone at the yes, for display only. */
  zone: string;
};

export type HeldState = "waiting" | "firing" | "sent" | "not_sent" | "missed" | "cancelled" | "unknown" | "refused";

/**
 * Why, as a short code the brain picks its line by (Fable's 4-G), beside the words in `why`. At its time: `asleep` (this
 * computer saw itself sleep), `unreached` (awake, no link to 10 & 2), `busy` (the thread still on the run it was on at
 * the yes, or its subagents working), `app` (its work system not running here, named in `app`). The checks at firing:
 * `wrote`, `ran`, `asking`, `gone`, `settled`, `policy`, `ceiling`, `place`, `refused` (its work system's own refusal).
 * A chain's trigger: `working` (it hadn't finished), `failed`, `stopped`, `asked`, `vanished`. A set's entry: `time`,
 * `full`, `invalid`, `conflict`, `version`.
 */
export type Why = "asleep" | "unreached" | "busy" | "app" | "wrote" | "ran" | "asking" | "gone" | "settled" | "policy" | "ceiling" | "place" | "refused"
  | "working" | "failed" | "stopped" | "asked" | "vanished" | "time" | "full" | "invalid" | "conflict" | "version";
type Reason = { code: Why; why: string; app?: string };

/**
 * What this computer holds, as the view and `set_schedules` report it. `code`, `why` and `app`: on a waiting row, why it
 * hasn't gone yet (past its time); on a sent or missed one, why it didn't go at its time; on a not-sent or refused one,
 * why not. `at`: when it was due (a chain: when its thread finished); `firedAt`: when it was handed to its work system;
 * `receipt`: what that answered (`itemId`, a start's new thread); `after`: the target then, a chain's baseline.
 */
export type Held = {
  id: string;
  state: HeldState;
  code?: Why; why?: string; app?: string;
  at?: string; firedAt?: string; receipt?: Receipt;
  after?: { lastRunAt: string | null; questionId: string | null };
};

/** What `set_schedules` answers: what it holds, one entry per id (the set's own first), or why the whole set wasn't applied. */
export type SetAnswer = { held: Held[] } | { refused: "stale" | "clock"; error: string; minutes?: number };

const MIN = 60_000;
const HOUR = 60 * MIN;
/** At most this many waiting at once, so a brain can't fill the disk. */
export const MAX_HELD = 50;
/** The brain's clock and this one may differ by this much; past it, nothing is applied (a wrong clock would fire at the wrong time). */
export const SKEW_MS = 5 * MIN;
/**
 * `until` at most this far ahead: 72 hours, the 2-hour window after, and the clock difference allowed (stage 4's final
 * review: one at the brain's limit, handed to a computer whose clock is a little behind, is still taken).
 */
export const MAX_AHEAD_MS = 74 * HOUR + SKEW_MS;
/** The runner looks at least this often, on the wall clock: Node's timers stop while a Mac sleeps. */
export const TICK_MS = 15_000;
/** A gap this long between looks is this computer asleep (four missed looks). */
export const SLEEP_GAP_MS = 60_000;
/** Finished rows stay listed this long. */
export const KEPT_MS = 7 * 24 * HOUR;
/** A subagent that finished this recently is about to be answered by its parent (spike/relay's `subagentsBusy`). */
const SUBAGENT_MS = 3 * MIN;

type Extra = {
  /** Why it hasn't gone yet, at the last look past its time (or a chain's thread still working). */
  hold?: Reason;
  /** The first reason it couldn't go at its time: what a late send or a missed one is told with. */
  late?: Reason;
  /** The final reason (not sent, missed). */
  outcome?: Reason;
  /** A chain's thread finished cleanly then (ms). */
  metAt?: number;
  firedAt?: number;
  receipt?: Receipt;
  after?: { lastRunAt: string | null; questionId: string | null };
};
type Row = { id: string; v: number | null; device: string; hash: string; body: string; state: string; extra: Extra; set_at: number; done_at: number | null };
type Verdict = Reason & { hold: boolean };

const iso = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));
const isoOrNull = (v: unknown) => v === null || iso(v);
const toIso = (ms: number) => new Date(ms).toISOString();
const sameTime = (a: string | null | undefined, b: string | null | undefined) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
const only = (v: object, fields: string[]) => Object.keys(v).every((k) => fields.includes(k));
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** A reply whose last paragraph asks something ("Should I drop the old column?"): not a clean finish (spike/relay). */
export function endsAsking(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).at(-1) ?? "";
  return /\?[\s"'”’)*_`]*(?:\s|$)/.test(last);
}

/**
 * `item` has subagents at work, or one that finished after its own last run, which it's about to answer: its run that
 * ended isn't the end of its work, and a message sent now would land in the middle of it (spike/relay).
 */
export function subagentsBusy(item: WorkItem, items: Iterable<WorkItem>, now: number): boolean {
  const last = item.lastRunAt ? Date.parse(item.lastRunAt) : 0;
  for (const c of items) {
    if (c.parentId !== item.id || c.settled) continue;
    if (c.status === "running") return true;
    const done = c.lastRunAt ? Date.parse(c.lastRunAt) : 0;
    if (done > last && now - done < SUBAGENT_MS) return true;
  }
  return false;
}

/** What this computer's policy says to a schedule's action, when it's handed over and again when it fires; null: allowed. */
export function policyRefusal(policy: Policy, a: Action): Reason | null {
  const rules = rulesOf(policy);
  if (rules === "off") return { code: "policy", why: "This computer isn't set to send messages for later." };
  if (a.kind === "start_work" && rules !== "start") return { code: "policy", why: "This computer isn't set to start threads for later." };
  if (!allows(policy, a.kind)) return { code: "policy", why: `10 & 2 isn't allowed to ${a.kind === "start_work" ? "start new work" : "send messages"} on this computer.` };
  if (a.kind === "start_work" && !withinCeiling(policy, a.profile)) return { code: "ceiling", why: "This computer doesn't allow that much access for a thread started later." };
  return null;
}

/**
 * One entry of a set, checked as the Ledger checks an action (`actionOf`, with 2a's `questionId`): the schedule, or why
 * it's refused. Unknown fields are refused; a `v` newer than this code's is refused as needing a newer 10and2.
 */
export function parseSchedule(e: unknown): { id: string; schedule?: Schedule; refusal?: Reason } {
  const id = isObject(e) && text(e.id) && e.id.length <= 200 ? e.id : "";
  const invalid = (why: string) => ({ id, refusal: { code: "invalid" as const, why } });
  if (!isObject(e) || !id) return invalid("A schedule needs an id.");
  if (e.v !== 1) return typeof e.v === "number" && e.v > 1 ? { id, refusal: { code: "version", why: "It needs a newer 10and2 on this computer." } } : invalid("That schedule's version isn't valid.");
  if (!only(e, ["v", "id", "action", "when", "until", "guard", "said", "zone"])) return invalid("Unknown schedule fields aren't supported.");
  let action: Action;
  try { action = actionOf(e.action); } catch (err) { return invalid(describe(err)); }
  if (action.kind !== "follow_up" && action.kind !== "start_work") return invalid("Only a message or new work can be set up for later.");
  const w = e.when;
  let when: Schedule["when"];
  if (isObject(w) && "at" in w && only(w, ["at"]) && iso(w.at)) when = { at: w.at };
  else if (isObject(w) && only(w, ["after", "notBefore"]) && isObject(w.after) && only(w.after, ["itemId", "lastRunAt"]) && text(w.after.itemId) && isoOrNull(w.after.lastRunAt)
    && (w.notBefore === undefined || iso(w.notBefore))) when = { after: { itemId: w.after.itemId, lastRunAt: w.after.lastRunAt }, ...(w.notBefore !== undefined ? { notBefore: w.notBefore } : {}) };
  else return invalid("When it goes isn't valid.");
  if (!iso(e.until)) return invalid("Until when it may go isn't valid.");
  if ("at" in when && Date.parse(when.at) > Date.parse(e.until)) return invalid("It's due after its own end.");
  const g = e.guard;
  if (!isObject(g) || !only(g, ["agreedAt", "running", "lastRunAt", "questionId"]) || !iso(g.agreedAt) || typeof g.running !== "boolean" || !isoOrNull(g.lastRunAt)
    || !(g.questionId === null || (text(g.questionId) && g.questionId.length <= 200))) return invalid("What the thread was like at the yes isn't valid.");
  if (!text(e.said) || e.said.length > 1000) return invalid("A schedule needs its sentence.");
  if (typeof e.zone !== "string" || e.zone.length > 64) return invalid("A schedule needs the phone's zone.");
  return { id, schedule: { v: 1, id, action, when, until: e.until, guard: { agreedAt: g.agreedAt, running: g.running, lastRunAt: g.lastRunAt, questionId: g.questionId }, said: e.said, zone: e.zone } };
}

type Options = {
  ledger: Ledger;
  local: Local;
  policy: Policy;
  /** Which pairing these rows were given under: rows from another (set up again for another account) are cancelled. */
  device: string;
  /** Whether this computer may fire now: the link up, heard from in the last 75 s, its last set applied (link.ts). */
  gate: () => boolean;
  now?: () => number;
  log?: (s: string) => void;
};

/** A row a restart left firing that won't be sent again (past its end, stopped, no longer allowed): it may have gone. */
const STOPPED_SENDING: Receipt = { ok: false, unknown: true, error: "The connector stopped while it was being sent." };

/** The schedules held on this computer: the store, `set_schedules`, the runner, and what the view reports. */
export class Schedules {
  private readonly opts: Options;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly listeners = new Set<() => void>();
  /** Rows this process is firing or recovering now. */
  private readonly inflight = new Set<string>();
  /** Rows claimed and on their way to their work system now: a set leaves them as they are, since they may arrive. */
  private readonly dispatching = new Set<string>();
  /** When this process saw the computer asleep: gaps in its looks ([from, to], ms). */
  private sleeps: [number, number][] = [];
  private lastBeat: number | null = null;
  private ticking = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private beats: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;

  constructor(opts: Options) {
    this.opts = opts;
    this.db = opts.ledger.handle;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    const now = this.now();
    // Another pairing's rows: never fired here. One that was being sent when it changed may have gone, so it's unknown.
    this.db.prepare("UPDATE schedules SET state = 'cancelled', done_at = ? WHERE device != ? AND v = 1 AND state = 'waiting'").run(now, opts.device);
    this.db.prepare("UPDATE schedules SET state = 'unknown', done_at = ? WHERE device != ? AND v = 1 AND state = 'firing'").run(now, opts.device);
  }

  /** Told each time what the view reports changes (a set applied, an outcome, a new reason it's waiting). */
  watch(f: () => void): () => void { this.listeners.add(f); return () => this.listeners.delete(f); }
  private changed() { for (const f of this.listeners) { try { f(); } catch (e) { this.log(`schedules: ${describe(e)}`); } } }

  private rows(where: string, ...args: (string | number)[]): Row[] {
    return (this.db.prepare(`SELECT id, v, device, hash, body, state, extra, set_at, done_at FROM schedules WHERE ${where}`).all(...args) as any[])
      .map((r) => ({ ...r, extra: (() => { try { return JSON.parse(r.extra) ?? {}; } catch { return {}; } })() }));
  }
  private row(id: string): Row | undefined { return this.rows("id = ?", id)[0]; }
  private save(id: string, state: string, extra: Extra, done = false) {
    this.db.prepare(`UPDATE schedules SET state = ?, extra = ?${done ? ", done_at = ?" : ""} WHERE id = ?`).run(...[state, JSON.stringify(extra), ...(done ? [this.now()] : []), id]);
  }

  /** Each row of this pairing, as the view reports it, oldest first. */
  view(): Held[] {
    return this.rows("device = ? ORDER BY set_at, id", this.opts.device).map((r) => this.held(r));
  }

  private held(r: Row): Held {
    if (r.v !== 1) return { id: r.id, state: "refused", code: "version", why: "It needs a newer 10and2 on this computer." };
    const s = JSON.parse(r.body) as Schedule;
    const e = r.extra;
    const at = "at" in s.when ? s.when.at : e.metAt !== undefined ? toIso(e.metAt) : undefined;
    const reason = r.state === "waiting" ? e.hold : r.state === "sent" ? e.late : r.state === "not_sent" || r.state === "missed" ? e.outcome
      : r.state === "unknown" && e.receipt && !e.receipt.ok ? { code: undefined, why: e.receipt.error } : undefined;
    return {
      id: r.id, state: r.state as HeldState,
      ...(reason?.code ? { code: reason.code } : {}), ...(reason?.why ? { why: reason.why } : {}), ...(reason && "app" in reason && reason.app ? { app: reason.app } : {}),
      ...(at ? { at } : {}), ...(e.firedAt !== undefined ? { firedAt: toIso(e.firedAt) } : {}), ...(e.receipt ? { receipt: e.receipt } : {}), ...(e.after ? { after: e.after } : {}),
    };
  }

  /** The waiting ones, for status.json: when (null for a chain's) and the card's sentence. */
  summary(): { at: string | null; said: string }[] {
    return this.rows("device = ? AND v = 1 AND state IN ('waiting', 'firing')", this.opts.device)
      .map((r) => { const s = JSON.parse(r.body) as Schedule; return { at: "at" in s.when ? s.when.at : null, said: s.said }; })
      .sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
  }

  /**
   * `set_schedules`: the brain's full set for this computer, applied in one synchronous transaction. A waiting row it
   * leaves out is cancelled; a new id is stored; the same id with the same content is left as it is; the same id with
   * other content is refused. Rows already firing, sent, not sent, missed or unknown can't be cancelled and are
   * answered as they are. Throws (invalid params: nothing done) for a malformed call.
   */
  set(seq: unknown, list: unknown, brainNow: unknown): SetAnswer {
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error("A set needs its seq, a whole number from 1.");
    if (!Array.isArray(list) || list.length > 500) throw new Error("A set needs its schedules.");
    if (typeof brainNow !== "number" || !Number.isFinite(brainNow)) throw new Error("A set needs the brain's clock (tenandtwo/now).");
    const now = this.now();
    const off = Math.abs(now - brainNow);
    if (off > SKEW_MS) {
      const minutes = Math.round(off / MIN);
      return { refused: "clock", minutes, error: `This computer's clock is ${minutes} minutes off, so it won't send anything until that's fixed.` };
    }
    const device = this.opts.device;
    const answer: Held[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = (this.db.prepare("SELECT seq FROM schedule_sync WHERE device = ?").get(device) as { seq: number } | undefined)?.seq;
      if (last !== undefined && (seq as number) <= last) {
        this.db.exec("ROLLBACK");
        return { refused: "stale", error: `An older set (${seq}) than one already applied (${last}); nothing was changed.` };
      }
      const entries = list.map((e) => parseSchedule(e));
      const ids = new Set(entries.map((e) => e.id).filter(Boolean));
      const mine = new Map(this.rows("device = ?", device).map((r) => [r.id, r]));
      // Left out of the set: a waiting row is cancelled (Stop); anything already on its way stays as it is. One a restart
      // left firing, not yet sent again (`recover`, its checks awaited too), may or may not have gone: it's never sent
      // again (Stop always wins).
      for (const r of mine.values()) {
        if (r.v === 1 && r.state === "waiting" && !ids.has(r.id)) {
          this.db.prepare("UPDATE schedules SET state = 'cancelled', done_at = ? WHERE id = ?").run(now, r.id);
          r.state = "cancelled";
        } else if (r.v === 1 && r.state === "firing" && !ids.has(r.id) && !this.dispatching.has(r.id)) {
          this.db.prepare("UPDATE schedules SET state = 'unknown', extra = ?, done_at = ? WHERE id = ?").run(JSON.stringify({ ...r.extra, receipt: STOPPED_SENDING }), now, r.id);
          r.state = "unknown";
        }
      }
      let count = [...mine.values()].filter((r) => r.v === 1 && (r.state === "waiting" || r.state === "firing")).length;
      const seen = new Set<string>();
      for (const e of entries) {
        const refuse = (refusal: Reason) => answer.push({ id: e.id, state: "refused", code: refusal.code, why: refusal.why });
        if (e.id && seen.has(e.id)) { refuse({ code: "conflict", why: "That id is in the set twice." }); continue; }
        seen.add(e.id);
        if (!e.schedule) { refuse(e.refusal!); continue; }
        const s = e.schedule;
        const hash = actionHash(s as unknown as Action);
        const existing = mine.get(s.id) ?? this.row(s.id);
        if (existing) {
          if (existing.device === device && existing.v === 1 && existing.hash === hash) answer.push(this.held(existing));
          else refuse({ code: "conflict", why: "That id was already used for something else." });
          continue;
        }
        const refusal = policyRefusal(this.opts.policy, s.action)
          ?? (Date.parse(s.until) <= now ? { code: "time" as const, why: "Its time has passed." } : null)
          ?? (Date.parse(s.until) > now + MAX_AHEAD_MS ? { code: "time" as const, why: "It's more than 3 days ahead." } : null)
          ?? (count >= MAX_HELD ? { code: "full" as const, why: `This computer holds at most ${MAX_HELD} for later.` } : null);
        if (refusal) { refuse(refusal); continue; }
        this.db.prepare("INSERT INTO schedules (id, v, device, hash, body, state, extra, set_at) VALUES (?, 1, ?, ?, ?, 'waiting', '{}', ?)").run(s.id, device, hash, JSON.stringify(s), now);
        count++;
        answer.push(this.held(this.row(s.id)!));
      }
      for (const r of this.rows("device = ? ORDER BY set_at, id", device)) if (!seen.has(r.id)) answer.push(this.held(r));
      this.db.prepare("INSERT INTO schedule_sync (device, seq) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET seq = excluded.seq").run(device, seq as number);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.changed();
    this.poke();
    return { held: answer };
  }

  /** This computer was disconnected from 10 & 2 (revoked): nothing it holds goes. */
  revoke() {
    this.db.prepare("UPDATE schedules SET state = 'cancelled', done_at = ? WHERE v = 1 AND state = 'waiting'").run(this.now());
    this.changed();
  }

  /** One look at the wall clock: a gap since the last is this computer having slept. */
  beat() {
    const now = this.now();
    if (this.lastBeat !== null && now - this.lastBeat > SLEEP_GAP_MS) {
      this.sleeps.push([this.lastBeat, now]);
      this.sleeps = this.sleeps.filter(([, to]) => now - to < MAX_AHEAD_MS + HOUR);
    }
    this.lastBeat = now;
  }
  private slept(at: number) { return this.sleeps.some(([from, to]) => from < at && at <= to); }

  /** Why it can't go at its time, from where this computer was then: asleep (seen), or no link to 10 & 2. */
  private away(at: number, gate: boolean): Reason | null {
    if (this.slept(at)) return { code: "asleep", why: "This computer was asleep." };
    return gate ? null : { code: "unreached", why: "This computer couldn't reach 10 & 2." };
  }

  /** Looks at every row: fires what's due, misses what's past its end, recovers what a restart left firing. */
  async tick(): Promise<void> {
    this.beat();
    if (this.ticking) { this.again = true; return; }
    this.ticking = true;
    try {
      do {
        this.again = false;
        this.db.prepare("DELETE FROM schedules WHERE done_at IS NOT NULL AND done_at < ?").run(this.now() - KEPT_MS);
        const live = this.rows("device = ? AND v = 1 AND state IN ('waiting', 'firing') ORDER BY set_at, id", this.opts.device);
        for (const r of live) {
          if (this.inflight.has(r.id)) continue;
          try { await this.step(r.id); } catch (e) { this.log(`schedules: ${r.id}: ${describe(e)}`); }
        }
      } while (this.again);
    } finally {
      this.ticking = false;
      this.plan();
    }
  }

  /** A look soon: a set applied, the link synced, a work system's change. */
  poke() { if (this.beats) this.arm(0); }

  private async step(id: string) {
    const r = this.row(id);
    if (!r || r.v !== 1 || r.device !== this.opts.device) return;
    const s = JSON.parse(r.body) as Schedule;
    if (r.state === "firing") return this.recover(r, s);
    if (r.state !== "waiting") return;
    const now = this.now();
    const gate = this.opts.gate();
    const dueAt = "at" in s.when ? Date.parse(s.when.at) : r.extra.metAt ?? null;
    if (now > Date.parse(s.until)) {
      // Past its end: never sent, and told with why it couldn't go at its time.
      const outcome = r.extra.late ?? (dueAt !== null ? this.away(dueAt, gate) : null) ?? r.extra.hold
        ?? ("after" in s.when && gate ? { code: "working", why: "The thread it waited for hadn't finished." } : this.away(now, gate)) ?? { code: "unreached", why: "This computer couldn't reach 10 & 2." };
      this.save(id, "missed", { ...r.extra, outcome }, true);
      this.log(`schedules: ${id} missed (${outcome.code})`);
      this.changed();
      return;
    }
    const due = dueAt !== null && dueAt <= now;
    if (!gate) {
      if (due) this.hold(r, this.away(dueAt!, false)!, true);
      return;
    }
    if (due && !r.extra.late && this.slept(dueAt!)) this.hold(r, this.away(dueAt!, true)!, true);
    let at = dueAt;
    if (!("at" in s.when) && r.extra.metAt === undefined) {
      const t = await this.trigger(s, now);
      const fresh = this.row(id);
      if (!fresh || fresh.state !== "waiting") return;
      if (t === "met") {
        at = this.now();
        this.save(id, "waiting", { ...fresh.extra, metAt: at });
        this.changed();
      } else if (t.hold) return void this.hold(fresh, t, false);
      else return void this.finish(id, "not_sent", t);
    }
    if (at === null || at > this.now()) return;
    if ("after" in s.when && s.when.notBefore && Date.parse(s.when.notBefore) > this.now()) return;
    // Asked first outside the Ledger, so a send held for an hour doesn't write the audit log at every look.
    const pre = await this.checks(s, {});
    const fresh = this.row(id);
    if (!fresh || fresh.state !== "waiting") return;
    if (pre?.hold) return void this.hold(fresh, pre, true);
    if (pre) return void this.finish(id, "not_sent", pre);
    await this.fire(s, at);
  }

  /** Not yet: why, kept for Watching; at its time, the first such reason is what a late send is told with. */
  private hold(r: Row, reason: Reason, due: boolean) {
    const extra: Extra = { ...r.extra, hold: reason, ...(due && !r.extra.late ? { late: reason } : {}) };
    if (JSON.stringify(extra) === JSON.stringify(r.extra)) return;
    this.save(r.id, "waiting", extra);
    this.changed();
  }

  private finish(id: string, state: "not_sent" | "missed", outcome: Reason) {
    const r = this.row(id);
    if (!r) return;
    this.save(id, state, { ...r.extra, outcome }, true);
    this.log(`schedules: ${id} not sent (${outcome.code}: ${outcome.why})`);
    this.changed();
  }

  /**
   * A chain's trigger on this computer (spike/relay's clean finish): a run past the baseline, not running, no subagent
   * busy, not failed or stopped, no question, and its reply not ending in one. "met", a final reason, or why it's still
   * waiting (`working`).
   */
  private async trigger(s: Schedule, now: number): Promise<"met" | Verdict> {
    const after = (s.when as { after: { itemId: string; lastRunAt: string | null } }).after;
    const working: Verdict = { hold: true, code: "working", why: "The thread it waits for hasn't finished." };
    try { if (!this.opts.local.ready(after.itemId)) return { hold: true, code: "app", why: `${this.opts.local.systemOf(after.itemId)} isn't running on this computer.`, app: this.opts.local.systemOf(after.itemId) }; }
    catch { return { hold: false, code: "vanished", why: "The thread it waited for is gone." }; }
    const items = await this.opts.local.list();
    const a = items.find((i) => i.id === after.itemId);
    if (!a || a.settled) return { hold: false, code: "vanished", why: "The thread it waited for is gone." };
    if (a.pendingQuestion) return { hold: false, code: "asked", why: "The thread it waited for stopped to ask something." };
    if (a.status === "running") return working;
    if (!a.lastRunAt || sameTime(a.lastRunAt, after.lastRunAt) || (after.lastRunAt && Date.parse(a.lastRunAt) < Date.parse(after.lastRunAt))) return working;
    if (a.status === "failed") return { hold: false, code: "failed", why: "The thread it waited for failed." };
    if (a.status === "cancelled") return { hold: false, code: "stopped", why: "The thread it waited for was stopped." };
    if (subagentsBusy(a, items, now)) return working;
    const rep = await this.opts.local.report(a.id).catch(() => null);
    if (rep && (rep.question || endsAsking(rep.text))) return { hold: false, code: "asked", why: "The thread it waited for stopped to ask something." };
    return "met";
  }

  /**
   * The computer's checks at firing (engine.md §5's table), last thing before dispatch: why it waits (`hold`, tried again
   * at the next look until its end) or why it's never sent (final), or null to send. `seen` gets the target as it is, a
   * chain's baseline.
   */
  private async checks(s: Schedule, seen: { after?: Extra["after"] }): Promise<Verdict | null> {
    const local = this.opts.local;
    const a = s.action;
    const policy = policyRefusal(this.opts.policy, a);
    if (policy) return { ...policy, hold: false };
    const target = a.kind === "start_work" ? a.placeId : (a as { itemId: string }).itemId;
    let ready: boolean;
    try { ready = local.ready(target); } catch { return { hold: false, code: "gone", why: "Its work system isn't on this computer any more." }; }
    if (!ready) { const app = local.systemOf(target); return { hold: true, code: "app", why: `${app} isn't running on this computer.`, app }; }
    if (a.kind === "start_work") {
      if (!local.places().some((p) => p.id === a.placeId)) return { hold: false, code: "place", why: "Its project isn't on this computer any more." };
    } else if (a.kind === "follow_up") {
      const items = await local.list();
      const item = items.find((i) => i.id === a.itemId);
      const g = s.guard;
      if (!item) return { hold: false, code: "gone", why: "The thread is gone." };
      if (item.settled) return { hold: false, code: "settled", why: "The thread is settled." };
      // You, not 10 & 2: its own sends aren't you writing (typed, the engine's stage 3.9); an older adapter's wroteAt.
      const wrote = item.typed ? item.typed.at : item.wroteAt;
      if (wrote && Date.parse(wrote) > Date.parse(g.agreedAt)) return { hold: false, code: "wrote", why: "You wrote in it after this was set up." };
      if (item.status === "running") return g.running ? { hold: true, code: "busy", why: "It's still working." } : { hold: false, code: "ran", why: "It ran again after this was set up." };
      if (!g.running && !sameTime(item.lastRunAt, g.lastRunAt)) return { hold: false, code: "ran", why: "It ran again after this was set up." };
      // Holding a command at its time (Commands that wait; Fable's 4-H3): the words would stop it, so never sent.
      if (item.gate) return { hold: false, code: "asking", why: "It's asking something else now." };
      // Sent now, the words would be taken as the answer to a question it didn't ask at the yes.
      if (item.pendingQuestion && (item.questionId ?? null) !== g.questionId) return { hold: false, code: "asking", why: "It's asking something else now." };
      if (subagentsBusy(item, items, this.now())) return { hold: true, code: "busy", why: "Its subagents are still working." };
      seen.after = { lastRunAt: item.lastRunAt ?? null, questionId: item.pendingQuestion ? item.questionId ?? null : null };
    }
    const refused = await local.check(a);
    return refused ? { hold: false, code: "refused", why: refused } : null;
  }

  /** Hands it to its work system through the Ledger, under its own id, claiming the row in the dispatch's transaction. */
  private async fire(s: Schedule, at: number) {
    const local = this.opts.local;
    let verdict: Verdict | null = null;
    let claimed: boolean | undefined;
    const seen: { after?: Extra["after"] } = {};
    const how: How = { scheduled: { agreedAt: s.guard.agreedAt, ...("at" in s.when ? { at: toIso(at) } : {}), zone: s.zone } };
    this.inflight.add(s.id);
    try {
      const receipt = await this.opts.ledger.execute(s.action, s.id, {
        retrySafe: local.retrySafe(s.action),
        refuse: async () => { verdict = await this.checks(s, seen); return verdict ? { ok: false, error: verdict.why } : null; },
        claim: () => (claimed = this.claim(s.id, seen.after)),
        execute: () => local.dispatch(s.action, s.id, how),
        leftOut: () => local.sendLeftOut(s.action, s.id),
      });
      // Stopped while its checks were awaited: nothing was sent or recorded.
      if (claimed === false) return;
      const v = verdict as Verdict | null;
      if (v) {
        const r = this.row(s.id);
        if (r && r.state === "waiting") v.hold ? this.hold(r, v, true) : this.finish(s.id, "not_sent", v);
        return;
      }
      this.outcome(s.id, receipt);
    } finally {
      this.inflight.delete(s.id);
      this.dispatching.delete(s.id);
    }
  }

  /**
   * Synchronous, in the Ledger's dispatch transaction: `firing` only if it's still waiting, and only while it may fire
   * (`gate`): a set that arrived while the checks were awaited (busy, or not yet applied), or the link closing then,
   * leaves it waiting for the next look (Stop always wins).
   */
  private claim(id: string, after: Extra["after"]): boolean {
    const r = this.row(id);
    if (!r || r.state !== "waiting" || !this.opts.gate()) return false;
    this.save(id, "firing", { ...r.extra, firedAt: this.now(), ...(after ? { after } : {}) });
    this.dispatching.add(id);
    return true;
  }

  /** The same for a resend after a restart (`recover`): only if it's still firing (no set has left it out) and may fire. */
  private reclaim(id: string): boolean {
    const r = this.row(id);
    if (!r || r.state !== "firing" || !this.opts.gate()) return false;
    this.dispatching.add(id);
    return true;
  }

  private outcome(id: string, receipt: Receipt) {
    const r = this.row(id);
    if (!r || (r.state !== "firing" && r.state !== "waiting")) return;
    const state = receipt.ok ? "sent" : receipt.unknown ? "unknown" : "not_sent";
    this.save(id, state, { ...r.extra, firedAt: r.extra.firedAt ?? this.now(), receipt, ...(state === "not_sent" ? { outcome: { code: "refused" as const, why: (receipt as { error: string }).error } } : {}) }, true);
    this.log(`schedules: ${id} ${state}`);
    this.changed();
  }

  /**
   * A row a restart left `firing`: through the Ledger again with its id, never as a new send. A work system that dedupes
   * (T3 Code) is sent it again with the same key, as any send goes: inside its window, while it may fire (`gate`: the
   * reconnect's first set applied, so a Stop meanwhile has left it out, `set`), its policy allowing it, once its work
   * system is running, and past §5's checks at firing, asked first and again as the Ledger's refuse (stage 4's review:
   * written in, run again, asking something else or holding a command since the yes). A check that holds waits for the
   * next look; past its end, no longer allowed, or any other check, it's unknown (the first may have gone) and never
   * sent again. Any other work system answers unknown and doesn't resend.
   */
  private async recover(r: Row, s: Schedule) {
    const local = this.opts.local;
    const state = (this.db.prepare("SELECT state FROM actions WHERE key = ?").get(s.id) as { state: string } | undefined)?.state;
    if (state === undefined) return this.outcome(s.id, STOPPED_SENDING);
    const retrySafe = (() => { try { return local.retrySafe(s.action); } catch { return false; } })();
    const target = s.action.kind === "start_work" ? s.action.placeId : (s.action as { itemId: string }).itemId;
    // What the Ledger would send again: a dispatch with no outcome, or one lost as it went, to a work system that dedupes.
    const resend = retrySafe && (state === "dispatching" || state === "unknown");
    if (resend) {
      if (this.now() > Date.parse(s.until) || policyRefusal(this.opts.policy, s.action)) return this.outcome(s.id, STOPPED_SENDING);
      if (!this.opts.gate()) return;
      if (!(() => { try { return local.ready(target); } catch { return false; } })()) return;
      const pre = await this.checks(s, {});
      const fresh = this.row(s.id);
      if (!fresh || fresh.state !== "firing") return;
      if (pre) return pre.hold ? undefined : this.outcome(s.id, STOPPED_SENDING);
    }
    let verdict: Verdict | null = null;
    let claimed: boolean | undefined;
    this.inflight.add(s.id);
    try {
      const receipt = await this.opts.ledger.execute(s.action, s.id, {
        retrySafe,
        ...(resend ? {
          refuse: async () => { verdict = await this.checks(s, {}); return verdict ? { ok: false, error: verdict.why } : null; },
          claim: () => (claimed = this.reclaim(s.id)),
        } : {}),
        execute: () => local.dispatch(s.action, s.id),
        leftOut: () => local.sendLeftOut(s.action, s.id),
      });
      // Left out of a set (Stop), or the link no longer synced, while the checks were awaited: as that set left it, or
      // the next look.
      if (claimed === false) return;
      const v = verdict as Verdict | null;
      if (v) return v.hold ? undefined : this.outcome(s.id, STOPPED_SENDING);
      this.outcome(s.id, receipt);
    } finally {
      this.inflight.delete(s.id);
      this.dispatching.delete(s.id);
    }
  }

  /** Runs the runner: a look at least every 15 s on the wall clock, at each one's time, and at each work system's change. */
  start() {
    if (this.beats) return;
    this.beats = setInterval(() => void this.tick(), TICK_MS);
    this.beats.unref?.();
    this.unwatch = this.opts.local.watch(() => this.poke());
    this.arm(0);
  }
  stop() {
    if (this.beats) clearInterval(this.beats);
    if (this.timer) clearTimeout(this.timer);
    this.beats = this.timer = null;
    this.unwatch?.(); this.unwatch = null;
  }
  private arm(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, Math.max(0, Math.min(ms, TICK_MS)));
    this.timer.unref?.();
  }
  /** The next look: the soonest time a waiting one is due, at most a tick away. */
  private plan() {
    if (!this.beats) return;
    const now = this.now();
    const next = this.rows("device = ? AND v = 1 AND state = 'waiting'", this.opts.device).map((r) => {
      const s = JSON.parse(r.body) as Schedule;
      return "at" in s.when ? Date.parse(s.when.at) : s.when.notBefore ? Date.parse(s.when.notBefore) : Infinity;
    }).filter((t) => t > now).reduce((a, b) => Math.min(a, b), Infinity);
    this.arm(Math.min(TICK_MS, next - now));
  }
}

/** The pairing a credential belongs to: its device id, or for a brain of your own a hash of its token. */
export function deviceOf(token: string, deviceId: string | null | undefined): string {
  return deviceId ?? `t-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

/**
 * `10and2 revoke`, once the connector has stopped: every waiting row cancelled, so nothing set up for the account it
 * was connected to goes later. A connector still running holds the database; it cancels them itself when it's told.
 */
export function cancelWaiting(db: DatabaseSync, now = Date.now()): number {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get();
  if (!exists) return 0;
  return Number(db.prepare("UPDATE schedules SET state = 'cancelled', done_at = ? WHERE v = 1 AND state = 'waiting'").run(now).changes);
}
