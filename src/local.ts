// Several work systems on this machine. T3 keeps its old ids; the others own a prefix, so adding an adapter never
// changes existing stars or operation keys. Policy is checked here even when a caller skips the voice-side check.
import type { Action, ActionKind, Adapter, DocumentText, FirstAsk, PastReply, Place, Receipt, Report, WorkItem } from "./contract.ts";
import { allows, rulesOf, visible, withinCeiling, type Agent, type Policy } from "./policy.ts";
import { NAMES } from "./agents.ts";
import { ANSWERED } from "./util.ts";
import { typedOf, type Found, type Sent, type Write } from "./typed.ts";
import { discoverDocuments, DocumentRegistry, toSummary, type ThreadDocContext } from "./documents.ts";
import type { Refusals } from "./view.ts";
import { privacyRefusal } from "./privacy.ts";

/**
 * How a send goes, beyond its action: `scheduled`, one set up for later, with when it was agreed, when it was due (none
 * for a chain's: when another thread finished) and the phone's zone then (schedules.ts), so an agent's message can say
 * so (Claude Code's inbox, claude/inbox.ts).
 */
export type How = { scheduled?: { agreedAt: string; at?: string; zone: string } };

export type LocalAdapter = {
  prefix: string;
  /**
   * `personWrites`: the messages its work system marks as a person's in a thread, newest last (typed.ts), from which each
   * item's `typed` is made; an adapter without it reports no `typed` (the brain then takes nothing as you writing).
   * `readsChecks`: it reads its threads' test runs (`Report.checks`, stage 3.10); each item says so (`testRuns`).
   * `sendLeftOut`: whether a send of 10 & 2's, as it went (asked once, after), is never among `personWrites` (no message, or
   * one it leaves out by its own mark), so the Ledger's record of it goes rather than claim your same words later.
   */
  adapter: Adapter & {
    readonly isLoaded?: boolean; refusals?(): Refusals;
    /**
     * The folder a process this connector starts for the action would work in: new work's project (`start_work`, by
     * place id), or a session nothing has open (`follow_up`). Null when it goes to something already running.
     */
    workFolder?(kind: ActionKind, id: string): string | null;
    personWrites?(id: string): Write[];
    readonly readsChecks?: boolean;
    sendLeftOut?(action: Action, key: string): boolean;
    execute(action: Action, key: string, how?: How): Promise<Receipt>;
    answerHold?(id: string, questionId: string, run: boolean): Promise<Receipt | "unsupported">;
    /** Local paths for linked-document discovery; never sent off this machine. */
    docContext?(id: string): ThreadDocContext | null;
  };
  /** Only adapters with backend idempotency may resend an outcome lost in a crash. */
  retrySafe?: boolean;
};

/** Each work system's own name (agents.ts `NAMES`, which this file can't import without the adapters). */
const SYSTEMS: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", copilot: "Copilot CLI", cursor: "Cursor", t3: "T3 Code" };
const target = (a: Action) => a.kind === "start_work" ? a.placeId : a.itemId;

/**
 * Why a start can't run on the model it names, said as "<place> said: …": Pi and OpenCode offer none through 10 & 2
 * yet; the others offer what their place lists now (docs/launch/thread-model.md).
 */
export function modelRefusal(app: string): string {
  const name = NAMES[app as Agent] ?? "That coding app";
  if (app === "pi" || app === "opencode") return `${name} can't start on a chosen model through 10 & 2 yet.`;
  return `${name} doesn't offer that model ${app === "t3" ? "for this project " : ""}now.`;
}

export class Local implements Adapter {
  readonly name = "local";
  private readonly entries: LocalAdapter[];
  private readonly policy: Policy;
  private readonly docs = new DocumentRegistry();
  private readonly loaded = new Set<LocalAdapter>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();

  /**
   * 10 & 2's own sends, as the Ledger recorded them (typed.ts): what `typed` leaves out; `claim`, the Ledger keeping the
   * message each was found as.
   */
  private readonly sends: () => Sent[];
  private readonly claim: (key: string, found: Found) => void;

  constructor(entries: LocalAdapter[], policy: Policy, sends: () => Sent[] = () => [], claim: (key: string, found: Found) => void = () => {}) {
    if (new Set(entries.map((e) => e.prefix)).size !== entries.length || entries.some((e) => e.prefix.includes(":"))) throw new Error("Each local adapter needs a unique prefix without a colon");
    this.entries = entries;
    this.policy = policy;
    this.sends = sends;
    this.claim = claim;
    for (const e of entries) if (e.adapter.isLoaded !== false) this.loaded.add(e);
  }

