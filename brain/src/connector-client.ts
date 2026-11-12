// One machine's connector, as an adapter: the brain is the MCP client of the connector's server, over the socket the
// connector opened (docs/launch/contracts.md §2). No Node or Workers APIs here, so the Node brain on Lattice and a
// user's Durable Object can both carry it on their own sockets.
//
// What the brain knows of the machine (its view, rev and tools) is plain data a host can save and restore, so a
// Durable Object that hibernates between frames picks up where it left off without asking again.
import { titleFrom, type Action, type ActionKind, type Adapter, type LaunchProfile, type PastReply, type Place, type Receipt, type Report, type WorkItem } from "./adapter.ts";

export const SUBPROTOCOL = "10and2.mcp.1";
export const MCP_VERSION = "2025-06-18";
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';
export const WORK_URI = "tenandtwo://work";
export const CLOSE = { revoked: 4001, replaced: 4002, protocol: 4003 } as const;
const REQUEST_MS = 25_000;
/** A link the connector hasn't pinged for this long is treated as down, so a half-open one fails at once. */
const STALE_MS = 75_000;
const MAX_PENDING = 128;
const ACTIONS: ActionKind[] = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"];
/** JSON-RPC errors that mean the connector did nothing: bad arguments, no such tool, too busy. */
const NOTHING_DONE = new Set([-32602, -32601, -32000]);

export type Connection = { prefix: string; name: string; connected: boolean };
export type Refusals = Record<string, Partial<Record<ActionKind, string>>>;
/** What the brain knows of a machine; a host may save it and restore it after a restart or hibernation. */
type Mode = LaunchProfile["runtimeMode"];
const MODES: Mode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
/**
 * `names`: the connector lets the work system name a new thread itself (its start_work doesn't require a title; 0.6.0
 * on). Absent or false, a start is sent a title made from its prompt (`titleFrom`), as connectors before it need one.
 */
export type Saved = { rev: string | null; items: WorkItem[]; places: Place[]; connections: Connection[]; refusals: Refusals; ceiling: Mode; actions: ActionKind[]; names?: boolean };
/** The socket, as the host carries it. `lastSeen`: when the connector was last heard from (a frame or a ping). */
export type Wire = { send(text: string): void; close(code: number, reason: string): void; lastSeen(): number };

/** The outcome may or may not have happened: the link dropped or didn't answer in time. */
export class LinkLost extends Error {}
class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const str = (v: unknown) => typeof v === "string";
const validItem = (i: any) => i && str(i.id) && str(i.title) && str(i.group) && str(i.updatedAt) && ["running", "waiting", "completed", "failed", "cancelled", "idle"].includes(i.status) &&
  typeof i.settled === "boolean" && typeof i.pendingQuestion === "boolean" && (i.parentId === null || str(i.parentId)) && (i.snoozedUntil === null || str(i.snoozedUntil));
function validRead(f: any): boolean {
  return f && str(f.rev) && typeof f.full === "boolean" && Array.isArray(f.items) && f.items.every(validItem) &&
    Array.isArray(f.removed) && f.removed.every(str) &&
    Array.isArray(f.places) && f.places.every((p: any) => p && str(p.id) && str(p.name) && (p.activeAt === null || str(p.activeAt))) &&
    Array.isArray(f.connections) && f.connections.every((c: any) => c && str(c.prefix) && str(c.name) && typeof c.connected === "boolean") &&
    f.refusals && typeof f.refusals === "object" && Object.values(f.refusals).every((r: any) => r && typeof r === "object" && Object.values(r).every(str)) &&
    MODES.includes(f.ceiling);
}
const validReceipt = (r: any): r is Receipt => r && (r.ok === true ? r.itemId === undefined || str(r.itemId) : r.ok === false && str(r.error));
/** The fields the briefing diffs on; an updatedAt-only change means nothing to it. */
const briefed = (i: WorkItem) => JSON.stringify([i.status, i.title, i.settled, i.snoozedUntil, i.pendingQuestion, i.questionId ?? null, i.lastRunAt ?? null, i.group, i.parentId, i.visitedAt ?? null]);
const spoken = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const targetOf = (a: Action) => (a.kind === "start_work" ? a.placeId : a.itemId);

