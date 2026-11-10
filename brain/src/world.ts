// One work system's brain: its briefing, conversations, proposals and waits, over one adapter and one store. The real
// brain has one (main.ts); demo mode makes a fresh one for each demo (demo/world.ts).
import type { Adapter, LaunchProfile } from "./adapter.ts";
import type { Track } from "./analytics.ts";
import { Briefing, type Classifier, type OpenerWriter } from "./briefing.ts";
import { Proposals } from "./proposals.ts";
import type { Store } from "./store.ts";
import { namedItems } from "./voice/tools.ts";
import { Conversations } from "./voice/session.ts";
import { Waits } from "./waits.ts";

export function wire(o: { adapter: Adapter; store: Store; classify: Classifier; writeOpener: OpenerWriter; profiles: LaunchProfile[]; log: (m: string) => void; track?: Track }) {
  const { adapter, store, log } = o;
  const briefing = new Briefing({ adapter, store, classify: o.classify, writeOpener: o.writeOpener, log });
  const conversations = new Conversations(store);
  const proposals = new Proposals({
    store,
    adapter,
    named: () => namedItems(briefing),
    settled: () => namedItems(briefing, true),
    clutter: () => briefing.view().clutter,
    places: () => adapter.places?.() ?? [],
    profiles: o.profiles,
    started: (id, started) => briefing.added(id, started),
    spoken: (id) => conversations.spoken(id),
    lastUserTurn: (id) => conversations.lastUserTurn(id),
    log,
    track: o.track,
  });
  // Waits saved before a restart are watched again, so a holding phone still gets its call-back.
  const waits = new Waits({ adapter, log, store, track: o.track });
  return { briefing, conversations, proposals, waits };
}
