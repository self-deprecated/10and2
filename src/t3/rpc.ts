// A minimal client for T3 Code's WebSocket RPC (Effect RPC, JSON serialization), with no
// dependency on T3's packages. The frames, as captured from T3's own client:
//   us → T3:  {_tag:"Request", id, tag, payload, headers:[]} · {_tag:"Ack", requestId}
//             {_tag:"Interrupt", requestId} · {_tag:"Ping"}
//   T3 → us:  {_tag:"Exit", requestId, exit:{_tag:"Success", value} | {_tag:"Failure", cause}}
//             {_tag:"Chunk", requestId, values:[…]} · {_tag:"Pong"} · {_tag:"Ping"}
import { WebSocket } from "ws";

/** The orchestration protocol this client speaks; T3 refuses the upgrade (426) on a mismatch. */
export const ORCHESTRATION_PROTOCOL = 2;

export class RpcError extends Error {
  readonly tag: string | null;
  constructor(message: string, tag: string | null) {
    super(message);
    this.tag = tag;
  }
}

/** The request may or may not have reached T3: the socket dropped or T3 didn't answer in time. */
export class ConnectionError extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type StreamHandler = { onValue: (v: unknown) => void; onEnd: (e: Error | null) => void };

/** Finds the most useful message and _tag in an Effect cause, whatever its exact nesting. */
export function describeFailure(cause: unknown): { message: string; tag: string | null } {
  let found: { message: string; tag: string | null } | null = null;
  const visit = (v: unknown, depth: number) => {
    if (found || depth > 8 || v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.message === "string") {
      found = { message: o.message, tag: typeof o._tag === "string" ? o._tag : null };
      return;
    }
    for (const value of Object.values(o)) visit(value, depth + 1);
  };
  visit(cause, 0);
  return found ?? { message: JSON.stringify(cause).slice(0, 300), tag: null };
}

export class RpcClient {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, StreamHandler>();
  private readonly ping: NodeJS.Timeout;
  private lastFrameAt = Date.now();
  private closedError: Error | null = null;
  private readonly closeListeners: ((e: Error) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onFrame(String(data)));
    ws.on("close", (code) => this.fail(new Error(`T3 socket closed (${code})`)));
    ws.on("error", (err) => this.fail(err));
    // T3 answers pings; a socket that stays silent for 35 s is dead even if TCP hasn't noticed.
    this.ping = setInterval(() => {
      if (Date.now() - this.lastFrameAt > 35_000) {
        this.fail(new Error("T3 stopped responding"));
        this.ws.terminate();
        return;
      }
      this.send({ _tag: "Ping" });
    }, 10_000);
  }

  /** Opens the socket with a fresh one-use ticket (tickets keep the bearer out of the URL). */
  static async connect(baseUrl: string, bearer: string): Promise<RpcClient> {
    const res = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) throw new RpcError(`T3 refused a socket ticket (HTTP ${res.status})`, res.status === 401 ? "Unauthorized" : null);
    const { ticket } = (await res.json()) as { ticket: string };
    const url = new URL("/ws", baseUrl.replace(/^http/, "ws"));
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL));
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 64 << 20 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, r) => reject(new RpcError(`T3 refused the socket (HTTP ${r.statusCode})`, null)));
      ws.once("error", reject);
    });
    return new RpcClient(ws);
  }

  onClose(listener: (e: Error) => void) {
    this.closeListeners.push(listener);
  }

  /** Rejects with a ConnectionError on timeout or a dropped socket: the outcome is then unknown. */
  request<T = unknown>(tag: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.closedError) return Promise.reject(new ConnectionError(this.closedError.message));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new ConnectionError(`T3 did not answer ${tag} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  /** Starts a streaming RPC; returns a function that interrupts it. */
  stream(tag: string, payload: unknown, onValue: (v: unknown) => void, onEnd: (e: Error | null) => void): () => void {
    if (this.closedError) {
      onEnd(this.closedError);
      return () => {};
    }
    const id = this.nextId++;
    this.streams.set(id, { onValue, onEnd });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return () => {
      if (this.streams.delete(id)) this.send({ _tag: "Interrupt", requestId: id });
    };
  }

  close() {
    this.fail(new Error("closed"));
    this.ws.close();
  }

  private send(frame: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onFrame(text: string) {
    this.lastFrameAt = Date.now();
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame?._tag) {
      case "Ping":
        this.send({ _tag: "Pong" });
        return;
      case "Chunk": {
        const s = this.streams.get(frame.requestId);
        if (!s) return;
        for (const v of frame.values ?? []) s.onValue(v);
        this.send({ _tag: "Ack", requestId: frame.requestId });
        return;
      }
      case "Exit": {
        const ok = frame.exit?._tag === "Success";
        const err = ok ? null : (() => {
          const f = describeFailure(frame.exit?.cause);
          return new RpcError(f.message, f.tag);
        })();
        const p = this.pending.get(frame.requestId);
        if (p) {
          this.pending.delete(frame.requestId);
          if (ok) p.resolve(frame.exit.value);
          else p.reject(err!);
          return;
        }
        const s = this.streams.get(frame.requestId);
        if (s) {
          this.streams.delete(frame.requestId);
          s.onEnd(err);
        }
        return;
      }
    }
  }

  private fail(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    clearInterval(this.ping);
    for (const p of this.pending.values()) p.reject(new ConnectionError(error.message));
    this.pending.clear();
    for (const s of this.streams.values()) s.onEnd(error);
    this.streams.clear();
    for (const l of this.closeListeners) l(error);
  }
}
