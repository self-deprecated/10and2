// Record intent durably before the adapter sees it. An unknown result is only resent when that adapter promises
// backend deduplication; a local process or channel send cannot make that promise.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Action, Receipt } from "./contract.ts";
import { describe } from "./util.ts";
import { stateDirectory } from "./paths.ts";


/** Sorted object keys make retries independent of JSON property order. */
export function actionHash(action: Action): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(action))).digest("hex");
}

type Row = { action_hash: string; state: string; receipt: string | null };
const uncertain = (): Receipt => ({ ok: false, unknown: true, error: "The connector lost the outcome. It won't resend this action because this work system cannot safely retry it." });

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly audit: number;
  private readonly pending = new Map<string, { hash: string; result: Promise<Receipt> }>();

  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "connector.db");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      // Keep one owner of the ledger. SQLite releases this lock on a crash, unlike a PID file; another connector
      // must not mistake this process's in-flight dispatch for crash recovery and send it again.
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS actions (key TEXT PRIMARY KEY, action_hash TEXT NOT NULL, state TEXT NOT NULL, action TEXT NOT NULL, receipt TEXT);`);
    } catch (e) { this.db.close(); throw e; }
    this.audit = openSync(join(directory, "audit.jsonl"), "a", 0o600);
    chmodSync(join(directory, "audit.jsonl"), 0o600);
  }

  /**
   * Runs an action at most once per key. `refuse` is asked first, every time a dispatch would happen: a refusal there
   * (expired, not allowed, the session is busy) is answered and forgotten, never stored against the key, so a later
   * "yes" with the same key can still go ahead. Only what happened after dispatch is kept.
   */
  execute(action: Action, key: string, opts: { retrySafe: boolean; refuse?: () => Promise<Receipt | null>; execute: () => Promise<Receipt> }): Promise<Receipt> {
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
      this.db.prepare(`INSERT INTO actions (key, action_hash, state, action) VALUES (?, ?, 'dispatching', ?)
        ON CONFLICT(key) DO UPDATE SET state = 'dispatching', receipt = NULL`).run(key, hash, JSON.stringify(action));
      this.log({ key, actionHash: hash, action, state: "dispatching" });
      const receipt = await opts.execute().catch((e): Receipt => ({ ok: false, unknown: true, error: describe(e) }));
      this.finish(key, receipt);
      return receipt;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { hash, result });
    return result;
  }

  private finish(key: string, receipt: Receipt) {
    const state = receipt.ok ? "accepted" : receipt.unknown ? "unknown" : "rejected";
    this.db.prepare("UPDATE actions SET state = ?, receipt = ? WHERE key = ?").run(state, JSON.stringify(receipt), key);
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
