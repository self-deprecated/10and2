// T3 Code as a work system: threads are items, projects are groups and the places new work starts. Reads come from
// the live shell stream, and from T3's config (its settings and providers: the models a new thread can start on, and
// the one it starts on unless told); writes are exactly four thread commands, answering a thread's question (a
// follow-up to a thread that asked one), launching a thread, and marking a thread read, and nothing else (the
// connector's allowlist: `orchestration:operate` would also allow provider logins, installs, project changes and more).
import type { Action, Adapter, Checks, FirstAsk, ItemStatus, LaunchProfile, CodingModel, PastReply, Place, Receipt, ReplyRef, Report, WorkItem } from "../contract.ts";
import { checksIn, gateFailed, noneRan, partOnly, stepsOf, Tested, verdictOf, type OwnChecks, type Ran, type Step } from "../checks.ts";
import { issueSession, revokeSession, CONNECTOR_SCOPES, type Cli, type T3Session } from "./auth.ts";
import { ConnectionError, ORCHESTRATION_PROTOCOL, RpcClient, RpcError } from "./rpc.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ANSWERED, choicesOf, describe, modelKey } from "../util.ts";
import type { ThreadDocContext } from "../documents.ts";
import { firstAsk, worktreeStart } from "../work.ts";
import { digestOf, newest, type Write } from "../typed.ts";
import { allows, answers, steers, withinCeiling, type Policy } from "../policy.ts";
import type { Socket } from "node:net";
import { GATE_NOT_ALLOWED, GATE_NOT_SHOWN, GATE_ONE_AT_A_TIME, gateOf, gateRefusal, gateReport, Gates, type HeldSummary, NOT_ANSWERING, stopGate } from "../gate.ts";

const M = {
  subscribeShell: "orchestration.subscribeShell",
  getThreadProjection: "orchestration.getThreadProjection",
  getTurnItem: "orchestration.getTurnItem",
  dispatchCommand: "orchestration.dispatchCommand",
  launchThread: "orchestration.launchThread",
  /** T3's config, with its settings and providers; `orchestration:read` is enough, from T3 0.1.0 on. */
  getConfig: "server.getConfig",
} as const;

/** How long a launch waits for its thread to reach the shell stream, so it can be named straight away. */
const LAUNCH_SEEN_MS = 5000;
/** How long a launch waits for T3's settings before starting on the project's own model instead. */
const SETTINGS_MS = 10_000;
const NO_ANSWERS = "T3 Code is asking a question, and this computer doesn't let 10 & 2 answer them. Answer it in T3 Code.";
const NO_STEERING = "It's still running in T3 Code, and this computer doesn't let 10 & 2 send to a running thread. Try again once it's done.";
/** How often T3's config is read for the models each project offers, besides at connect and at each launch. */
const CONFIG_MS = 10 * 60_000;

/** A background task T3 Code tracks on a thread (delegated subagent, awaited command, etc.). */
export type PendingBackgroundTask = {
  taskId?: string;
  kind?: string;
  description?: string | null;
  /** Raw shell command on `kind: "command"` tasks; never echoed into progress text. */
  command?: string | null;
  childThreadId?: string | null;
  awaited?: boolean;
};

/** The fields of a T3 shell thread the brain reads. */
export type ShellThread = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledAt?: string | null;
  settledOverride?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  latestRunCompletedAt?: string | null;
  /** Set while a run is working, whatever the latest run (`status`) did. */
  activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
  pendingRuntimeRequest?: { id: string; kind: string } | null;
  /** Background work T3 is waiting on (delegated subagents, awaited commands); keeps the thread in Working. */
  pendingBackgroundTasks?: PendingBackgroundTask[];
  /** Blocked waiting on another thread (`t3_thread_wait`). */
  blockedOnThreadWait?: boolean;
  /** Present (even null) only on servers that track visits (`threadVisitedTracking`). */
  lastVisitedAt?: string | null;
  /**
   * T3's last message `createdBy: "user"`: T3's own sends are written so too (`personWrote`), so what a person typed is
   * read from the thread when this moves.
   */
  latestUserAuthoredMessageAt?: string | null;
  lineage?: { parentThreadId: string | null; relationshipToParent: string | null } | null;
  /** The model the thread runs on, as T3 gives it; passed back unchanged when launching in its project. */
  modelSelection?: unknown;
  /** The newest run (a queued one, if any), the one at work, and when the newest one ended (null until it does). */
  latestRunId?: string | null;
  activeRunId?: string | null;
  createdAt?: string;
  /** How many rows the whole thread shows: what tells whether a read of it was a recent window or all of it. */
  visibleItemCount?: number;
  /** The thread's git worktree checkout path, if it runs in a worktree outside the project's root. */
  worktreePath?: string | null;
};
/** The root is used only for the local policy: no path leaves the machine through Driver. */
type Project = { id: string; title: string; defaultModelSelection?: unknown; workspaceRoot?: string; repositoryIdentity?: { name?: string } | null };

/**
 * The parts of T3's settings (`server.getConfig`'s `settings`) that decide the model a new thread starts on. A model
 * is passed back to T3 as T3 gave it; only its provider instance (`instanceId`) is read here.
 */
export type T3Settings = {
  /** The machine's default model for new threads. */
  defaultModelSelection?: unknown;
  /** Once true, a project's own `defaultModelSelection` (from before per-project settings) no longer counts. */
  projectSettingsFolded?: boolean;
  providerInstances?: Record<string, { driver?: string; enabled?: boolean | null; config?: unknown } | undefined>;
  projectSettingsOverrides?: Record<string, { defaultModelSelection?: unknown; providerInstances?: Record<string, { enabled?: boolean | null } | undefined> } | undefined>;
  /** Models hidden from T3's pickers, and the order the user put them in, by provider instance. */
  providerModelPreferences?: Record<string, { hiddenModels?: unknown; modelOrder?: unknown } | undefined> | null;
};

/**
 * A provider instance as `server.getConfig`'s `providers` gives it (contracts' `ServerProvider`): the parts that decide
 * which of its models T3's picker offers a new thread.
 */
export type T3Provider = {
  instanceId: string;
  driver?: string;
  /** The name the user gave the instance in T3's settings, if any (`providerLabel`). */
  displayName?: string;
  status?: string;
  availability?: string;
  installed?: boolean;
  auth?: { status?: string } | null;
  /** From T3 0.1.11: an earlier check's models still offered after a later one failed. */
  modelsRetained?: boolean;
  subProviders?: { name: string; unavailableReason?: string }[];
  models?: { slug: string; name: string; isCustom?: boolean; isLegacy?: boolean; subProvider?: string }[];
  /** Ones that need a newer CLI, kept out of `models` by T3; never offered. */
  updateRequiredModels?: { slug: string }[];
  /** The runtime modes it runs with; T3 runs a thread on it as asking first when its mode isn't one of them. */
  supportedRuntimeModes?: string[];
};
/** The last good read of T3's config. */
export type T3Config = { settings: T3Settings; providers: T3Provider[] };
/** A model a new thread in a project can start on: as the brain gets it, and as T3 takes it. */
export type Offer = { model: CodingModel; instanceId: string; slug: string };

/** Drivers whose instances T3 leaves off until they're switched on (contracts' `DEFAULT_DISABLED_PROVIDER_DRIVERS`). */
const OFF_UNTIL_SWITCHED_ON = new Set(["cursor", "grok", "fx", "kiro", "muse", "pi", "opencode", "antigravity"]);

const instanceOf = (model: unknown): string | null => {
  const id = model && typeof model === "object" ? (model as { instanceId?: unknown }).instanceId : undefined;
  return typeof id === "string" ? id : null;
};

/**
 * Whether T3 lets new threads in a project run on a provider instance, by T3's own rule (contracts'
 * `resolveProjectProviderInstanceEnabled`): the project's switch for it, else the instance's own, else on only for the
 * built-in `codex` and `claudeAgent`. T3 refuses a launch on one that's off ("Provider instance … is disabled for
 * project …"): on 20 November a voice start in Lattice's "No project" was refused three times, on the `codex` instance
 * its latest thread used, which T3's settings had switched off.
 */
