// Reading OpenCode's own SQLite database (opencode.db, 1.19.5's layout), read-only, while OpenCode writes it: sessions,
// their messages and the parts that carry text, and what a session's latest turn says about itself.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PastReply, ReplyRef } from "../contract.ts";
import { isRules } from "./rules.ts";
import type { Rule } from "./rules.ts";

export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
export const dbPathFor = (dataDir?: string, env: NodeJS.ProcessEnv = process.env) => dataDir ? join(dataDir, "opencode.db") : env.OPENCODE_DB || join(defaultDataDir(env), "opencode.db");

export type SessionRow = {
  id: string; projectId: string; directory: string; title: string; agent: string | null; permission: Rule[] | null;
  createdAt: number; updatedAt: number; version: string;
  /** Changes whenever anything in the session does: its newest message or part. */
  signature: string;
};
export type Msg = {
  id: string; role: "user" | "assistant"; parentId: string | null; created: number; completed: number | null;
  finish: string | null; error: string | null; agent: string | null; summary: boolean;
};
export type Part = { id: string; messageId: string; type: string; text: string | null; synthetic: boolean; tool: string | null; status: string | null; input: string | null };
export type Asked = { question: string; options: string[]; multiple: boolean };

/** What a session's messages say: how its latest turn ended, its replies, and an open question if one is running. */
export type View = {
  /** incomplete: the newest step hasn't finished (running, or its process died); idle: a prompt nothing answered. */
  outcome: "completed" | "failed" | "cancelled" | "idle" | "incomplete";
  reply: (ReplyRef & { text: string }) | null;
  replies: PastReply[];
  progress: string | null;
  lastRunAt: string | null;
  wroteAt: string | null;
  /** The question tool waiting on the user in the newest step, as the database shows it. */
  asking: { partId: string; questions: Asked[] } | null;
  /** The agent the session last ran with. */
  agent: string | null;
};

/** `opencode run` gives its sessions exactly these rules: a script's run, not the user's own session. */
const RUN_RULES = JSON.stringify([{ permission: "question", pattern: "*", action: "deny" }, { permission: "plan_enter", pattern: "*", action: "deny" }, { permission: "plan_exit", pattern: "*", action: "deny" }]);
export const isRunSession = (s: Pick<SessionRow, "permission">) => JSON.stringify(s.permission) === RUN_RULES;

const iso = (ms: number | null | undefined) => typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const json = (s: unknown) => { try { return typeof s === "string" ? JSON.parse(s) : null; } catch { return null; } };

/** Opens the database for one read and closes it again; a locked or missing database is an error the caller keeps its last read through. */
export function withDb<T>(path: string, read: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) throw new Error("OpenCode has no database here yet");
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=2000"); return read(db); } finally { db.close(); }
}

/** Top-level, unarchived sessions changed since `since`, plus any in `also` (ones a process says it's running). */
export function sessions(db: DatabaseSync, since: number, also: string[] = []): SessionRow[] {
  const rows = db.prepare(`SELECT s.id, s.project_id, s.directory, s.title, s.agent, s.permission, s.time_created, s.time_updated, s.version,
      (SELECT max(time_updated) FROM message m WHERE m.session_id = s.id) AS m, (SELECT max(time_updated) FROM part p WHERE p.session_id = s.id) AS p
    FROM session s WHERE s.parent_id IS NULL AND s.time_archived IS NULL AND (s.time_updated >= ? OR s.id IN (SELECT value FROM json_each(?)))
    ORDER BY s.time_updated DESC`).all(since, JSON.stringify(also)) as any[];
  return rows.map((r) => {
    const permission = json(r.permission);
    return { id: r.id, projectId: r.project_id, directory: r.directory, title: r.title ?? "", agent: r.agent ?? null,
      permission: isRules(permission) ? permission : null, createdAt: r.time_created, updatedAt: r.time_updated, version: r.version ?? "",
      signature: `${r.time_updated}:${r.m ?? 0}:${r.p ?? 0}` };
  });
}

export function messages(db: DatabaseSync, sessionId: string): { messages: Msg[]; parts: Part[] } {
  const msgs = (db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY id").all(sessionId) as any[]).map((r): Msg | null => {
    const d = json(r.data);
    if (d?.role !== "user" && d?.role !== "assistant") return null;
    return { id: r.id, role: d.role, parentId: typeof d.parentID === "string" ? d.parentID : null, created: d.time?.created ?? r.time_created,
      completed: typeof d.time?.completed === "number" ? d.time.completed : null, finish: typeof d.finish === "string" ? d.finish : null,
      error: d.error ? String(d.error.name ?? "Error") : null, agent: typeof d.agent === "string" ? d.agent : null, summary: d.summary === true };
  }).filter((m): m is Msg => m !== null);
  // Only what's needed of each part: a tool's output can be megabytes.
  const parts = (db.prepare(`SELECT id, message_id, json_extract(data,'$.type') AS type, json_extract(data,'$.text') AS text,
      json_extract(data,'$.synthetic') AS synthetic, json_extract(data,'$.tool') AS tool, json_extract(data,'$.state.status') AS status,
      CASE WHEN json_extract(data,'$.tool') = 'question' THEN json_extract(data,'$.state.input') END AS input
    FROM part WHERE session_id = ? AND json_extract(data,'$.type') IN ('text','tool') ORDER BY id`).all(sessionId) as any[])
    .map((r): Part => ({ id: r.id, messageId: r.message_id, type: r.type, text: typeof r.text === "string" ? r.text : null, synthetic: !!r.synthetic,
      tool: r.tool ?? null, status: r.status ?? null, input: typeof r.input === "string" ? r.input : null }));
  return { messages: msgs, parts };
}