export class RemoteAdapter implements Adapter {
  readonly name: string;
  private wire: Wire | null = null;
  /** The handshake is done on the current wire: tools listed, subscribed, first view read. */
  private live = false;
  private loaded = false;
  private state: Saved = { rev: null, items: [], places: [], connections: [], refusals: {}, ceiling: "approval-required", actions: [] };
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private firstList: Promise<void> | null = null;
  private readonly opts: { timeoutMs: number; listTimeoutMs: number; staleMs: number; now: () => number; onSaved?: (s: Saved) => void; log: (m: string) => void };

  constructor(name: string, opts: { timeoutMs?: number; listTimeoutMs?: number; staleMs?: number; now?: () => number; onSaved?: (s: Saved) => void; log?: (m: string) => void } = {}) {
    this.name = name;
    this.opts = { timeoutMs: opts.timeoutMs ?? REQUEST_MS, listTimeoutMs: opts.listTimeoutMs ?? 15_000, staleMs: opts.staleMs ?? STALE_MS, now: opts.now ?? (() => Date.now()), onSaved: opts.onSaved, log: opts.log ?? (() => {}) };
    this.ready = new Promise((r) => { this.markReady = r; });
  }

  // --- the link ---

  /** What the brain last knew, from before a restart or hibernation; reads are answered from it at once. */
  restore(saved: Saved) {
    this.state = structuredClone(saved);
    this.loaded = true;
    this.markReady();
  }
  get saved(): Saved { return structuredClone(this.state); }

  /**
   * A new link for this machine. `resumed`: the same socket after hibernation, already initialized, so nothing is asked
   * again. Otherwise the brain initializes, lists tools, subscribes and reads; until then the machine isn't connected.
   */
  attach(wire: Wire, resumed = false) {
    if (this.wire && this.wire !== wire) {
      const previous = this.wire;
      this.detach(previous);
      previous.close(CLOSE.replaced, "replaced");
    }
    this.wire = wire;
    this.live = resumed && this.loaded;
    if (!resumed) void this.handshake(wire);
  }

