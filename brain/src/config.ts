// Configuration from the environment. Secrets come only from the environment, never from files here.
import { parseConnectors } from "./connectors.ts";
import type { LaunchProfile } from "./adapter.ts";
import { BACKEND_MODELS, LIVE_MODELS } from "./models.ts";

const env = process.env;

/** A number from the environment; `zero` allows 0, which then means "off". */
const num = (name: string, fallback: number, zero = false) => {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !zero)) throw new Error(`${name} must be a ${zero ? "non-negative" : "positive"} number`);
  return n;
};

export type Config = ReturnType<typeof loadConfig>;

/**
 * What new work may run with: Build (a fresh worktree, full access, since Driver can't answer an approval from the
 * car) and Plan (the same, in plan mode). The first is the default.
 */
export const DEFAULT_PROFILES: LaunchProfile[] = [
  { name: "Build", workspace: "worktree", runtimeMode: "full-access", interactionMode: "default" },
  { name: "Plan", workspace: "worktree", runtimeMode: "full-access", interactionMode: "plan" },
];

/** `DRIVER_LAUNCH_PROFILES`: a JSON array of launch profiles, the first the default. Names are said aloud, so words only. */
export function parseProfiles(text: string): LaunchProfile[] {
  if (!text.trim()) return DEFAULT_PROFILES;
  const bad = (why: string) => new Error(`DRIVER_LAUNCH_PROFILES: ${why}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad("isn't JSON");
  }
  if (!Array.isArray(raw) || raw.length === 0) throw bad("must be a non-empty array");
  const seen = new Set<string>();
  return raw.map((p: any) => {
    if (typeof p?.name !== "string" || !/^[A-Za-z][A-Za-z ]{0,29}$/.test(p.name)) throw bad(`"${p?.name}" isn't a name of words`);
    if (seen.has(p.name.toLowerCase())) throw bad(`"${p.name}" is there twice`);
    seen.add(p.name.toLowerCase());
    if (!["worktree", "root"].includes(p.workspace)) throw bad(`${p.name}: workspace is worktree or root`);
    if (!["approval-required", "auto-accept-edits", "auto", "full-access"].includes(p.runtimeMode)) throw bad(`${p.name}: runtimeMode isn't one of T3's`);
    if (!["default", "plan"].includes(p.interactionMode)) throw bad(`${p.name}: interactionMode is default or plan`);
    return { name: p.name, workspace: p.workspace, runtimeMode: p.runtimeMode, interactionMode: p.interactionMode };
  });
}

/**
 * `DRIVER_DEMO`: demo mode (demo/world.ts). `on` (the default): the phone picks it per request (`x-driver-mode: demo`,
 * Settings → Demo mode); `only`: every request is a demo and the brain never reaches T3 (a brain just for showing
 * Driver, or App Review); `off`: never.
 */
export function parseDemo(text: string): "on" | "only" | "off" {
  const v = text.trim().toLowerCase();
  if (v === "" || v === "on") return "on";
  if (v === "only" || v === "off") return v;
  throw new Error(`DRIVER_DEMO is on, only or off, not "${text}"`);
}

/**
 * The machines this brain reads, from `DRIVER_CONNECTORS`. A brain with none would brief nothing and say nothing, so it
 * refuses to start unless it only ever serves demos; the retired SSH settings refuse too, so a brain upgraded without
 * its switchover can't run quietly empty.
 */
export function parseMachines(e: NodeJS.ProcessEnv, demo: "on" | "only" | "off") {
  const retired = ["T3_URL", "T3_CLI", "DRIVER_T3_REMOTES"].filter((k) => e[k] !== undefined && e[k] !== "");
  if (retired.length) throw new Error(`${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} no longer read: each machine now runs the connector and dials in. Set DRIVER_CONNECTORS instead (docs/connector.md, "Switching over").`);
  const connectors = parseConnectors(e.DRIVER_CONNECTORS ?? "[]");
  if (!connectors.length && demo !== "only") throw new Error("DRIVER_CONNECTORS lists no machines, so Driver would brief nothing. Add each machine's connector (`10and2 brain add`, or docs/connector.md, \"Switching over\"), or set DRIVER_DEMO=only for a brain that only serves demos.");
  return connectors;
}