/** The user's own words in a message: its text parts, leaving out what OpenCode added itself. */
export function userText(parts: Part[], messageId: string): string {
  return parts.filter((p) => p.messageId === messageId && p.type === "text" && !p.synthetic && p.text).map((p) => p.text!).join("\n");
}
const assistantText = (parts: Part[], messageId: string) => userText(parts, messageId).trim();

/** The user messages in a session that aren't in `known`, with their words: the evidence a message arrived. */
export function newUserMessages(db: DatabaseSync, sessionId: string, known: Set<string>): { id: string; text: string }[] {
  const { messages: msgs, parts } = messages(db, sessionId);
  return msgs.filter((m) => m.role === "user" && !known.has(m.id)).map((m) => ({ id: m.id, text: userText(parts, m.id) }));
}
export function userMessageIds(db: DatabaseSync, sessionId: string): Set<string> {
  return new Set((db.prepare("SELECT id FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'user'").all(sessionId) as any[]).map((r) => r.id));
}

/** Projects OpenCode knows in a git checkout: where new work can start. */
export function projectRoots(db: DatabaseSync): string[] {
  return (db.prepare("SELECT worktree FROM project WHERE vcs = 'git' AND id != 'global'").all() as any[]).map((r) => r.worktree).filter((w) => typeof w === "string" && w !== "/");
}

export function questionsOf(input: unknown): Asked[] {
  const qs = (typeof input === "string" ? json(input) : input as any)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter((q: any) => typeof q?.question === "string").map((q: any) => ({
    question: q.question.slice(0, 2000),
    options: Array.isArray(q.options) ? q.options.map((o: any) => typeof o === "string" ? o : o?.label).filter((l: unknown) => typeof l === "string") : [],
    multiple: q.multiple === true,
  }));
}

/**
 * A turn is a user message and the assistant messages answering it (one per step, each parented to it). A reply is a
 * turn's last step, finished without error and not handing over to a tool, with text.
 */
export function view(msgs: Msg[], parts: Part[], sessionAgent: string | null = null): View {
  const assistants = msgs.filter((m) => m.role === "assistant" && !m.summary);
  const lastOfTurn = new Map<string, Msg>();
  for (const m of assistants) if (m.parentId) lastOfTurn.set(m.parentId, m);
  const last = assistants.at(-1) ?? null;
  const newest = msgs.at(-1) ?? null;
  const users = msgs.filter((m) => m.role === "user" && userText(parts, m.id).trim());
  const finals = assistants.filter((m) => m.parentId && lastOfTurn.get(m.parentId) === m && m.completed !== null && !m.error && m.finish !== "tool-calls" && assistantText(parts, m.id));
  const replies: PastReply[] = finals.map((m) => ({ runId: m.parentId, messageId: m.id, at: iso(m.completed)!, text: assistantText(parts, m.id),
    prompt: m.parentId ? userText(parts, m.parentId) || null : null })).reverse();
  let outcome: View["outcome"];
  if (!last || newest?.role === "user") outcome = "idle";
  else if (last.error) outcome = last.error === "MessageAbortedError" ? "cancelled" : "failed";
  else if (last.completed === null) outcome = "incomplete";
  else outcome = "completed";
  const turn = last?.parentId ? assistants.filter((m) => m.parentId === last.parentId) : [];
  const progress = outcome === "incomplete" ? turn.map((m) => assistantText(parts, m.id)).filter(Boolean).at(-1) ?? null : null;
  const question = outcome === "incomplete" && last ? parts.find((p) => p.messageId === last.id && p.tool === "question" && (p.status === "running" || p.status === "pending")) : undefined;
  const questions = question ? questionsOf(question.input) : [];
  const head = replies[0];
  return {
    outcome, replies, progress,
    reply: head ? { runId: head.runId, messageId: head.messageId, at: head.at, text: head.text } : null,
    lastRunAt: last && outcome !== "incomplete" && outcome !== "idle" ? iso(last.completed ?? last.created) : head?.at ?? null,
    wroteAt: iso(users.at(-1)?.created),
    asking: question && questions.length ? { partId: question.id, questions } : null,
    agent: last?.agent ?? [...msgs].reverse().find((m) => m.agent)?.agent ?? sessionAgent,
  };
}
