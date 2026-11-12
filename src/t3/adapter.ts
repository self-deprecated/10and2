// T3 Code as a work system: threads are items, projects are groups and the places new work starts. Reads come from
// the live shell stream; writes are exactly four thread commands, answering a thread's question (a follow-up to a
// thread that asked one), launching a thread, and marking a thread read, and nothing else (the connector's allowlist:
// `orchestration:operate` would also allow provider logins, installs, project changes and more).
import type { Action, Adapter, ItemStatus, LaunchProfile, PastReply, Place, Receipt, ReplyRef, Report, WorkItem } from "../contract.ts";
import { issueSession, revokeSession, CONNECTOR_SCOPES, type Cli, type T3Session } from "./auth.ts";
import { ConnectionError, RpcClient, RpcError } from "./rpc.ts";
import { execFile } from "node:child_process";
import { describe } from "../util.ts";
import { worktreeStart } from "../work.ts";

const M = {
  subscribeShell: "orchestration.subscribeShell",
  getThreadProjection: "orchestration.getThreadProjection",
  dispatchCommand: "orchestration.dispatchCommand",
  launchThread: "orchestration.launchThread",
} as const;

/** How long a launch waits for its thread to reach the shell stream, so it can be named straight away. */
const LAUNCH_SEEN_MS = 5000;

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
  /** Present (even null) only on servers that track visits (`threadVisitedTracking`). */
  lastVisitedAt?: string | null;
  /** The last message the user wrote in it. */
  latestUserAuthoredMessageAt?: string | null;
  lineage?: { parentThreadId: string | null; relationshipToParent: string | null } | null;
  /** The model the thread runs on, as T3 gives it; passed back unchanged when launching in its project. */
  modelSelection?: unknown;
};
/** The root is used only for the local policy: no path leaves the machine through Driver. */
type Project = { id: string; title: string; defaultModelSelection?: unknown; workspaceRoot?: string; repositoryIdentity?: { name?: string } | null };

/**
 * The end of a checkout's path, as a place's `folder` ("mono/nix" of /home/jmo/Development/mono/nix): enough to tell two
 * projects of one name apart and to say it ("mono nix"), never the whole path. claude/adapter.ts has the same.
 */
