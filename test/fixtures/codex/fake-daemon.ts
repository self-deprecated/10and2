// A stand-in for the Codex CLI's app-server daemon (0.167.0), for the Codex adapter's tests: a WebSocket server on a
// unix socket speaking the part of its JSON-RPC the adapter uses, with threads, turns and server requests (questions,
// approvals) a test sets up and drives. Every request is recorded; any method can be overridden per test.
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

export type FakeItem = { type: string; id: string; text?: string; clientId?: string | null; content?: any[]; phase?: string | null; startedAtMs?: number };
export type FakeTurn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; items: FakeItem[]; startedAt: number | null; completedAt: number | null };
export type FakeThread = {
  id: string; name: string | null; preview: string; cwd: string; updatedAt: number; createdAt: number; ephemeral: boolean;
  status: { type: string; activeFlags?: string[] }; originator: string | null; source: unknown; threadSource: string | null;
  modelProvider: string; parentThreadId: string | null; path: string | null;
  /** Oldest first. */
  turns: FakeTurn[];
  settings: { approvalPolicy: unknown; sandbox: unknown; approvalsReviewer: string; collaborationMode?: { mode: string } };
  /** Set: `thread/resume` fails as Codex does for a thread another process writes, or one on another provider. */
  refuse?: "writer" | "provider";
};
type Conn = { ws: WebSocket; nextId: number; subs: Set<string>; out: Map<number, { key: string }> };
type Asked = { key: string; threadId: string; method: string; params: any; resolved: boolean; ids: Map<Conn, number> };
export const HANG = Symbol("hang");

const now = () => Math.floor(Date.now() / 1000);

export class FakeCodex {
  readonly home: string;
  readonly socketPath: string;
  readonly threads = new Map<string, FakeThread>();
  readonly calls: { method: string; params: any }[] = [];
  /** Answers clients sent to server requests: the request's method, and the result. */
  readonly answers: { method: string; result: any }[] = [];
  readonly handlers: Record<string, (params: any) => any> = {};
  private readonly asked: Asked[] = [];
  private readonly conns = new Set<Conn>();
  private http!: Server;
  private wss!: WebSocketServer;

  private constructor(home: string) {
    this.home = home;
    this.socketPath = join(home, "app-server-control", "app-server-control.sock");
  }

