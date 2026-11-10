// Talking to open Pis through 10 & 2's Pi extension (extensions/pi/10and2.ts): its registry says which sessions are
// open and what they're doing; its socket takes the user's words and answers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";

export type Question = { questionId: string; title: string; options: string[] };
export type Live = {
  sessionId: string; sessionFile: string | null; cwd: string; name: string | null; pid: number; mode: string | null;
  status: "idle" | "busy" | "waiting";
  /** The dialog Pi is blocked on (any extension's): its kind, title, and since when. */
  prompt: { kind: string; title: string | null; since: string | null } | null;
  /** Questions the extension asked that Driver can answer. */
  questions: Question[];
  socket: string; updatedAt: string | null;
};

/** Pi's session ids: letters, digits, `.`, `_` and `-` (`--session-id`); UUIDs by default. */
export const piSessionId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(id);
const str = (v: unknown, max = 2000) => typeof v === "string" ? v.slice(0, max) : null;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The open Pis, by session: entries whose process is alive and whose socket is there. Anything malformed is left out. */
export function readRegistry(agentDir: string): Map<string, Live> {
  const dir = join(agentDir, "10and2"), out = new Map<string, Live>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5), socket = join(dir, `${id}.sock`);
    try {
      const r = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!piSessionId(id) || r.sessionId !== id || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.cwd !== "string" || !isAbsolute(r.cwd)) continue;
      if (!alive(r.pid) || !existsSync(socket)) continue;
      const questions: Question[] = Array.isArray(r.questions) ? r.questions.flatMap((q: any) => typeof q?.questionId === "string" && typeof q.title === "string"
        ? [{ questionId: q.questionId, title: q.title.slice(0, 2000), options: Array.isArray(q.options) ? q.options.filter((o: unknown) => typeof o === "string").map((o: string) => o.slice(0, 500)) : [] }] : []) : [];
      out.set(id, {
        sessionId: id, sessionFile: typeof r.sessionFile === "string" && isAbsolute(r.sessionFile) ? r.sessionFile : null, cwd: r.cwd,
        name: str(r.name, 500), pid: r.pid, mode: str(r.mode, 20),
        status: ["idle", "busy", "waiting"].includes(r.status) ? r.status : "idle",
        prompt: r.prompt && typeof r.prompt === "object" ? { kind: str(r.prompt.kind, 50) ?? "dialog", title: str(r.prompt.title), since: str(r.prompt.since, 50) } : null,
        questions, socket, updatedAt: str(r.updatedAt, 50),
      });
    } catch { /* Being rewritten, or not one of ours: the next scan reads it again. */ }
  }
  return out;
}

/**
 * Sends one request to an open Pi and waits for its reply with the same id. "unreachable": nothing answered the
 * connection, so nothing was sent. "silent": sent, but no reply came in time.
 */
export function talk(socket: string, request: { id: string; type: string; [k: string]: unknown }, timeoutMs = 5000): Promise<any | "unreachable" | "silent"> {
  return new Promise((resolve) => {
    let connected = false, done = false, text = "";
    const conn = createConnection(socket);
    const finish = (r: any) => { if (!done) { done = true; clearTimeout(timer); conn.destroy(); resolve(r); } };
    const timer = setTimeout(() => finish(connected ? "silent" : "unreachable"), timeoutMs);
    conn.on("error", () => finish(connected ? "silent" : "unreachable"));
    conn.on("close", () => finish(connected ? "silent" : "unreachable"));
    conn.on("connect", () => { connected = true; conn.write(JSON.stringify(request) + "\n"); });
    conn.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 1024 * 1024) return finish("silent");
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n")) {
        const line = text.slice(0, i); text = text.slice(i + 1);
        try { const r = JSON.parse(line); if (r?.id === request.id) return finish(r); } catch { /* not a reply */ }
      }
    });
  });
}
