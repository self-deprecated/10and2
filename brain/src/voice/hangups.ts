// A GPT-Live session bills until OpenAI ends it, so a session the brain has lost track of is money draining away.
// Every session is recorded the moment OpenAI returns its id, and counts as over only once OpenAI confirms it: a
// hang-up it accepts, a hang-up it answers with "already ended", or session.closed on the sideband. Until then the
// brain keeps hanging up, with backoff, for as long as it runs, and starts again at every start. It never gives up.
// The database is only a record: if it fails (a full disk), the reaper keeps the session in memory and carries on.
import type { Store } from "../store.ts";
import { describe } from "../util.ts";
import type { Track } from "../analytics.ts";

/** After the first failed hang-up, wait 5 s, then 15 s, then 60 s, then every 5 minutes. */
export const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

export class Hangups {
  /** Sessions being hung up: how many attempts have failed, since when, and the next one. */
  private readonly trying = new Map<string, { failures: number; failedAt: number | null; timer: NodeJS.Timeout | null }>();
  /**
   * Confirmed over by OpenAI when the store couldn't record it, with the next try at recording it: until it's stored, a
   * restart would take the session for one that may still bill.
   */
  private readonly confirmed = new Map<string, { failures: number; timer: NodeJS.Timeout | null }>();
  private readonly store: Store;
  /** One hang-up attempt: resolves once OpenAI confirms the session is over, rejects otherwise. */
  private readonly hangup: (sessionId: string) => Promise<void>;
  private readonly log: (m: string) => void;
  private readonly retryMs: number[];
  /** Usage analytics: every failed hang-up, and the confirmation after one (the billing alert's events). */
  private readonly track: Track;

  constructor(deps: { store: Store; hangup: (sessionId: string) => Promise<void>; log: (m: string) => void; retryMs?: number[]; track?: Track }) {
    this.store = deps.store;
    this.hangup = deps.hangup;
    this.log = deps.log;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.track = deps.track ?? (() => {});
  }

  /**
   * OpenAI returned a session id: from now on the session is the brain's to end. If it can't be recorded, nothing
   * would find it after a restart, so it's hung up at once (from memory) and the error is thrown: the session fails.
   */
  created(sessionId: string, conversationId: string) {
    try {
      this.store.startSession(sessionId, conversationId);
    } catch (e) {
      this.log(`voice ${sessionId}: couldn't record the session (${describe(e)}); hanging it up now`);
      this.close(sessionId);
      throw e;
    }
  }

  /** Hangs the session up unless OpenAI has already confirmed it's over, and keeps trying until it does. */
  close(sessionId: string) {
    if (this.trying.has(sessionId) || this.closed(sessionId)) return;
    this.trying.set(sessionId, { failures: 0, failedAt: null, timer: null });
    void this.attempt(sessionId);
  }

  /** At start: every session a previous run didn't see confirmed over (a crash, a failed hang-up) is hung up again. */
  resume() {
    let ids: string[];
    try {
      ids = this.store.unclosedSessions();
    } catch (e) {
      return this.log(`voice: COULDN'T READ WHICH SESSIONS MAY STILL BILL (${describe(e)})`);
    }
    for (const id of ids) {
      this.record(id, () => this.store.endSession(id, null, { kind: "restarted" }));
      this.close(id);
    }
  }

  /**
   * Sessions that may still be billing: a hang-up failed and OpenAI hasn't confirmed them over. Both what the store
   * recorded and what it couldn't (failures kept only in memory) count.
   */
  alert(): { sessions: number; since: number } | null {
    const failed = new Map<string, number>();
    try {
      for (const f of this.store.failedHangups()) failed.set(f.id, f.since);
    } catch (e) {
      this.log(`voice: couldn't read failed hang-ups (${describe(e)})`);
    }
    for (const [id, t] of this.trying) if (t.failedAt !== null) failed.set(id, Math.min(failed.get(id) ?? t.failedAt, t.failedAt));
    for (const id of this.confirmed.keys()) failed.delete(id);
    return failed.size ? { sessions: failed.size, since: Math.min(...failed.values()) } : null;
  }

  /** Stops retrying (shutdown and tests). The sessions stay unconfirmed, so the next start tries them again. */
  stop() {
    for (const t of [...this.trying.values(), ...this.confirmed.values()]) if (t.timer) clearTimeout(t.timer);
    this.trying.clear();
  }

  private async attempt(sessionId: string) {
    const t = this.trying.get(sessionId);
    if (!t) return;
    t.timer = null;
    if (this.closed(sessionId)) return void this.trying.delete(sessionId);
    try {
      await this.hangup(sessionId);
    } catch (e) {
      if (this.trying.get(sessionId) !== t) return; // stopped meanwhile
      if (this.closed(sessionId)) return void this.trying.delete(sessionId);
      // The next try is scheduled before anything is written, so a failing store can't stop the retries.
      t.failures++;
      t.failedAt ??= Date.now();
      const delay = this.retryMs[Math.min(t.failures - 1, this.retryMs.length - 1)];
      t.timer = setTimeout(() => void this.attempt(sessionId), delay);
      t.timer.unref();
      this.log(`voice ${sessionId}: HANG-UP FAILED (try ${t.failures}): ${describe(e)}. It may still be billing; trying again in ${Math.round(delay / 1000)} s`);
      const status = (e as { status?: unknown }).status;
      this.track("hangup_failed", { session_id: sessionId, attempt: t.failures, http_status: typeof status === "number" ? status : null });
      this.record(sessionId, () => this.store.hangupFailed(sessionId, t.failedAt!));
      return;
    }
    this.trying.delete(sessionId);
    this.log(`voice ${sessionId}: hung up${t.failures ? ` after ${t.failures} failed ${t.failures === 1 ? "try" : "tries"}` : ""}`);
    if (t.failures) this.track("hangup_confirmed", { session_id: sessionId, after_failures: t.failures, minutes: Math.round((Date.now() - t.failedAt!) / 60_000) });
    this.confirmed.set(sessionId, { failures: 0, timer: null });
    this.saveClosed(sessionId);
  }

  /** Records OpenAI's confirmation, retrying with the same backoff until the store takes it. */
  private saveClosed(sessionId: string) {
    const c = this.confirmed.get(sessionId);
    if (!c) return;
    c.timer = null;
    if (this.record(sessionId, () => this.store.sessionClosed(sessionId))) return void this.confirmed.delete(sessionId);
    c.failures++;
    c.timer = setTimeout(() => this.saveClosed(sessionId), this.retryMs[Math.min(c.failures - 1, this.retryMs.length - 1)]);
    c.timer.unref();
  }

  /** OpenAI has confirmed it, by the store's record or (when the store failed) the reaper's own. */
  private closed(sessionId: string): boolean {
    if (this.confirmed.has(sessionId)) return true;
    try {
      return this.store.isClosed(sessionId);
    } catch (e) {
      this.log(`voice ${sessionId}: couldn't read whether it's closed (${describe(e)}); hanging up anyway`);
      return false;
    }
  }

  /** Writes to the store; a failure is logged and never stops the reaper. */
  private record(sessionId: string, write: () => void): boolean {
    try {
      write();
      return true;
    } catch (e) {
      this.log(`voice ${sessionId}: couldn't record it (${describe(e)}); the reaper carries on from memory`);
      return false;
    }
  }
}
