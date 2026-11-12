// Threads on several machines as one work system. The brain's own machine keeps its ids; another machine's are
// "<machine>|<id>", and their group says where they are ("expo, on Quartz"), so names and commands go to the right
// machine. A machine that hasn't answered yet (asleep, offline) contributes nothing rather than holding everyone up.
import type { Action, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "./adapter.ts";
import { describe } from "./util.ts";

export type Machine = {
  /** Its configured machine name, which is also how it's said: "on Quartz". */
  name: string;
  adapter: Adapter & { readonly isLoaded?: boolean };
  /** The brain's own machine: its ids are kept as they are, and its failures are the brain's failures. */
  local?: boolean;
  /** How it's said when it isn't its name: the brain's own machine, by its host name ("Lattice"). */
  said?: string;
};

const SEP = "|";
const spoken = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export class Machines implements Adapter {
  readonly name = "machines";
  private readonly machines: Machine[];
  private readonly log: (m: string) => void;

  constructor(machines: Machine[], log: (m: string) => void) {
    this.machines = machines;
    this.log = log;
  }

  get actions(): Adapter["actions"] { return [...new Set(this.machines.flatMap((m) => [...m.adapter.actions]))]; }

  actionsFor(itemId: string): Adapter["actions"] {
    try {
      return this.route(itemId).m.adapter.actions;
    } catch {
      return [];
    }
  }

  private id(m: Machine, id: string): string {
    return m.local ? id : `${m.name}${SEP}${id}`;
  }

  /** Which machine an id belongs to, and its id there. */
  private route(id: string): { m: Machine; id: string } {
    const at = id.indexOf(SEP);
    const remote = at > 0 ? this.machines.find((m) => !m.local && m.name === id.slice(0, at)) : undefined;
    if (remote) return { m: remote, id: id.slice(at + 1) };
    const local = this.machines.find((m) => m.local);
    if (!local) throw new Error(`No machine has ${id}`);
    return { m: local, id };
  }

  connected(itemId?: string): boolean {
    if (itemId !== undefined) {
      const r = this.route(itemId);
      return r.m.adapter.connected(r.id);
    }
    return this.machines.find((m) => m.local)?.adapter.connected() ?? false;
  }

  isLocal(itemId: string): boolean {
    return this.route(itemId).m.local === true;
  }

  connectionStatus(): { name: string; connected: boolean }[] {
    return this.machines.map((m) => ({ name: m.name, connected: m.adapter.connected() }));
  }

  async list(): Promise<WorkItem[]> {
    const lists = await Promise.all(
      this.machines.map(async (m) => {
        if (m.local) return m.adapter.list();
        if (m.adapter.isLoaded === false) return [];
        const items = await m.adapter.list().catch((e) => {
          this.log(`${m.name}: list failed: ${describe(e)}`);
          return [];
        });
        return items.map((i) => ({
          ...i,
          id: this.id(m, i.id),
          parentId: i.parentId === null ? null : this.id(m, i.parentId),
          group: `${i.group}, on ${spoken(m.name)}`,
        }));
      }),
    );
    return lists.flat();
  }

  async report(id: string): Promise<Report> {
    const r = this.route(id);
    return r.m.adapter.report(r.id);
  }

  async replies(id: string): Promise<PastReply[]> {
    const r = this.route(id);
    return r.m.adapter.replies?.(r.id) ?? Promise.resolve([]);
  }

  /**
   * Every machine's places, each said with its machine ("driver, on Quartz", and this machine's by its host name), so
   * the same project on two machines has two names. A machine that hasn't answered has none.
   */
  places(): Place[] {
    return this.machines.flatMap((m) => (m.adapter.isLoaded === false ? [] : (m.adapter.places?.() ?? [])).map((p) => ({ ...p, id: this.id(m, p.id), name: `${p.name}, on ${m.said ?? spoken(m.name)}` })));
  }

  async check(action: Action): Promise<string | null> {
    const r = this.route(action.kind === "start_work" ? action.placeId : action.itemId);
    if (!r.m.adapter.actions.includes(action.kind)) return `The app isn't allowed to ${action.kind.replaceAll("_", " ")} on ${r.m.said ?? spoken(r.m.name)}.`;
    const local = action.kind === "start_work" ? { ...action, placeId: r.id } : { ...action, itemId: r.id };
    return r.m.adapter.check?.(local) ?? null;
  }

  async execute(action: Action, idempotencyKey: string): Promise<Receipt> {
    if (action.kind === "start_work") {
      const r = this.route(action.placeId);
      const receipt = await r.m.adapter.execute({ ...action, placeId: r.id }, idempotencyKey);
      return receipt.ok && receipt.itemId ? { ...receipt, itemId: this.id(r.m, receipt.itemId) } : receipt;
    }
    const r = this.route(action.itemId);
    return r.m.adapter.execute({ ...action, itemId: r.id }, idempotencyKey);
  }

  markRead(itemId: string, watermark: string, idempotencyKey: string): Promise<Receipt | "unsupported"> {
    const r = this.route(itemId);
    return r.m.adapter.markRead?.(r.id, watermark, idempotencyKey) ?? Promise.resolve("unsupported");
  }

  watch(onChange: (ids: string[], urgent: boolean) => void): () => void {
    const stops = this.machines.map((m) => m.adapter.watch((ids, urgent) => onChange(ids.map((id) => this.id(m, id)), urgent)));
    return () => stops.forEach((s) => s());
  }

  async close(): Promise<void> {
    await Promise.all(this.machines.map((m) => m.adapter.close().catch(() => {})));
  }
}
