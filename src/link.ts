// One outbound socket to the brain, serving MCP down it (docs/launch/contracts.md §2). The brain is the client: it
// initializes, lists tools, reads `tenandtwo://work` and calls tools. The connector speaks first only to say the view
// changed, and otherwise sends nothing but a keep-alive every 30 s, so a brain with nothing to do can sleep.
import { WebSocket } from "ws";
import type { PastReply, Receipt } from "./contract.ts";
import type { Ledger } from "./ledger.ts";
import type { Local } from "./local.ts";
import { actionOf, CLOSE, reportOut, ERR, MAX_FRAME, MAX_REQUESTS, MAX_TTL_MS, MCP_VERSION, PING, PING_MS, PONG, SILENCE_MS, SUBPROTOCOL, text, tools, TOOL_ACTIONS, VERSION, WORK_URI } from "./protocol.ts";
import { linkAgent } from "./net.ts";
import { defaultPolicyPath } from "./policy.ts";
import { redactOutbound } from "./redact.ts";
import { describe } from "./util.ts";
import { Sent, type View } from "./view.ts";
import type { Schedules } from "./schedules.ts";

type Options = {
  url: string;
  token: string;
  adapter: Local;
  ledger: Ledger;
  log: (s: string) => void;
  onFatal: (code: number) => void;
  /** This computer was disconnected from 10 & 2 (its credential refused, or revoked on the link), before it stops. */
  onRevoked?: () => void;
  /** What this computer holds for later (schedules.ts): `set_schedules`, and the view's `schedules`. */
  schedules?: Schedules;
  /** Told when the link comes up (initialized) and goes down, for `10and2 status`. */
  onState?: (s: { linked: boolean; error?: string }) => void;
  /** After each read, a delta too: how much 10 & 2 can see here (the whole view), for `setup` and `status`. */
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

/**
 * Whether an HTTP answer to the link's upgrade is the brain refusing this computer's credential (revoked, or unknown):
 * a 401 with the cloud's `sign_in` error, or a bare one (a brain of your own answers just the status line). A 403, or
 * a 401 with anything else in it, came from something in between (a firewall, VPN, proxy or captive portal).
 */
export function refusedByBrain(status: number, body: string): boolean {
  if (status !== 401) return false;
  if (!body.trim()) return true;
  try { return JSON.parse(body)?.code === "sign_in"; } catch { return false; }
}

/**
 * The most a thread's past replies may come to (as JSON), for every work system: the link carries a message of at most
 * 8 MB (`MAX_FRAME`), and one over it would close the link, so a long session's replies are cut well below that.
 */
export const REPLIES_BYTES = 2 << 20;
const size = (r: PastReply) => Buffer.byteLength(JSON.stringify(r));

/**
 * Replies (newest first) within `max` bytes: the newest that fit, older ones dropped. The newest is always given, its
 * text and prompt cut short (marked "…") when it alone is over.
 */
export function capReplies(replies: PastReply[], max = REPLIES_BYTES): PastReply[] {
  const out: PastReply[] = [];
  let bytes = 0;
  for (const r of replies) {
    const n = size(r);
    if (bytes + n > max) { if (!out.length) out.push(clip(r, max)); break; }
    out.push(r); bytes += n;
  }
  return out;
}
function clip(r: PastReply, max: number): PastReply {
  let c = r;
  for (let n = size(c); n > max; n = size(c)) {
    const keep = (s: string | null) => s && s.length > 64 ? `${s.slice(0, Math.floor(s.length * (max / n) * 0.9))}…` : s;
    const next = { ...c, text: keep(c.text) ?? "", prompt: keep(c.prompt) };
    if (next.text === c.text && next.prompt === c.prompt) return { ...c, text: "", prompt: null };
    c = next;
  }
  return c;
}

/** A JSON-RPC error answered to the brain. `-32602`/`-32601` mean nothing was done. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
const invalid = (m: string) => new RpcError(ERR.invalidParams, m);

/**
 * This machine's time zone as `serverInfo.timeZone`, what the brain says times in ("yesterday at 8 AM"): an IANA name
 * ("Europe/Copenhagen", "UTC"), or null when the system's isn't one (unset, "Etc/Unknown", an offset).
 */
export function ianaZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/.test(zone) || zone === "Etc/Unknown") return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return null; }
}
/**
 * The zone this machine is in now. Node reads the computer's zone once and keeps it, so a connector left running while
 * its computer moves zone (travel) would say the old one; unsetting TZ, which isn't set, makes it read the zone again.
 * A TZ that is set is the user's choice, and kept. Node on Windows doesn't read it again that way, so there the zone is
 * the one the connector started in, until it next starts (at sign-in).
 */
