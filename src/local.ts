// Several work systems on this machine. T3 keeps its old ids; the others own a prefix, so adding an adapter never
// changes existing stars or operation keys. Policy is checked here even when a caller skips the voice-side check.
import type { Action, ActionKind, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "./contract.ts";
import { allows, withinCeiling, type Policy } from "./policy.ts";
import type { Refusals } from "./view.ts";

export type LocalAdapter = {
  prefix: string;
  adapter: Adapter & { readonly isLoaded?: boolean; refusals?(): Refusals };
  /** Only adapters with backend idempotency may resend an outcome lost in a crash. */
  retrySafe?: boolean;
};

const target = (a: Action) => a.kind === "start_work" ? a.placeId : a.itemId;

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
  report(id: string): Promise<Report> { const r = this.route(id); return r.e.adapter.report(r.id); }
  replies(id: string): Promise<PastReply[]> { const r = this.route(id); return r.e.adapter.replies?.(r.id) ?? Promise.resolve([]); }
  async check(a: Action): Promise<string | null> {
    if (!allows(this.policy, a.kind)) return `Driver isn't allowed to ${a.kind.replaceAll("_", " ")} on this machine.`;
    if (a.kind === "start_work" && !withinCeiling(this.policy, a.profile)) return `The ${a.profile.name} profile asks for more access than this machine allows.`;
    const r = this.route(target(a));
    if (!r.e.adapter.actions.includes(a.kind)) return `This work system can't ${a.kind.replaceAll("_", " ")}.`;
    return r.e.adapter.check?.(this.action(a, r.id)) ?? null;
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