export const folderOf = (root: string) => root.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).slice(-2).join("/");

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FINISHED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export function mapStatus(t: ShellThread): ItemStatus {
  if (t.pendingRuntimeRequest) return "waiting";
  // `status` is the latest run's: one queued and cancelled while another still works would read as cancelled.
  if (t.activityRunStatus || ACTIVE.has(t.status)) return "running";
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

export function toWorkItem(t: ShellThread, projects: Map<string, string>, now: number): WorkItem {
  return {
    id: t.id,
    title: t.title,
    group: projects.get(t.projectId) ?? "unknown project",
    status: mapStatus(t),
    updatedAt: t.updatedAt,
    settled: t.settledAt != null && t.settledOverride !== "active",
    snoozedUntil: snoozedUntil(t, now),
    parentId: t.lineage?.relationshipToParent === "subagent" ? (t.lineage.parentThreadId ?? null) : null,
    pendingQuestion: Boolean(t.pendingRuntimeRequest),
    lastRunAt: t.latestRunCompletedAt ?? null,
    questionId: t.pendingRuntimeRequest?.id ?? null,
    visitedAt: t.lastVisitedAt ?? null,
    wroteAt: t.latestUserAuthoredMessageAt ?? null,
  };
}

/** Which reply a message is: its run's end, or (for a message outside any run) when it was last written. */
function replyRef(m: any, runs: any[]): ReplyRef | null {
  const at = (m.runId ? runs.find((r) => r.id === m.runId)?.completedAt : null) ?? m.updatedAt ?? m.createdAt;
  return m.id && at ? { runId: m.runId ?? null, messageId: m.id, at } : null;
}

/** What a change has to touch before the briefing cares (updatedAt and item counts churn constantly). */
function digestKey(t: ShellThread, now: number): string {
  const w = toWorkItem(t, new Map(), now);
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
    const option = q.options?.find((o) => plain(o.label) === plain(message) || (o.value !== undefined && plain(o.value) === plain(message)));
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

type Options = {
  baseUrl: string;
  cli: Cli;
  label: string;
  log: (msg: string) => void;
  /** Defaults to T3's CLI; tests swap in fakes. */
  visible?: (root: string) => boolean;
  /** Where new worktrees start (the policy's `worktreeBase`); "HEAD" when unset. */
  worktreeBase?: string;
  onRevoked?: () => void;
  auth?: { issue(): Promise<T3Session>; revoke(sessionId: string): Promise<void> };
};

export class T3Adapter implements Adapter {
  readonly name = "t3";
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
  private retryMs = 1000;
  /** The server tracks visits: its shell rows carry `lastVisitedAt`. */
  private visits = false;

  private readonly auth: NonNullable<Options["auth"]>;

  constructor(opts: Options) {
    this.opts = opts;
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
  }

  private async checkAuth() {
    const s = this.session;
    if (!s || this.revoked || this.closed) return;
    const res = await fetch(new URL("/api/auth/websocket-ticket", this.opts.baseUrl), { method: "POST", headers: { authorization: `Bearer ${s.token}` } }).catch(() => null);
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
    this.opts.onRevoked?.();
  }

  /** Whether the threads have been read at least once; until then `list` waits. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  connected(): boolean {
    return this.live && this.loaded && this.client !== null && !this.closed && !this.revoked;
  }

  async list(): Promise<WorkItem[]> {
    await this.ready;
    const now = Date.now();
    const items = [...this.threads.values()]
      .filter((t) => !t.archivedAt && !t.deletedAt && this.projectVisible(t.projectId))
      .map((t) => toWorkItem(t, this.projects, now));
    for (const i of items) {
      this.exposed.add(i.id);
      if (i.parentId && !this.itemVisible(i.parentId)) i.parentId = null;
    }
    return items;
  }

  async report(id: string): Promise<Report> {
    this.requireVisible(id);
    const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
    this.requireVisible(id);
    const said = (p.messages ?? []).filter((m: any) => m.role === "assistant" && !m.streaming && m.text?.trim());
    // A run that is still going has only progress notes so far; the reply is the last message of a finished run.
    const unfinished = new Set((p.runs ?? []).filter((r: any) => !FINISHED.has(r.status)).map((r: any) => r.id));
    const done = said.filter((m: any) => !unfinished.has(m.runId));
    const progress = said.filter((m: any) => unfinished.has(m.runId)).at(-1)?.text ?? null;
    const last = done.at(-1);
    const pending = this.threads.get(id)?.pendingRuntimeRequest;
    let question: string | null = null;
    if (pending) {
      const item = (p.turnItems ?? []).find((i: any) => i.type === "user_input_request" && i.requestId === pending.id);
      question = item
        ? item.questions
            .map((q: any) => `${q.question}${q.options?.length ? ` Options: ${q.options.map((o: any) => o.label).join(" / ")}.` : ""}`)
            .join(" ")
        : `A ${pending.kind.replace(/_/g, " ")} is waiting.`;
    }
    return { text: last?.text ?? "", progress, question, reply: last ? replyRef(last, p.runs ?? []) : null };
  }

  async replies(id: string): Promise<PastReply[]> {
    this.requireVisible(id);
    const p = await this.rpc().request<any>(M.getThreadProjection, { threadId: id });
    this.requireVisible(id);
    const messages: any[] = p.messages ?? [];
    const out: PastReply[] = [];
    for (const run of (p.runs ?? []).filter((r: any) => FINISHED.has(r.status))) {
      const said = messages.filter((m) => m.runId === run.id && m.role === "assistant" && !m.streaming && m.text?.trim());
      const last = said.at(-1);
      const ref = last ? replyRef(last, p.runs) : null;
      if (!ref) continue;
      const prompt = (run.userMessageId && messages.find((m) => m.id === run.userMessageId)) || messages.find((m) => m.runId === run.id && m.role === "user");
      out.push({ ...ref, text: last.text, prompt: prompt?.text?.trim() || null });
    }
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
    if (!this.loaded) return [];
    const active = new Map<string, string>();
    for (const t of this.threads.values()) {
      if (t.archivedAt || t.deletedAt) continue;
      if ((active.get(t.projectId) ?? "") < t.updatedAt) active.set(t.projectId, t.updatedAt);
    }
    return [...this.projectInfo.values()].filter((p) => this.projectVisible(p.id)).map((p) => ({
      id: p.id, name: p.title, activeAt: active.get(p.id) ?? null,
      // Other names the user may say for it, and what tells two of one name apart (brain/src/places.ts).
      ...(p.workspaceRoot ? { folder: folderOf(p.workspaceRoot) } : {}), ...(p.repositoryIdentity?.name ? { repo: p.repositoryIdentity.name } : {}),
    }));
  }

  /** The model new work in a project runs on: the project's default, else that of its most recently active thread. */
  modelFor(projectId: string): unknown {
    const project = this.projectInfo.get(projectId);
    if (project?.defaultModelSelection) return project.defaultModelSelection;
    return [...this.threads.values()]
      .filter((t) => t.projectId === projectId && t.modelSelection)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]?.modelSelection ?? null;
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
    return allowed ? null : "That project is outside 10 & 2's visible projects, or is no longer in T3.";
  }

  async execute(action: Action, idempotencyKey: string): Promise<Receipt> {
    if (this.revoked) return { ok: false, error: "10 & 2's access to T3 was revoked." };
    const reason = await this.check(action);
    if (reason) return { ok: false, error: reason };
    if (action.kind === "start_work") return this.launch(action, idempotencyKey);
    // A follow-up queued behind a question would wait for an answer that never comes: it answers the question instead.
    // A retry reuses the key, and T3 never runs a command id twice, whichever command it was.
    const pending = action.kind === "follow_up" ? this.threads.get(action.itemId)?.pendingRuntimeRequest : null;
    if (action.kind === "follow_up" && pending?.kind === "user_input") return this.answer(action.itemId, pending.id, action.message, idempotencyKey);
    return this.dispatch(toCommand(action, idempotencyKey));
  }

  private async launch(action: Extract<Action, { kind: "start_work" }>, commandId: string): Promise<Receipt> {
    if (this.revoked) return { ok: false, error: "10 & 2's access to T3 was revoked." };
    if (!this.client || !this.loaded) return { ok: false, error: "T3 is not connected right now." };
    if (!this.projectInfo.has(action.placeId)) return { ok: false, error: "That project is no longer in T3." };
    const model = this.modelFor(action.placeId);
    if (!model) return { ok: false, error: "T3 has no model to start it with: the project has no default model and no threads." };
    const root = this.projectInfo.get(action.placeId)!.workspaceRoot;
    const base = action.profile.workspace === "worktree" && root ? await worktreeStart(root, this.opts.worktreeBase ?? "HEAD") : "HEAD";
    let threadId: string;
    try {
      const r = await this.client.request<{ threadId: string }>(M.launchThread, toLaunch(action, commandId, model, base));
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
    if (this.authCheck) clearInterval(this.authCheck);
    this.stopStream?.();
    this.client?.close();
    if (this.session) await this.auth.revoke(this.session.sessionId).catch(() => {});
    this.session = null;
  }

  private rpc(): RpcClient {
    if (!this.client) throw new Error("T3 is not connected");
    return this.client;
  }

  private async token(): Promise<string> {
    if (this.revoked) throw new Error("revoked");
    const s = this.session;
    if (s && Date.parse(s.expiresAt) - Date.now() > 3600_000) return s.token;
    const next = await this.auth.issue();
    if (s) await this.auth.revoke(s.sessionId).catch(() => {});
    this.session = next;
    return next.token;
  }

  private async connect(): Promise<void> {
    while (!this.closed && !this.revoked) {
      try {
        let client: RpcClient;
        try {
          client = await RpcClient.connect(this.opts.baseUrl, await this.token());
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
      if ((snap.threads ?? []).length === 0 && this.live) return;
      const changed: string[] = [];
      const seen = new Set<string>();
      for (const t of snap.threads as ShellThread[]) {
        if ("lastVisitedAt" in t) this.visits = true;
        seen.add(t.id);
        this.threads.set(t.id, t);
        this.arrived(t.id);
        const key = digestKey(t, now);
        if (this.keys.get(t.id) !== key) changed.push(t.id);
        this.keys.set(t.id, key);
      }
      for (const id of [...this.threads.keys()]) {
        if (!seen.has(id)) {
          this.threads.delete(id);
          this.keys.delete(id);
          changed.push(id);
        }
      }
      this.loaded = true;
      this.live = true;
      this.markReady();
      if (changed.length) this.emit(changed, false);
      return;
    }
    if (v?.kind === "project.updated" && v.project) return this.setProject(v.project);
    if (v?.kind === "project.removed" && v.projectId) {
      this.projectInfo.delete(v.projectId);
      this.emit([...this.threads.values()].filter((t) => t.projectId === v.projectId).map((t) => t.id), false);
      return;
    }
    if (v?.kind === "thread.removed" && v.threadId) {
      if (this.threads.delete(v.threadId)) {
        this.keys.delete(v.threadId);
        this.emit([v.threadId], false);
      }
      return;
    }
    if (v?.kind === "thread.updated" && v.thread) {
      const t = v.thread as ShellThread;
      if ("lastVisitedAt" in t) this.visits = true;
      const before = this.threads.get(t.id);
      if (v.location && v.location !== "active") t.archivedAt ??= new Date(now).toISOString();
      this.threads.set(t.id, t);
      this.arrived(t.id);
      const key = t.archivedAt || t.deletedAt ? "gone" : digestKey(t, now);
      if (this.keys.get(t.id) === key) return;
      this.keys.set(t.id, key);
      this.emit([t.id], Boolean(t.pendingRuntimeRequest) && !before?.pendingRuntimeRequest);
    }
  }

  private arrived(id: string) {
    this.arrivals.get(id)?.();
    this.arrivals.delete(id);
  }

  private setProject(p: Project) {
    this.projects.set(p.id, p.title);
    this.projectInfo.set(p.id, { id: p.id, title: p.title, defaultModelSelection: p.defaultModelSelection ?? null, workspaceRoot: p.workspaceRoot, repositoryIdentity: p.repositoryIdentity ?? null });
    if (this.loaded && this.opts.visible) this.emit([...this.threads.values()].filter((t) => t.projectId === p.id).map((t) => t.id), false);
  }

  private emit(ids: string[], urgent: boolean) {
    const visible = ids.filter((id) => this.exposed.has(id) || this.itemVisible(id));
    for (const id of visible) {
      if (this.itemVisible(id)) this.exposed.add(id);
      else this.exposed.delete(id);
    }
    if (visible.length) for (const l of this.listeners) l(visible, urgent);
  }
}
