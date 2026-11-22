// What one link's brain has been given of `tenandtwo://work`, so the connector can say when to read again and answer a
// read with only what changed. Pure bookkeeping: no I/O, no timers.
import { createHash, randomBytes } from "node:crypto";
import type { ActionKind, LaunchProfile, CodingModel, Place, WirePlace, WorkItem } from "./contract.ts";
import type { Rules } from "./policy.ts";
import type { Held } from "./schedules.ts";

export type Refusals = Record<string, Partial<Record<ActionKind, string>>>;
export type Connection = { prefix: string; name: string; connected: boolean };
/**
 * `ceiling`: the most a launch may run with here, so a proposal asking for more is refused before it's read back.
 * `rules`: what sends and starts set up for later may do here; `schedules`: what this computer holds for later, always
 * whole (docs/launch/engine.md §5; stage 4a). An older brain ignores both.
 */
export type View = { items: WorkItem[]; places: Place[]; connections: Connection[]; refusals: Refusals; ceiling: LaunchProfile["runtimeMode"]; rules?: Rules; schedules?: Held[] };
/** As `tenandtwo://work` carries it: each place's models named by `catalog`, a key into `catalogs` (`pack`). */
export type Read = Omit<View, "places"> & { places: WirePlace[]; catalogs: Record<string, CodingModel[]>; rev: string; full: boolean; removed: string[] };

/**
 * Places as the link sends them: most share one list of models (every Claude Code folder, most of a T3's projects), so
 * each list goes once, in `catalogs`, under a key made from it, which changes only when the list does (its order and
 * each model's provider included). A place that offers none has no key (docs/launch/thread-model.md).
 */
export function pack(places: Place[]): { places: WirePlace[]; catalogs: Record<string, CodingModel[]> } {
  const catalogs: Record<string, CodingModel[]> = {};
  const wire = places.map(({ models, ...p }): WirePlace => {
    if (!models?.length) return p;
    const catalog = createHash("sha256").update(JSON.stringify(models)).digest("hex").slice(0, 12);
    catalogs[catalog] ??= models;
    return { ...p, catalog };
  });
  return { places: wire, catalogs };
}

/**
 * The fields the brain's briefing diffs on, what a question waits on, and when you last wrote in it yourself (the
 * engine's stage 3.9: news you've seen is dropped, and Away ends); an updatedAt-only change means nothing to it.
 */
const briefed = (i: WorkItem) => JSON.stringify([i.status, i.title, i.settled, i.snoozedUntil, i.pendingQuestion, i.questionId ?? null, i.questionKind ?? null, i.lastRunAt ?? null, i.group, i.parentId, i.visitedAt ?? null, i.typed ?? null]);
/** Places with their models: a change in any list is a change. */
const rest = (v: View) => JSON.stringify([v.places, v.connections, v.refusals, v.ceiling, v.rules ?? null, v.schedules ?? null]);

export class Sent {
  /** A fresh prefix per connector run, so a rev from an earlier run is never mistaken for this one's. */
  private readonly prefix = randomBytes(4).toString("hex");
  private n = 0;
  rev: string | null = null;
  private items = new Map<string, WorkItem>();
  private others = "";
  /** Ids the work systems said changed (a new reply can leave every listed field alone). */
  private touched = new Set<string>();

  touch(ids: string[]) { for (const id of ids) this.touched.add(id); }

  /** Whether the brain should read again, and whether it's urgent (a new question waiting on the user). */
  changed(v: View): { any: boolean; urgent: boolean } {
    if (this.rev === null) return { any: true, urgent: false };
    const now = new Map(v.items.map((i) => [i.id, i]));
    let any = this.touched.size > 0 || rest(v) !== this.others || [...this.items.keys()].some((id) => !now.has(id));
    let urgent = false;
    for (const i of v.items) {
      const before = this.items.get(i.id);
      if (!before || briefed(before) !== briefed(i)) any = true;
      if (i.pendingQuestion && (!before?.pendingQuestion || (before.questionId ?? null) !== (i.questionId ?? null))) urgent = true;
    }
    return { any, urgent };
  }

  /** Answers a read: a delta when `since` is the last rev this link was given, else the whole view. */
  read(v: View, since: string | null): Read {
    const delta = since !== null && since === this.rev;
    const now = new Map(v.items.map((i) => [i.id, i]));
    const items = delta ? v.items.filter((i) => this.touched.has(i.id) || JSON.stringify(this.items.get(i.id)) !== JSON.stringify(i)) : v.items;
    const removed = delta ? [...this.items.keys()].filter((id) => !now.has(id)) : [];
    this.items = now;
    this.others = rest(v);
    this.touched.clear();
    this.rev = `${this.prefix}-${++this.n}`;
    return { rev: this.rev, full: !delta, items, removed, ...pack(v.places), connections: v.connections, refusals: v.refusals, ceiling: v.ceiling,
      ...(v.rules ? { rules: v.rules } : {}), ...(v.schedules ? { schedules: v.schedules } : {}) };
  }
}
