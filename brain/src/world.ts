// One work system's brain: its briefing, conversations, proposals and waits, over one adapter and one store. The real
// brain has one (main.ts); demo mode makes a fresh one for each demo (demo/world.ts).
import type { Adapter, LaunchProfile } from "./adapter.ts";
import type { Track } from "./analytics.ts";
import { Briefing, type Classifier, type OpenerWriter } from "./briefing.ts";
import { Proposals } from "./proposals.ts";
import { Purposes, type Purposer } from "./purposes.ts";
import type { Store } from "./store.ts";
import type { Engine } from "./engine.ts";
import type { Limits } from "./levels.ts";
import type { Titler } from "./titles.ts";
import { namedItems } from "./voice/tools.ts";
import { Conversations } from "./voice/session.ts";
import { Waits } from "./waits.ts";
import { Later } from "./later.ts";

/**
 * `onDemand`: changed threads are summarized only while someone looks (briefing.ts); the demo summarizes at once.
 * `title`: titles new threads as they start; without it (demo worlds, tests) the work system names them. `purpose`:
 * writes threads' purposes while someone looks (purposes.ts); without it (demo worlds, which keep their own, and
 * tests) none are written. `purposeCanRun`: whether it can run now (the cloud's: the account can pay, within today's
 * background safety limit); without it, always. `limits`: the account's level's (the cloud's, as its engine reads them),
 * which a send reads just before it goes; without them (Lattice, demo worlds), Long Haul's.
 */
export function wire(o: { adapter: Adapter; store: Store; classify: Classifier; writeOpener: OpenerWriter; title?: Titler; purpose?: Purposer; purposeCanRun?: () => boolean; profiles: LaunchProfile[]; log: (m: string) => void; track?: Track; onDemand?: boolean; limits?: () => Limits }) {
  const { adapter, store, log } = o;
  // A purpose written later has its thread's card judged again against it (briefing.ts `purposed`).
  const purposes = o.purpose
    ? new Purposes({ adapter, store, make: o.purpose, canRun: o.purposeCanRun, log, report: (id) => briefing.report(id), written: (ids) => void briefing.purposed(ids) })
    : undefined;
  const briefing = new Briefing({ adapter, store, classify: o.classify, writeOpener: o.writeOpener, log, onDemand: o.onDemand, purposes });
  const conversations = new Conversations(store);
  // Sends and starts set up for later (stage 4b), where the adapter spans computers that can hold them (the cloud's
  // links, Lattice's machines); a demo world has none.
  // Waits saved before a restart are watched again, so a holding phone still gets its call-back.
  const waits = new Waits({ adapter, log, store, track: o.track });
  // A chain's tail ("and call me when that's done", 4-J) is a call-back, started when its last step goes.
  const later = adapter.laterLinks ? new Later({ store, adapter, log, limits: o.limits, waits, track: o.track, started: (id, started) => briefing.added(id, started) }) : undefined;
  const proposals = new Proposals({
    store,
    adapter,
    named: () => namedItems(briefing),
    settled: () => namedItems(briefing, true),
    clutter: () => briefing.view().clutter,
    places: () => adapter.places?.() ?? [],
    profiles: o.profiles,
    started: (id, started) => briefing.added(id, started),
    title: o.title,
    spoken: (id) => conversations.spoken(id),
    lastUserTurn: (id) => conversations.lastUserTurn(id),
    log,
    track: o.track,
    limits: o.limits,
    later,
  });
  return { briefing, conversations, proposals, waits, later };
}

/**
 * A machine's report wakes what watches the threads, in each host alike (docs/launch/engine.md §7): the briefing, the
 * call-back waits and the engine (none in a demo world). Nothing polls; between reports, the engine's own due times
 * keep its time (Lattice's timer, the cloud's alarm), and a holding phone's asks look at the waits.
 */
export function wake(adapter: Pick<Adapter, "watch">, briefing: Pick<Briefing, "onChange">, waits: Pick<Waits, "changed">, engine?: Pick<Engine, "changed">): () => void {
  return adapter.watch((ids, urgent) => {
    briefing.onChange(ids, urgent);
    waits.changed();
    engine?.changed();
  });
}