  private async handshake(wire: Wire) {
    try {
      const init = await this.request("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "10and2-brain", version: "1" } }, wire);
      if (init?.protocolVersion !== MCP_VERSION) throw new RpcFailure(-32600, `the connector speaks MCP ${init?.protocolVersion}, not ${MCP_VERSION}`);
      this.notify("notifications/initialized", wire);
      await this.listTools(wire);
      await this.request("resources/subscribe", { uri: WORK_URI }, wire);
      await this.read(wire);
    } catch (e) {
      if (this.wire !== wire) return;
      this.opts.log(`${this.name}: connector handshake failed (${e instanceof Error ? e.message : e})`);
      wire.close(CLOSE.protocol, "handshake failed");
      this.detach(wire);
    }
  }

  /** A frame from the connector (keep-alives are the host's). False when it breaks the protocol: close with 4003. */
  receive(wire: Wire, text: string): boolean {
    if (wire !== this.wire) return true;
    let m: any;
    try { m = JSON.parse(text); } catch { return false; }
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return false;
    if (typeof m.method === "string") {
      if (m.id !== undefined) {
        // The brain serves nothing; answer so the connector isn't left waiting.
        wire.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "The brain serves no requests." } }));
        return true;
      }
      if (m.method === "notifications/resources/updated" && m.params?.uri === WORK_URI) { if (this.live) void this.read(wire).catch(() => {}); return true; }
      if (m.method === "notifications/tools/list_changed") { if (this.live) void this.listTools(wire).catch(() => {}); return true; }
      return true;
    }
    if (typeof m.id !== "number") return false;
    const p = this.pending.get(m.id);
    if (!p) return true;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new RpcFailure(typeof m.error.code === "number" ? m.error.code : -32603, String(m.error.message ?? "The connector failed.")));
    else p.resolve(m.result);
    return true;
  }

  /** The link closed: whatever it was asked and hasn't answered may or may not have happened. */
  detach(wire: Wire) {
    if (wire !== this.wire) return;
    this.wire = null; this.live = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new LinkLost(`The link to ${spoken(this.name)} dropped; the outcome may be unknown.`)); }
    this.pending.clear();
    this.emit(this.state.items.map((i) => i.id));
  }

  revoke() {
    const wire = this.wire;
    if (wire) { this.detach(wire); wire.close(CLOSE.revoked, "revoked"); }
  }

  private async listTools(wire: Wire) {
    const r = await this.request("tools/list", {}, wire);
    const tools: any[] = Array.isArray(r?.tools) ? r.tools : [];
    const names: unknown[] = tools.map((t) => t?.name);
    this.state.actions = ACTIONS.filter((a) => names.includes(a));
    const required = tools.find((t) => t?.name === "start_work")?.inputSchema?.required;
    this.state.names = Array.isArray(required) && !required.includes("title");
    this.opts.onSaved?.(this.saved);
  }

  /** Reads the view (a delta since the last rev), one read at a time; a notice during a read reads once more after. */
  private read(wire: Wire): Promise<void> {
    if (this.reading) { this.readAgain = true; return this.reading; }
    this.reading = (async () => {
      do {
        this.readAgain = false;
        const uri = this.state.rev ? `${WORK_URI}?since=${encodeURIComponent(this.state.rev)}` : WORK_URI;
        const r = await this.request("resources/read", { uri }, wire);
        let f: any;
        try { f = JSON.parse(r?.contents?.[0]?.text); } catch { f = null; }
        if (!validRead(f)) throw new RpcFailure(-32600, "the connector's view isn't valid");
        if (wire !== this.wire) return;
        this.apply(f);
      } while (this.readAgain && wire === this.wire);
    })().finally(() => { this.reading = null; });
    return this.reading;
  }

  private apply(f: { rev: string; full: boolean; items: WorkItem[]; removed: string[]; places: Place[]; connections: Connection[]; refusals: Refusals; ceiling: Mode }) {
    const before = new Map(this.state.items.map((i) => [i.id, i]));
    const wasLive = this.live;
    let next: Map<string, WorkItem>;
    let changed: string[];
    if (f.full) {
      next = new Map(f.items.map((i) => [i.id, i]));
      // A machine that just linked is briefed in full; afterwards only what the briefing diffs on counts.
      changed = [...new Set([...before.keys(), ...next.keys()])].filter((id) => !wasLive || !before.has(id) || !next.has(id) || briefed(before.get(id)!) !== briefed(next.get(id)!));
    } else {
      next = new Map(before);
      for (const id of f.removed) next.delete(id);
      for (const i of f.items) next.set(i.id, i);
      changed = [...f.items.map((i) => i.id), ...f.removed.filter((id) => before.has(id))];
    }
    const urgent = f.items.some((i) => i.pendingQuestion && (!before.get(i.id)?.pendingQuestion || (before.get(i.id)?.questionId ?? null) !== (i.questionId ?? null)));
    this.state = { ...this.state, rev: f.rev, items: [...next.values()], places: f.places, connections: f.connections, refusals: f.refusals, ceiling: f.ceiling };
    this.loaded = true; this.live = true; this.markReady();
    this.opts.onSaved?.(this.saved);
    if (changed.length) this.emit(changed, urgent || !wasLive);
  }

  private request(method: string, params: object, wire = this.wire): Promise<any> {
    if (!wire || wire !== this.wire) return Promise.reject(new LinkLost(`${spoken(this.name)} isn't connected right now.`));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new RpcFailure(-32000, `${spoken(this.name)} has too many requests waiting.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new LinkLost(`${spoken(this.name)} didn't answer in time; the outcome may be unknown.`)); }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { wire.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new LinkLost(`${spoken(this.name)} isn't connected right now.`)); }
    });
  }
  private notify(method: string, wire: Wire) { wire.send(JSON.stringify({ jsonrpc: "2.0", method })); }

  // --- the adapter ---

  get isLoaded() { return this.loaded; }
  get actions(): readonly ActionKind[] { return this.state.actions; }
  private up(): boolean { return this.live && !!this.wire && this.opts.now() - this.wire.lastSeen() <= this.opts.staleMs; }
  connected(itemId?: string): boolean {
    if (!this.up()) return false;
    const conns = this.state.connections;
    if (itemId === undefined) return conns.some((c) => c.connected);
    const prefix = itemId.includes(":") ? itemId.slice(0, itemId.indexOf(":")) : "";
    return (conns.find((c) => c.prefix === prefix) ?? conns.find((c) => c.prefix === ""))?.connected ?? false;
  }
  async list(): Promise<WorkItem[]> {
    this.firstList ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.listTimeoutMs);
      void this.ready.then(() => { clearTimeout(timer); resolve(); });
    });
    await this.firstList;
    return this.state.items.map((i) => ({ ...i }));
  }
  places(): Place[] { return this.state.places.map((p) => ({ ...p })); }
  async report(id: string): Promise<Report> { return (await this.tool("read_report", { id })) as Report; }
  async replies(id: string): Promise<PastReply[]> { return ((await this.tool("past_replies", { id })) as { replies: PastReply[] }).replies; }

  /** From what the machine last said: no round trip, so a proposal never waits on the link. Execute checks again. */
  async check(action: Action): Promise<string | null> {
    const target = targetOf(action);
    if (!this.connected(target)) return `${spoken(this.name)} isn't connected right now, so the app can't change anything there.`;
    if (!this.state.actions.includes(action.kind)) return `The app isn't allowed to ${action.kind.replaceAll("_", " ")} on ${spoken(this.name)}.`;
    if (action.kind === "start_work" && MODES.indexOf(action.profile.runtimeMode) > MODES.indexOf(this.state.ceiling)) return `The ${action.profile.name} profile asks for more access than ${spoken(this.name)} allows.`;
    return this.state.refusals[target]?.[action.kind] ?? null;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (!this.connected(targetOf(action))) return { ok: false, error: `${spoken(this.name)} isn't connected right now, so nothing was sent.` };
    const { kind, ...args } = action.kind === "start_work" && !action.title && !this.state.names ? { ...action, title: titleFrom(action.message) } : action;
    try {
      const r = await this.request("tools/call", { name: kind, arguments: args, _meta: { "tenandtwo/key": key, "tenandtwo/ttlMs": this.opts.timeoutMs } });
      if (!validReceipt(r?.structuredContent)) return { ok: false, unknown: true, error: `${spoken(this.name)} answered with something the app doesn't understand; the outcome may be unknown.` };
      return r.structuredContent;
    } catch (e) { return this.failed(e); }
  }

  async markRead(id: string, watermark: string, key: string): Promise<Receipt | "unsupported"> {
    if (!this.connected(id)) return { ok: false, error: `${spoken(this.name)} isn't connected right now.` };
    try {
      const r = await this.request("tools/call", { name: "mark_read", arguments: { id, watermark }, _meta: { "tenandtwo/key": key } });
      const v = r?.structuredContent;
      if (v?.unsupported === true) return "unsupported";
      return validReceipt(v) ? v : { ok: false, unknown: true, error: "The connector's answer wasn't a receipt." };
    } catch (e) { return this.failed(e); }
  }

  /** Only an answer that says nothing was done is a known failure; anything else may have happened. */
  private failed(e: unknown): Receipt {
    const error = e instanceof Error ? e.message : String(e);
    return e instanceof RpcFailure && NOTHING_DONE.has(e.code) ? { ok: false, error } : { ok: false, error, unknown: true };
  }

  private async tool(name: string, args: object): Promise<unknown> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r?.isError) throw new Error(String(r?.content?.[0]?.text ?? "The connector couldn't do that."));
    return r?.structuredContent;
  }

  watch(l: (ids: string[], urgent: boolean) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit(ids: string[], urgent = false) { for (const l of this.listeners) l(ids, urgent); }
  async close() { const wire = this.wire; if (wire) { this.detach(wire); wire.close(1001, "closing"); } this.markReady(); }
}
