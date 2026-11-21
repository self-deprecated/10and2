// A GitHub Copilot CLI session (measured on 1.0.112): one folder per session, `<COPILOT_HOME or ~/.copilot>/session-
// state/<id>/`, with `workspace.yaml` (`id`, `cwd`, `name`: its title, `created_at`, `updated_at`, …) and `events.jsonl`,
// one event a line, `{type, data, id, timestamp, parentId}`: `user.message` (`content`, the words as typed),
// `assistant.message` (`content`, `toolRequests`: none in the reply that ends a turn), `tool.execution_start` /
// `tool.execution_complete`, `assistant.turn_end`, `abort`, `session.error`. While a Copilot has the session open (a
// terminal, or an editor through ACP) the folder holds `inuse.<pid>.lock`, removed when it closes. A question Copilot asks
// the user is its `ask_user` tool, written as a `tool.execution_start` and completed once answered.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { iso, JsonLines, project, type Msg, type Projection } from "../acp/session.ts";

/** `workspace.yaml`'s top-level `key: value` lines (Copilot writes nothing nested there), unquoted. */
export function parseWorkspace(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    out[m[1]!] = v;
  }
  return out;
}

/** The question an `ask_user` call puts, with the choices its schema offers: "Which colour? Options: red / blue." */
export function askText(args: any): string {
  const message = typeof args?.message === "string" ? args.message.trim() : typeof args?.question === "string" ? args.question.trim() : "";
  const props = args?.requestedSchema?.properties && typeof args.requestedSchema.properties === "object" ? Object.values(args.requestedSchema.properties) as any[] : [];
  const choices = props.flatMap((p) => Array.isArray(p?.enum) ? p.enum : Array.isArray(p?.oneOf) ? p.oneOf.map((o: any) => o?.title ?? o?.const) : []).filter((c) => typeof c === "string");
  return `${message || "Copilot is asking you something."}${choices.length ? ` Options: ${choices.join(" / ")}.` : ""}`;
}

export class CopilotSession {
  readonly dir: string;
  private readonly lines: JsonLines;
  private events: Msg[] = [];
  private calls = new Map<string, { at: string | null; ask: string | null }>();
  private workspace: Record<string, string> = {};
  /** `workspace.yaml`'s time and size when last read. */
  private workspaceStamp = "";
  private cached: Projection | null = null;
  mtimeMs = 0;

  constructor(dir: string) { this.dir = dir; this.lines = new JsonLines(join(dir, "events.jsonl")); }

  get id(): string | null { return this.workspace.id || null; }
  get cwd(): string | null { return this.workspace.cwd || null; }
  /** Its title when the user named it; otherwise Copilot's is only its first words, which Driver says its own way. */
  get name(): string | null { return this.workspace.user_named === "false" ? null : this.workspace.name?.trim() || null; }
  get createdAt(): string | null { return iso(this.workspace.created_at); }

  read(): void {
    try {
      const st = statSync(join(this.dir, "workspace.yaml"));
      // Its size too: Linux takes a file's time from a coarse clock (a tick, 1-4 ms), so a rename Copilot writes within a
      // tick of the last read keeps the time it had (CI, 21 November).
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== this.workspaceStamp) { this.workspace = parseWorkspace(readFileSync(join(this.dir, "workspace.yaml"), "utf8")); this.workspaceStamp = stamp; }
      this.mtimeMs = Math.max(st.mtimeMs, (() => { try { return statSync(this.lines.path).mtimeMs; } catch { return 0; } })());
    } catch { return; }
    const { records, reset } = this.lines.read();
    if (reset) { this.events = []; this.calls.clear(); }
    if (records.length || reset) this.cached = null;
    for (const e of records) this.apply(e);
  }

  private apply(e: any) {
    const d = e?.data ?? {}, at = iso(e?.timestamp), id = typeof e?.id === "string" ? e.id : `${this.events.length}`;
    switch (e?.type) {
      case "user.message": {
        // Only the user's own words: not autopilot's own continuations, nor a message from a skill or another agent.
        if (d.isAutopilotContinuation || (typeof d.source === "string" && d.source !== "user")) return;
        const text = typeof d.content === "string" ? d.content.trim() : "";
        if (text) this.events.push({ id, at, k: "u", text });
        return;
      }
      case "assistant.message": {
        const calls = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
        // A subagent's messages belong to the tool call that started it.
        if (d.parentToolCallId) return;
        this.events.push({ id, at, k: "a", text: typeof d.content === "string" ? d.content : "", final: !calls });
        if (calls) this.events.push({ id: `${id}:tools`, at, k: "t" });
        return;
      }
      case "tool.execution_start":
        if (typeof d.toolCallId === "string") this.calls.set(d.toolCallId, { at, ask: d.toolName === "ask_user" ? askText(d.arguments) : null });
        return;
      case "tool.execution_complete":
        if (typeof d.toolCallId === "string") this.calls.delete(d.toolCallId);
        return;
      case "abort": this.events.push({ id, at, k: "e", cancelled: true }); this.calls.clear(); return;
      case "session.error": this.events.push({ id, at, k: "e" }); return;
    }
  }

  get projection(): Projection { return this.cached ??= project(this.events); }
  get started(): boolean { return this.events.some((m) => m.k === "u"); }
  get userCount(): number { return this.events.filter((m) => m.k === "u").length; }
  says(words: string, after = 0): boolean { return this.events.filter((m) => m.k === "u").slice(after).some((m) => m.k === "u" && m.text === words.trim()); }
  /** The question Copilot is waiting on, when its `ask_user` hasn't been answered. */
  get question(): string | null { for (const c of this.calls.values()) if (c.ask) return c.ask; return null; }

  /** The pids that hold it open now (`inuse.<pid>.lock`), whether or not they still run. */
  holders(): number[] {
    try { return readdirSync(this.dir).map((f) => /^inuse\.(\d+)\.lock$/.exec(f)?.[1]).filter((p): p is string => !!p).map(Number); }
    catch { return []; }
  }
}