export function instanceOn(settings: T3Settings, projectId: string, instanceId: string): boolean {
  const own = settings.projectSettingsOverrides?.[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (typeof own === "boolean") return own;
  const instances = settings.providerInstances ?? {};
  const instance = Object.hasOwn(instances, instanceId) ? instances[instanceId] : undefined;
  if (!instance) return instanceId === "codex" || instanceId === "claudeAgent";
  const config = instance.config && typeof instance.config === "object" && !Array.isArray(instance.config) ? (instance.config as { enabled?: unknown }).enabled : undefined;
  const configOn = typeof config === "boolean" ? config : undefined;
  if (instance.enabled === false || configOn === false) return false;
  return instance.enabled ?? configOn ?? !OFF_UNTIL_SWITCHED_ON.has(String(instance.driver));
}

/**
 * A model T3 hides from its pickers (and isn't one of the instance's custom models): T3 passes over a project default
 * on one, rather than "silently pick a model nobody chose" (shared's `resolveProjectSettings`, from T3 0.1.10 on).
 */
function hidden(settings: T3Settings, model: unknown): boolean {
  const instance = instanceOf(model);
  const slug = slugOf(model);
  if (instance === null || slug === null) return false;
  const hiddenModels = settings.providerModelPreferences?.[instance]?.hiddenModels;
  if (!Array.isArray(hiddenModels) || !hiddenModels.includes(slug)) return false;
  return !customModels(settings, instance).some((c) => c.slug === slug);
}

const slugOf = (model: unknown): string | null => {
  const slug = model && typeof model === "object" ? (model as { model?: unknown }).model : undefined;
  return typeof slug === "string" ? slug : null;
};

/** An instance's custom models in T3's settings, as T3 reads them (shared's `readCustomModelEntries`): trimmed, once each. */
function customModels(settings: T3Settings, instanceId: string): { slug: string; name: string }[] {
  const config = settings.providerInstances?.[instanceId]?.config;
  const list = config && typeof config === "object" ? (config as { customModels?: unknown }).customModels : undefined;
  const out: { slug: string; name: string }[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const entry = typeof c === "string" ? { slug: c } : c && typeof c === "object" ? c as { slug?: unknown; name?: unknown } : {};
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (slug && !out.some((m) => m.slug === slug)) out.push({ slug, name: (typeof entry.name === "string" && entry.name.trim()) || slug });
  }
  return out;
}

const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
/** A list from T3's config, or none: what it gives is read inside the shell stream's handler, which mustn't throw. */
const list = <T>(v: T[] | undefined): T[] => Array.isArray(v) ? v : [];

/** Drivers whose every current model T3 lists to its agents; the others' catalogs can run to hundreds, so 8 of them. */
const FULL_CATALOG = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODELS = 8;

/**
 * Whether T3's picker offers a provider instance's models to a new thread in a project where it's `on` (web's
 * `isProviderInstancePickerReady`): available, and ready, or warning while a sub-provider, an earlier check's models
 * or a confirmed sign-in still stands.
 */
function pickerReady(p: T3Provider, on: boolean): boolean {
  if (!on || p.availability === "unavailable") return false;
  const models = list(p.models);
  if (p.status === "ready") return true;
  const usable = new Set(list(p.subProviders).filter((s) => s?.unavailableReason === undefined).map((s) => s?.name));
  if (p.status === "warning" && models.some((m) => m.subProvider !== undefined && usable.has(m.subProvider))) return true;
  if (p.subProviders !== undefined) return false;
  if (p.modelsRetained === true) return true;
  return p.status === "warning" && p.installed === true && p.auth?.status === "authenticated" && models.length > 0;
}

/** Each driver's name in T3 (contracts' `PROVIDER_DISPLAY_NAMES`). */
const DRIVER_NAMES = new Map([["antigravity", "Antigravity"], ["codex", "Codex"], ["claudeAgent", "Claude"], ["cursor", "Cursor"], ["grok", "Grok"],
  ["fx", "fx"], ["kiro", "Kiro"], ["muse", "Muse Code"], ["acpRegistry", "ACP Registry"], ["pi", "Pi"], ["opencode", "OpenCode"]]);

/** An id made readable as T3 does it (client-runtime's `humanizeSlug`): "claude-proxy" → "Claude Proxy". */
const humanize = (slug: string) => slug.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * What T3 calls a provider instance in its pickers (client-runtime's `resolveProviderInstanceDisplayName`), so the user
 * hears the name they see there: the name they gave it, unless that's just its driver's; else its id made readable, when
 * it isn't the driver's own instance ("Claude Proxy"); else the driver's name ("Claude", "Codex").
 */
export function providerLabel(p: Pick<T3Provider, "instanceId" | "driver" | "displayName">): string {
  const own = typeof p.displayName === "string" ? p.displayName.trim() : "";
  const driver = typeof p.driver === "string" ? p.driver : "";
  const kind = DRIVER_NAMES.get(driver) ?? humanize(driver);
  if (own && own !== kind) return own;
  if (p.instanceId !== driver && humanize(p.instanceId)) return humanize(p.instanceId);
  return own || kind;
}

/**
 * The models a new thread in a project can start on, as T3's own picker offers them: on each provider instance T3 has
 * on for the project and ready, its models and the custom ones in its settings, less those hidden (unless custom),
 * legacy and needing a newer CLI, in the user's order; 8 of a large catalog's (T3's listing for its agents), and every
 * custom one. Each with its instance's label (`providerLabel`), since one model can be on several (Claude and a Claude
 * Proxy), and the user chooses which. The instance a start with no model would use (`preferred`) first, then drivers'
 * own instances (`claudeAgent`, not a `claude-proxy`), then the rest, each in T3's order; one per name within an
 * instance, which is what's said (compared as the brain does, `modelKey`). The order decides only which of a name comes
 * first, never what's listed, so every id listed is one a launch takes, whichever instance a default has moved to.
 */
export function offeredModels(projectId: string, config: T3Config, preferred: unknown): Offer[] {
  const { settings } = config;
  const first = instanceOf(preferred);
  const rank = (p: T3Provider) => p.instanceId === first ? 0 : p.instanceId === p.driver ? 1 : 2;
  // A stable sort: T3's order within each rank.
  const providers = list(config.providers).filter((p) => p && typeof p.instanceId === "string" && pickerReady(p, instanceOn(settings, projectId, p.instanceId)))
    .sort((a, b) => rank(a) - rank(b));
  const out: Offer[] = [];
  for (const p of providers) {
    const provider = providerLabel(p);
    const prefs = settings.providerModelPreferences?.[p.instanceId];
    const hiddenModels = new Set(strings(prefs?.hiddenModels));
    const order = new Map(strings(prefs?.modelOrder).map((slug, n) => [slug, n]));
    const stale = new Set(list(p.updateRequiredModels).map((m) => m?.slug));
    // T3's snapshot of the custom ones can lag a removal, so its picker reads them from the settings.
    const builtIn = list(p.models).filter((m) => m && !m.isCustom && typeof m.slug === "string" && typeof m.name === "string");
    const own = new Set(builtIn.map((m) => m.slug));
    const custom = p.driver === "antigravity" ? [] : customModels(settings, p.instanceId)
      .filter((m) => m.slug.length <= 256 && !own.has(m.slug)).map((m) => ({ ...m, isCustom: true, isLegacy: false }));
    const visible = [...builtIn, ...custom]
      .map((m, n) => ({ m, n }))
      .filter(({ m }) => m.isCustom || !hiddenModels.has(m.slug))
      .sort((a, b) => (order.get(a.m.slug) ?? Infinity) - (order.get(b.m.slug) ?? Infinity) || a.n - b.n)
      .map(({ m }) => m)
      .filter((m) => !m.isLegacy && !stale.has(m.slug));
    const shown = FULL_CATALOG.has(String(p.driver)) ? visible : visible.filter((m, n) => m.isCustom || n < LISTED_MODELS);
    const said = new Set<string>();
    for (const m of shown) {
      const id = `${p.instanceId}:${m.slug}`;
      // start_work takes a model of at most 200 characters.
      if (id.length > 200 || said.has(modelKey(m.name))) continue;
      said.add(modelKey(m.name));
      out.push({ model: { id, name: m.name.trim(), provider }, instanceId: p.instanceId, slug: m.slug });
    }
  }
  return out;
}

/**
 * The model a new thread in a project starts on, as T3 picks a new thread's default (shared's `resolveProjectSettings`):
 * the project's default, else the machine's, from T3's settings; never one on a provider instance T3 has switched off
 * for the project, nor a project default T3 hides. A project whose default T3 has as null ("automatic") has none, not
 * the machine's. Without T3's settings, the project's default as the shell gives it. Failing those, the model of the
 * project's most recently active thread that T3 still allows. (T3's switch to its fallback model when a provider's
 * usage runs out isn't followed: the provider's own limit then stops the run.)
 */
export function newThreadModel(projectId: string, project: Project | undefined, threads: Iterable<ShellThread>, settings: T3Settings | null): unknown {
  const allowed = (model: unknown) => {
    const instance = instanceOf(model);
    return !settings || instance === null || instanceOn(settings, projectId, instance);
  };
  let candidates: unknown[];
  if (!settings) candidates = [project?.defaultModelSelection];
  else {
    // Its entry in T3's settings, even null; else, until T3 folds them into its settings, the project's own field.
    const stored = settings.projectSettingsOverrides?.[projectId]?.defaultModelSelection;
    const own = stored !== undefined ? stored : settings.projectSettingsFolded ? undefined : (project?.defaultModelSelection ?? undefined);
    candidates = own === null ? [] : [own && !hidden(settings, own) ? own : undefined, settings.defaultModelSelection];
  }
  const chosen = candidates.find((model) => model && allowed(model));
  if (chosen) return chosen;
  return [...threads]
    .filter((t) => t.projectId === projectId && t.modelSelection && allowed(t.modelSelection))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]?.modelSelection ?? null;
}

/**
 * The end of a checkout's path, as a place's `folder` ("mono/nix" of /home/jmo/Development/mono/nix): enough to tell two
 * projects of one name apart and to say it ("mono nix"), never the whole path. claude/adapter.ts has the same.
 */
export const folderOf = (root: string) => root.replace(/[/\\]+$/, "").split(/[/\\]/).filter((s) => s && !/^[A-Za-z]:$/.test(s)).slice(-2).join("/");

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FINISHED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** Background tasks that keep a T3 thread in Working: subagents and awaited commands, not daemons left running (`awaited: false`). */
export function awaitedBackgroundTasks(t: ShellThread): PendingBackgroundTask[] {
  return Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks.filter((b) => b && b.awaited !== false) : [];
}

/** A short progress line when a thread's own run ended while background work (subagents, awaited commands, thread waits) still runs. */
export function backgroundProgress(t: ShellThread, threads: Map<string, ShellThread>, runningChildren: ShellThread[] = []): string | null {
  const tasks = awaitedBackgroundTasks(t);
  if (tasks.length) {
    const names = tasks
      .map((b) => b.description?.trim() || (b.childThreadId ? threads.get(b.childThreadId)?.title?.trim() : "") || "")
      .filter(Boolean)
      .slice(0, 3);
    if (tasks.length === 1) {
      const kind = tasks[0]!.kind === "subagent" ? "subagent" : tasks[0]!.kind === "command" ? "background command" : "background task";
      return names[0] ? `Waiting on ${kind}: ${names[0]}.` : `Waiting on a ${kind}.`;
    }
    const what = tasks.every((b) => b.kind === "subagent") ? "subagents" : "background tasks";
    return names.length ? `Waiting on ${tasks.length} ${what}: ${names.join("; ")}.` : `Waiting on ${tasks.length} ${what}.`;
  }
  if (t.blockedOnThreadWait) return "Waiting on another thread.";
  if (t.pendingBackgroundTasks === undefined && runningChildren.length) {
    const names = runningChildren.map((c) => c.title.trim()).filter(Boolean).slice(0, 3);
    if (runningChildren.length === 1) return names[0] ? `Waiting on subagent: ${names[0]}.` : "Waiting on a subagent.";
    return names.length ? `Waiting on ${runningChildren.length} subagents: ${names.join("; ")}.` : `Waiting on ${runningChildren.length} subagents.`;
  }
  return null;
}

export function mapStatus(t: ShellThread): ItemStatus {
  if (t.pendingRuntimeRequest) return "waiting";
  // `status` is the latest run's: one queued and cancelled while another still works would read as cancelled.
  // T3 also keeps a thread in Working while awaited background tasks (subagents, awaited commands) or a thread wait run.
  if (t.activityRunStatus || ACTIVE.has(t.status) || t.blockedOnThreadWait || awaitedBackgroundTasks(t).length > 0) return "running";
  if (t.status === "interrupted" || t.status === "cancelled") return "cancelled";
  if (t.status === "completed" || t.status === "failed" || t.status === "idle") return t.status;
  return "idle";
}

/** T3's own rule (client-runtime's effective snooze): a question or a newer finished run wakes it. */
export function snoozedUntil(t: ShellThread, now: number): string | null {
  if (!t.snoozedUntil || Date.parse(t.snoozedUntil) <= now || t.pendingRuntimeRequest) return null;
  if (t.snoozedAt && t.latestRunCompletedAt && Date.parse(t.latestRunCompletedAt) > Date.parse(t.snoozedAt)) return null;
  return t.snoozedUntil;
}

export function toWorkItem(t: ShellThread, projects: Map<string, string>, now: number, hasRunningSubagent = false): WorkItem {
  const base = mapStatus(t);
  // Older T3 servers omit `pendingBackgroundTasks`; fall back to unsettled running subagent children only then.
  const status: ItemStatus = t.pendingBackgroundTasks === undefined && hasRunningSubagent && base !== "waiting" ? "running" : base;
  return {
    id: t.id,
    title: t.title,
    group: projects.get(t.projectId) ?? "unknown project",
    status,
    updatedAt: t.updatedAt,
    settled: t.settledAt != null && t.settledOverride !== "active",
    snoozedUntil: snoozedUntil(t, now),
    parentId: t.lineage?.relationshipToParent === "subagent" ? (t.lineage.parentThreadId ?? null) : null,
    pendingQuestion: Boolean(t.pendingRuntimeRequest),
    lastRunAt: t.latestRunCompletedAt ?? null,
    questionId: t.pendingRuntimeRequest?.id ?? null,
    // Only a question for the user is answered from 10 & 2; any other request (a permission) waits for them in T3 Code.
    ...(t.pendingRuntimeRequest ? { questionKind: t.pendingRuntimeRequest.kind === "user_input" ? "input" as const : "approval" as const } : {}),
    visitedAt: t.lastVisitedAt ?? null,
    wroteAt: t.latestUserAuthoredMessageAt ?? null,
    createdAt: t.createdAt ?? null,
  };
}

/**
 * Whether a person typed T3 message `m` (`WorkItem.typed`, the engine's stage 3.9, ported from spike/away-watch), by
 * what T3 records of it, never its words: the user's, typed in T3's web or desktop app (`creationSource: "web"`, at a
 * computer) or its phone app (`"mobile"`, which 10 & 2's own sends also say: theirs are `driver:` ids). T3 writes as the
 * user's what nobody typed too: a usage limit's "Continue where you left off." (`limit-resume:`, `creationSource:
 * "server"`), a question's answers relayed, a restart's continuation (`"server"`), a scheduled task's
 * (`scheduledTaskId`), another thread's or agent's (`senderThreadId`, `"mcp"`, `"provider"`), a notice, a workflow's
 * script, an idle compaction. A message that doesn't say where it came from isn't counted.
 */
export const personWrote = (m: any): boolean =>
  m?.role === "user" && m.createdBy === "user" && (m.creationSource === "web" || m.creationSource === "mobile") && !m.scheduledTaskId && !m.senderThreadId
  && !m.notification && !m.workflowScript && !m.idleCompaction && !/^(limit-resume|driver):/.test(String(m.id ?? ""));

/** What a person typed in a thread's messages (`personWrote`), oldest first: at a computer unless T3's phone app. */
export function personWrites(messages: any[]): Write[] {
  return newest(messages.filter(personWrote).flatMap((m) => {
    const at = m.createdAt ?? m.updatedAt;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? [{ at, digest: digestOf(String(m.text ?? "")), desk: m.creationSource === "web" }] : [];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}

/**
 * A thread first seen with T3's last user write older than this is taken as it is, unread: Away lasts at most 72 hours
 * and news is kept a day, so nothing reads a write older than that. Newer, the thread is read for who wrote.
 */
export const WROTE_CHECK_MS = 73 * 3_600_000;

/** Which reply a message is: its run's end, or (for a message outside any run) when it was last written. */
function replyRef(m: any, runs: any[], messages: any[]): ReplyRef | null {
  const run = m.runId ? runs.find((r) => r.id === m.runId) : null;
  const at = run?.completedAt ?? m.updatedAt ?? m.createdAt;
  return m.id && at ? { runId: m.runId ?? null, messageId: m.id, at, ...(startedBy(run, messages)?.createdBy === "agent" ? { byAgent: true as const } : {}) } : null;
}

/**
 * The message that started a run: the user's, or, when a background task the agent left running finishes, the note T3
 * writes as the agent's own to wake it.
 */
const startedBy = (run: any, messages: any[]) =>
  run ? (run.userMessageId && messages.find((m) => m.id === run.userMessageId)) || messages.find((m) => m.runId === run.id && m.role === "user") : undefined;

/**
 * The user's first message in a thread's projection: the oldest one of theirs with words, never a note the agent wrote
 * itself (`createdBy` "agent", as `startedBy` finds) or the system's, nor a workflow's script.
 */
function firstMessage(p: any): any {
  const own = (p.messages ?? []).filter((m: any) => m.role === "user" && (m.createdBy ?? "user") === "user" && !m.workflowScript && m.text?.trim() && m.createdAt);
  return own.reduce((first: any, m: any) => (!first || Date.parse(m.createdAt) < Date.parse(first.createdAt) ? m : first), null);
}

/** How many earlier replies' times a report carries: enough to count what's unheard ("Seven replies you haven't heard"). */
const EARLIER_MAX = 9;

/** How many threads' whole histories are kept (`T3Adapter.history`): a long thread's is megabytes to read. */
const HISTORIES = 16;
/** How long a whole read that failed isn't tried again: meanwhile the window's replies are given straight away. */
const HISTORY_RETRY_MS = 60_000;
/**
 * The most a thread's replies may come to (as JSON), oldest dropped first: the link carries a message of at most 8 MB
 * (`MAX_FRAME`), and a long thread's every reply and prompt can come to more.
 */
const REPLIES_BYTES = 4 << 20;

/** Every finished run's reply in a thread's projection, newest first. */
function pastReplies(p: any): PastReply[] {
  const messages: any[] = p.messages ?? [];
  const out: PastReply[] = [];
  // A run the user rolled back isn't in T3's thread any more (its window leaves it out), though the whole snapshot keeps it.
  for (const run of (p.runs ?? []).filter((r: any) => FINISHED.has(r.status) && r.status !== "rolled_back")) {
    const said = messages.filter((m) => m.runId === run.id && m.role === "assistant" && !m.streaming && m.text?.trim());
    const last = said.at(-1);
    const ref = last ? replyRef(last, p.runs, messages) : null;
    if (!ref) continue;
    // The agent's own note isn't anything the user asked: not read as what they asked, nor matched as their words.
    out.push({ ...ref, text: last.text, prompt: ref.byAgent ? null : startedBy(run, messages)?.text?.trim() || null });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** What a change has to touch before the briefing cares (updatedAt and item counts churn constantly). */
function digestKey(t: ShellThread, now: number, hasRunningSubagent = false): string {
  const w = toWorkItem(t, new Map(), now, hasRunningSubagent);
  return JSON.stringify([w.status, w.settled, w.snoozedUntil, w.pendingQuestion, t.title, t.latestRunCompletedAt ?? null]);
}

type Question = { id: string; options?: { label: string; value?: string }[]; allowCustomAnswer?: boolean };

const plain = (s: string) => s.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * A follow-up as the answer to every question a thread asked at once: the option it names ("Prism", for "Prism
 * (Recommended)"), or else the message itself, which the agent reads in full each time. A question that takes only
 * its options and isn't given one is the user's to answer.
 */
export function answersFor(questions: Question[], message: string): Record<string, string> | { error: string } {
  if (questions.length === 0) return { error: "Couldn't find the question the thread is asking, so nothing was sent." };
  const answers: Record<string, string> = {};
  for (const q of questions) {
    // An option's own label first (a tap sends one), so "Deploy (later)" isn't taken for "Deploy", which reads the same
    // once the parenthetical is dropped.
    const option = q.options?.find((o) => o.label === message.trim())
      ?? q.options?.find((o) => plain(o.label) === plain(message) || (o.value !== undefined && plain(o.value) === plain(message)));
    if (option) answers[q.id] = option.value ?? option.label;
    else if (q.allowCustomAnswer === false) return { error: `The thread's question takes one of its options: ${(q.options ?? []).map((o) => o.label).join(" / ")}. Nothing was sent.` };
    else answers[q.id] = message;
  }
  return answers;
}

export function toCommand(action: Action, commandId: string): Record<string, unknown> {
  switch (action.kind) {
    case "settle":
      return { type: "thread.settle", commandId, threadId: action.itemId };
    case "archive":
      return { type: "thread.archive", commandId, threadId: action.itemId };
    case "snooze":
      return { type: "thread.snooze", commandId, threadId: action.itemId, snoozedUntil: action.until };
    case "unsnooze":
      return { type: "thread.unsnooze", commandId, threadId: action.itemId, reason: "user" };
    case "unsettle":
      return { type: "thread.unsettle", commandId, threadId: action.itemId, reason: "user" };
    case "follow_up":
      // Starts a run on an idle thread and queues behind a busy one; never steers or interrupts.
      return {
        type: "message.dispatch",
        commandId,
        threadId: action.itemId,
        messageId: `driver:${commandId}`,
        text: action.message,
        attachments: [],
        createdBy: "user",
        creationSource: "mobile",
        dispatchMode: { type: "queue_after_active" },
      };
    case "start_work":
      throw new Error("start_work is launched, not dispatched");
  }
}

/**
 * A short seed title from a prompt, as T3's own clients make one: the first line of the user's words (not a line saying
 * it was dictated, nor a quoted one), cut at a word to about 50 characters. brain/src/adapter.ts `titleFrom` is the same.
 */
export function titleFrom(message: string): string {
  const line = message.split("\n").map((l) => l.trim()).find((l) => l && !/^\(.*\)$/.test(l) && !l.startsWith(">")) ?? "";
  const words = line.replace(/\s+/g, " ");
  if (words.length <= 50) return words.replace(/[\s.,;:]+$/, "") || "New thread";
  const cut = words.slice(0, 50);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 25)).replace(/[\s.,;:]+$/, "")}…`;
}

/**
 * A launch, built in code from the profile: the project's own id, a fresh worktree or its own checkout (never a path),
 * no attachments. With no title, T3 names the thread from its first message (`generateTitle`), showing a seed made from
 * it until then: T3 needs a title either way. A worktree starts from `base` (`worktreeStart`): a branch, which T3 fetches from origin first, or
 * "HEAD", the checkout's current commit; null runs it in the project's folder. The same `commandId` returns the same
 * thread (T3 keeps launch receipts).
 */
export function toLaunch(action: Extract<Action, { kind: "start_work" }>, commandId: string, modelSelection: unknown, base: string | null = "HEAD"): Record<string, unknown> {
  const p: LaunchProfile = action.profile;
  return {
    commandId,
    creationSource: "mobile",
    projectId: action.placeId,
    title: action.title ?? titleFrom(action.message),
    generateTitle: !action.title,
    modelSelection,
    runtimeMode: p.runtimeMode,
    interactionMode: p.interactionMode,
    workspaceStrategy: p.workspace === "root" || base === null ? { type: "root" }
      : base === "HEAD" ? { type: "worktree", baseRef: "HEAD" } : { type: "worktree", baseRef: base, startFromOrigin: true },
    initialMessage: { text: action.message, attachments: [] },
  };
}

/** Where T3's server listens when it hasn't said otherwise. */
export const T3_DEFAULT_ORIGIN = "http://127.0.0.1:3773";

/** T3 Code's own folder: $T3CODE_HOME as T3 reads it (`~` is the home folder), else ~/.t3. */
export function t3Home(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.T3CODE_HOME?.trim();
  if (!raw) return join(homedir(), ".t3");
  return resolve(raw === "~" ? homedir() : /^~[/\\]/.test(raw) ? join(homedir(), raw.slice(2)) : raw);
}

const alive = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Where this computer's T3 server is: the origin it wrote down when it started (`userdata/server-runtime.json`), as T3's
 * own CLI finds it. T3 takes the next free port when another program has 3773, so that file is where it is. One left
 * by a server that has stopped counts as none: then T3's default.
 */
export function t3Origin(home: string = t3Home()): string {
  try {
    const state = JSON.parse(readFileSync(join(home, "userdata", "server-runtime.json"), "utf8")) as { origin?: unknown; pid?: unknown };
    if (typeof state.origin === "string" && /^https?:$/.test(new URL(state.origin).protocol) && alive(state.pid)) return state.origin;
  } catch { /* none yet, or not T3's */ }
  return T3_DEFAULT_ORIGIN;
}

type Options = {
  /** T3's address ($T3_URL); without it, where T3 says it is (`t3Origin`), read again at each connect. */
  baseUrl?: string;
  /** T3's folder, where it says its address (`t3Home()`); tests swap in their own. */
  t3Home?: string;
  cli: Cli;
  label: string;
  log: (msg: string) => void;
  /** Defaults to T3's CLI; tests swap in fakes. */
  visible?: (root: string) => boolean;
  /** Where new worktrees start (the policy's `worktreeBase`); "HEAD" when unset. */
  worktreeBase?: string;
  /**
   * The connector's policy, as it applies to T3 Code: the machine's, narrowed by `agents.t3` (its actions, answering,
   * steering a running thread, its ceiling). Unset only in tests that don't need it: Local checks the machine's own.
   */
  policy?: Policy;
  /** T3 refused the connector's session: T3 Code alone stops until the connector restarts; nothing else does. */
  onRevoked?: () => void;
  auth?: { issue(): Promise<T3Session>; revoke(sessionId: string): Promise<void> };
  /** Commands that wait: what's held here changed (status.json). */
  onHolds?: (held: HeldSummary[]) => void;
};

/**
 * Tests passed or failed (docs/launch/engine.md §11 stage 3.10; spike/run-receipts): what run `runId` ran of its checks,
 * from its projection's turn items in order: each `command_execution` that's a check (`checksIn`), with its exit, and
 * each `file_change`. T3 gives an exit code for some agents' commands; for others (Claude's) only the item's status,
 * `failed` for a refused command too, and on the wire never the output, only `outputIndicatesFailure` (a non-zero exit
 * code, or output saying "Exit code 1"), so a failure counts only with that. A check piped on (`npm test | tail`) goes by
 * its runner's summary in its output (`verdict`, read with `getTurnItem`). A check whose clean exit only its status tells
 * (`byStatus`) counts once its output has been read and it wasn't left in the background (`verdict` true; false, a
 * failure, when its output says a test failed). Only the kind, the result and the label are kept.
 */
function runSteps(items: any[], runId: string, own: OwnChecks, verdict: (item: any) => boolean | null): Step[] {
  const steps: Step[] = [];
  for (const i of items.filter((i) => i?.runId === runId).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    if (i.type === "file_change" && i.status === "completed") steps.push("edit");
    if (i.type !== "command_execution" || typeof i.input !== "string") continue;
    const ran = checksIn(i.input, own);
    if (!ran) continue;
    const failed = typeof i.exitCode === "number" ? i.exitCode !== 0 : i.outputIndicatesFailure === true;
    let ok = i.status === "completed" && !failed ? true : i.status === "failed" && failed ? false : null;
    // Its status alone: a pass once its output was read and says it ran in the foreground, a failure if it says one failed.
    if (byStatus(i, ran)) ok = verdict(i);
    steps.push(...stepsOf(ran, ok, verdict(i)));
  }
  return steps;
}

/**
 * A check whose clean exit only its status would tell: `completed`, no exit code, nothing saying it failed, and its
 * line's exit its own (or `cleanPasses`). Claude's commands through T3 have no exit code, and one Claude ran in the
 * background is `completed` the moment it launches, so its output is read first.
 */
const byStatus = (i: any, ran: Ran) => i.status === "completed" && typeof i.exitCode !== "number" && i.outputIndicatesFailure !== true && (ran.exit || ran.cleanPasses);
/** What Claude Code's output says for a command it ran in the background, or moved there at its timeout. */
const BACKGROUND = /^(?:Command running in background with ID|Command did not complete within .{0,40}moved to the background)/i;

/**
 * What a check's output, read once, tells and is kept of it: for one whose clean exit only its status tells
 * (`byStatus`), null if it was left in the background or says no test ran (`noneRan`), false if its output says a test
 * failed, else true; for one whose exit isn't its own, what its output says (`verdictOf`); for one that failed after a
 * command that could have stopped it (`gated`), false too when its output shows it ran (`gateFailed`). The output
 * itself is dropped.
 */
export function outputVerdict(i: any, own: OwnChecks, output: string): boolean | null {
  const ran = checksIn(i.input, own)!;
  const said = verdictOf(output, ran.found[0].kind, ran.several);
  if (!byStatus(i, ran)) return said ?? (ran.gated && i.status === "failed" && gateFailed(ran, output) ? false : null);
  return BACKGROUND.test(output.trimStart()) ? null : said === false ? false : ran.found[0].kind === "test" && noneRan(output) ? null : true;
}

/**
 * The checks in run `runId` whose output `getTurnItem` is asked for (`outputVerdict`): one whose clean exit only its
 * status tells, one whose exit isn't its own, so only its output's summary can tell (not one whose clean exit already
 * says it passed, `npm test && git commit` with an exit code 0, `cleanPasses`), and one that failed after a command that
 * could have stopped it (`gated`: `cd no-such && npm test`), whose failure is its own only as its output tells.
 */
const outputChecks = (items: any[], runId: string, own: OwnChecks) =>
  items.filter((i) => {
    if (i?.runId !== runId || i.type !== "command_execution" || typeof i.input !== "string" || !["completed", "failed"].includes(i.status)) return false;
    const ran = checksIn(i.input, own);
    return !!ran && (byStatus(i, ran) || (!ran.exit && !(ran.cleanPasses && i.status === "completed" && !i.outputIndicatesFailure && (i.exitCode ?? 0) === 0))
      || (!!ran.gated && i.status === "failed"));
  });

/** One page of a thread's turn items, and the cursor to the page before it. */
export type Page = { items: any[]; cursor: string | null };
/** How many of T3's history pages (75 items each) a run's receipts read back at most: about 3,000 items. */
export const HISTORY_PAGES = 40;

/**
 * Run `runId`'s turn items, all of them. T3's projection holds only a thread's newest turn items (77), so a long run's
 * earlier checks aren't in it. When the window starts inside the run, or before it, the older items are read a page at a
 * time (`page`: null for the first, T3's own bounded window with its cursor) until an older item that isn't the run's
 * shows its start, what was read meets `known` (the run's items from its start, read whole before: the review of 45ec9eccdf6f,
 * F2, so a run still going is read on from them, and a failure that left the window still counts), T3 has no more, or
 * `HISTORY_PAGES` pages. `whole`: the run's start was reached; `failed`: a page couldn't be read (so it's worth trying
 * again; a run longer than the pages read is neither, and stays as read).
 */
export async function runItems(window: any[], runId: string, page: (cursor: string | null) => Promise<Page | null>, known?: any[]): Promise<{ items: any[]; whole: boolean; failed?: true }> {
  const seen = new Map<string, any>();
  const add = (items: any[]) => { for (const i of items) if (i && typeof i.id === "string" && !seen.has(i.id)) seen.set(i.id, i); };
  add(window);
  const started = () => {
    const sorted = [...seen.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    return sorted.findIndex((i) => i.runId === runId) > 0;
  };
  const ids = new Set((known ?? []).map((i) => i?.id));
  const met = () => [...seen.keys()].some((id) => ids.has(id));
  // What's read now first: an item read again is as it is now.
  const whole = () => (add(known ?? []), { items: [...seen.values()], whole: true });
  if (started() || met()) return whole();
  let cursor: string | null | undefined;
  for (let n = 0; n <= HISTORY_PAGES; n++) {
    const got = await page(n === 0 ? null : cursor!);
    if (!got) return { items: [...seen.values()], whole: false, failed: true };
    add(got.items);
    if (started() || met() || !got.cursor) return whole();
    cursor = got.cursor;
  }
  return { items: [...seen.values()], whole: false };
}
/** What `runSteps`, `outputChecks` and `runItems` read of a turn item: kept of a run read whole, nothing else. */
const keptOf = (i: any) => ({ id: i.id, runId: i.runId, ordinal: i.ordinal, type: i.type, status: i.status, input: i.input, exitCode: i.exitCode, outputIndicatesFailure: i.outputIndicatesFailure });

export class T3Adapter implements Adapter {
  readonly name = "t3";
  /** It reads its threads' test runs (`Report.checks`, stage 3.10). */
  readonly readsChecks = true;
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;

  private readonly opts: Options;
  private session: T3Session | null = null;
  private client: RpcClient | null = null;
  private stopStream: (() => void) | null = null;
  private readonly threads = new Map<string, ShellThread>();
  private readonly projects = new Map<string, string>();
  private readonly projectInfo = new Map<string, Project>();
  /** Launches waiting for their thread to reach the shell stream. */
  private readonly arrivals = new Map<string, () => void>();
  private readonly keys = new Map<string, string>();
  /** Stage 3.10: a piped check's verdict from its runner's summary, by turn item (never its output). */
  private readonly verdicts = new Map<string, boolean | null>();
  /**
   * Stage 3.10: a finished run's checks once read, by thread and run: a finished run doesn't change. `unread`: read only
   * in part (longer than the pages read), so it never will be whole.
   */
  private readonly receipted = new Map<string, { checks: Checks | undefined; unread: boolean }>();
  /**
   * A run's items from its start, as last read whole (`keptOf`), by thread and run: a run still going is read on from
   * them (`runItems`), so what left the projection's window still counts (the review of 45ec9eccdf6f, F2).
   */
  private readonly runsRead = new Map<string, any[]>();
  /** Each thread's test runs across its runs (`Tested`): T3 Code's connector has no store, so in memory. */
  private readonly tested = new Tested();
  private readonly exposed = new Set<string>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private ready: Promise<void>;
  private markReady!: () => void;
  private failReady!: (e: Error) => void;
  private closed = false;
  /** The first thread list has arrived. */
  private loaded = false;
  private live = false;
  /** Someone revoked the connector's T3 session: stop, and don't mint a replacement until restart. */
  private revoked = false;
  private authCheck: NodeJS.Timeout | null = null;
  private configCheck: NodeJS.Timeout | null = null;
  /** T3's config as last read, and from it the models each project offers (`offeredModels`). */
  private config: T3Config | null = null;
  private catalogs = new Map<string, Offer[]>();
  /** Each project's first-listed instance at the last `recatalog`: a thread used on another moves it (`followNewest`). */
  private firsts = new Map<string, string | null>();
  /** A read of T3's config away from a launch failed, and said so in the log; said again once one works. */
  private configFailing = false;
  private retryMs = 1000;
  /** The server tracks visits: its shell rows carry `lastVisitedAt`. */
  private visits = false;
  /** Long threads' finished replies, read whole (`history`), and the run end they were read after. */
  private readonly histories = new Map<string, { key: string; replies: Promise<PastReply[]>; retryAt?: number }>();
  /** A session being issued, which every caller of `token` then waits for. */
  private renewing: Promise<string> | null = null;
  /**
   * Per thread, what a person typed in it (`personWrites`), read for T3's `latestUserAuthoredMessageAt` as it was then
   * (`raw`). Until it's been read, none: a thread is read only when that moves, one at a time.
   */
  private readonly wrote = new Map<string, { raw: string | null; writes: Write[] }>();
  private readonly reading = new Set<string>();
  private reads: Promise<void> = Promise.resolve();
  /** Where T3 is, as of the last connect. */
  private base: string;

  private readonly auth: NonNullable<Options["auth"]>;
  /**
   * Commands that wait (gate.ts): commands of T3's Claude threads held by Claude Code's PreToolUse hook (the Claude
   * adapter's socket hands them here: `claimGate`), by thread; and which T3 thread each Claude session is.
   */
  private readonly gates: Gates;
  private readonly claudeSessions = new Map<string, string>();

  constructor(opts: Options) {
    this.opts = opts;
    this.gates = new Gates({ log: (m) => opts.log(`t3: ${m}`), changed: (id) => { opts.onHolds?.(this.gates.summary()); this.emit([id], this.gates.has(id)); } });
    this.base = opts.baseUrl ?? T3_DEFAULT_ORIGIN;
    this.auth = opts.auth ?? {
      issue: () => issueSession({ cli: opts.cli, label: opts.label, ttl: "24h", scopes: CONNECTOR_SCOPES }),
      revoke: (id) => revokeSession(opts.cli, id),
    };
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve;
      this.failReady = reject;
    });
    this.ready.catch(() => {}); // start() reports it
  }

  async start(): Promise<void> {
    await this.connect();
    await this.ready;
    // Revoking a T3 session doesn't close an open socket (spike finding), so check it ourselves.
    this.authCheck = setInterval(() => void this.checkAuth(), 5 * 60_000);
    this.authCheck.unref();
    // What T3 offers changes in its own settings (and as its providers check in), which send nothing down the shell.
    this.configCheck = setInterval(() => void this.refreshConfig(), CONFIG_MS);
    this.configCheck.unref();
  }

  private async checkAuth() {
    const s = this.session;
    if (!s || this.revoked || this.closed) return;
    const res = await fetch(new URL("/api/auth/websocket-ticket", this.base), { method: "POST", headers: { authorization: `Bearer ${s.token}` } }).catch(() => null);
    if (res?.status === 401 && Date.parse(s.expiresAt) > Date.now()) this.onRevoked();
  }

  private onRevoked() {
    if (this.revoked) return;
    this.revoked = true;
    this.session = null;
    this.failReady(new Error("T3 refused the connector's session (revoked or unauthorized)"));
    this.opts.log("t3: the connector's session was revoked; stopping until the connector is restarted");
    this.stopStream?.();
    const c = this.client;
    this.client = null;
    c?.close();
    this.live = false;
    // Only T3 Code stops: every other work system stays connected, and the view says T3's is down.
    this.emit([], false);
    this.opts.onRevoked?.();
  }

  /** Whether the threads have been read at least once; until then `list` waits. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  connected(): boolean {
    return this.live && this.loaded && this.client !== null && !this.closed && !this.revoked;
  }

  /** Active unsettled subagent threads grouped by each ancestor thread id, for older T3 servers without `pendingBackgroundTasks`. */
  private runningSubagents(): Map<string, ShellThread[]> {
    const byParent = new Map<string, ShellThread[]>();
    for (const c of this.threads.values()) {
      if (c.archivedAt || c.deletedAt || (c.settledAt != null && c.settledOverride !== "active")) continue;
      if (c.lineage?.relationshipToParent !== "subagent" || !c.lineage.parentThreadId || !this.projectVisible(c.projectId)) continue;
      if (mapStatus(c) !== "running") continue;
      let cur: ShellThread | undefined = c;
      const seen = new Set<string>([c.id]);
      for (let depth = 0; depth < 20 && cur?.lineage?.relationshipToParent === "subagent" && cur.lineage.parentThreadId; depth++) {
        const pid = cur.lineage.parentThreadId;
        if (seen.has(pid)) break;
        seen.add(pid);
        const list = byParent.get(pid) ?? [];
        list.push(c);
        byParent.set(pid, list);
        cur = this.threads.get(pid);
      }
    }
    return byParent;
  }

  async list(): Promise<WorkItem[]> {
    await this.ready;
    const now = Date.now();
    const running = this.runningSubagents();
    const items = [...this.threads.values()]
      .filter((t) => !t.archivedAt && !t.deletedAt && this.projectVisible(t.projectId))
      .map((t) => toWorkItem(t, this.projects, now, running.has(t.id)));
    for (const i of items) {
      // A held command: the thread holds it, whatever T3 says of its run.
      const gate = this.gates.get(i.id);
      if (gate) Object.assign(i, { status: "waiting", pendingQuestion: true, questionId: gate.id, gate: gateOf(gate), snoozedUntil: null });
      this.exposed.add(i.id);
      if (i.parentId && !this.itemVisible(i.parentId)) i.parentId = null;
    }
    return items;
  }

  /**
   * Whether a send of 10 & 2's is never taken for a person's message here (the Ledger then drops its row): a follow-up
   * is written with a `driver:` id (`toCommand`), which `personWrote` leaves out, or answers T3's question, which T3
   * relays as its own (`"server"`). New work's first message says neither, so its row stays.
   */
  sendLeftOut(action: Action): boolean { return action.kind === "follow_up"; }
  /** What a person typed in a thread (`personWrites`), as last read: `WorkItem.typed`. */
  personWrites(id: string): Write[] {
    return this.wrote.get(id)?.writes ?? [];
  }

  docContext(id: string): ThreadDocContext | null {
    const t = this.threads.get(id);
    if (!t || !this.projectVisible(t.projectId)) return null;
    const root = this.projectInfo.get(t.projectId)?.workspaceRoot ?? null;
    const cwd = t.worktreePath ?? root;
    return {
      agent: "t3",
      cwd,
      projectRoot: root,
      worktreeTrusted: Boolean(t.worktreePath && this.projectVisible(t.projectId)),
    };
  }
  async report(id: string): Promise<Report> {
    this.requireVisible(id);
    const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
    this.requireVisible(id);
    const said = (p.messages ?? []).filter((m: any) => m.role === "assistant" && !m.streaming && m.text?.trim());
    // A run that is still going has only progress notes so far; the reply is the last message of a finished run.
    const unfinished = new Set((p.runs ?? []).filter((r: any) => !FINISHED.has(r.status)).map((r: any) => r.id));
    const done = said.filter((m: any) => !unfinished.has(m.runId));
    const shell = this.threads.get(id);
    const progress = said.filter((m: any) => unfinished.has(m.runId)).at(-1)?.text
      ?? (shell ? backgroundProgress(shell, this.threads, shell.pendingBackgroundTasks === undefined ? (this.runningSubagents().get(id) ?? []) : []) : null);
    const last = done.at(-1);
    const pending = shell?.pendingRuntimeRequest;
    let question: string | null = null, choices: string[] | null = null;
    if (pending) {
      const item = (p.turnItems ?? []).find((i: any) => i.type === "user_input_request" && i.requestId === pending.id);
      question = item
        ? item.questions
            .map((q: any) => `${q.question}${q.options?.length ? ` Options: ${q.options.map((o: any) => o.label).join(" / ")}.` : ""}`)
            .join(" ")
        : `A ${pending.kind.replace(/_/g, " ")} is waiting.`;
      // Only a question's options are choices; a permission (no request item) has none.
      if (item) choices = choicesOf((item.questions as any[]).map((q) => ({ options: ((q.options ?? []) as any[]).map((o) => String(o.label)) })));
    }
    let text: string = last?.text ?? "";
    let reply = last ? replyRef(last, p.runs ?? [], p.messages ?? []) : null;
    let before = reply ? pastReplies(p) : [];
    // A run longer than the window leaves no finished reply in it (18 November: "read me the latest response" got "no
    // finished reply yet" from a thread with 14 runs behind the long one going): then it's read from the whole thread.
    // The window starts after the thread's first run (ordinals start at 1), so there are runs before it to look in.
    if (!last && !this.whole(id, p) && !(p.runs ?? []).some((r: any) => r.ordinal === 1)) {
      const all = await this.history(id).catch(() => []);
      this.requireVisible(id);
      const latest = all[0];
      if (latest) {
        text = latest.text;
        reply = { runId: latest.runId, messageId: latest.messageId, at: latest.at, ...(latest.byAgent ? { byAgent: true as const } : {}) };
        before = all;
      }
    }
    // When the replies before it finished: so the brain counts those the user hasn't heard.
    const at = reply ? Date.parse(reply.at) : 0;
    const earlier = reply ? before.filter((r) => Date.parse(r.at) < at).slice(0, EARLIER_MAX).map((r) => r.at) : [];
    const gate = this.gates.get(id);
    if (gate) return gateReport(gate, { text, progress, reply, earlier });
    // Stage 3.10: the checks of the run the reply ended, and of the run still going, so far, each from its start (`run`):
    // read only in part, its failures and never a pass (the review of 45ec9eccdf6f, F2).
    const own = this.opts.policy?.checks ?? {};
    const { checks, unread } = reply?.runId ? await this.checksOf(id, p.turnItems ?? [], reply.runId) : { checks: undefined, unread: false };
    const going = (p.turnItems ?? []).filter((i: any) => i?.runId && unfinished.has(i.runId)).sort((a: any, b: any) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1)?.runId;
    let running: Checks | undefined;
    if (going) {
      const { items, whole } = await this.run(id, p.turnItems ?? [], going);
      await this.verdictsFor(id, items, going);
      const soFar = this.tested.receipts(id, going, runSteps(items, going, own, (i) => this.verdicts.get(i.id) ?? null));
      running = whole ? soFar : partOnly(soFar);
    }
    const since = going ? (p.runs ?? []).find((r: any) => r.id === going)?.startedAt ?? null : null;
    return { text, progress, question, choices, reply, earlier, ...(checks ? { checks } : unread ? { checksUnread: true as const } : {}), ...(running ? { running, runningId: going, ...(since ? { runningSince: since } : {}) } : {}) };
  }

  /**
   * Stage 3.10: a finished run's checks, from all its items (`run`, reading back past the projection's window), kept
   * once read (a finished run doesn't change), unless a page or a piped check's output couldn't be read: then `unread`,
   * and only what was read (the report says so when that's none, `checksUnread`, never "no check ran"). Read only in
   * part (a page refused, or longer than the pages read), only its failures, never a pass (`partOnly`; the review of
   * 45ec9eccdf6f, F2).
   */
  private async checksOf(threadId: string, window: any[], runId: string): Promise<{ checks: Checks | undefined; unread: boolean }> {
    const key = `${threadId}\n${runId}`;
    const kept = this.receipted.get(key);
    if (kept) return kept;
    const { items, whole, failed } = await this.run(threadId, window, runId);
    const read = await this.verdictsFor(threadId, items, runId);
    const all = this.tested.receipts(threadId, runId, runSteps(items, runId, this.opts.policy?.checks ?? {}, (i) => this.verdicts.get(i.id) ?? null));
    const got = { checks: whole ? all : partOnly(all), unread: !whole || !read };
    if (!failed && read) {
      this.receipted.set(key, got);
      this.runsRead.delete(key);
      if (this.receipted.size > 500) this.receipted.delete(this.receipted.keys().next().value!);
    }
    return got;
  }

  /**
   * Run `runId`'s items from its start (`runItems`): the window, read on from what was read of it before, and back over
   * T3's history where they don't meet. Kept once read whole, for the next read.
   */
  private async run(threadId: string, window: any[], runId: string): Promise<{ items: any[]; whole: boolean; failed?: true }> {
    const key = `${threadId}\n${runId}`;
    const got = await runItems(window, runId, (cursor) => this.page(threadId, cursor), this.runsRead.get(key));
    if (got.whole) {
      this.runsRead.delete(key);
      this.runsRead.set(key, got.items.filter((i) => i?.runId === runId).map(keptOf));
      if (this.runsRead.size > 50) this.runsRead.delete(this.runsRead.keys().next().value!);
    }
    return got;
  }

  /**
   * A check's output read once with `getTurnItem` (T3 leaves outputs out of the projection) and only its verdict kept
   * (`outputVerdict`), by item: a finished item's output doesn't change. False when one couldn't be read (it's tried
   * again next time).
   */
  private async verdictsFor(threadId: string, items: any[], runId: string): Promise<boolean> {
    const own = this.opts.policy?.checks ?? {};
    let all = true;
    for (const i of outputChecks(items, runId, own)) {
      if (this.verdicts.has(i.id)) continue;
      const got = await this.rpc().request<any>(M.getTurnItem, { threadId, itemId: i.id }).catch(() => null);
      if (!got) { all = false; continue; }
      const output = typeof got.item?.output === "string" ? got.item.output : "";
      this.verdicts.set(i.id, outputVerdict(i, own, output));
      if (this.verdicts.size > 2000) this.verdicts.delete(this.verdicts.keys().next().value!);
    }
    return all;
  }

  /**
   * One page of a thread's turn items over T3's HTTP API (it has no socket method for them): with no cursor, its bounded
   * window, for the cursor to what's older; then each older page (75 items). Read scope; null when T3 refuses or fails.
   */
  private async page(threadId: string, cursor: string | null): Promise<Page | null> {
    try {
      const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}/${cursor ? `history?cursor=${encodeURIComponent(cursor)}` : "bounded"}`;
      const res = await fetch(new URL(path, this.base), { headers: { authorization: `Bearer ${await this.token()}`, "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL) }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const j: any = await res.json();
      return cursor
        ? { items: (j.items ?? []).map((r: any) => r?.item), cursor: j.hasMoreHistory ? j.nextCursor ?? null : null }
        : { items: j.projection?.turnItems ?? [], cursor: j.hasMoreHistory ? j.historyCursor ?? null : null };
    } catch {
      return null;
    }
  }

  /**
   * Every finished run's reply, newest first. A long thread's window holds only its latest runs' (none at all while a
   * long run goes), so the older ones come from the whole thread; where that can't be read, the latest are given.
   */
  async replies(id: string): Promise<PastReply[]> {
    this.requireVisible(id);
    const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
    this.requireVisible(id);
    const recent = pastReplies(p);
    if (this.whole(id, p)) return recent;
    const all = await this.history(id).catch(() => []);
    this.requireVisible(id);
    // The window's are as of now; the whole thread's may be from before a run that has just ended.
    const ids = new Set(recent.map((r) => r.messageId));
    const replies = [...recent, ...all.filter((r) => !ids.has(r.messageId))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    let bytes = 0;
    const kept = replies.filter((r, i) => (bytes += Buffer.byteLength(JSON.stringify(r))) <= REPLIES_BYTES || i === 0);
    if (kept.length < replies.length) this.opts.log(`t3: thread ${id} has ${replies.length} replies; giving the newest ${kept.length} (${REPLIES_BYTES >> 20} MB)`);
    return kept;
  }

  /**
   * Whether a projection is the whole thread. T3 answers `getThreadProjection` with a recent window of a long thread
   * (75 rows or 1 MB, runs and messages alike, since October) without saying so: it's whole only when it holds every row
   * the shell counts.
   */
  private whole(id: string, p: any): boolean {
    const rows = this.threads.get(id)?.visibleItemCount;
    return typeof rows === "number" && (p.visibleTurnItems ?? []).length >= rows;
  }

  /**
   * A long thread's finished replies, from the whole thread through T3's HTTP API (the snapshot `getThreadProjection`
   * windows), kept until another of its runs ends: what changes them, other than the window's newest.
   */
  private history(id: string): Promise<PastReply[]> {
    const t = this.threads.get(id);
    // What moves when a run starts or ends, and not as it works (updatedAt moves with every row). A server whose shell
    // doesn't name runs falls back to updatedAt.
    const key = t?.latestRunId !== undefined ? `${t.latestRunId}|${t.latestRunCompletedAt ?? ""}|${t.activeRunId ?? ""}` : (t?.updatedAt ?? "");
    const kept = this.histories.get(id);
    this.histories.delete(id);
    if (kept?.key === key && (kept.retryAt === undefined || Date.now() < kept.retryAt)) {
      this.histories.set(id, kept);
      return kept.replies;
    }
    const replies = this.wholeThread(id).then(pastReplies);
    const entry: { key: string; replies: Promise<PastReply[]>; retryAt?: number } = { key, replies };
    this.histories.set(id, entry);
    for (const old of this.histories.keys()) if (this.histories.size > HISTORIES) this.histories.delete(old);
    replies.catch((e) => {
      entry.retryAt = Date.now() + HISTORY_RETRY_MS;
      this.opts.log(`t3: couldn't read the whole of thread ${id} (${describe(e)}); giving its newest replies for now`);
    });
    return replies;
  }

  /** The thread's whole projection, from T3's HTTP API with the connector's own session. */
  private async wholeThread(id: string): Promise<any> {
    const token = await this.token();
    this.requireVisible(id);
    const res = await fetch(new URL(`/api/orchestration/threads/${encodeURIComponent(id)}`, this.base), {
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = (await res.json()) as { projection?: unknown; hasMoreHistory?: boolean };
    // Were T3 to window this too, it would say so; the window's replies are already what the caller has.
    if (snapshot.hasMoreHistory) throw new Error("T3 gave only part of the thread");
    return snapshot.projection ?? {};
  }

  /**
   * The user's first message. T3 answers `getThreadProjection` with a recent window of a long thread (about 10 user turns,
   * 75 rows or 1 MB) without saying so, so the read is complete only when it holds every row the shell counts.
   */
  async firstAsk(id: string): Promise<FirstAsk | null> {
    this.requireVisible(id);
    const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
    this.requireVisible(id);
    const first = firstMessage(p);
    return first ? firstAsk(first.text, first.createdAt, this.whole(id, p)) : null;
  }

  async markRead(itemId: string, watermark: string, idempotencyKey: string): Promise<Receipt | "unsupported"> {
    if (!this.itemVisible(itemId)) return { ok: false, error: "That thread is outside 10 & 2's visible projects." };
    // Until a snapshot has come, it isn't known whether this T3 tracks visits: try again later.
    if (!this.loaded || !this.client) return { ok: false, error: "T3 is not connected right now." };
    if (!this.visits) return "unsupported";
    // T3 keeps the later of this and what it has, so a retry or a stale watermark never marks a thread unread.
    return this.dispatch({ type: "thread.visit", commandId: idempotencyKey, threadId: itemId, visitedAt: watermark });
  }

  places(): Place[] {
    if (!this.loaded || (this.opts.policy && !allows(this.opts.policy, "start_work", "t3"))) return [];
    const active = new Map<string, string>();
    for (const t of this.threads.values()) {
      if (t.archivedAt || t.deletedAt) continue;
      if ((active.get(t.projectId) ?? "") < t.updatedAt) active.set(t.projectId, t.updatedAt);
    }
    return [...this.projectInfo.values()].filter((p) => this.projectVisible(p.id)).map((p) => ({
      id: p.id, name: p.title, activeAt: active.get(p.id) ?? null,
      // Other names the user may say for it, and what tells two of one name apart (brain/src/places.ts).
      ...(p.workspaceRoot ? { folder: folderOf(p.workspaceRoot) } : {}), ...(p.repositoryIdentity?.name ? { repo: p.repositoryIdentity.name } : {}),
      models: (this.catalogs.get(p.id) ?? []).map((o) => o.model),
    }));
  }

  /** The model new work in a project runs on (`newThreadModel`), by T3's settings when they're given. */
  modelFor(projectId: string, settings: T3Settings | null = null): unknown {
    return newThreadModel(projectId, this.projectInfo.get(projectId), this.threads.values(), settings);
  }

  /**
   * T3's settings and providers (`server.getConfig`), kept as the last good read, with each project's models from them;
   * null when T3 gives no settings. Read at connect, every 10 minutes and at each launch: they change in T3's own
   * settings. Throws when T3 doesn't answer.
   */
  private async readConfig(): Promise<T3Config | null> {
    const c = await this.rpc().request<{ settings?: T3Settings; providers?: T3Provider[] } | null>(M.getConfig, {}, SETTINGS_MS);
    if (!c?.settings || typeof c.settings !== "object") return null;
    this.config = { settings: c.settings, providers: Array.isArray(c.providers) ? c.providers : [] };
    this.recatalog();
    return this.config;
  }

  /** A read of T3's config for the models it offers, away from a launch. A failure keeps the last good one. */
  private async refreshConfig() {
    if (this.closed || this.revoked || !this.client) return;
    try {
      await this.readConfig();
      this.configFailing = false;
    } catch (e) {
      if (!this.configFailing && !this.closed) this.opts.log(`t3: couldn't read T3's settings (${describe(e)}); offering the models it gave last`);
      this.configFailing = true;
    }
  }

  /** Each visible project's models from the last config read; the brain is told to read again when any changed. */
  private recatalog() {
    const config = this.config;
    if (!config) return;
    const next = new Map<string, Offer[]>();
    this.firsts.clear();
    // First the instance a start with no model would use, its newest thread's when T3 has no default: of a name on
    // several, that's the one the brain takes when no provider is said.
    for (const id of this.projectInfo.keys()) {
      if (!this.projectVisible(id)) continue;
      const plain = this.modelFor(id, config.settings);
      this.firsts.set(id, instanceOf(plain));
      next.set(id, offeredModels(id, config, plain));
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.catalogs]);
    this.catalogs = next;
    if (changed && this.loaded) for (const l of this.listeners) l([], false);
  }

  private projectVisible(id: string): boolean {
    const p = this.projectInfo.get(id);
    return !!p && (!this.opts.visible || (!!p.workspaceRoot && this.opts.visible(p.workspaceRoot)));
  }

  private itemVisible(id: string): boolean {
    const t = this.threads.get(id);
    return !!t && this.projectVisible(t.projectId);
  }

  private requireVisible(id: string) {
    if (!this.itemVisible(id)) throw new Error("That thread is outside 10 & 2's visible projects.");
  }

  async check(action: Action): Promise<string | null> {
    const allowed = action.kind === "start_work" ? this.projectVisible(action.placeId) : this.itemVisible(action.itemId);
    if (!allowed) return "That project is outside 10 & 2's visible projects, or is no longer in T3.";
    // A held command: words that would let it run are refused (only the release path can), as is a tap on an earlier
    // one; any other words stop it (`execute`).
    const gate = action.kind === "follow_up" ? this.gates.get(action.itemId) : undefined;
    if (gate && action.kind === "follow_up") return gateRefusal(gate, action);
    const policy = this.opts.policy;
    if (!policy) return null;
    if (!allows(policy, action.kind, "t3")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") return withinCeiling(policy, action.profile, "t3") ? null : "That launch profile exceeds this machine's permission ceiling.";
    return action.kind === "follow_up" ? this.followUpRefusal(action.itemId, policy) : null;
  }
  /**
   * What T3's own narrowing refuses a follow-up now: answering its question, or one sent to a thread that's running,
   * which queues behind the run (T3's steering). A permission it's waiting on is refused when it's sent (`execute`).
   */
  private followUpRefusal(id: string, policy: Policy): string | null {
    const t = this.threads.get(id);
    if (!t) return null;
    if (t.pendingRuntimeRequest?.kind === "user_input") return answers(policy, "t3") ? null : NO_ANSWERS;
    if (!t.pendingRuntimeRequest && mapStatus(t) === "running") return steers(policy, "t3") ? null : NO_STEERING;
    return null;
  }
  /** Follow-ups T3's own narrowing would refuse right now, per visible thread; checked again on execute. */
  refusals(): Record<string, { follow_up?: string }> {
    const policy = this.opts.policy;
    if (!this.loaded || !policy || !allows(policy, "follow_up", "t3")) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const t of this.threads.values()) {
      if (t.archivedAt || t.deletedAt || !this.projectVisible(t.projectId)) continue;
      const why = this.followUpRefusal(t.id, policy);
      if (why) out[t.id] = { follow_up: why };
    }
    return out;
  }

  async execute(action: Action, idempotencyKey: string): Promise<Receipt> {
    if (this.revoked) return { ok: false, error: "10 & 2's access to T3 was revoked." };
    const reason = await this.check(action);
    if (reason) return { ok: false, error: reason };
    if (action.kind === "start_work") return this.launch(action, idempotencyKey);
    // A held command's thread: the words stop it, and the agent is told them. Never a T3 command (the hook is Claude Code's).
    if (action.kind === "follow_up" && this.gates.has(action.itemId)) return this.stopHeld(action.itemId, action.message, idempotencyKey);
    // A follow-up queued behind a question would wait for an answer that never comes: it answers the question instead.
    // A retry reuses the key, and T3 never runs a command id twice, whichever command it was.
    const pending = action.kind === "follow_up" ? this.threads.get(action.itemId)?.pendingRuntimeRequest : null;
    // An answer to one question (a tap) answers that request only: T3 may have moved on since Local looked.
    if (action.kind === "follow_up" && action.questionId !== undefined && pending?.id !== action.questionId) return { ok: false, error: ANSWERED };
    if (action.kind === "follow_up" && pending?.kind === "user_input") return this.answer(action.itemId, pending.id, action.message, idempotencyKey);
    // Driver never gives a permission (release.md): a follow-up would only queue behind it, so the user hears where to answer.
    if (action.kind === "follow_up" && pending) return { ok: false, error: "It's waiting for your OK in T3 Code. 10 & 2 doesn't give that; answer it in T3 Code." };
    return this.dispatch(toCommand(action, idempotencyKey));
  }

  /** Stops a held command with the user's words (gate.ts `gateSaid`); the same key again gets the first receipt. */
  private readonly stopped = new Map<string, Receipt>();
  private async stopHeld(threadId: string, words: string, key: string): Promise<Receipt> {
    const earlier = this.stopped.get(key);
    if (earlier) return earlier;
    const receipt: Receipt = (await this.gates.stopWith(threadId, words)) ? { ok: true } : { ok: false, unknown: true, error: "That command may have been answered at the computer already. 10 & 2 won't send it again." };
    this.stopped.set(key, receipt);
    if (this.stopped.size > 100) this.stopped.delete(this.stopped.keys().next().value!);
    return receipt;
  }

  /**
   * Answers a held command from the release path (`answer_hold`): only that hold, while it's held. Let it run only where
   * this computer lets 10 & 2 answer T3 Code (Stop it always: it lets nothing run).
   */
  async answerHold(threadId: string, questionId: string, run: boolean): Promise<Receipt> {
    if (!this.itemVisible(threadId)) return { ok: false, error: "That thread is outside 10 & 2's visible projects." };
    if (run && this.opts.policy && !answers(this.opts.policy, "t3")) return { ok: false, error: NOT_ANSWERING };
    return this.gates.answer(threadId, questionId, run);
  }

  /**
   * Holds a command on this computer's list of a Claude Code session if it's one of T3's Claude threads, in a project
   * 10 & 2 sees (the Claude adapter's `claimGate`): the thread then holds it until the phone's answer or a stop. False
   * when it isn't one: the Claude adapter decides. T3 says which Claude session each thread runs in its projection
   * (`providerThreads[].nativeThreadRef`); only threads with a run going are looked at, since the hook holds one.
   */
  async claimGate(session: string, socket: Socket, command: string, matched: string): Promise<boolean> {
    const threadId = await this.threadOf(session);
    if (!threadId || this.closed) return false;
    // A computer that doesn't let 10 & 2 answer T3 Code: stopped at once, as the Claude adapter stops its own.
    if (this.opts.policy && !answers(this.opts.policy, "t3")) { stopGate(socket, GATE_NOT_ALLOWED); return true; }
    if (!this.gates.hold(threadId, socket, command, matched, this.threads.get(threadId)?.title ?? "")) stopGate(socket, GATE_ONE_AT_A_TIME);
    return true;
  }

  private async threadOf(session: string): Promise<string | null> {
    const known = this.claudeSessions.get(session);
    if (known && this.itemVisible(known)) return known;
    if (!this.client || !this.loaded) return null;
    const working = [...this.threads.values()]
      .filter((t) => !t.archivedAt && !t.deletedAt && this.projectVisible(t.projectId) && (t.activityRunStatus || ACTIVE.has(t.status)))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 20);
    for (const t of working) {
      const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: t.id }).catch(() => null);
      for (const pt of p?.providerThreads ?? []) {
        const native = pt?.nativeThreadRef?.nativeId;
        if (pt?.driver === "claudeAgent" && typeof native === "string") this.claudeSessions.set(native, t.id);
      }
      if (this.claudeSessions.get(session) === t.id) return t.id;
    }
    return null;
  }

  private async launch(action: Extract<Action, { kind: "start_work" }>, commandId: string): Promise<Receipt> {
    if (this.revoked) return { ok: false, error: "10 & 2's access to T3 was revoked." };
    if (!this.client || !this.loaded) return { ok: false, error: "T3 is not connected right now." };
    if (!this.projectInfo.has(action.placeId)) return { ok: false, error: "That project is no longer in T3." };
    let config: T3Config | null = null;
    try { config = await this.readConfig(); } catch (e) {
      this.opts.log(`t3: couldn't read T3's settings (${describe(e)}); ${action.model === undefined ? "starting new work on the project's own model" : "not starting on a model it may not offer"}`);
    }
    const settings = config?.settings ?? null;
    // T3 may have gone, or dropped the project, while its settings were read (or the worktree's start was found):
    // nothing has been sent yet.
    const gone = (): Receipt | null => this.revoked ? { ok: false, error: "10 & 2's access to T3 was revoked." }
      : !this.client ? { ok: false, error: "T3 is not connected right now." }
      : !this.projectInfo.has(action.placeId) ? { ok: false, error: "That project is no longer in T3." } : null;
    const stopped = gone();
    if (stopped) return stopped;
    let model = this.modelFor(action.placeId, settings);
    if (action.model !== undefined) {
      // T3 takes any model on a launch and fails later, so the one asked for is checked against what T3 offers now.
      if (!config) return { ok: false, error: "T3 Code didn't say which models it offers just now. Try again in a moment." };
      const offer = offeredModels(action.placeId, config, null).find((o) => o.model.id === action.model);
      if (!offer) return { ok: false, error: "T3 Code doesn't offer that model for this project now." };
      // On a provider without the profile's mode, T3 quietly runs it asking first, and 10 & 2 never gives an OK.
      const modes = config.providers.find((p) => p.instanceId === offer.instanceId)?.supportedRuntimeModes;
      if (Array.isArray(modes) && !modes.includes(action.profile.runtimeMode)) return { ok: false, error: "In T3 Code that model would ask for your OK at each step, which 10 & 2 can't give. Choose another model." };
      // T3's own rule (pickModelSelection): the default again keeps its options; another model starts without any.
      model = instanceOf(model) === offer.instanceId && slugOf(model) === offer.slug ? model : { instanceId: offer.instanceId, model: offer.slug };
    } else if (!model) {
      return { ok: false, error: settings
        ? "T3 has no model to start it with here: no default model, or only one on a provider that's switched off. Choose a default model in T3's settings."
        : "T3 has no model to start it with: the project has no default model and no threads." };
    }
    const root = this.projectInfo.get(action.placeId)!.workspaceRoot;
    const base = action.profile.workspace === "worktree" && root ? await worktreeStart(root, this.opts.worktreeBase ?? "HEAD") : "HEAD";
    const lost = gone();
    if (lost) return lost;
    const client = this.client!;
    let threadId: string;
    try {
      const r = await client.request<{ threadId: string }>(M.launchThread, toLaunch(action, commandId, model, base));
      threadId = r.threadId;
    } catch (e) {
      if (e instanceof ConnectionError) return { ok: false, error: e.message, unknown: true };
      return { ok: false, error: e instanceof RpcError ? e.message : String(e) };
    }
    // Started either way; waiting only lets the thread be named at once rather than after the next shell event.
    if (!this.threads.has(threadId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => (this.arrivals.delete(threadId), resolve()), LAUNCH_SEEN_MS);
        this.arrivals.set(threadId, () => (clearTimeout(timer), resolve()));
      });
    }
    return { ok: true, itemId: threadId };
  }
  private async answer(threadId: string, requestId: string, message: string, commandId: string): Promise<Receipt> {
    let questions: Question[];
    try {
      const p = await this.rpc().request<any>(M.getThreadProjection, { threadId });
      questions = (p.turnItems ?? []).find((i: any) => i.type === "user_input_request" && i.requestId === requestId)?.questions ?? [];
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const answers = answersFor(questions, message);
    if ("error" in answers) return { ok: false, error: answers.error };
    return this.dispatch({ type: "runtime-request.respond", commandId, threadId, requestId, answers });
  }

  private async dispatch(command: Record<string, unknown>): Promise<Receipt> {
    if (this.revoked) return { ok: false, error: "10 & 2's access to T3 was revoked." };
    if (!this.client) return { ok: false, error: "T3 is not connected right now." };
    try {
      await this.client.request(M.dispatchCommand, command);
      return { ok: true };
    } catch (e) {
      if (e instanceof ConnectionError) return { ok: false, error: e.message, unknown: true };
      return { ok: false, error: e instanceof RpcError ? e.message : String(e) };
    }
  }

  watch(onChange: (ids: string[], urgent: boolean) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.gates.close();
    if (this.authCheck) clearInterval(this.authCheck);
    if (this.configCheck) clearInterval(this.configCheck);
    this.stopStream?.();
    this.client?.close();
    if (this.session) await this.auth.revoke(this.session.sessionId).catch(() => {});
    this.session = null;
  }

  private rpc(): RpcClient {
    if (!this.client) throw new Error("T3 is not connected");
    return this.client;
  }

  /** The session's token, renewed in its last hour: once for every caller at a time (whole reads come in parallel). */
  private token(): Promise<string> {
    if (this.revoked || this.closed) return Promise.reject(new Error(this.revoked ? "revoked" : "closed"));
    const s = this.session;
    if (s && Date.parse(s.expiresAt) - Date.now() > 3600_000) return Promise.resolve(s.token);
    this.renewing ??= (async () => {
      const next = await this.auth.issue();
      if (s) await this.auth.revoke(s.sessionId).catch(() => {});
      // Closed or revoked meanwhile: nothing would revoke it later.
      if (this.closed || this.revoked) {
        await this.auth.revoke(next.sessionId).catch(() => {});
        throw new Error(this.revoked ? "revoked" : "closed");
      }
      this.session = next;
      return next.token;
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  private async connect(): Promise<void> {
    while (!this.closed && !this.revoked) {
      try {
        let client: RpcClient;
        try {
          // A T3 that restarted may be on another port: where it is now is read again each time.
          const token = await this.token();
          this.base = this.opts.baseUrl ?? t3Origin(this.opts.t3Home);
          client = await RpcClient.connect(this.base, token);
        } catch (e) {
          // token() renews before expiry, so a 401 here means someone revoked the session.
          if (e instanceof RpcError && e.tag === "Unauthorized") return this.onRevoked();
          throw e;
        }
        this.live = false;
        this.client = client;
        this.retryMs = 1000;
        client.onClose((err) => {
          if (this.closed || this.client !== client) return;
          this.opts.log(`t3: connection lost (${err.message}); reconnecting`);
          this.live = false;
          this.client = null;
          setTimeout(() => void this.connect(), this.retryMs);
          this.retryMs = Math.min(this.retryMs * 2, 30_000);
        });
        this.stopStream = client.stream(M.subscribeShell, {}, (v) => this.onShell(v), (err) => {
          // A stream that ends while the socket stays open would freeze the briefing: reconnect.
          if (this.closed || this.client !== client) return;
          this.opts.log(`t3: shell stream ended${err ? `: ${err.message}` : ""}; reconnecting`);
          this.live = false;
          client.close();
        });
        return;
      } catch (e) {
        this.opts.log(`t3: connect failed (${describe(e)}); retrying in ${this.retryMs / 1000}s`);
        await new Promise((r) => setTimeout(r, this.retryMs));
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
      }
    }
  }

  private onShell(v: any) {
    const now = Date.now();
    if (v?.kind === "snapshot") {
      const snap = v.snapshot;
      for (const p of (snap.projects ?? []) as Project[]) this.setProject(p);
      // Later snapshot frames refresh projects only and carry no threads; only a frame with
      // threads replaces the thread list. The first frame always counts, even empty: a machine
      // with no threads yet is still loaded.
      if ((snap.threads ?? []).length === 0 && this.live) return this.recatalog();
      const connecting = !this.live;
      const changed: string[] = [];
      const seen = new Set<string>();
      for (const t of snap.threads as ShellThread[]) {
        if ("lastVisitedAt" in t) this.visits = true;
        seen.add(t.id);
        this.threads.set(t.id, t);
        this.arrived(t.id);
      }
      for (const id of [...this.threads.keys()]) {
        if (!seen.has(id)) {
          this.threads.delete(id);
          this.keys.delete(id);
          changed.push(id);
        }
      }
      const running = this.runningSubagents();
      for (const t of snap.threads as ShellThread[]) {
        const key = digestKey(t, now, running.has(t.id));
        if (this.keys.get(t.id) !== key) changed.push(t.id);
        this.keys.set(t.id, key);
      }
      this.loaded = true;
      this.live = true;
      this.markReady();
      if (changed.length) this.emit(changed, false);
      // Once the shell has loaded on a connection, what each project offers (and, until then, what it last did).
      this.recatalog();
      if (connecting) void this.refreshConfig();
      return;
    }
    if (v?.kind === "project.updated" && v.project) { this.setProject(v.project); return this.recatalog(); }
    if (v?.kind === "project.removed" && v.projectId) {
      this.projectInfo.delete(v.projectId);
      this.emit([...this.threads.values()].filter((t) => t.projectId === v.projectId).map((t) => t.id), false);
      return;
    }
    if (v?.kind === "thread.removed" && v.threadId) {
      const removed = this.threads.get(v.threadId);
      const project = removed?.projectId;
      if (this.threads.delete(v.threadId)) {
        if (project) this.followNewest(project);
        this.keys.delete(v.threadId);
        this.tested.forget(v.threadId);
        const affected = [v.threadId, ...this.refreshLegacyAncestors(removed, now)];
        this.emit(affected, false);
      }
      return;
    }
    if (v?.kind === "thread.updated" && v.thread) {
      const t = v.thread as ShellThread;
      if ("lastVisitedAt" in t) this.visits = true;
      const before = this.threads.get(t.id);
      if (v.location && v.location !== "active") t.archivedAt ??= new Date(now).toISOString();
      this.threads.set(t.id, t);
      this.followNewest(t.projectId);
      this.arrived(t.id);
      const running = this.runningSubagents();
      const key = t.archivedAt || t.deletedAt ? "gone" : digestKey(t, now, running.has(t.id));
      if (key === "gone") this.tested.forget(t.id);
      const changed: string[] = [];
      if (this.keys.get(t.id) !== key) {
        this.keys.set(t.id, key);
        changed.push(t.id);
      }
      changed.push(...this.refreshLegacyAncestors(t, now, running));
      if (!changed.length) return;
      this.emit(changed, Boolean(t.pendingRuntimeRequest) && !before?.pendingRuntimeRequest);
    }
  }

  /** Re-keys ancestors without `pendingBackgroundTasks` when a subagent updates or disappears. */
  private refreshLegacyAncestors(t: ShellThread | undefined, now: number, running?: Map<string, ShellThread[]>): string[] {
    if (!t || t.lineage?.relationshipToParent !== "subagent" || !t.lineage.parentThreadId) return [];
    const active = running ?? this.runningSubagents();
    const changed: string[] = [];
    const seen = new Set<string>([t.id]);
    let pid: string | null | undefined = t.lineage.parentThreadId;
    for (let depth = 0; depth < 20 && pid && !seen.has(pid); depth++) {
      seen.add(pid);
      const parent = this.threads.get(pid);
      if (!parent) break;
      if (parent.pendingBackgroundTasks === undefined && !parent.archivedAt && !parent.deletedAt) {
        const key = digestKey(parent, now, active.has(parent.id));
        if (this.keys.get(parent.id) !== key) {
          this.keys.set(parent.id, key);
          changed.push(parent.id);
        }
      }
      pid = parent.lineage?.relationshipToParent === "subagent" ? parent.lineage.parentThreadId : null;
    }
    return changed;
  }

  /**
   * With no default in T3's settings a start with no model runs on the project's newest thread's: when a thread used on
   * another instance makes that change, the project's models are listed again, that instance first, so the brain's
   * "Opus" (no provider said) is the one a plain start would use, not one up to 10 minutes old.
   */
  private followNewest(projectId: string) {
    if (!this.config || !this.firsts.has(projectId)) return;
    if (instanceOf(this.modelFor(projectId, this.config.settings)) !== this.firsts.get(projectId)) this.recatalog();
  }

  private arrived(id: string) {
    this.arrivals.get(id)?.();
    this.arrivals.delete(id);
    this.wroteMoved(id);
  }

  /**
   * T3's last user write moved, or a thread is first seen with one in the last `WROTE_CHECK_MS`: the thread is read, one
   * at a time, for what a person typed (`personWrites`), and reported again once known.
   */
  private wroteMoved(id: string) {
    const raw = this.threads.get(id)?.latestUserAuthoredMessageAt ?? null;
    const had = this.wrote.get(id);
    if ((had && had.raw === raw) || this.reading.has(id) || !this.itemVisible(id)) return;
    if (!raw) return void this.wrote.set(id, { raw, writes: had?.writes ?? [] });
    if (!had && Date.now() - Date.parse(raw) > WROTE_CHECK_MS) return void this.wrote.set(id, { raw, writes: [] });
    this.reading.add(id);
    this.reads = this.reads.then(async () => {
      try {
        const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
        this.wrote.set(id, { raw, writes: personWrites(p.messages ?? []) });
      } catch (e) {
        this.opts.log(`t3: couldn't read who last wrote in a thread (${describe(e)}); trying again at its next change`);
      } finally {
        this.reading.delete(id);
      }
      if (this.wrote.get(id)?.raw === raw) this.emit([id], false);
      // Moved again while it was read.
      if ((this.threads.get(id)?.latestUserAuthoredMessageAt ?? null) !== raw) this.wroteMoved(id);
    });
  }

  private setProject(p: Project) {
    this.projects.set(p.id, p.title);
    this.projectInfo.set(p.id, { id: p.id, title: p.title, defaultModelSelection: p.defaultModelSelection ?? null, workspaceRoot: p.workspaceRoot, repositoryIdentity: p.repositoryIdentity ?? null });
    if (this.loaded && this.opts.visible) this.emit([...this.threads.values()].filter((t) => t.projectId === p.id).map((t) => t.id), false);
  }

  private emit(ids: string[], urgent: boolean) {
    // A held command of a thread no longer shown (archived, removed, its project hidden) is stopped: nobody can answer it.
    for (const id of ids) if (this.gates.has(id) && !this.itemVisible(id)) this.gates.drop(id, GATE_NOT_SHOWN);
    const visible = ids.filter((id) => this.exposed.has(id) || this.itemVisible(id));
    for (const id of visible) {
      if (this.itemVisible(id)) this.exposed.add(id);
      else this.exposed.delete(id);
    }
    if (visible.length) for (const l of this.listeners) l(visible, urgent);
  }
}