  get actions(): ActionKind[] {
    return [...new Set(this.entries.flatMap((e) => [...e.adapter.actions]))].filter((a) => allows(this.policy, a));
  }
  get ceiling() { return this.policy.maxRuntimeMode; }
  /** Whether commands on this computer's list wait for the phone (Commands that wait; the policy's `guard`). */
  get holds(): boolean { return (this.policy.guard?.length ?? 0) > 0; }
  /** What sends and starts set up for later may do here (the policy's `rules`). */
  get rules() { return rulesOf(this.policy); }
  get documentsEnabled(): boolean { return (this.policy.documents ?? "off") !== "off"; }
  get isLoaded(): boolean { return this.entries.some((e) => e.adapter.isLoaded !== false); }
  /** Every work system has read its state at least once. */
  get allLoaded(): boolean { return this.entries.every((e) => e.adapter.isLoaded !== false); }
  private id(e: LocalAdapter, id: string): string { return e.prefix ? `${e.prefix}:${id}` : id; }
  private route(id: string): { e: LocalAdapter; id: string } {
    const at = id.indexOf(":");
    const e = this.entries.find((e) => e.prefix && e.prefix === id.slice(0, at));
    if (e) return { e, id: id.slice(at + 1) };
    const plain = this.entries.find((e) => !e.prefix);
    if (!plain) throw new Error("That work system isn't available on this machine.");
    return { e: plain, id };
  }
  private action(a: Action, id: string): Action { return a.kind === "start_work" ? { ...a, placeId: id } : { ...a, itemId: id }; }
  retrySafe(a: Action): boolean { return this.route(target(a)).e.retrySafe === true; }
  connections() { return this.entries.map((e) => ({ prefix: e.prefix, name: e.adapter.name, connected: e.adapter.connected() })); }
  connectionStatus() { return this.connections().map(({ name, connected }) => ({ name, connected })); }
  /**
   * Whether the work system holding `id` (an item, or a place for new work) has loaded and is connected now: a
   * schedule for it waits while it isn't (T3 Code not running). Throws when no work system here takes that id.
   */
  ready(id: string): boolean {
    const r = this.route(id);
    return r.e.adapter.isLoaded !== false && r.e.adapter.connected(r.id);
  }
  /** The work system's own name for `id`'s ("T3 Code"), as a schedule held for it says. */
  systemOf(id: string): string {
    const name = this.route(id).e.adapter.name;
    return SYSTEMS[name as Agent] ?? name;
  }
  connected(id?: string): boolean {
    if (id === undefined) return this.entries.some((e) => e.adapter.connected());
    const r = this.route(id);
    return r.e.adapter.connected(r.id);
  }
  async list(): Promise<WorkItem[]> {
    const sends = this.sends();
    const lists = await Promise.all(this.entries.filter((e) => e.adapter.isLoaded !== false).map(async (e) => {
      const items = (await e.adapter.list()).map((i) => {
        const id = this.id(e, i.id);
        // When you last wrote in it yourself, leaving out 10 & 2's own sends (the engine's stage 3.9).
        const writes = e.adapter.personWrites?.(i.id);
        // Whether its test runs are read (stage 3.10): said for every item, so a brain can tell an older connector's silence.
        return { ...i, id, parentId: i.parentId === null ? null : this.id(e, i.parentId), ...(writes ? { typed: typedOf(id, writes, sends, this.claim, i.createdAt) } : {}), testRuns: e.adapter.readsChecks === true };
      });
      if (!this.loaded.has(e)) {
        this.loaded.add(e);
        for (const listener of this.listeners) listener(items.map((i) => i.id), false);
      }
      return items;
    }));
    return lists.flat();
  }
  /** Per item, the allowed actions its work system would refuse right now and why. */
  refusals(): Refusals {
    const out: Refusals = {};
    for (const e of this.entries) {
      if (e.adapter.isLoaded === false) continue;
      for (const [id, reasons] of Object.entries(e.adapter.refusals?.() ?? {})) {
        const kept = Object.fromEntries(Object.entries(reasons).filter(([kind]) => allows(this.policy, kind as ActionKind)));
        if (Object.keys(kept).length) out[this.id(e, id)] = kept;
      }
    }
    return out;
  }
  places(): Place[] { return this.entries.filter((e) => e.adapter.isLoaded !== false).flatMap((e) => (e.adapter.places?.() ?? []).map((p) => ({ ...p, id: this.id(e, p.id) }))); }
  /**
   * Whether macOS lets this program into the protected folders (privacy.ts) that projects where new work can start
   * are in; asking makes macOS show its prompt, so the login service asks once it has read every work system.
   */
  async privacy(): Promise<string[]> {
    const refusals = new Set<string>();
    for (const e of this.entries) {
      if (e.adapter.isLoaded === false) continue;
      for (const p of e.adapter.places?.() ?? []) { const why = await privacyRefusal(e.adapter.workFolder?.("start_work", p.id)); if (why) refusals.add(why); }
    }
    return [...refusals];
  }
  async report(id: string): Promise<Report> {
    const r = this.route(id);
    const rep = await r.e.adapter.report(r.id);
    const access = this.policy.documents ?? "off";
    if (access === "off") return rep;
    const ctx = r.e.adapter.docContext?.(r.id);
    if (!ctx) return rep;
    const found = await discoverDocuments({
      threadId: id,
      replyText: rep.text,
      ctx,
      access,
      visibleProject: (folder) => visible(this.policy, folder),
    });
    if (!found.length) return rep;
    this.docs.register(id, found);
    return { ...rep, docs: found.map(toSummary) };
  }
  async readDocument(id: string, docId: string): Promise<DocumentText> {
    const access = this.policy.documents ?? "off";
    if (access === "off") throw new Error("Document reading is turned off on this computer.");
    const r = this.route(id);
    if (!r.e.adapter.docContext?.(r.id)) throw new Error("That thread isn't visible to 10 & 2.");
    return this.docs.read(id, docId, access);
  }
  replies(id: string): Promise<PastReply[]> { const r = this.route(id); return r.e.adapter.replies?.(r.id) ?? Promise.resolve([]); }
  firstAsk(id: string): Promise<FirstAsk | null> { const r = this.route(id); return r.e.adapter.firstAsk?.(r.id) ?? Promise.resolve(null); }
  async check(a: Action): Promise<string | null> {
    if (!allows(this.policy, a.kind)) return `10 & 2 isn't allowed to ${a.kind.replaceAll("_", " ")} on this machine.`;
    if (a.kind === "start_work" && !withinCeiling(this.policy, a.profile)) return `The ${a.profile.name} profile asks for more access than this machine allows.`;
    const r = this.route(target(a));
    if (!r.e.adapter.actions.includes(a.kind)) return `This work system can't ${a.kind.replaceAll("_", " ")}.`;
    // An answer to one question (a tap) goes only while the thread asks that question by the work system's latest view,
    // looked at last thing before dispatch: the brain's copy may be behind (answered here, or asked again since). A work
    // system that hasn't loaded yet is refused by its own check.
    if (a.kind === "follow_up" && a.questionId !== undefined && r.e.adapter.isLoaded !== false) {
      const now = (await r.e.adapter.list()).find((i) => i.id === r.id);
      if (!now?.pendingQuestion || now.questionId !== a.questionId) return ANSWERED;
    }
    const why = await r.e.adapter.check?.(this.action(a, r.id)) ?? null;
    if (why) return why;
    // A folder macOS keeps closed to this program would leave the work waiting on a prompt nobody sees (privacy.ts).
    const closed = await privacyRefusal(r.e.adapter.workFolder?.(a.kind, r.id));
    if (closed) return closed;
    // A model the place doesn't list now would start on something nobody chose, or not at all: nothing is sent.
    if (a.kind === "start_work" && a.model !== undefined) {
      const { adapter } = r.e;
      if (!adapter.places?.().find((p) => p.id === r.id)?.models?.some((m) => m.id === a.model)) return modelRefusal(adapter.name);
    }
    return null;
  }
  async execute(a: Action, key: string): Promise<Receipt> {
    const reason = await this.check(a);
    if (reason) return { ok: false, error: reason };
    return this.dispatch(a, key);
  }
  /** Why an action can't be sent now: `check`'s reason, or the deadline passing while it ran. Asked just before dispatch. */
  async refusal(a: Action, deadline: number): Promise<string | null> {
    if (Date.now() >= deadline) return "That operation expired. Nothing was sent.";
    return await this.check(a) ?? (Date.now() >= deadline ? "That operation expired. Nothing was sent." : null);
  }
  /** Sends an action already checked (`refusal`) to its work system. */
  async dispatch(a: Action, key: string, how?: How): Promise<Receipt> {
    const r = this.route(target(a));
    const receipt = await (how ? r.e.adapter.execute(this.action(a, r.id), key, how) : r.e.adapter.execute(this.action(a, r.id), key));
    return receipt.ok && receipt.itemId ? { ...receipt, itemId: this.id(r.e, receipt.itemId) } : receipt;
  }
  /** Whether send `a` (key `key`), as it went, is never among its work system's `personWrites` (`LocalAdapter`). */
  sendLeftOut(a: Action, key: string): boolean {
    try {
      const r = this.route(target(a));
      return r.e.adapter.sendLeftOut?.(this.action(a, r.id), key) === true;
    } catch { return false; }
  }
  /**
   * Answers a held command (Commands that wait; gate.ts): Let it run or Stop it, from the phone's release path only.
   * "unsupported": its work system holds none (only Claude Code's, and T3 Code's Claude threads, do).
   */
  answerHold(id: string, questionId: string, run: boolean): Promise<Receipt | "unsupported"> {
    const r = this.route(id);
    return r.e.adapter.answerHold?.(r.id, questionId, run) ?? Promise.resolve("unsupported");
  }
  markRead(id: string, watermark: string, key: string): Promise<Receipt | "unsupported"> {
    const r = this.route(id);
    return r.e.adapter.markRead?.(r.id, watermark, key) ?? Promise.resolve("unsupported");
  }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void {
    this.listeners.add(onChange);
    const stops = this.entries.map((e) => e.adapter.watch((ids, urgent) => onChange(ids.map((id) => this.id(e, id)), urgent)));
    return () => { this.listeners.delete(onChange); stops.forEach((stop) => stop()); };
  }
  async close() { await Promise.all(this.entries.map((e) => e.adapter.close())); }
}
