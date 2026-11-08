// One outbound socket to the brain, serving MCP down it (docs/launch/contracts.md §2). The brain is the client: it
// initializes, lists tools, reads `tenandtwo://work` and calls tools. The connector speaks first only to say the view
// changed, and otherwise sends nothing but a keep-alive every 30 s, so a brain with nothing to do can sleep.
import { WebSocket } from "ws";
import type { Receipt } from "./contract.ts";
import type { Ledger } from "./ledger.ts";
import type { Local } from "./local.ts";
import { actionOf, CLOSE, ERR, MAX_FRAME, MAX_REQUESTS, MAX_TTL_MS, MCP_VERSION, PING, PING_MS, PONG, SILENCE_MS, SUBPROTOCOL, text, tools, TOOL_ACTIONS, VERSION, WORK_URI } from "./protocol.ts";
import { defaultPolicyPath } from "./policy.ts";
import { redactOutbound } from "./redact.ts";
import { describe } from "./util.ts";
import { Sent, type View } from "./view.ts";

type Options = {
  url: string;
  token: string;
  adapter: Local;
  ledger: Ledger;
  log: (s: string) => void;
  onFatal: (code: number) => void;
  /** Told when the link comes up (initialized) and goes down, for `10and2 status`. */
  onState?: (s: { linked: boolean; error?: string }) => void;
  /** After each whole view is sent: how much 10 & 2 can see here, for `setup` and `status`. */
  onView?: (n: { threads: number; projects: number }) => void;
  /** Tests can reconnect promptly without changing the production backoff. */
  retryMs?: number;
  /** How often the view is recomputed here to notice changes no work system announces (places, health). Local only. */
  stateMs?: number;
  /** The shortest gap between two change notifications that aren't urgent. */
  notifyMs?: number;
  pingMs?: number;
  /**
   * How long after starting the first view waits for every work system to load. A view without T3's threads would tell
   * the brain they'd all gone, so it waits for them; past this, a work system that's still down can't hold back the rest.
   */
  loadGraceMs?: number;
};