function hostZone(): string {
  if (process.env.TZ === undefined) delete process.env.TZ;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export class Link {
  private readonly opts: Options;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unwatch: (() => void) | null = null;
  private backoff = 1000;
  private readonly startedAt = Date.now();
  /**
   * Whether a schedule may fire now (docs/launch/engine.md §5, "Stop always wins"): the link is up and initialized, a
   * frame came in the last 75 s, and the last `set_schedules` the brain sent on it was applied (`synced`, cleared the
   * moment one arrives, even one refused as busy, and reset at every close).
   */
  fireable: () => boolean = () => false;

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
    // Through the company's proxy (HTTPS_PROXY), when there is one: pairing's fetch already goes through it (net.ts).
    const agent = linkAgent(this.opts.url);
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL, { headers: { authorization: `Bearer ${this.opts.token}` }, maxPayload: MAX_FRAME, handshakeTimeout: 10_000, ...(agent ? { agent } : {}) });
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
    let synced = false;
    this.fireable = () => this.ws === ws && ws.readyState === WebSocket.OPEN && initialized && synced && Date.now() - lastFrame <= SILENCE_MS;

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
      const schedules = this.opts.schedules?.view();
      return { items: await a.list(), places: a.places(), connections: a.connections(), refusals: a.refusals(), ceiling: a.ceiling, rules: a.rules, ...(schedules ? { schedules } : {}) };
    };
    /** Looks at the view, and tells the brain to read when something it cares about changed. */
    const check = async () => {
      if (!initialized || this.ws !== ws || checking || !ready()) return;
      checking = true;
      try {
        const now = JSON.stringify([this.opts.adapter.actions, this.opts.adapter.documentsEnabled]);
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
        listed = JSON.stringify([this.opts.adapter.actions, this.opts.adapter.documentsEnabled]);
        const unwatch = this.opts.adapter.watch((ids) => { sent.touch(ids); void check(); });
        const unheld = this.opts.schedules?.watch(() => void check());
        this.unwatch = () => { unwatch(); unheld?.(); };
        this.timers.push(setInterval(() => void check(), this.opts.stateMs ?? 5000));
        const timeZone = ianaZone(hostZone());
        return { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: true }, resources: { subscribe: true } }, serverInfo: { name: "10and2", version: VERSION, ...(timeZone ? { timeZone } : {}) } };
      }
      if (!initialized) throw new RpcError(ERR.invalidRequest, "The session isn't initialized.");
      switch (m.method) {
        case "tools/list": listed = JSON.stringify([this.opts.adapter.actions, this.opts.adapter.documentsEnabled]); return { tools: tools(this.opts.adapter.actions, !!this.opts.schedules, this.opts.adapter.holds, this.opts.adapter.documentsEnabled) };
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
          const now = await view();
          const read = sent.read(now, uri.searchParams.get("since"));
          notified = false;
          const text = JSON.stringify(redactOutbound(read));
          this.opts.onView?.({ threads: now.items.length, projects: now.places.length });
          if (first) this.opts.log(`connector: linked; first view ${read.items.length} items, ${read.places.length} places, ${Math.round(Buffer.byteLength(text) / 1024)} KB`);
          // A change that landed while this read was being answered still gets its own notification.
          setTimeout(() => void check(), 0);
          return { contents: [{ uri: WORK_URI, mimeType: "application/json", text }] };
        }
        case "tools/call": return p?.name === "set_schedules" && this.opts.schedules ? setSchedules(p) : this.call(p);
        default: throw new RpcError(ERR.noMethod, `${m.method} isn't supported.`);
      }
    };

    /**
     * The brain's full set for this computer, applied before anything else can run (no await), so sets apply in the order
     * they arrive. Applied: this link may fire again. Refused (stale, the clock): nothing on it fires until the next.
     */
    const setSchedules = (p: any) => {
      const args = p.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => k !== "seq" && k !== "schedules")) throw invalid("A set takes seq and schedules.");
      let answer;
      try { answer = this.opts.schedules!.set(args.seq, args.schedules, p._meta?.["tenandtwo/now"]); }
      catch (e) { throw invalid(describe(e)); }
      if ("refused" in answer) return { content: [{ type: "text", text: answer.error }], structuredContent: answer, isError: true };
      synced = true;
      this.opts.schedules!.poke();
      return { content: [{ type: "text", text: `Holding ${answer.held.filter((h) => h.state === "waiting").length}.` }], structuredContent: answer, isError: false };
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
      // Before anything else, a busy answer included: a set this link may never apply can't leave an older one in force.
      if (m.method === "tools/call" && m.params?.name === "set_schedules") synced = false;
      if (m.id === undefined) return; // notifications/initialized, notifications/cancelled: nothing to do
      if (requests >= MAX_REQUESTS) { send({ jsonrpc: "2.0", id: m.id, error: { code: ERR.busy, message: "Too many requests are waiting on this machine." } }); return; }
      requests++;
      void handle(m).then((result) => send({ jsonrpc: "2.0", id: m.id, result }), (e) => send({ jsonrpc: "2.0", id: m.id, error: {
        code: e instanceof RpcError ? e.code : ERR.internal,
        message: describe(e),
      } })).finally(() => requests--);
    });
    let failure: string | undefined;
    ws.on("unexpected-response", (_req, res) => {
      // Read what answered first (a little of it): only the brain's own refusal stops this computer for good.
      const status = res.statusCode ?? 0;
      let body = "";
      let decided = false;
      const decide = () => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        if (refusedByBrain(status, body)) { this.opts.log("connector: the brain refused this machine's credential (revoked?); stopping"); this.opts.onRevoked?.(); this.fatal(); }
        else if (status === 426) { this.opts.log(`connector: the brain doesn't speak ${SUBPROTOCOL}; update the connector`); this.fatal(); }
        else if (status === 401 || status === 403) {
          // A firewall, VPN, company proxy or captive portal answers like this too: never taken as a revocation.
          failure = `HTTP ${status} from something between this computer and 10 & 2 (a firewall, VPN or proxy?); trying again`;
          this.opts.log(`connector: ${failure}`);
        }
        else failure = `HTTP ${status} on connecting; trying again`;
        ws.terminate();
      };
      const timer = setTimeout(decide, 2000);
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
      res.once("end", decide);
      res.once("error", decide);
      res.once("close", decide);
    });
    // What answered the upgrade says more than the error its closing then gives.
    ws.on("error", (e) => { failure ??= describe(e); this.opts.log(`connector: link failed (${describe(e)})`); });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      if (initialized) this.opts.log(`connector: link closed (${code}${reason.length ? ` ${reason}` : ""})`);
      this.opts.onState?.({ linked: false, error: failure ?? (code === CLOSE.protocol ? "the brain closed the link (protocol)" : undefined) });
      this.ws = null;
      this.clear();
      if (this.stopped) return;
      if (code === CLOSE.revoked || code === CLOSE.replaced) {
        this.opts.log(code === CLOSE.revoked ? "connector: this machine was revoked; stopping" : "connector: another copy of this connector took over; stopping");
        if (code === CLOSE.revoked) this.opts.onRevoked?.();
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
        const report = reportOut(await a.report(args.id));
        return result(report, report.text);
      }
      case "past_replies": {
        if (!text(args.id)) throw invalid("A thread is required.");
        const all = await a.replies(args.id);
        const replies = capReplies(all);
        if (replies.length < all.length || replies[0] !== all[0]) this.opts.log(`connector: thread ${args.id} has ${all.length} replies; giving the newest ${replies.length} (${REPLIES_BYTES >> 20} MB)`);
        return result({ replies }, "");
      }
      case "first_ask": {
        if (!text(args.id)) throw invalid("A thread is required.");
        return result({ first: await a.firstAsk(args.id) }, "");
      }
      case "read_document": {
        if (!a.documentsEnabled) throw new RpcError(ERR.noMethod, "There's no such tool.");
        if (!text(args.id) || !text(args.docId)) throw invalid("A thread and a document id are required.");
        const doc = await a.readDocument(args.id, args.docId);
        return result(doc, doc.text);
      }
      case "mark_read": {
        if (!text(args.id) || !text(args.watermark) || !Number.isFinite(Date.parse(args.watermark))) throw invalid("A thread and a read watermark are required.");
        const r = await a.markRead(args.id, args.watermark, keyOf());
        return r === "unsupported" ? result({ unsupported: true }, "Unsupported here.") : result(r, r.ok ? "Done." : r.error, !r.ok);
      }
      // Commands that wait: the release path, for one hold only (gate.ts). Never through the Ledger: it sends nothing to
      // the thread, and a hold lives only as long as its hook's connection.
      case "answer_hold": {
        if (!text(args.itemId) || !text(args.questionId) || args.questionId.length > 200 || typeof args.run !== "boolean" || Object.keys(args).some((k) => !["itemId", "questionId", "run"].includes(k))) throw invalid("A thread, its held command's questionId and run are required.");
        const r = await a.answerHold(args.itemId, args.questionId, args.run);
        return r === "unsupported" ? result({ unsupported: true }, "Nothing is held there.", true) : result(r, r.ok ? "Done." : r.error, !r.ok);
      }
    }
    if (!TOOL_ACTIONS.includes(p.name)) throw new RpcError(ERR.noMethod, "There's no such tool.");
    if (!a.actions.includes(p.name)) throw invalid(`10 & 2 isn't allowed to ${String(p.name).replaceAll("_", " ")} on this machine.`);
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
      leftOut: () => a.sendLeftOut(action, key),
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
