// Wires the brain together: store, machine connectors, briefing, proposals, voice server,
// and demo mode beside them (or instead of them, with DRIVER_DEMO=only).
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { RemoteAdapter } from "./connectors.ts";
import { Machines } from "./machines.ts";
import { makeLlm } from "./llm.ts";
import { syncVisits } from "./reads.ts";
import { modelRewriter } from "./reading.ts";
import { openAiSpeech, Speech } from "./voice/speech.ts";
import { modelClassifier, modelOpener } from "./briefing.ts";
import { modelBriefingWriter } from "./briefing-reading.ts";
import { startServer, type DemoWorlds, type ServerDeps } from "./server.ts";
import { wire } from "./world.ts";
import { demoWorld, demoWriter } from "./demo/world.ts";
import { hangup } from "./voice/live.ts";
import { nodeSocket } from "./voice/socket-node.ts";
import { dirFiles } from "./files.ts";
import { Hangups } from "./voice/hangups.ts";
import { Waits } from "./waits.ts";
import { Recordings } from "./voice/recording.ts";
import { Flags } from "./flags.ts";
import { brainRev, describe, spokenHost } from "./util.ts";
import { Analytics, tagged } from "./analytics.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
// Which brain is running, for the phone, recordings, flags and the log.
const rev = brainRev();
log(`driver brain ${rev}`);
// A stray rejection must never take the brain down mid-drive: log it and carry on.
const cfg = loadConfig();
// Usage analytics (docs/launch/contracts.md §5): nothing is sent without POSTHOG_KEY, or before the phone says who it is.
const analytics = new Analytics({ key: cfg.posthogKey, host: cfg.posthogHost, env: cfg.env, runtime: "lattice", brainRev: rev, mode: "lattice", log });
log(`analytics: ${analytics.enabled ? `to ${cfg.posthogHost} (${cfg.env})` : "off (no POSTHOG_KEY)"}`);
process.on("unhandledRejection", (e) => {
  log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`);
  analytics.exception("unhandled", e);
});
const store = new Store(cfg.db);
store.recoverExecutingProposals();

// Sessions bill at OpenAI until it ends them. Any a previous run didn't see confirmed over (a crash, a failed
// hang-up) is hung up now, and retried until OpenAI confirms.
const hangups = new Hangups({ store, hangup: (id) => hangup(cfg.apiKey, id), log, track: analytics.track });
hangups.resume();
const llm = makeLlm(cfg.apiKey);
const state = dirname(cfg.db);
// The brain's files (recordings, read-aloud audio, flags, the phone's logs), next to the database.
const files = dirFiles(state);
// Each session's event stream, next to the database, for reading back and replaying (test/replay.ts). Old recordings
// expire even with recording turned off.
const recordings = new Recordings(files, { days: cfg.recordingDays, maxMb: cfg.recordingsMaxMb, log });
// Replies read aloud: their audio next to the database, and their prepared text for a month.
const speech = new Speech(files, { synthesize: openAiSpeech(cfg.apiKey, cfg.ttsModel), model: cfg.ttsModel, days: cfg.speechDays, maxMb: cfg.speechMaxMb, log });
// Old recordings and audio go now and every hour, whatever else the brain is doing.
const prune = () => void Promise.all([recordings.prune(), speech.prune()]);
prune();
setInterval(prune, 3600_000).unref();
/** What the real brain and every demo world have in common. */
const common = {
  log, speech, files, openSocket: nodeSocket, brainRev: rev, profiles: cfg.launchProfiles, recordings: cfg.recordSessions ? recordings : undefined, analytics,
  // The one consent (contracts §5), taken by the server from each request as it arrives; in memory on Lattice.
  consent: analytics.consent,
  rewrite: modelRewriter(llm, cfg.rewriteModel), rewriteChunkChars: cfg.rewriteChunkChars, leadInColdHours: cfg.leadInColdHours,
  writeBriefing: modelBriefingWriter(llm, cfg.openerModel),
};
// A moment flagged in a call ("debug this"), for agents to review: next to the database, pointing at the recordings.
const flagsIn = (dir: string, s: Store) => new Flags(files, { store: s, log, dir });

// Demo mode: a fresh in-memory world per demo. Its sessions' billing record outlives demos and restarts, in its own
// database, so a demo session is hung up like any other; its flags are kept apart from the real ones.
let demo: DemoWorlds | undefined;
if (cfg.demo !== "off") {
  // Its analytics are the same person's, counted as mode "demo".
  const demoAnalytics = tagged(analytics, { mode: "demo" });
  const demoHangups = new Hangups({ store: new Store(join(state, "demo-sessions.db")), hangup: (id) => hangup(cfg.apiKey, id), log: (m) => log(`demo: ${m}`), track: demoAnalytics.track });
  demoHangups.resume();
  const write = demoWriter(llm, cfg.rewriteModel);
  demo = () => demoWorld({ ...common, analytics: demoAnalytics, hangups: demoHangups, write, flags: (s) => flagsIn("demo-flags", s) });
}

let deps: ServerDeps;
let closeWork = async () => {};
if (cfg.demo === "only") {
  log("demo: every request is a demo (DRIVER_DEMO=only); not reaching T3");
  const world = await demo!();
  deps = world;
  closeWork = () => world.close();
} else {
  const connectors = cfg.connectors.map((c) => ({ ...c, adapter: new RemoteAdapter(c.name) }));
  const adapter = new Machines(connectors.map((c) => ({ ...c, said: c.local ? spokenHost() : undefined })), log);
  const { briefing, conversations, proposals, waits } = wire({
    adapter, store, classify: modelClassifier(llm, cfg.classifyModel), writeOpener: modelOpener(llm, cfg.openerModel), profiles: cfg.launchProfiles, log,
    track: analytics.track,
  });
  adapter.watch((ids, urgent) => briefing.onChange(ids, urgent));
  void briefing.refresh().catch((e) => {
    log(`briefing: first refresh failed: ${describe(e)}`);
    analytics.exception("briefing", e);
  });
  // Expired snoozes and threads going stale produce no T3 event, so look again every hour. Replies read in full that a
  // machine hasn't been told about yet (it was asleep) are sent again then too.
  setInterval(() => {
    briefing.refresh().catch((e) => {
      log(`briefing: hourly refresh failed: ${describe(e)}`);
      analytics.exception("briefing", e);
    });
    void syncVisits({ adapter, briefing, store, log });
  }, 3600_000).unref();
  store.forgetReadings(Date.now() - 30 * 86_400_000);
  deps = { ...common, connectors, adapter, briefing, proposals, store, conversations, waits, hangups, flags: flagsIn("flags", store), refresh: () => briefing.refresh() };
  closeWork = () => adapter.close();
}
const server = startServer(cfg, deps, demo);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  await server.close().catch(() => {});
  // A session's recording is written after it; wait for its last lines (2 s at most).
  await recordings.close();
  await analytics.flush();
  await closeWork();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
