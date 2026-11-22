// One machine's connector, as an adapter: the brain is the MCP client of the connector's server, over the socket the
// connector opened (docs/launch/contracts.md §2). No Node or Workers APIs here, so the Node brain on Lattice and a
// user's Durable Object can both carry it on their own sockets.
//
// What the brain knows of the machine (its view, rev and tools) is plain data a host can save and restore, so a
// Durable Object that hibernates between frames picks up where it left off without asking again.
import { titleFrom, type Action, type ActionKind, type Adapter, type DocumentText, type FirstAsk, type Held, type LaterLink, type LaterRules, type LaunchProfile, type CodingModel, type PastReply, type Place, type Receipt, type Report, type Schedule, type SetAnswer, type WirePlace, type WorkItem } from "./adapter.ts";
import { validZone } from "./zone.ts";
import { cleanChecks } from "./receipts.ts";
import { APPS, type App } from "./places.ts";

export const SUBPROTOCOL = "10and2.mcp.1";
export const MCP_VERSION = "2025-06-18";
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';
export const WORK_URI = "tenandtwo://work";
export const CLOSE = { revoked: 4001, replaced: 4002, protocol: 4003 } as const;
const REQUEST_MS = 25_000;
/**
 * A send or a start may take longer than a read to answer: a start in a large repository makes its git worktree first.
 * Timed out, it's "outcome unknown", so it gets this long.
 */
