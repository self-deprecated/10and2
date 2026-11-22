// Record intent durably before the adapter sees it. An unknown result is only resent when that adapter promises
// backend deduplication; a local process or channel send cannot make that promise.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Action, Receipt } from "./contract.ts";
import { describe } from "./util.ts";
import { databasePath, stateDirectory } from "./paths.ts";
import { digestOf, type Found, type Sent } from "./typed.ts";

/**
 * How long a send's row is kept (Fable on 3.9): as long as its message may still be reported and read, so it's never
 * taken for you writing hours later. Away lasts at most 72 hours and news is kept a day; a month is well past both.
 * `typedOf`'s own 12 hours (`SEND_TAKES_MS`) is how long after it a send's message may first show, not how long it's kept.
 */
export const SENT_KEPT_MS = 30 * 86_400_000;


/**
 * Whether a connector is running from `directory`: one holds its ledger locked from soon after it starts until it ends,
 * however it ends, unlike a pid, which Windows soon gives to another process. Undefined when it can't be told (no ledger
 * there yet). A connector starting meanwhile waits out this brief look (the ledger's busy_timeout).
 */
export function ledgerHeld(directory = stateDirectory()): boolean | undefined {
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath(join(directory, "connector.db")), { readOnly: true }); } catch { return undefined; }
  try { db.prepare("SELECT 1 FROM sqlite_master").get(); return false; }
  catch (e) { return (((e as { errcode?: number }).errcode ?? 0) & 0xff) === 5 /* SQLITE_BUSY */ ? true : undefined; }
  finally { db.close(); }
}

/** Sorted object keys make retries independent of JSON property order. */
export function actionHash(action: Action): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(action))).digest("hex");
}