/** `cloud`: a user's brain in a Durable Object, whose machines are paired devices (cloud/src/links.ts), not `DRIVER_CONNECTORS`. */
export function loadConfig(o: { cloud?: boolean } = {}) {
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (an OpenAI project with GPT-Live access).");
  const host = env.DRIVER_HOST ?? "127.0.0.1";
  const accessCode = env.DRIVER_ACCESS_CODE ?? "";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  // Anyone who reaches this server can spend on the OpenAI key and change threads. Behind a proxy such as Tailscale
  // Serve, every request comes from loopback, so a code that is set is enforced there too.
  if (accessCode && accessCode.length < 12) throw new Error("DRIVER_ACCESS_CODE must be 12+ characters.");
  if (!loopback && !accessCode) throw new Error("DRIVER_ACCESS_CODE (12+ characters) is required when DRIVER_HOST is not loopback.");
  return {
    apiKey,
    host,
    port: num("DRIVER_PORT", 8790),
    accessCode,
    db: env.DRIVER_DB ?? "data/driver.db",
    connectors: o.cloud ? [] : parseMachines(env, parseDemo(env.DRIVER_DEMO ?? "")),
    /** What threads started by voice run with; voice picks one by name and nothing more. */
    launchProfiles: parseProfiles(env.DRIVER_LAUNCH_PROFILES ?? ""),
    liveModel: env.DRIVER_LIVE_MODEL ?? LIVE_MODELS[0],
    backendModel: env.DRIVER_BACKEND_MODEL ?? BACKEND_MODELS[0],
    classifyModel: env.DRIVER_CLASSIFY_MODEL ?? "gpt-6.1-sol",
    openerModel: env.DRIVER_OPENER_MODEL ?? "gpt-6-luna",
    voice: env.DRIVER_VOICE ?? "marin",
    /** Reading replies aloud: the text-to-speech model, and how long and how much of its audio is kept. */
    ttsModel: env.DRIVER_TTS_MODEL ?? "gpt-4o-mini-tts",
    /** Rewrites replies for listening, when the phone asks for that. */
    rewriteModel: env.DRIVER_REWRITE_MODEL ?? "gpt-6-luna",
    /** A reply longer than this is rewritten in parts of about this size, at once; 0 rewrites it in one call. */
    rewriteChunkChars: num("DRIVER_REWRITE_CHUNK_CHARS", 1200, true),
    speechDays: num("DRIVER_SPEECH_DAYS", 7),
    speechMaxMb: num("DRIVER_SPEECH_MAX_MB", 300),
    /** A reading of a thread the user hasn't been in for this long starts with what they asked, when the phone wants that. */
    leadInColdHours: num("DRIVER_LEAD_IN_COLD_HOURS", 3),
    idleMs: num("DRIVER_IDLE_SECONDS", 90) * 1000,
    maxSessionMs: num("DRIVER_MAX_SESSION_MINUTES", 15) * 60_000,
    /** Each session's sideband stream, kept next to the database for replaying (see voice/recording.ts). */
    recordSessions: !/^(?:0|false|off|no)$/i.test(env.DRIVER_RECORD_SESSIONS ?? ""),
    recordingDays: num("DRIVER_RECORDING_DAYS", 14),
    /** All recordings together; past this the oldest are deleted. */
    recordingsMaxMb: num("DRIVER_RECORDINGS_MAX_MB", 500),
    demo: parseDemo(env.DRIVER_DEMO ?? ""),
    /** Usage analytics to PostHog (docs/launch/contracts.md §5): off without a key. */
    posthogKey: env.POSTHOG_KEY ?? "",
    posthogHost: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    /** Which environment events are counted under: `prd` on Lattice, `dev` for a brain run by hand. */
    env: env.DRIVER_ENV ?? "dev",
  };
}
