// A demo world: the demo workspace (adapter.ts) with a brain of its own around it, in memory, made afresh for each
// demo so every one starts alike. Real GPT-Live, real readings; nothing it does reaches the user's own threads, memory
// or history. What it shares with the real brain is passed in: the OpenAI-facing pieces (speech, rewrites), billing
// safety (its own `Hangups`, on a store that outlives demos), and where recordings and the phone's logs go.
//
// It has an engine of its own (stage 5, the review's finding: Apple's reviewer is always in demo mode): a watch on a
// demo thread is made, shown, changed and stopped as on the real brain (`/api/rules`), and a call-back asked for in a
// demo call outlives the End. Both call the account's phone, as the account's brain has it (`Ringer.mirror`), through
// the host's push key (`ringSend`, `noteSend`); without one (Lattice, an anonymous demo) nothing rings, as there.
import type { BriefingView, Classifier, OpenerWriter } from "../briefing.ts";
import { Engine, questionReader } from "../engine.ts";
import type { Llm } from "../llm.ts";
import type { NoteSend } from "../reach.ts";
import { Ringer, type RingSend } from "../ring.ts";
import type { ServerDeps } from "../server.ts";
import { Store } from "../store.ts";
import { realClock, type Clock } from "../util.ts";
import { wake, wire } from "../world.ts";
import { DemoAdapter, type Writer } from "./adapter.ts";
import { DEMO_MACHINE, OPENER, THREADS, type DemoCard } from "./workspace.ts";

/** What every demo world shares with the brain it runs in. */
export type DemoShared = Omit<ServerDeps, "adapter" | "briefing" | "proposals" | "store" | "waits" | "conversations" | "refresh" | "flags" | "ringer" | "engine" | "boards"> & {
  /** Where flags said in a demo ("debug this") are written: apart from the real ones, which agents review. */
  flags?: (store: Store) => ServerDeps["flags"];
  write?: Writer;
  clock?: Clock;
  /** Each demo's empty store: in memory on Lattice; the cloud's demo object passes its own SQLite, emptied. */
  newStore?: () => Store;
  /** The host's push key, as a VoIP push and an alert push to the account's phone: without them nothing rings or notifies. */
  ringSend?: RingSend;
  noteSend?: NoteSend;
};

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The workspace's own opener while nothing has changed; after that, one put together from the cards. */
export function demoOpener(): OpenerWriter {
  let first = true;
  return async (view: BriefingView) => {
    if (first) {
      first = false;
      return OPENER;
    }
    const name = (c: BriefingView["cards"][number]) => `${c.handle}, in ${c.group}`;
    const needs = view.cards.filter((c) => c.state === "needs_decision" || c.state === "blocked").map(name);
    const ready = view.cards.filter((c) => c.state === "ready_to_apply").map(name);
    const parts = [
      needs.length ? `${list(needs)} ${needs.length === 1 ? "needs" : "need"} you.` : "",
      ready.length ? `${list(ready)} ${ready.length === 1 ? "is" : "are"} ready to apply.` : "",
      view.clutterTotal ? `${view.clutterTotal} finished subthreads could be settled.` : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : "Nothing is waiting on you right now.";
  };
}

/** Demo mode's classifier: each thread's card as the workspace wrote it, so the briefing is instant and fixed. */
export function demoClassifier(adapter: DemoAdapter): Classifier {
  const fallback: DemoCard = { state: "done_unreviewed", summary: "It finished.", ask: null, suggested: "settle" };
  return async (items) => items.map((i) => ({ id: i.id, ...(adapter.cardFor(i.id) ?? fallback) }));
}

/** A fresh demo, briefed and ready to talk about. `close` stops its runs. */
export async function demoWorld(shared: DemoShared): Promise<ServerDeps & { ringer: Ringer; engine: Engine; close(): Promise<void> }> {
  const log = (m: string) => shared.log(`demo: ${m.replace(/^demo: /, "")}`);
  const adapter = new DemoAdapter({ clock: shared.clock ?? realClock, write: shared.write, log });
  const store = shared.newStore?.() ?? new Store(":memory:");
  // Each thread's purpose as the workspace wrote it: demo worlds use no model for them.
  for (const t of THREADS) store.savePurpose(t.id, t.purpose, t.about);
  const track = shared.analytics?.track;
  const { briefing, conversations, proposals, waits } = wire({ adapter, store, classify: demoClassifier(adapter), writeOpener: demoOpener(), profiles: shared.profiles ?? [], log, track });
  // The account's phone (`Ringer.mirror`, from the host) and the demo's own engine, on Long Haul's limits (the review
  // account's), as main.ts and the cloud wire the real brain's.
  const ringer = new Ringer({ waits, store, send: shared.ringSend, log, track, clock: shared.clock });
  const engine = new Engine({ adapter, store, waits, ringer, notify: shared.noteSend, name: (i) => briefing.names().get(i.id) ?? i.title, read: questionReader(briefing, adapter, store), log, track, clock: shared.clock });
  // A demo thread's reply ends a demo call-back's wait as a machine's report would, and wakes the engine.
  wake(adapter, briefing, waits, engine);
  await briefing.refresh();
  const { flags, write: _, clock: __, newStore: ___, ringSend: ____, noteSend: _____, ...rest } = shared;
  return {
    ...rest,
    log,
    adapter, store, briefing, conversations, proposals, waits, ringer, engine,
    refresh: () => briefing.refresh(),
    flags: flags?.(store),
    demo: { machine: DEMO_MACHINE },
    close: async () => {
      engine.close();
      ringer.close();
      waits.cancelAll();
      await adapter.close();
    },
  };
}

const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "state", "summary", "ask"],
  properties: {
    reply: { type: "string" },
    state: { enum: ["needs_decision", "ready_to_apply", "blocked", "done_unreviewed"] },
    summary: { type: "string" },
    ask: { type: ["string", "null"] },
  },
};