type Row = { action_hash: string; state: string; receipt: string | null };
/** What `execute` answers when its `claim` says no: nothing was sent, and nothing is kept against the key. */
export const NOT_CLAIMED: Receipt = { ok: false, error: "It was stopped before it was sent. Nothing was sent." };
const uncertain = (): Receipt => ({ ok: false, unknown: true, error: "The connector lost the outcome. It won't resend this action because this work system cannot safely retry it." });

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly audit: number;
  private readonly pending = new Map<string, { hash: string; result: Promise<Receipt> }>();

  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "connector.db");
    this.db = new DatabaseSync(databasePath(path));
    chmodSync(path, 0o600);
    try {
      // Keep one owner of the ledger. SQLite releases this lock on a crash, unlike a PID file; another connector
      // must not mistake this process's in-flight dispatch for crash recovery and send it again. A second waits a
      // moment for it, as it does for `10and2 status` looking whether it's held (ledgerHeld), and then fails.
      this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS actions (key TEXT PRIMARY KEY, action_hash TEXT NOT NULL, state TEXT NOT NULL, action TEXT NOT NULL, receipt TEXT);
        CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, item TEXT, digest TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, v INTEGER, device TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL,
          state TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', set_at INTEGER NOT NULL, done_at INTEGER);
        CREATE TABLE IF NOT EXISTS schedule_sync (device TEXT PRIMARY KEY, seq INTEGER NOT NULL);`);
      // The message each send was found as (`claim`), added to a store from before it, each column by itself: a crash
      // between the two leaves one, which the next start adds to rather than fails on.
      const columns = (this.db.prepare("PRAGMA table_info(sent)").all() as { name: string }[]).map((c) => c.name);
      for (const c of ["found_item", "found_at"]) if (!columns.includes(c)) this.db.exec(`ALTER TABLE sent ADD COLUMN ${c} TEXT`);
    } catch (e) { this.db.close(); throw e; }
    this.audit = openSync(join(directory, "audit.jsonl"), "a", 0o600);
    chmodSync(join(directory, "audit.jsonl"), 0o600);
  }

  /**
   * The ledger's own connection, for the schedules held here (schedules.ts): on this one handle, under its exclusive
   * lock, so only one connector process can ever fire a schedule, and a schedule's claim and its dispatch's record are
   * written in one transaction (`execute`'s `claim`).
   */
  get handle(): DatabaseSync { return this.db; }

  /**
   * Runs an action at most once per key. `refuse` is asked first, every time a dispatch would happen: a refusal there
   * (expired, not allowed, the session is busy) is answered and forgotten, never stored against the key, so a later
   * "yes" with the same key can still go ahead. Only what happened after dispatch is kept. `leftOut`, asked once it's
   * dispatched: whether its work system never writes this send as a person's message, or its adapter leaves that
   * message out by its own mark (`Local.sendLeftOut`), so its `sent` row goes rather than claim the user's same words later.
   * `claim`, asked synchronously once `refuse` has passed, in the same transaction as the dispatch's record: false (a
   * schedule stopped while `refuse` was awaited) sends nothing and records nothing (`NOT_CLAIMED`).
   */
  execute(action: Action, key: string, opts: { retrySafe: boolean; refuse?: () => Promise<Receipt | null>; claim?: () => boolean; execute: () => Promise<Receipt>; leftOut?: () => boolean }): Promise<Receipt> {
    const hash = actionHash(action);
    const conflict: Receipt = { ok: false, error: "That operation key was already used for a different action. Nothing was sent." };
    const active = this.pending.get(key);
    if (active) return active.hash === hash ? active.result : Promise.resolve(conflict);
    const row = this.db.prepare("SELECT action_hash, state, receipt FROM actions WHERE key = ?").get(key) as Row | undefined;
    if (row && row.action_hash !== hash) return Promise.resolve(conflict);
    if (row && row.state !== "dispatching" && (row.state !== "unknown" || !opts.retrySafe)) return Promise.resolve(JSON.parse(row.receipt!));
    if (row && !opts.retrySafe) {
      const receipt = uncertain();
      this.finish(key, receipt);
      return Promise.resolve(receipt);
    }
    // Defer until the pending map owns the key, including a second call in this same tick.
    const result = Promise.resolve().then(async (): Promise<Receipt> => {
      const refusal = await opts.refuse?.().catch((e): Receipt => ({ ok: false, error: describe(e) }));
      if (refusal) {
        this.log({ key, actionHash: hash, action, state: "refused", receipt: refusal });
        // An earlier attempt's outcome is still unknown; a refusal now doesn't make it a known failure.
        return row ? { ...refusal, ok: false, unknown: true } as Receipt : refusal;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (opts.claim && !opts.claim()) { this.db.exec("ROLLBACK"); return NOT_CLAIMED; }
        this.db.prepare(`INSERT INTO actions (key, action_hash, state, action) VALUES (?, ?, 'dispatching', ?)
          ON CONFLICT(key) DO UPDATE SET state = 'dispatching', receipt = NULL`).run(key, hash, JSON.stringify(action));
        this.db.exec("COMMIT");
      } catch (e) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw e; }
      this.sending(action, key);
      this.log({ key, actionHash: hash, action, state: "dispatching" });
      const receipt = await opts.execute().catch((e): Receipt => ({ ok: false, unknown: true, error: describe(e) }));
      if (opts.leftOut?.() === true) this.db.prepare("DELETE FROM sent WHERE key = ?").run(key);
      this.finish(key, receipt);
      return receipt;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { hash, result });
    return result;
  }

  /**
   * 10 & 2's own words, recorded before the work system has them (the engine's stage 3.9): what `WorkItem.typed` leaves
   * out, so they're never taken for you writing (typed.ts). Kept for `SENT_KEPT_MS`, then pruned.
   */
  private sending(action: Action, key: string) {
    if (action.kind !== "follow_up" && action.kind !== "start_work") return;
    const now = Date.now();
    this.db.prepare("DELETE FROM sent WHERE at < ?").run(now - SENT_KEPT_MS);
    this.db.prepare("INSERT OR REPLACE INTO sent (key, item, digest, at) VALUES (?, ?, ?, ?)").run(key, action.kind === "follow_up" ? action.itemId : null, digestOf(action.message), now);
  }

  /**
   * 10 & 2's own sends as kept (`SENT_KEPT_MS`), oldest first: each claims its message for as long as that message can be
   * read, not only while it may first show (Fable on 3.9: a send 13 hours old was taken for you writing).
   */
  sends(): Sent[] {
    type Row = { key: string; item: string | null; digest: string; at: number; found_item: string | null; found_at: string | null };
    return (this.db.prepare("SELECT key, item, digest, at, found_item, found_at FROM sent ORDER BY at").all() as Row[])
      .map((r) => ({ key: r.key, item: r.item ?? null, digest: r.digest, at: r.at, found: r.found_item && r.found_at ? { item: r.found_item, at: r.found_at } : null }));
  }

  /**
   * Send `key` was found as the message `found` (typed.ts `typedOf`): kept, so it takes only that message from now on,
   * after a restart too, never a later one with the same words (the review of 45ec9eccdf6f, F5).
   */
  claim(key: string, found: Found): void {
    this.db.prepare("UPDATE sent SET found_item = ?, found_at = ? WHERE key = ? AND found_at IS NULL").run(found.item, found.at, key);
  }

  private finish(key: string, receipt: Receipt) {
    const state = receipt.ok ? "accepted" : receipt.unknown ? "unknown" : "rejected";
    this.db.prepare("UPDATE actions SET state = ?, receipt = ? WHERE key = ?").run(state, JSON.stringify(receipt), key);
    // Refused by the work system: nothing of it will show.
    if (!receipt.ok && !receipt.unknown) this.db.prepare("DELETE FROM sent WHERE key = ?").run(key);
    this.log({ key, state, receipt });
  }
  private log(value: object) {
    appendFileSync(this.audit, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
    fsyncSync(this.audit);
  }
  async close() {
    await Promise.allSettled([...this.pending.values()].map((p) => p.result));
    this.db.close();
    closeSync(this.audit);
  }
}
