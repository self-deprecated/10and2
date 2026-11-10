// A synthetic OpenCode database in the layout OpenCode 1.19.5 writes (the tables the adapter reads, as `sqlite_master`
// showed them), with helpers to add projects, sessions, messages and parts as OpenCode stores them.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS \`project\` (\`id\` text PRIMARY KEY, \`worktree\` text NOT NULL, \`vcs\` text, \`name\` text, \`icon_url\` text, \`icon_url_override\` text,
  \`icon_color\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`time_initialized\` integer, \`sandboxes\` text NOT NULL, \`commands\` text);
CREATE TABLE IF NOT EXISTS \`session\` (\`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text, \`slug\` text NOT NULL,
  \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL, \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer,
  \`summary_deletions\` integer, \`summary_files\` integer, \`summary_diffs\` text, \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL,
  \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_read\` integer DEFAULT 0 NOT NULL, \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text, \`permission\` text, \`agent\` text,
  \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`time_compacting\` integer, \`time_archived\` integer,
  CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS \`message\` (\`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL, CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS \`part\` (\`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
  CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX IF NOT EXISTS \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
CREATE INDEX IF NOT EXISTS \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX IF NOT EXISTS \`session_parent_idx\` ON \`session\` (\`parent_id\`);`;

let seq = 0;
/** Ids as OpenCode makes them: a prefix, then hex that sorts in creation order. */
export const newId = (prefix: string) => `${prefix}_${(BigInt(Date.now()) * 4096n + BigInt(seq++ % 4096)).toString(16).padStart(14, "0")}${randomBytes(6).toString("hex")}`;

export type AssistantOpts = { text?: string; completed?: boolean; error?: string; finish?: string; question?: unknown[]; agent?: string; at?: number; summary?: boolean };

export class FakeDb {
  readonly path: string;
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" + SCHEMA);
    this.project("/", "global", null);
  }
  project(worktree: string, id = newId("prj"), vcs: string | null = "git") {
    this.db.prepare("INSERT OR IGNORE INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)").run(id, worktree, vcs, Date.now(), Date.now(), "[]");
    return id;
  }
  session(o: { directory: string; id?: string; title?: string; parentId?: string; archived?: number; permission?: unknown; agent?: string; updated?: number; created?: number; projectId?: string }): string {
    const id = o.id ?? newId("ses"), at = o.updated ?? Date.now();
    this.db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, permission, agent, model, time_created, time_updated, time_archived)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.projectId ?? "global", o.parentId ?? null, "brave-orchid", o.directory, "", o.title ?? `New session - ${new Date(at).toISOString()}`,
      "1.19.5", o.permission === undefined ? null : JSON.stringify(o.permission), o.agent ?? "build", JSON.stringify({ id: "mock-model", providerID: "mock" }), o.created ?? at, at, o.archived ?? null);
    return id;
  }
  private touch(sessionId: string, at: number) { this.db.prepare("UPDATE session SET time_updated = max(time_updated, ?) WHERE id = ?").run(at, sessionId); }
  private part(sessionId: string, messageId: string, data: unknown, at: number) {
    const id = newId("prt");
    this.db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(id, messageId, sessionId, at, at, JSON.stringify(data));
    return id;
  }
  user(sessionId: string, text: string, o: { at?: number; agent?: string; synthetic?: string } = {}): string {
    const id = newId("msg"), at = o.at ?? Date.now();
    this.db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)").run(id, sessionId, at, at,
      JSON.stringify({ role: "user", time: { created: at }, agent: o.agent ?? "build", model: { providerID: "mock", modelID: "mock-model" }, summary: { diffs: [] } }));
    this.part(sessionId, id, { type: "text", text }, at);
    if (o.synthetic) this.part(sessionId, id, { type: "text", text: o.synthetic, synthetic: true }, at);
    this.touch(sessionId, at);
    return id;
  }
  assistant(sessionId: string, parentId: string, o: AssistantOpts = {}): { id: string; partId: string | null } {
    const id = newId("msg"), at = o.at ?? Date.now(), done = o.completed !== false;
    const data: any = { parentID: parentId, role: "assistant", mode: o.agent ?? "build", agent: o.agent ?? "build", path: { cwd: "/", root: "/" }, cost: 0,
      tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { write: 0, read: 0 } }, modelID: "mock-model", providerID: "mock", time: { created: at, ...(done ? { completed: at + 5 } : {}) } };
    if (done && !o.error) data.finish = o.finish ?? "stop";
    if (o.error) data.error = { name: o.error, data: { message: "stopped" } };
    if (o.summary) data.summary = true;
    this.db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)").run(id, sessionId, at, at, JSON.stringify(data));
    this.part(sessionId, id, { type: "step-start", snapshot: "4b825dc6" }, at);
    let partId: string | null = null;
    if (o.text) this.part(sessionId, id, { type: "text", text: o.text, time: { start: at, end: at + 1 } }, at);
    if (o.question) partId = this.part(sessionId, id, { type: "tool", tool: "question", callID: "call_1", state: { status: "running", input: { questions: o.question }, time: { start: at } } }, at);
    if (done) this.part(sessionId, id, { type: "step-finish", reason: data.finish ?? "stop", snapshot: "4b825dc6", tokens: data.tokens, cost: 0 }, at);
    this.touch(sessionId, at);
    return { id, partId };
  }
  /** A session with one finished turn. */
  finished(directory: string, prompt = "Add a lap counter", reply = "Added the lap counter.", o: { title?: string; at?: number } = {}): string {
    const at = o.at ?? Date.now() - 60_000;
    const id = this.session({ directory, title: o.title ?? "Lap counter", updated: at, created: at });
    const u = this.user(id, prompt, { at });
    this.assistant(id, u, { text: reply, at: at + 10 });
    return id;
  }
  close() { this.db.close(); }
}