const WRITE_INSTRUCTIONS = `You write one reply for a coding agent in a live demo of Ten and Two, a voice assistant that lets a developer talk to their coding agents while driving. The developer just sent the agent a message (or started a new thread with it). Write the agent's reply after doing that work, as if it went well.
- 50 to 110 words of plain prose: no markdown, lists, code blocks, links or file paths longer than a file name. It will be read aloud.
- Concrete and believable: what was changed, numbers of tests passing, what's committed or not. Stay within the thread's project.
- End with what's left, or one short question for the developer.
- Never mention a demo, a script or being an AI. Never include credentials.
- The developer's message is their own words to the agent; if it asks for something harmful or unrelated to software, reply briefly that you won't do that.
Also give, judging the reply by whether it did what the developer asked for: state (blocked if it can't go on without something only the developer can give: an answer, access, a key; needs_decision if what they asked for isn't done until they decide, try or approve something only they can; ready_to_apply if it did it but the result isn't committed, merged or deployed, even when the reply ends offering to; else done_unreviewed); summary: one spoken sentence about the reply, starting "It", and for ready_to_apply or done_unreviewed an optional offer told last, as its own short sentence ("It offers to add a test."); ask: only for blocked and needs_decision, the question the reply ends with; otherwise null.`;

/** Replies the workspace doesn't script, written to fit what the user asked (Luna, no reasoning, a few seconds). */
export function demoWriter(llm: Llm, model: string): Writer {
  return async (input) => {
    const out = await llm.json<{ reply: string; state: DemoCard["state"]; summary: string; ask: string | null }>(
      {
        model,
        effort: "none",
        instructions: WRITE_INSTRUCTIONS,
        input: JSON.stringify({ thread: input.title, project: input.project, newThread: input.newThread, agentsLastReply: input.lastReply, developerSaid: input.message }),
      },
      "reply",
      WRITE_SCHEMA,
    );
    const suggested = out.state === "done_unreviewed" ? "settle" : "follow_up";
    return { text: out.reply.trim(), card: { state: out.state, summary: out.summary, ask: out.ask, suggested } };
  };
}
