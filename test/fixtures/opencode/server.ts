// A fake OpenCode server: the v1 routes the adapter uses, writing to a synthetic database (db.ts) as OpenCode would.
// Scriptable through `state`: what's busy, open questions and permission requests, whether a prompt is taken (and
// recorded) at all, and the agents' rules. Serves on a unix socket (a TUI as the plugin announces it) or on TCP (a
// TUI started with --port, or Driver's own `opencode serve`, via fake-opencode.ts).
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { FakeDb } from "./db.ts";

export type Seen = { method: string; path: string; directory: string | null; body: any; auth: string | null };
export type State = {
  status: Record<string, { type: string }>;
  questions: any[];
  permissions: any[];
  /** false: a prompt gets 204 but nothing is recorded (no evidence it arrived). A number: that status, nothing recorded. */
  accept: boolean | number;
  /** The assistant's reply to a prompt: "ACK <words>" by default; null for none (a busy session that queued it). */
  reply: ((text: string) => string | null) | null;
  agents: { name: string; mode: string; permission: unknown[] }[];
  /** Required Basic auth, when set. */
  auth: string | null;
};

const BASE = [{ permission: "*", pattern: "*", action: "allow" }, { permission: "doom_loop", pattern: "*", action: "ask" }, { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "/home/u/.local/share/opencode/tool-output/*", action: "allow" }, { permission: "question", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" }, { permission: "read", pattern: "*.env", action: "ask" }, { permission: "question", pattern: "*", action: "allow" }];
/** The agents as OpenCode 1.19.5 reports them by default (their rules trimmed to the ones that matter). */
export const AGENTS = () => [
  { name: "build", mode: "primary", permission: [...BASE, { permission: "plan_enter", pattern: "*", action: "allow" }] },
  { name: "plan", mode: "primary", permission: [...BASE, { permission: "plan_exit", pattern: "*", action: "allow" }, { permission: "edit", pattern: "*", action: "deny" }, { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" }] },
  { name: "general", mode: "subagent", permission: [...BASE] },
];

export function fakeOpenCode(dbPath: string, state: Partial<State> = {}) {
  const db = new FakeDb(dbPath);
  const s: State = { status: {}, questions: [], permissions: [], accept: true, reply: (t) => `ACK ${t}`, agents: AGENTS(), auth: null, ...state };
  const seen: Seen[] = [];
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url ?? "/", "http://x");
    const header = req.headers["x-opencode-directory"];
    const directory = typeof header === "string" ? decodeURIComponent(header) : url.searchParams.get("directory");
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const path = url.pathname;
    if (path !== "/event") seen.push({ method: req.method ?? "", path, directory, body, auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null });
    const send = (status: number, value?: unknown) => { res.writeHead(status, value === undefined ? {} : { "content-type": "application/json" }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (s.auth && req.headers.authorization !== s.auth) return send(401, { error: "unauthorized" });
    const m = (re: RegExp) => re.exec(`${req.method} ${path}`);
    let r: RegExpExecArray | null;
    if (m(/^GET \/global\/health$/)) return send(200, { healthy: true, version: "1.19.5" });
    if (m(/^GET \/session\/status$/)) return send(200, s.status);
    if (m(/^GET \/question$/)) return send(200, s.questions);
    if (m(/^GET \/permission$/)) return send(200, s.permissions);
    if (m(/^GET \/agent$/)) return send(200, s.agents);
    if ((r = m(/^POST \/question\/([^/]+)\/reply$/))) {
      const i = s.questions.findIndex((q) => q.id === r![1]);
      if (i < 0) return send(404, { error: "not found" });
      s.questions.splice(i, 1);
      return send(200, true);
    }
    if (m(/^GET \/event$/)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      return;
    }
    if (m(/^POST \/session$/)) {
      const id = db.session({ directory: directory ?? "/", title: body?.title, agent: body?.agent, permission: body?.permission });
      return send(200, { id, directory, title: body?.title ?? "New session", permission: body?.permission });
    }
    if ((r = m(/^POST \/session\/([^/]+)\/prompt_async$/))) {
      if (typeof s.accept === "number") return send(s.accept, { error: "refused" });
      if (s.accept) {
        const text = (body?.parts ?? []).map((p: any) => p.text).join("\n");
        const u = db.user(r[1]!, text, { agent: body?.agent });
        const reply = s.reply?.(text);
        if (reply) db.assistant(r[1]!, u, { text: reply, agent: body?.agent });
      }
      return send(204);
    }
    if ((r = m(/^GET \/session\/([^/]+)\/message$/))) return send(200, []);
    if ((r = m(/^DELETE \/session\/([^/]+)$/))) return send(200, true);
    return send(404, { error: `fake has no ${req.method} ${path}` });
  }
  const server: Server = createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* closed */ } }); });
  return {
    db, state: s, seen, server,
    /** Only the requests that ask for something to happen. */
    writes: () => seen.filter((x) => x.method !== "GET"),
    listen: (target: string | number) => new Promise<number>((resolve) => {
      if (typeof target === "string") server.listen(target, () => resolve(0));
      else server.listen(target, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); if (db.db.isOpen) db.close(); }),
  };
}
