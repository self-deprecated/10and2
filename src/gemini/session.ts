// A Gemini CLI session file (measured on 0.68.0 and 0.70.0): `<GEMINI_CLI_HOME or ~>/.gemini/tmp/<project>/chats/
// session-<time>-<id prefix>.jsonl`. The first line is the session's metadata `{sessionId, projectHash, startTime,
// lastUpdated, kind}`; after it, messages `{id, timestamp, type: "user"|"gemini"|"info"|"error"|"warning", content,
// toolCalls?}` (a message written again with the same id replaces it), and edits to both: `{"$set": {...}}` merges into
// the metadata (`summary`, the session's title, among others), `{"$patch": {id | updates, removeIds, orderIds}}` changes
// messages, `{"$rewindTo": id}` drops that message and everything after it. Releases before JSON lines wrote one JSON
// object, `session-….json`, with the metadata and a `messages` list; that's read too.
import { readFileSync, statSync } from "node:fs";
import { iso, JsonLines, project, type Msg, type Projection } from "../acp/session.ts";

/** A message's text: a string, or its parts' text joined. */
export function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p: any) => typeof p?.text === "string" && !p.thought ? p.text : "").join("") : "";
}

/**
 * What Gemini itself leaves out of a session's history: its own context, hook context, slash commands, `?` help. Words
 * Driver sends that start with "/" go with a space in front (acp/adapter.ts `promptText`), so they're the user's words.
 */
export const ignoredUserText = (raw: string) => { const t = raw.trim(); return !t || raw.startsWith("/") || raw.startsWith("?") || t.startsWith("<session_context>") || t.startsWith("<hook_context>"); };

type Raw = { id: string; timestamp?: unknown; type?: unknown; content?: unknown; toolCalls?: unknown };

export class GeminiSession {
  readonly path: string;
  private readonly lines: JsonLines | null;
  private meta: Record<string, any> = {};
  private messages = new Map<string, Raw>();
  private cached: { msgs: Msg[]; projection: Projection } | null = null;
  mtime = "";

  constructor(path: string) { this.path = path; this.lines = path.endsWith(".jsonl") ? new JsonLines(path) : null; }

  get id(): string | null { return typeof this.meta.sessionId === "string" ? this.meta.sessionId : null; }
  get projectHash(): string | null { return typeof this.meta.projectHash === "string" ? this.meta.projectHash : null; }
  get startTime(): string | null { return iso(this.meta.startTime); }
  get lastUpdated(): string | null { return iso(this.meta.lastUpdated); }
  get summary(): string | null { return typeof this.meta.summary === "string" && this.meta.summary.trim() ? this.meta.summary.trim() : null; }
  /** "main" for a session the user had; a subagent's has its own kind. Older files have none. */
  get kind(): string { return typeof this.meta.kind === "string" ? this.meta.kind : "main"; }

  read(): void {
    try { this.mtime = statSync(this.path).mtime.toISOString(); } catch { return; }
    if (!this.lines) {
      // A whole JSON file, written at once: read again when it changes.
      try {
        const o = JSON.parse(readFileSync(this.path, "utf8"));
        const { messages, ...meta } = o ?? {};
        this.meta = meta; this.messages = new Map();
        for (const m of Array.isArray(messages) ? messages : []) if (typeof m?.id === "string") this.messages.set(m.id, m);
        this.cached = null;
      } catch { /* half-written: the next read gets it */ }
      return;
    }
    const { records, reset } = this.lines.read();
    if (reset) { this.meta = {}; this.messages = new Map(); }
    if (records.length || reset) this.cached = null;
    for (const r of records) this.apply(r);
  }

  private apply(r: any) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return;
    if (typeof r.$rewindTo === "string") {
      let found = false;
      for (const id of [...this.messages.keys()]) { if (id === r.$rewindTo) found = true; if (found) this.messages.delete(id); }
      if (!found) this.messages.clear();
    } else if (r.$patch && typeof r.$patch === "object") {
      const p = r.$patch;
      for (const u of [...(typeof p.id === "string" ? [p] : []), ...(Array.isArray(p.updates) ? p.updates : [])]) {
        const m = typeof u?.id === "string" ? this.messages.get(u.id) : undefined;
        if (m && u.content !== undefined) m.content = u.content;
        if (m && Array.isArray(u.toolCalls) && Array.isArray(m.toolCalls)) {
          for (const tc of u.toolCalls) { const own = (m.toolCalls as any[]).find((t) => t?.id === tc?.id); if (own && "result" in tc) own.result = tc.result; }
        }
      }
      for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) this.messages.delete(id);
      if (Array.isArray(p.orderIds)) {
        const ordered = p.orderIds.filter((id: unknown) => typeof id === "string" && this.messages.has(id)) as string[];
        const set = new Set(ordered), next = new Map<string, Raw>();
        for (const [id, m] of this.messages) if (!set.has(id)) next.set(id, m);
        for (const id of ordered) next.set(id, this.messages.get(id)!);
        this.messages = next;
      }
    } else if (r.$set && typeof r.$set === "object") Object.assign(this.meta, r.$set);
    else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") Object.assign(this.meta, r);
    else if (typeof r.id === "string") { this.messages.delete(r.id); this.messages.set(r.id, { ...r }); }
  }

  /** The messages as the projection reads them. */
  private msgs(): Msg[] {
    const out: Msg[] = [];
    let inTurn = false;
    for (const m of this.messages.values()) {
      const at = iso(m.timestamp);
      if (m.type === "user") {
        const raw = partsText(m.content);
        if (ignoredUserText(raw)) continue;
        out.push({ id: m.id, at, k: "u", text: raw.trim() }); inTurn = true;
      } else if (m.type === "gemini") {
        const calls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
        out.push({ id: m.id, at, k: "a", text: partsText(m.content), final: !calls });
        if (calls) out.push({ id: `${m.id}:tools`, at, k: "t" });
        inTurn = calls;
      } else if (m.type === "error" && inTurn) { out.push({ id: m.id, at, k: "e" }); inTurn = false; }
    }
    return out;
  }
  private view() { return this.cached ??= (() => { const msgs = this.msgs(); return { msgs, projection: project(msgs) }; })(); }
  get projection(): Projection { return this.view().projection; }
  /** Whether the user has said anything in it yet (Gemini leaves files for sessions that never started). */
  get started(): boolean { return this.view().msgs.some((m) => m.k === "u"); }
  /** Whether a user message with exactly these words is in it, after the first `after` user messages. */
  says(words: string, after = 0): boolean {
    return this.view().msgs.filter((m) => m.k === "u").slice(after).some((m) => m.k === "u" && m.text === words.trim());
  }
  get userCount(): number { return this.view().msgs.filter((m) => m.k === "u").length; }
}