export const WRITE_MS = 90_000;
/** The actions that wait for `WRITE_MS`; every other request waits `REQUEST_MS`. */
const WRITES: ReadonlySet<string> = new Set(["follow_up", "start_work"]);
/** A link the connector hasn't pinged for this long is treated as down, so a half-open one fails at once. */
export const STALE_MS = 75_000;
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
 * on). Absent or false, a start the brain made no title for (titles.ts) is sent one made from its prompt (`titleFrom`),
 * as connectors before it need one. `firstAsks`: it lists `first_ask` (0.10.0 on). `timeZone`: the machine's, as its
 * `serverInfo` said it (0.10.0 on), when that's a zone this runtime knows. `models`: its start_work takes a `model`
 * (its schema lists one, after 0.10.0); absent (a view saved before) or false, a start on a chosen model is refused here.
 * `catalogs`: the models its places offer, by the key each place names (`WirePlace.catalog`), as its last view said
 * them; absent from a connector that sends none (0.10.0 and before), so its places have no `models`. `asks`: its
 * follow_up takes the `questionId` an answer to one question carries (a tap), and refuses it unless the thread asks that
 * question then. Absent or false, the field is left out (a connector refuses fields it doesn't know), and only the
 * brain's own look guards the answer.
 * `schedules`: it lists `set_schedules` (stage 4a's connector on); `rules` and `held`: its view's `rules` and
 * `schedules` (null and none from a connector without them), what sends and starts for later may do there and what it
 * holds (stage 4b).
 */
export type Saved = { rev: string | null; items: WorkItem[]; places: WirePlace[]; connections: Connection[]; refusals: Refusals; ceiling: Mode; actions: ActionKind[]; names?: boolean; firstAsks?: boolean; documents?: boolean; timeZone?: string | null; models?: boolean; catalogs?: Record<string, CodingModel[]>; asks?: boolean; schedules?: boolean; rules?: LaterRules | null; held?: Held[]; holds?: boolean };
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
/** At most this many lists, each of this many models, are kept from a view: more than any coding app offers. */
const CATALOGS_MAX = 200;
const MODELS_MAX = 200;
/**
 * A view's `catalogs`, as far as they can be read: a list that isn't one is dropped, and so is a model without an id
 * (1–200 characters, sent back as is) and a name (1–100, said), or a name it has already on that provider (one per
 * name and provider). A provider (1–100) is kept where there's one; any other is none. Never a reason to refuse the
 * view: an odd list costs that list. Absent: the connector sends none (an older one).
 */
function catalogsOf(v: unknown): Record<string, CodingModel[]> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const text = (s: unknown, max: number): s is string => typeof s === "string" && s.trim() !== "" && s.length <= max;
  return Object.fromEntries(Object.entries(v).filter(([, list]) => Array.isArray(list)).slice(0, CATALOGS_MAX).map(([key, list]: [string, unknown[]]) => {
    const seen = new Set<string>();
    const provider = (m: any): string | undefined => (text(m.provider, 100) ? m.provider.trim() : undefined);
    const once = (m: any) => `${m.name.trim().toLowerCase()}|${provider(m)?.toLowerCase() ?? ""}`;
    const models = list.filter((m: any) => m && text(m.id, 200) && text(m.name, 100) && !seen.has(once(m)) && !!seen.add(once(m)));
    return [key, models.slice(0, MODELS_MAX).map((m: any) => ({ id: m.id, name: m.name.trim(), ...(provider(m) ? { provider: provider(m) } : {}) }))];
  }));
}
const RULES: LaterRules[] = ["off", "send", "start"];
const HELD_STATES = ["waiting", "firing", "sent", "not_sent", "missed", "cancelled", "unknown", "refused"];
const optStr = (v: unknown) => v === undefined || (typeof v === "string" && v.length <= 2000);
/** A held row the brain can read: its id and state, and every field it has of the shape it should be; others are left out. */
const validHeld = (h: any): h is Held => h && str(h.id) && h.id.length <= 200 && HELD_STATES.includes(h.state) && optStr(h.code) && optStr(h.why) && optStr(h.app) && optStr(h.at) && optStr(h.firedAt) &&
  (h.receipt === undefined || validReceipt(h.receipt)) && (h.after === undefined || (h.after && (h.after.lastRunAt === null || str(h.after.lastRunAt)) && (h.after.questionId === null || str(h.after.questionId))));
const validFirstAsk = (f: any): f is FirstAsk | null => f === null || (f && str(f.text) && str(f.at) && typeof f.complete === "boolean");
const validDocument = (d: any): d is DocumentText => d && str(d.id) && str(d.name) && typeof d.text === "string" && str(d.contentHash);
const validReceipt = (r: any): r is Receipt => r && (r.ok === true ? r.itemId === undefined || str(r.itemId) : r.ok === false && str(r.error));
/** The fields the briefing diffs on, and what a question waits on; an updatedAt-only change means nothing to it. */
const briefed = (i: WorkItem) => JSON.stringify([i.status, i.title, i.settled, i.snoozedUntil, i.pendingQuestion, i.questionId ?? null, i.questionKind ?? null, i.lastRunAt ?? null, i.group, i.parentId, i.visitedAt ?? null]);
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
  private readonly laterListeners = new Set<(why: "linked" | "report") => void>();
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private firstList: Promise<void> | null = null;
  private readonly opts: { timeoutMs: number; writeTimeoutMs: number; listTimeoutMs: number; staleMs: number; now: () => number; onSaved?: (s: Saved) => void; log: (m: string) => void };

  constructor(name: string, opts: { timeoutMs?: number; writeTimeoutMs?: number; listTimeoutMs?: number; staleMs?: number; now?: () => number; onSaved?: (s: Saved) => void; log?: (m: string) => void } = {}) {
    this.name = name;
    this.opts = { timeoutMs: opts.timeoutMs ?? REQUEST_MS, writeTimeoutMs: opts.writeTimeoutMs ?? opts.timeoutMs ?? WRITE_MS, listTimeoutMs: opts.listTimeoutMs ?? 15_000, staleMs: opts.staleMs ?? STALE_MS, now: opts.now ?? (() => Date.now()), onSaved: opts.onSaved, log: opts.log ?? (() => {}) };
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
      // Saved with the tool list, next.
      this.state.timeZone = validZone(init?.serverInfo?.timeZone);
      this.notify("notifications/initialized", wire);
      await this.listTools(wire);
      await this.request("resources/subscribe", { uri: WORK_URI }, wire);
      await this.read(wire);
      // The handshake ends with the first set of sends and starts for later (stage 4b), sent even when it's empty: until
      // one is applied on this link, the computer fires none (Stop always wins).
      if (this.wire === wire) this.emitLater("linked");
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
    const schema = tools.find((t) => t?.name === "start_work")?.inputSchema;
    const required = schema?.required;
    this.state.names = Array.isArray(required) && !required.includes("title");
    // A start on a chosen model goes only to a connector that takes one: an older one refuses the field.
    this.state.models = !!schema?.properties && typeof schema.properties === "object" && Object.hasOwn(schema.properties, "model");
    this.state.firstAsks = names.includes("first_ask");
    this.state.asks = !!tools.find((t) => t?.name === "follow_up")?.inputSchema?.properties?.questionId;
    this.state.schedules = names.includes("set_schedules");
    // Commands that wait: it holds them (its list isn't empty), and lets one run or stops it with `answer_hold`.
    this.state.holds = names.includes("answer_hold");
    this.state.documents = names.includes("read_document");
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

  private apply(f: { rev: string; full: boolean; items: WorkItem[]; removed: string[]; places: WirePlace[]; catalogs?: unknown; connections: Connection[]; refusals: Refusals; ceiling: Mode; rules?: unknown; schedules?: unknown }) {
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
    // What it holds for later and lets them do (stage 4a's connector on; an older one has neither): whole each time.
    const rules = RULES.includes(f.rules as LaterRules) ? (f.rules as LaterRules) : null;
    const held = Array.isArray(f.schedules) ? f.schedules.filter(validHeld) : [];
    // The catalogs come whole with every read, as the places do.
    this.state = { ...this.state, rev: f.rev, items: [...next.values()], places: f.places, catalogs: catalogsOf(f.catalogs), connections: f.connections, refusals: f.refusals, ceiling: f.ceiling, rules, held };
    this.loaded = true; this.live = true; this.markReady();
    this.opts.onSaved?.(this.saved);
    if (changed.length) this.emit(changed, urgent || !wasLive);
    // The handshake's own first read says it's linked once it's done; any later one is a report.
    if (wasLive) this.emitLater("report");
  }

  private request(method: string, params: object, wire = this.wire, timeoutMs = this.opts.timeoutMs): Promise<any> {
    if (!wire || wire !== this.wire) return Promise.reject(new LinkLost(`${spoken(this.name)} isn't connected right now.`));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new RpcFailure(-32000, `${spoken(this.name)} has too many requests waiting.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new LinkLost(`${spoken(this.name)} didn't answer in time; the outcome may be unknown.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { wire.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new LinkLost(`${spoken(this.name)} isn't connected right now.`)); }
    });
  }
  private notify(method: string, wire: Wire) { wire.send(JSON.stringify({ jsonrpc: "2.0", method })); }

  // --- the adapter ---

  get isLoaded() { return this.loaded; }
  get actions(): readonly ActionKind[] { return this.state.actions; }
  /**
   * The machine itself is reporting: its link is up and heard from within `staleMs`, whatever its agent apps say (a
   * computer offline, docs/launch/engine.md §11 item 7, is this false, never T3 Code down on a live computer).
   */
  linked(): boolean { return this.live && !!this.wire && this.opts.now() - this.wire.lastSeen() <= this.opts.staleMs; }
  /** When the current link last heard from the machine (a frame, a ping, its opening); null with none (the host knows when the last one closed). */
  heardAt(): number | null { return this.wire ? this.wire.lastSeen() : null; }
  connected(itemId?: string): boolean {
    if (!this.linked()) return false;
    const conns = this.state.connections;
    if (itemId === undefined) return conns.some((c) => c.connected);
    return this.connectionOf(itemId)?.connected ?? false;
  }
  /** The work system holding `itemId` by its own name ("T3 Code"), as this machine's view last listed it, or null. */
  appOf(itemId: string): string | null {
    const c = this.connectionOf(itemId);
    return c ? (Object.hasOwn(APPS, c.name) ? APPS[c.name as App] : c.name) : null;
  }
  private connectionOf(itemId: string): Connection | undefined {
    const conns = this.state.connections;
    const prefix = itemId.includes(":") ? itemId.slice(0, itemId.indexOf(":")) : "";
    return conns.find((c) => c.prefix === prefix) ?? conns.find((c) => c.prefix === "");
  }
  async list(): Promise<WorkItem[]> {
    this.firstList ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.listTimeoutMs);
      void this.ready.then(() => { clearTimeout(timer); resolve(); });
    });
    await this.firstList;
    return this.state.items.map((i) => ({ ...i }));
  }
  /**
   * Each place with its models, from the catalog it names (none named: none offered); a connector that sends no
   * catalogs gives places with no `models` at all.
   */
  places(): Place[] {
    const catalogs = this.state.catalogs;
    return this.state.places.map(({ catalog, models: _, ...p }: WirePlace & { models?: unknown }) =>
      catalogs ? { ...p, models: typeof catalog === "string" && Object.hasOwn(catalogs, catalog) ? catalogs[catalog].map((m) => ({ ...m })) : [] } : p);
  }
  async report(id: string): Promise<Report> {
    const { checks, checksUnread, running, runningSince, runningId, ...r } = (await this.tool("read_report", { id })) as Report;
    // Tests passed or failed (docs/launch/engine.md §11 stage 3.10): only what a receipt may carry, whatever the machine
    // sent (an older connector sends none).
    const clean = cleanChecks(checks), now = cleanChecks(running);
    const since = now && typeof runningSince === "string" && Number.isFinite(Date.parse(runningSince)) ? runningSince : null;
    const run = now && typeof runningId === "string" && runningId.length > 0 && runningId.length <= 200 ? runningId : null;
    return { ...r, ...(clean ? { checks: clean } : checksUnread === true ? { checksUnread: true as const } : {}), ...(now ? { running: now, ...(since ? { runningSince: since } : {}), ...(run ? { runningId: run } : {}) } : {}) };
  }
  async replies(id: string): Promise<PastReply[]> { return ((await this.tool("past_replies", { id })) as { replies: PastReply[] }).replies; }
  /** Null from a connector before 0.10.0, which has no `first_ask`. */
  async firstAsk(id: string): Promise<FirstAsk | null> {
    if (!this.state.firstAsks) return null;
    const first = ((await this.tool("first_ask", { id })) as { first?: unknown } | undefined)?.first ?? null;
    if (!validFirstAsk(first)) throw new Error(`${spoken(this.name)} answered with a first message the app doesn't understand.`);
    return first;
  }
  /** Null from a connector that hasn't opted into linked documents or predates `read_document`. */
  async readDocument(id: string, docId: string): Promise<DocumentText | null> {
    if (!this.state.documents) return null;
    const doc = await this.tool("read_document", { id, docId });
    if (!validDocument(doc)) throw new Error(`${spoken(this.name)} answered with a document the app doesn't understand.`);
    return doc;
  }
  /** Every item here is on this one machine. */
  timeZone(): string | null { return this.state.timeZone ?? null; }

  /** From what the machine last said: no round trip, so a proposal never waits on the link. Execute checks again. */
  async check(action: Action): Promise<string | null> {
    if (!this.connected(targetOf(action))) return `${spoken(this.name)} isn't connected right now, so the app can't change anything there.`;
    return this.allows(action);
  }

  /** The machine's own saved word on `action` (its tools, its ceiling, its refusals), whether or not it's connected now. */
  allows(action: Action): string | null {
    const target = targetOf(action);
    if (!this.state.actions.includes(action.kind)) return `The app isn't allowed to ${action.kind.replaceAll("_", " ")} on ${spoken(this.name)}.`;
    if (action.kind === "start_work" && MODES.indexOf(action.profile.runtimeMode) > MODES.indexOf(this.state.ceiling)) return `The ${action.profile.name} profile asks for more access than ${spoken(this.name)} allows.`;
    if (action.kind === "start_work" && action.model !== undefined) {
      // A view with catalogs is from a connector that takes a model (they came together): a link resumed with what an
      // older brain saved has never listed its tools again, so has no `models` yet.
      if (!(this.state.models ?? this.state.catalogs !== undefined)) return `10 & 2 on ${spoken(this.name)} can't start a thread on a chosen model until it's updated. Ask the user whether to start it as usual.`;
      // Which models it takes now is the connector's to say (it checks before sending anything): a model the brain chose
      // from this list may be listed under another of T3's providers by the yes, and T3 still takes it.
    }
    return this.state.refusals[target]?.[action.kind] ?? null;
  }

  // --- sends and starts for later (docs/launch/engine.md §5; contracts §2; stage 4b) ---

  /**
   * This machine as the brain hands it sends and starts for later (`LaterLink`, without its name and prefix, which the
   * adapter spanning it adds): what it last said, read when asked.
   */
  laterLink(): Omit<LaterLink, "machine" | "prefix"> {
    const self = this;
    return {
      get tool() { return !!self.state.schedules; },
      get rules() { return self.state.rules ?? null; },
      get ceiling() { return self.state.ceiling; },
      get held() { return (self.state.held ?? []).map((h) => ({ ...h })); },
      linked: () => this.linked(),
      allows: (action) => this.allows(action),
      set: (seq, schedules, now) => this.setSchedules(seq, schedules, now),
    };
  }

  /**
   * Hands the machine its whole set (`set_schedules`), with the brain's clock for its check: what it holds now, or a
   * refusal of the whole set. A set that times out, or fails on the wire, closes the wire (`CLOSE.protocol`): the
   * computer may never have seen it, and an older set mustn't stay in force; the reconnect's first set decides.
   */
  async setSchedules(seq: number, schedules: Schedule[], now: number): Promise<SetAnswer> {
    const wire = this.wire;
    if (!wire || !this.live || !this.state.schedules) return { lost: true };
    const closing = (why: string): SetAnswer => {
      this.opts.log(`${this.name}: set_schedules ${why}; closing the link`);
      if (this.wire === wire) {
        wire.close(CLOSE.protocol, "set_schedules failed");
        this.detach(wire);
      }
      return { lost: true };
    };
    let r: any;
    try {
      r = await this.request("tools/call", { name: "set_schedules", arguments: { seq, schedules }, _meta: { "tenandtwo/now": now } }, wire);
    } catch (e) {
      return closing(`failed (${e instanceof Error ? e.message : e})`);
    }
    const v = r?.structuredContent;
    if (r?.isError && (v?.refused === "stale" || v?.refused === "clock") && str(v.error)) {
      return { refused: v.refused, error: v.error, ...(typeof v.minutes === "number" && Number.isFinite(v.minutes) ? { minutes: v.minutes } : {}) };
    }
    if (r?.isError || !Array.isArray(v?.held)) return closing("answered with something the app doesn't understand");
    const held = (v.held as unknown[]).filter(validHeld);
    if (this.wire === wire) {
      this.state.held = held;
      this.opts.onSaved?.(this.saved);
    }
    return { held };
  }

  onLater(l: (why: "linked" | "report") => void) { this.laterListeners.add(l); return () => { this.laterListeners.delete(l); }; }
  private emitLater(why: "linked" | "report") { for (const l of [...this.laterListeners]) l(why); }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (!this.connected(targetOf(action))) return { ok: false, error: `${spoken(this.name)} isn't connected right now, so nothing was sent.` };
    const sent = action.kind === "start_work" && !action.title && !this.state.names ? { ...action, title: titleFrom(action.message) }
      : action.kind === "follow_up" && action.questionId !== undefined && !this.state.asks ? { kind: action.kind, itemId: action.itemId, message: action.message } : action;
    const { kind, ...args } = sent;
    try {
      const ms = WRITES.has(kind) ? this.opts.writeTimeoutMs : this.opts.timeoutMs;
      const r = await this.request("tools/call", { name: kind, arguments: args, _meta: { "tenandtwo/key": key, "tenandtwo/ttlMs": ms } }, this.wire, ms);
      if (!validReceipt(r?.structuredContent)) return { ok: false, unknown: true, error: `${spoken(this.name)} answered with something the app doesn't understand; the outcome may be unknown.` };
      const receipt: Receipt = r.structuredContent;
      // The connector answers a start once its own view has the thread; read that view now, rather than on its notice,
      // so the new thread is listed, with its name, as Driver says it started (14 November).
      if (receipt.ok && receipt.itemId && !this.state.items.some((i) => i.id === receipt.itemId) && this.wire) await this.read(this.wire).catch(() => {});
      return receipt;
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

  /**
   * Answers a held command (Commands that wait; connector/src/gate.ts): lets it run, or stops it, for that hold only.
   * "unsupported": this computer's 10and2 holds no commands (no `answer_hold`).
   */
  async answerHold(id: string, questionId: string, run: boolean): Promise<Receipt | "unsupported"> {
    if (!this.state.holds) return "unsupported";
    if (!this.connected(id)) return { ok: false, error: `${spoken(this.name)} isn't connected right now, so nothing was sent.` };
    try {
      const r = await this.request("tools/call", { name: "answer_hold", arguments: { itemId: id, questionId, run } });
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
