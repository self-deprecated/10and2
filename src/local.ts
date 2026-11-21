// Several work systems on this machine. T3 keeps its old ids; the others own a prefix, so adding an adapter never
// changes existing stars or operation keys. Policy is checked here even when a caller skips the voice-side check.
import type { Action, ActionKind, Adapter, FirstAsk, PastReply, Place, Receipt, Report, WorkItem } from "./contract.ts";
import { allows, withinCeiling, type Agent, type Policy } from "./policy.ts";
import { NAMES } from "./agents.ts";
import type { Refusals } from "./view.ts";
import { privacyRefusal } from "./privacy.ts";

export type LocalAdapter = {
  prefix: string;
  adapter: Adapter & {
    readonly isLoaded?: boolean; refusals?(): Refusals;
    /**
     * The folder a process this connector starts for the action would work in: new work's project (`start_work`, by
     * place id), or a session nothing has open (`follow_up`). Null when it goes to something already running.
     */
    workFolder?(kind: ActionKind, id: string): string | null;
  };
  /** Only adapters with backend idempotency may resend an outcome lost in a crash. */
  retrySafe?: boolean;
};

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
  private readonly loaded = new Set<LocalAdapter>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();

  constructor(entries: LocalAdapter[], policy: Policy) {
    if (new Set(entries.map((e) => e.prefix)).size !== entries.length || entries.some((e) => e.prefix.includes(":"))) throw new Error("Each local adapter needs a unique prefix without a colon");
    this.entries = entries;
    this.policy = policy;
    for (const e of entries) if (e.adapter.isLoaded !== false) this.loaded.add(e);
  }

  get actions(): ActionKind[] {
    return [...new Set(this.entries.flatMap((e) => [...e.adapter.actions]))].filter((a) => allows(this.policy, a));
  }
  get ceiling() { return this.policy.maxRuntimeMode; }
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
  connected(id?: string): boolean {
    if (id === undefined) return this.entries.some((e) => e.adapter.connected());
    const r = this.route(id);
    return r.e.adapter.connected(r.id);
  }
  async list(): Promise<WorkItem[]> {
    const lists = await Promise.all(this.entries.filter((e) => e.adapter.isLoaded !== false).map(async (e) => {
      const items = (await e.adapter.list()).map((i) => ({
        ...i, id: this.id(e, i.id), parentId: i.parentId === null ? null : this.id(e, i.parentId),
      }));
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
  report(id: string): Promise<Report> { const r = this.route(id); return r.e.adapter.report(r.id); }
  replies(id: string): Promise<PastReply[]> { const r = this.route(id); return r.e.adapter.replies?.(r.id) ?? Promise.resolve([]); }
  firstAsk(id: string): Promise<FirstAsk | null> { const r = this.route(id); return r.e.adapter.firstAsk?.(r.id) ?? Promise.resolve(null); }
  async check(a: Action): Promise<string | null> {
    if (!allows(this.policy, a.kind)) return `10 & 2 isn't allowed to ${a.kind.replaceAll("_", " ")} on this machine.`;
    if (a.kind === "start_work" && !withinCeiling(this.policy, a.profile)) return `The ${a.profile.name} profile asks for more access than this machine allows.`;
    const r = this.route(target(a));
    if (!r.e.adapter.actions.includes(a.kind)) return `This work system can't ${a.kind.replaceAll("_", " ")}.`;
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
  async dispatch(a: Action, key: string): Promise<Receipt> {
    const r = this.route(target(a));
    const receipt = await r.e.adapter.execute(this.action(a, r.id), key);
    return receipt.ok && receipt.itemId ? { ...receipt, itemId: this.id(r.e, receipt.itemId) } : receipt;
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