/** A JSON-RPC error answered to the brain. `-32602`/`-32601` mean nothing was done. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
const invalid = (m: string) => new RpcError(ERR.invalidParams, m);

export class Link {
  private readonly opts: Options;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unwatch: (() => void) | null = null;
  private backoff = 1000;
  private readonly startedAt = Date.now();

  constructor(opts: Options) { this.opts = opts; }
  /**
   * Dials once every work system has loaded (or the grace is over), so the brain's first read is answered at once
   * rather than held past its request timeout while T3 loads.
   */
  start() {
    if (this.ws || this.stopped || this.retry) return;
    if (this.ready()) { this.connect(); return; }
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, 100);
  }
  private ready() { return this.opts.adapter.allLoaded || Date.now() - this.startedAt >= (this.opts.loadGraceMs ?? 25_000); }

  private connect() {
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL, { headers: { authorization: `Bearer ${this.opts.token}` }, maxPayload: MAX_FRAME, handshakeTimeout: 10_000 });
    this.ws = ws;
    const sent = new Sent();
    let initialized = false;
    let requests = 0;
    let lastFrame = Date.now();
    const openedAt = Date.now();
    /** A notification is out and the brain hasn't read since; one is enough. */
    let notified = false;
    let lastNotice = 0;
    let listed = "";
    let checking = false;

    const send = (frame: object | string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const data = typeof frame === "string" ? frame : JSON.stringify(redactOutbound(frame));
      const bytes = Buffer.byteLength(data);
      if (bytes > MAX_FRAME) {
        // Bytes are at least the brain's characters, so this refuses before the brain would. It retries with backoff,
        // as the view may shrink; the log and `10and2 status` say what to do meanwhile.
        const why = `this machine's view is ${(bytes / 1048576).toFixed(1)} MB, over the 8 MB a message may be: list fewer folders in "projects" (${defaultPolicyPath()})`;
        this.opts.log(`connector: ${why}`);
        this.opts.onState?.({ linked: false, error: why });
        ws.close(1009, "view too large");
        return;
      }
      if (ws.bufferedAmount > MAX_FRAME) { ws.close(1009, "the brain isn't reading"); return; }
      ws.send(data);
    };
    const ready = () => this.ready();
    const view = async (): Promise<View> => {
      const a = this.opts.adapter;
      return { items: await a.list(), places: a.places(), connections: a.connections(), refusals: a.refusals(), ceiling: a.ceiling };
    };
    /** Looks at the view, and tells the brain to read when something it cares about changed. */
    const check = async () => {
      if (!initialized || this.ws !== ws || checking || !ready()) return;
      checking = true;
      try {
        const now = JSON.stringify(this.opts.adapter.actions);
        if (now !== listed) { listed = now; send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
        if (notified) return;
        const { any, urgent } = sent.changed(await view());
        if (!any || (!urgent && Date.now() - lastNotice < (this.opts.notifyMs ?? 1000))) return;
        notified = true; lastNotice = Date.now();
        send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: WORK_URI } });
      } catch (e) { this.opts.log(`connector: reading this machine failed (${describe(e)})`); }
      finally { checking = false; }
    };

    const handle = async (m: any): Promise<unknown> => {
      const p = m.params ?? {};
      if (m.method === "ping") return {};
      if (m.method === "initialize") {
        initialized = true;
        this.backoff = 1000;
        this.opts.onState?.({ linked: true });
        listed = JSON.stringify(this.opts.adapter.actions);
        this.unwatch = this.opts.adapter.watch((ids) => { sent.touch(ids); void check(); });
        this.timers.push(setInterval(() => void check(), this.opts.stateMs ?? 5000));
        return { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: true }, resources: { subscribe: true } }, serverInfo: { name: "10and2", version: VERSION } };
      }
      if (!initialized) throw new RpcError(ERR.invalidRequest, "The session isn't initialized.");
      switch (m.method) {
        case "tools/list": listed = JSON.stringify(this.opts.adapter.actions); return { tools: tools(this.opts.adapter.actions) };
        case "resources/list": return { resources: [{ uri: WORK_URI, name: "work", mimeType: "application/json", description: "This machine's threads, places and work-system health." }] };
        case "resources/subscribe": case "resources/unsubscribe":
          if (p.uri !== WORK_URI) throw invalid("There's no such resource.");
          return {};
        case "resources/read": {
          const uri = typeof p.uri === "string" ? new URL(p.uri) : null;
          if (!uri || `${uri.protocol}//${uri.host}` !== WORK_URI) throw invalid("There's no such resource.");
          // Until every work system has loaded (or the grace is over), a view would say their threads had gone.
          while (!ready()) await new Promise((r) => setTimeout(r, 100));
          const first = sent.rev === null;
          const read = sent.read(await view(), uri.searchParams.get("since"));
          notified = false;
          const text = JSON.stringify(redactOutbound(read));
          if (read.full) this.opts.onView?.({ threads: read.items.length, projects: read.places.length });
          if (first) this.opts.log(`connector: linked; first view ${read.items.length} items, ${read.places.length} places, ${Math.round(Buffer.byteLength(text) / 1024)} KB`);
          // A change that landed while this read was being answered still gets its own notification.
          setTimeout(() => void check(), 0);
          return { contents: [{ uri: WORK_URI, mimeType: "application/json", text }] };
        }
        case "tools/call": return this.call(p);
        default: throw new RpcError(ERR.noMethod, `${m.method} isn't supported.`);
      }
    };

    ws.on("open", () => {
      this.timers.push(setInterval(() => {
        if (Date.now() - lastFrame > SILENCE_MS || (!initialized && Date.now() - openedAt >= 10_000)) ws.terminate();
        else send(PING);
      }, this.opts.pingMs ?? PING_MS));
    });
    ws.on("message", (data, binary) => {
      lastFrame = Date.now();
      const raw = String(data);
      if (raw === PONG) return;
      let m: any;
      try { if (binary) throw new Error("binary frame"); m = JSON.parse(raw); } catch { ws.close(1002, "invalid frame"); return; }
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
        // The connector sends no requests, so the brain never owes it a response.
        ws.close(1002, "JSON-RPC request required"); return;
      }
      if (m.id === undefined) return; // notifications/initialized, notifications/cancelled: nothing to do
      if (requests >= MAX_REQUESTS) { send({ jsonrpc: "2.0", id: m.id, error: { code: ERR.busy, message: "Too many requests are waiting on this machine." } }); return; }
      requests++;
      void handle(m).then((result) => send({ jsonrpc: "2.0", id: m.id, result }), (e) => send({ jsonrpc: "2.0", id: m.id, error: {
        code: e instanceof RpcError ? e.code : ERR.internal,
        message: describe(e),
      } })).finally(() => requests--);
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      ws.terminate();
      if (res.statusCode === 401 || res.statusCode === 403) { this.opts.log("connector: the brain refused this machine's credential (revoked?); stopping"); this.fatal(); }
      else if (res.statusCode === 426) { this.opts.log(`connector: the brain doesn't speak ${SUBPROTOCOL}; update the connector`); this.fatal(); }
    });
    let failure: string | undefined;
    ws.on("error", (e) => { failure = describe(e); this.opts.log(`connector: link failed (${failure})`); });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      if (initialized) this.opts.log(`connector: link closed (${code}${reason.length ? ` ${reason}` : ""})`);
      this.opts.onState?.({ linked: false, error: failure ?? (code === CLOSE.protocol ? "the brain closed the link (protocol)" : undefined) });
      this.ws = null;
      this.clear();
      if (this.stopped) return;
      if (code === CLOSE.revoked || code === CLOSE.replaced) {
        this.opts.log(code === CLOSE.revoked ? "connector: this machine was revoked; stopping" : "connector: another copy of this connector took over; stopping");
        this.fatal(); return;
      }
      const delay = this.opts.retryMs ?? Math.round(this.backoff * (0.75 + Math.random() * 0.5));
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
    });
  }

  /** One `tools/call`. Reading tools answer with the work system's data; acting tools with a receipt. */
  private async call(p: any): Promise<unknown> {
    const a = this.opts.adapter;
    const args = p.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid("Arguments must be an object.");
    const result = (structuredContent: object, words: string, isError = false) => ({ content: [{ type: "text", text: words }], structuredContent, isError });
    const keyOf = () => { const key = p._meta?.["tenandtwo/key"]; if (!text(key)) throw invalid("An operation key is required."); return key; };
    switch (p.name) {
      case "read_report": {
        if (!text(args.id)) throw invalid("A thread is required.");
        const report = await a.report(args.id);
        return result(report, report.text);
      }
      case "past_replies": {
        if (!text(args.id)) throw invalid("A thread is required.");
        return result({ replies: await a.replies(args.id) }, "");
      }
      case "mark_read": {
        if (!text(args.id) || !text(args.watermark) || !Number.isFinite(Date.parse(args.watermark))) throw invalid("A thread and a read watermark are required.");
        const r = await a.markRead(args.id, args.watermark, keyOf());
        return r === "unsupported" ? result({ unsupported: true }, "Unsupported here.") : result(r, r.ok ? "Done." : r.error, !r.ok);
      }
    }
    if (!TOOL_ACTIONS.includes(p.name)) throw new RpcError(ERR.noMethod, "There's no such tool.");
    if (!a.actions.includes(p.name)) throw invalid(`Driver isn't allowed to ${String(p.name).replaceAll("_", " ")} on this machine.`);
    let action;
    try { action = actionOf({ ...args, kind: p.name }); } catch (e) { throw invalid(describe(e)); }
    if ("kind" in args) throw invalid("Unknown action fields aren't supported.");
    const key = keyOf();
    const ttl = p._meta?.["tenandtwo/ttlMs"];
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) throw invalid("A time to live is required.");
    const deadline = Date.now() + Math.min(ttl, MAX_TTL_MS);
    const receipt: Receipt = await this.opts.ledger.execute(action, key, {
      retrySafe: a.retrySafe(action),
      // Asked last thing before dispatch; a refusal here isn't kept, so the next yes can still send it.
      refuse: async () => { const why = await a.refusal(action, deadline); return why ? { ok: false, error: why } : null; },
      execute: () => a.dispatch(action, key),
    });
    return result(receipt, receipt.ok ? "Done." : receipt.error, !receipt.ok);
  }

  private clear() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unwatch?.(); this.unwatch = null;
  }
  private fatal() { if (this.stopped) return; this.close(); this.opts.onFatal(78); }
  close() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.clear();
    this.ws?.close();
    this.ws = null;
  }
}
