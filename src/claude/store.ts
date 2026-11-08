import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt } from "../contract.ts";

/** What Driver keeps for a Claude session itself, since Claude has no such state. */
export type OverlayKind = "settle" | "snooze" | "archive" | "unsettle" | "unsnooze";
export type Overlay = { settledAt: string | null; snoozedAt: string | null; snoozedUntil: string | null; archived: number };
export type Operation = { hash: string; receipt: string | null };
export type Run = { sessionId: string; pid: number | null; procStart: string | null };

/** Claude state lives in its own database, independent of the connector transport ledger. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS claude_overlay (sessionId TEXT PRIMARY KEY, settledAt TEXT, snoozedAt TEXT, snoozedUntil TEXT, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS claude_operations (key TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS claude_runs (sessionId TEXT PRIMARY KEY, pid INTEGER, procStart TEXT);
      CREATE TABLE IF NOT EXISTS claude_started (sessionId TEXT PRIMARY KEY);`);
  }
  overlay(id: string): Overlay {
    return (this.db.prepare("SELECT * FROM claude_overlay WHERE sessionId=?").get(id) as Overlay | undefined) ?? { settledAt: null, snoozedAt: null, snoozedUntil: null, archived: 0 };
  }
  operation(key: string): Operation | undefined { return this.db.prepare("SELECT hash, receipt FROM claude_operations WHERE key=?").get(key) as Operation | undefined; }
  begin(key: string, hash: string, id?: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.operation(key) || (id && this.run(id))) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO claude_operations(key,hash) VALUES(?,?)").run(key, hash);
      if (id) this.db.prepare("INSERT INTO claude_runs(sessionId) VALUES(?)").run(id);
      this.db.exec("COMMIT"); return true;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  completeOverlay(key: string, hash: string, id: string, kind: OverlayKind, at: string, until?: string): Receipt | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.operation(key)) { this.db.exec("ROLLBACK"); return null; }
      this.db.prepare("INSERT INTO claude_operations(key,hash) VALUES(?,?)").run(key, hash);
      this.apply(id, kind, at, until);
      const receipt = this.finish(key, { ok: true });
      this.db.exec("COMMIT");
      return receipt;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  finish(key: string, receipt: Receipt): Receipt {
    this.db.prepare("UPDATE claude_operations SET receipt=? WHERE key=?").run(JSON.stringify(receipt), key);
    return receipt;
  }
  /** Sessions Driver started or sent to: headless runs, yet the user's work, so they're listed. */
  markStarted(id: string) { this.db.prepare("INSERT OR IGNORE INTO claude_started(sessionId) VALUES(?)").run(id); }
  startedByDriver(id: string): boolean { return this.db.prepare("SELECT 1 FROM claude_started WHERE sessionId=?").get(id) !== undefined; }
  run(id: string): Run | undefined { return this.db.prepare("SELECT * FROM claude_runs WHERE sessionId=?").get(id) as Run | undefined; }
  runs(): Run[] { return this.db.prepare("SELECT * FROM claude_runs").all() as Run[]; }
  started(id: string, pid: number, procStart: string | null) { this.db.prepare("UPDATE claude_runs SET pid=?,procStart=? WHERE sessionId=?").run(pid, procStart, id); }
  ended(id: string, pid?: number) {
    if (pid === undefined) this.db.prepare("DELETE FROM claude_runs WHERE sessionId=?").run(id);
    else this.db.prepare("DELETE FROM claude_runs WHERE sessionId=? AND pid=?").run(id, pid);
  }
  apply(id: string, kind: OverlayKind, at: string, until?: string) {
    this.db.prepare("INSERT OR IGNORE INTO claude_overlay(sessionId) VALUES(?)").run(id);
    if (kind === "settle") this.db.prepare("UPDATE claude_overlay SET settledAt=?,snoozedUntil=NULL WHERE sessionId=?").run(at, id);
    if (kind === "snooze") this.db.prepare("UPDATE claude_overlay SET snoozedAt=?,snoozedUntil=?,settledAt=NULL WHERE sessionId=?").run(at, until!, id);
    if (kind === "archive") this.db.prepare("UPDATE claude_overlay SET archived=1 WHERE sessionId=?").run(id);
    if (kind === "unsettle") this.db.prepare("UPDATE claude_overlay SET settledAt=NULL WHERE sessionId=?").run(id);
    if (kind === "unsnooze") this.db.prepare("UPDATE claude_overlay SET snoozedAt=NULL,snoozedUntil=NULL WHERE sessionId=?").run(id);
  }
  close() { this.db.close(); }
}
