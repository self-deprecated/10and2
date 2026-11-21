// A client for a coding agent's ACP mode (the Agent Client Protocol, https://agentclientprotocol.com: JSON-RPC 2.0 as
// newline-delimited JSON over the agent's stdin and stdout), as Gemini CLI (`gemini --acp`) and GitHub Copilot CLI
// (`copilot --acp`) speak it. Only what 10 & 2 needs: initialize, a session (new or loaded), its mode and model, one
// prompt. The agent's own requests are answered here: a permission is never granted (the policy's rule for every agent),
// and its file-system and terminal requests are refused, as initialize offers neither.
import type { ChildProcess } from "node:child_process";
import { execFileCommand, spawnCommand } from "../command.ts";

export class AcpError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.code = code; }
}

/** One model a session can run on, as `session/new` lists it. */
export type AcpModel = { modelId: string; name: string };
/** One mode (approval level), as `session/new` lists it. */
export type AcpMode = { id: string; name: string };
export type AcpSession = {
  sessionId: string;
  models: AcpModel[]; currentModelId: string | null;
  modes: AcpMode[]; currentModeId: string | null;
  /** ACP's session config options (newer agents put model and mode here instead), kept as given. */
  configOptions: any[];
};

/** What the agent asked permission for, and the option chosen in reply (a rejection, or a cancel when it offered none). */
export type Asked = { title: string; outcome: string };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class AcpClient {
  readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ended: Error | null = null;
  /** The agent's `session/update` notifications, as they come. */
  onUpdate: (sessionId: string, update: any) => void = () => {};
  /** Each permission the agent asked for, and what it was told. */
  onAsked: (asked: Asked) => void = () => {};
  agentCapabilities: any = {};

  constructor(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const [file, ...args] = command as [string, ...string[]];
    this.child = spawnCommand(file, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (e) => this.end(e));
    this.child.on("exit", (code, signal) => this.end(new Error(`the agent exited (${signal ?? code})`)));
    // Records are split on LF only: a JSON string may hold U+2028, which a line reader would split on.
    let buf = Buffer.alloc(0);
    this.child.stdout!.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10)) {
        const line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        this.onMessage(m);
      }
      if (buf.length > 64 * 1024 * 1024) buf = Buffer.alloc(0);
    });
  }

  private end(e: Error) {
    if (this.ended) return;
    this.ended = e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
  private write(o: object) { if (!this.ended) this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n"); }

  private onMessage(m: any) {
    if (m?.method && m.id !== undefined) return this.onRequest(m.id, m.method, m.params);
    if (m?.method === "session/update") return this.onUpdate(m.params?.sessionId, m.params?.update);
    if (m?.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new AcpError(String(m.error.data?.details ?? m.error.data?.message ?? m.error.message ?? "the agent refused"), Number(m.error.code ?? -32000)));
    else p.resolve(m.result);
  }

  private onRequest(id: unknown, method: string, params: any) {
    if (method === "session/request_permission") {
      // Never granted: a rejection when the agent offers one, so the turn goes on and the agent says it couldn't.
      const options: any[] = Array.isArray(params?.options) ? params.options : [];
      const no = options.find((o) => o?.kind === "reject_once") ?? options.find((o) => o?.kind === "reject_always");
      const title = String(params?.toolCall?.title ?? params?.toolCall?.kind ?? "a tool");
      this.onAsked({ title, outcome: no ? String(no.optionId) : "cancelled" });
      return this.write({ id, result: { outcome: no ? { outcome: "selected", optionId: no.optionId } : { outcome: "cancelled" } } });
    }
    this.write({ id, error: { code: -32601, message: `${method} isn't offered by this client` } });
  }

  request<T = any>(method: string, params: object): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: object) { this.write({ method, params }); }

  async initialize(): Promise<void> {
    const r = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "10and2", title: "10 & 2", version: "1" },
    });
    this.agentCapabilities = r?.agentCapabilities ?? {};
  }

  /** A new session in `cwd`, or the one named loaded (its history replayed as updates, which are ignored here). */
  async session(cwd: string, load?: string): Promise<AcpSession> {
    const r = load
      ? await this.request("session/load", { sessionId: load, cwd, mcpServers: [] })
      : await this.request("session/new", { cwd, mcpServers: [] });
    return {
      sessionId: load ?? String(r?.sessionId ?? ""),
      models: Array.isArray(r?.models?.availableModels) ? r.models.availableModels.filter((m: any) => typeof m?.modelId === "string")
        .map((m: any) => ({ modelId: m.modelId, name: typeof m.name === "string" && m.name ? m.name : m.modelId })) : [],
      currentModelId: typeof r?.models?.currentModelId === "string" ? r.models.currentModelId : null,
      modes: Array.isArray(r?.modes?.availableModes) ? r.modes.availableModes.filter((m: any) => typeof m?.id === "string")
        .map((m: any) => ({ id: m.id, name: String(m.name ?? m.id) })) : [],
      currentModeId: typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : null,
      configOptions: Array.isArray(r?.configOptions) ? r.configOptions : [],
    };
  }

  setMode(sessionId: string, modeId: string) { return this.request("session/set_mode", { sessionId, modeId }); }
  setModel(sessionId: string, modelId: string) { return this.request("session/set_model", { sessionId, modelId }); }
  /** One turn: resolves with its stop reason once the agent has finished it. */
  async prompt(sessionId: string, text: string): Promise<string> {
    const r = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return String(r?.stopReason ?? "end_turn");
  }

  stop() {
    try { this.child.stdin!.end(); } catch { /* gone */ }
    const child = this.child;
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 2000).unref();
  }
  /**
   * Ends the agent now, resolving once it has exited (on Windows, the folder it runs in can't be removed until then).
   * Its input is closed first, which an ACP agent ends on, and so does a worker it started. On Windows its whole tree is
   * ended (Gemini's launcher runs its worker as a process of its own); elsewhere SIGTERM, then SIGKILL after 3 s. It
   * never waits more than 6 s, so closing can't hang on it.
   */
  kill(): Promise<void> {
    const child = this.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let exited = false, tree = process.platform !== "win32";
      const timers: NodeJS.Timeout[] = [];
      const finish = () => { if (!exited || !tree) return; for (const t of timers) clearTimeout(t); resolve(); };
      child.once("exit", () => { exited = true; finish(); });
      try { child.stdin!.end(); } catch { /* gone */ }
      if (process.platform === "win32") {
        execFileCommand("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000 }, (err) => { if (err) child.kill(); tree = true; finish(); });
      } else {
        child.kill();
        timers.push(setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000));
      }
      timers.push(setTimeout(() => { exited = tree = true; finish(); }, 6000));
    });
  }
}