  static async start(home = mkdtempSync(join(tmpdir(), "fake-codex-"))): Promise<FakeCodex> {
    const f = new FakeCodex(home);
    await f.listen();
    return f;
  }
  async listen() {
    mkdirSync(join(this.home, "app-server-control"), { recursive: true });
    rmSync(this.socketPath, { force: true });
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => {
      const conn: Conn = { ws, nextId: 0, subs: new Set(), out: new Map() };
      this.conns.add(conn);
      ws.on("close", () => this.conns.delete(conn));
      ws.on("message", (data) => void this.onMessage(conn, JSON.parse(String(data))));
    });
    await new Promise<void>((resolve) => this.http.listen(this.socketPath, resolve));
  }
  /** Stops listening and drops every connection, as a daemon that exits. */
  async stop() {
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((resolve) => this.wss.close(() => this.http.close(() => resolve())));
    rmSync(this.socketPath, { force: true });
  }
  get connections() { return this.conns.size; }
  count(method: string) { return this.calls.filter((c) => c.method === method).length; }
  last(method: string) { return this.calls.filter((c) => c.method === method).at(-1)?.params; }

  /** A thread with one finished turn ("Synthetic request." → `reply`), or none when `reply` is null. */
  thread(cwd: string, opts: Partial<FakeThread> & { reply?: string | null; prompt?: string } = {}): FakeThread {
    const id = opts.id ?? randomUUID();
    const at = opts.updatedAt ?? now() - 60;
    const t: FakeThread = {
      id, name: null, preview: opts.prompt ?? "Synthetic request.", cwd, updatedAt: at, createdAt: at - 10, ephemeral: false,
      status: { type: "notLoaded" }, originator: "codex-tui", source: "vscode", threadSource: null, modelProvider: "mock",
      parentThreadId: null, path: `/fake/${id}.jsonl`, turns: [],
      settings: { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }, approvalsReviewer: "user" },
      ...opts,
    };
    if (opts.reply !== null && !opts.turns) t.turns.push(this.turnOf(opts.prompt ?? "Synthetic request.", opts.reply ?? "Synthetic answer.", at));
    this.threads.set(id, t);
    return t;
  }
  turnOf(prompt: string, reply: string | null, at = now(), status: FakeTurn["status"] = "completed"): FakeTurn {
    const items: FakeItem[] = [{ type: "userMessage", id: randomUUID(), clientId: randomUUID(), content: [{ type: "text", text: prompt, text_elements: [] }], startedAtMs: at * 1000 }];
    if (reply !== null) items.push({ type: "agentMessage", id: `msg_${randomUUID().slice(0, 8)}`, text: reply, phase: null });
    return { id: randomUUID(), status, items, startedAt: at, completedAt: status === "inProgress" ? null : at };
  }

  /** Sends a notification to every connection. */
  notify(method: string, params: any) { for (const c of this.conns) this.send(c, { method, params }); }
  setStatus(id: string, status: FakeThread["status"]) {
    const t = this.threads.get(id)!;
    t.status = status;
    this.notify("thread/status/changed", { threadId: id, status });
  }
  /** Starts a turn in a thread, as its terminal would: it's running until `finish`. */
  begin(id: string, prompt: string): FakeTurn {
    const t = this.threads.get(id)!;
    const turn = this.turnOf(prompt, null, now(), "inProgress");
    t.turns.push(turn); t.updatedAt = now();
    this.setStatus(id, { type: "active", activeFlags: [] });
    return turn;
  }
  /** Ends the running turn with `reply`. */
  finish(id: string, reply: string, status: FakeTurn["status"] = "completed") {
    const t = this.threads.get(id)!, turn = t.turns.at(-1)!;
    turn.items.push({ type: "agentMessage", id: `msg_${randomUUID().slice(0, 8)}`, text: reply, phase: null });
    turn.status = status; turn.completedAt = now(); t.updatedAt = now();
    this.setStatus(id, { type: "idle" });
    for (const c of this.conns) if (c.subs.has(id)) this.send(c, { method: "turn/completed", params: { threadId: id, turn } });
  }
  /** Codex asks the user something in a thread (a question or an approval): its flag shows to all, the request to subscribers. */
  ask(threadId: string, method: string, params: any): Asked {
    const a: Asked = { key: randomUUID(), threadId, method, params: { threadId, turnId: this.threads.get(threadId)!.turns.at(-1)?.id, itemId: `call_${randomUUID().slice(0, 6)}`, ...params }, resolved: false, ids: new Map() };
    this.asked.push(a);
    this.setStatus(threadId, { type: "active", activeFlags: [method === "item/tool/requestUserInput" ? "waitingOnUserInput" : "waitingOnApproval"] });
    for (const c of this.conns) if (c.subs.has(threadId)) this.offer(c, a);
    return a;
  }
  /** The question or approval resolved elsewhere (in the terminal). */
  resolve(a: Asked) {
    a.resolved = true;
    for (const [c, id] of a.ids) this.send(c, { method: "serverRequest/resolved", params: { threadId: a.threadId, requestId: id } });
    this.setStatus(a.threadId, { type: "active", activeFlags: [] });
  }
  private offer(c: Conn, a: Asked) {
    const id = c.nextId++;
    a.ids.set(c, id); c.out.set(id, { key: a.key });
    this.send(c, { id, method: a.method, params: a.params });
  }

  private send(c: Conn, msg: object) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
  private view(t: FakeThread) {
    const { turns, settings, refuse, ...rest } = t;
    void turns; void settings; void refuse;
    return { ...rest, turns: [] };
  }

  private async onMessage(c: Conn, m: any) {
    if (m.method === undefined && m.id !== undefined) {
      // A client's answer to one of our requests.
      if (m.id === -1) return;
      const out = c.out.get(m.id);
      const a = out && this.asked.find((x) => x.key === out.key);
      if (!a) return;
      this.answers.push({ method: a.method, result: m.result });
      if (a.resolved) return;
      this.resolve(a);
      return;
    }
    if (m.id === undefined) return; // a notification ("initialized")
    this.calls.push({ method: m.method, params: m.params });
    try {
      const custom = this.handlers[m.method];
      const result = custom ? await custom(m.params) : this.handle(c, m.method, m.params ?? {});
      if (result === HANG) return;
      this.send(c, { id: m.id, result });
    } catch (e: any) {
      this.send(c, { id: m.id, error: { code: e.code ?? -32600, message: e.message } });
    }
  }
  private fail(message: string): never { throw Object.assign(new Error(message), { code: -32600 }); }
  private get(id: string): FakeThread { const t = this.threads.get(id); if (!t) this.fail(`thread not found: ${id}`); return t!; }

  private handle(c: Conn, method: string, p: any): any {
    switch (method) {
      case "initialize": return { userAgent: `fake-codex/0.167.0 (test; ${p.clientInfo?.name})`, codexHome: this.home, platformFamily: "unix", platformOs: "linux" };
      case "thread/list": {
        const data = [...this.threads.values()].filter((t) => !t.ephemeral).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => this.view(t));
        return { data, nextCursor: null };
      }
      case "thread/loaded/list": return { data: [...this.threads.values()].filter((t) => t.status.type !== "notLoaded").map((t) => t.id), nextCursor: null };
      case "thread/read": return { thread: this.view(this.get(p.threadId)) };
      case "thread/turns/list": {
        const t = this.get(p.threadId);
        if (!t.turns.length) this.fail(`thread ${t.id} is not materialized yet`);
        return { data: [...t.turns].reverse().slice(0, p.limit ?? 25), nextCursor: null };
      }
      case "thread/resume": {
        const t = this.get(p.threadId);
        if (t.refuse === "writer") this.fail(`thread ${t.id} already has an active writer`);
        if (t.refuse === "provider") this.fail("This chat uses mock, but your current provider is other");
        if (t.status.type === "notLoaded") this.setStatus(t.id, { type: "idle" });
        c.subs.add(t.id);
        for (const a of this.asked) if (a.threadId === t.id && !a.resolved) setImmediate(() => this.offer(c, a));
        return { thread: this.view(t), model: "mock-model", modelProvider: t.modelProvider, approvalPolicy: t.settings.approvalPolicy, sandbox: t.settings.sandbox,
          approvalsReviewer: t.settings.approvalsReviewer, collaborationMode: t.settings.collaborationMode ?? { mode: "default", settings: { model: "mock-model" } } };
      }
      case "thread/unsubscribe": c.subs.delete(p.threadId); return { status: "unsubscribed" };
      case "turn/start": {
        const t = this.get(p.threadId);
        if (t.status.type === "notLoaded") this.fail(`thread not loaded: ${t.id}`);
        const user: FakeItem = { type: "userMessage", id: randomUUID(), clientId: p.clientUserMessageId ?? null, content: p.input, startedAtMs: Date.now() };
        const running = t.turns.at(-1)?.status === "inProgress" ? t.turns.at(-1)! : null;
        if (running) { running.items.push(user); return { turn: { ...running, items: [], itemsView: "notLoaded" } }; }
        const turn: FakeTurn = { id: randomUUID(), status: "inProgress", items: [user], startedAt: now(), completedAt: null };
        t.turns.push(turn); t.updatedAt = now();
        if (t.preview === "") t.preview = p.input?.[0]?.text ?? "";
        this.setStatus(t.id, { type: "active", activeFlags: [] });
        return { turn: { ...turn, items: [], itemsView: "notLoaded" } };
      }
      case "turn/steer": {
        const t = this.get(p.threadId);
        const running = t.turns.at(-1)?.status === "inProgress" ? t.turns.at(-1)! : null;
        if (!running) this.fail("no active turn to steer");
        if (running!.id !== p.expectedTurnId) this.fail(`expected active turn id ${p.expectedTurnId} but found ${running!.id}`);
        running!.items.push({ type: "userMessage", id: randomUUID(), clientId: p.clientUserMessageId ?? null, content: p.input, startedAtMs: Date.now() });
        return { turnId: running!.id };
      }
      case "thread/start": {
        const t = this.thread(p.cwd, { reply: null, prompt: "", status: { type: "idle" }, threadSource: p.threadSource ?? null, updatedAt: now(),
          settings: { approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, approvalsReviewer: p.approvalsReviewer ?? "user" } });
        c.subs.add(t.id);
        this.notify("thread/started", { thread: this.view(t) });
        return { thread: this.view(t), model: "mock-model", modelProvider: "mock", approvalPolicy: p.approvalPolicy, sandbox: p.sandbox };
      }
      case "thread/name/set": {
        const t = this.get(p.threadId);
        if (!t.turns.length) this.fail("failed to set thread name: rollout is empty");
        t.name = p.name;
        this.notify("thread/name/updated", { threadId: t.id, threadName: p.name });
        return {};
      }
      default: this.fail(`unknown method ${method}`);
    }
  }
}
