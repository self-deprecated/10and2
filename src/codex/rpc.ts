// A client for the Codex CLI's shared app-server daemon (measured on codex-cli 0.167.0): WebSocket over the daemon's
// control socket ($CODEX_HOME/app-server-control/app-server-control.sock, a symlink into /tmp), JSON-RPC 2.0 without
// the "jsonrpc" field. One connection: `initialize` then `initialized`, then requests both ways and notifications.
//   us → Codex:  {id, method, params} · {method, params} · {id, result} / {id, error} (answers to its requests)
//   Codex → us:  {id, result} / {id, error} · {method, params} (notifications) · {id, method, params} (its requests:
//                approvals and questions, `currentTime/read`)
import { WebSocket } from "ws";

/** Codex refused the request: a definite answer, so nothing was done. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The request may or may not have reached Codex: the socket dropped, or Codex didn't answer in time. */
export class ConnectionError extends Error {}

/** A request from Codex to this client, answered (or not) with `respond`. Its id is only meaningful on this connection. */
export type ServerRequest = { id: number | string; method: string; params: any };

export type Initialized = { userAgent?: string; codexHome?: string; platformFamily?: string; platformOs?: string };

export type ConnectOptions = {
  clientName: string;
  clientTitle: string;
  version: string;
  onNotification: (method: string, params: any) => void;
  onRequest: (request: ServerRequest) => void;
  /** Notifications this connection never needs (streaming deltas). */
  optOut?: string[];
  timeoutMs?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class CodexRpc {
  private readonly ws: WebSocket;
  private readonly opts: ConnectOptions;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;
  private readonly closeListeners: ((e: Error) => void)[] = [];
  init: Initialized = {};

  private constructor(ws: WebSocket, opts: ConnectOptions) {
    this.ws = ws;
    this.opts = opts;
    ws.on("message", (data) => this.onFrame(String(data)));
    ws.on("close", (code) => this.fail(new Error(`Codex closed the connection (${code})`)));
    ws.on("error", (err) => this.fail(err));
  }

  /** Opens the socket and completes the handshake. Rejects when nothing listens there (ENOENT/ECONNREFUSED) or Codex refuses. */
  static async connect(socketPath: string, opts: ConnectOptions): Promise<CodexRpc> {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: opts.timeoutMs ?? 10_000, maxPayload: 256 << 20, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, r) => reject(new Error(`Codex refused the connection (HTTP ${r.statusCode})`)));
      ws.once("error", reject);
    });
    const rpc = new CodexRpc(ws, opts);
    try {
      rpc.init = await rpc.request<Initialized>("initialize", {
        clientInfo: { name: opts.clientName, title: opts.clientTitle, version: opts.version },
        // `requestAttestation` is required from 0.167 on; Driver never generates attestations.
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: opts.optOut ?? [] },
      }, opts.timeoutMs ?? 10_000);
      rpc.send({ method: "initialized" });
    } catch (e) {
      rpc.close();
      throw e;
    }
    return rpc;
  }

  get closed(): boolean { return this.closedError !== null; }

  onClose(listener: (e: Error) => void) {
    if (this.closedError) listener(this.closedError);
    else this.closeListeners.push(listener);
  }

  /** Rejects with RpcError when Codex refuses, ConnectionError when the outcome is unknown (timeout, dropped socket). */
  request<T = any>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.closedError) return Promise.reject(new ConnectionError(this.closedError.message));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new ConnectionError(`Codex did not answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      if (!this.send({ id, method, params })) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new ConnectionError("Codex connection is not open"));
      }
    });
  }

  /** Answers one of Codex's requests on this connection. False when the socket is gone. */
  respond(id: number | string, result: unknown): boolean { return this.send({ id, result }); }
  respondError(id: number | string, code: number, message: string): boolean { return this.send({ id, error: { code, message } }); }

  close() {
    this.fail(new Error("closed"));
    try { this.ws.close(); } catch { /* already closing */ }
  }

  private send(frame: object): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private onFrame(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (m === null || typeof m !== "object") return;
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new RpcError(String(m.error.message ?? "Codex refused the request"), Number(m.error.code ?? 0), m.error.data));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== "string") return;
    try {
      if (m.id !== undefined) this.opts.onRequest({ id: m.id, method: m.method, params: m.params ?? {} });
      else this.opts.onNotification(m.method, m.params ?? {});
    } catch { /* A handler's bug must not take the connection down. */ }
  }

  private fail(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ConnectionError(error.message)); }
    this.pending.clear();
    for (const l of this.closeListeners) { try { l(error); } catch { /* listener bug */ } }
  }
}
