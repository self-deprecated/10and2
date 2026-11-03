// Test doubles shared by the unit tests.
import type { Action, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "../src/contract.ts";
const targetOf = (a: Action) => a.kind === "start_work" ? a.placeId : a.itemId;

export function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Thread ${id}`,
    group: "proj",
    status: "completed",
    updatedAt: "2026-10-16T08:00:00Z",
    settled: false,
    snoozedUntil: null,
    parentId: null,
    pendingQuestion: false,
    ...over,
  };
}

export class FakeAdapter implements Adapter {
  readonly name: string = "fake";
  actions: Adapter["actions"] = ["follow_up", "settle", "snooze", "archive", "start_work"];
  items: WorkItem[];
  reports = new Map<string, Report>();
  executed: { action: Action; key: string }[] = [];
  failFor = new Set<string>();
  /** Items whose command gets lost with the connection (outcome unknown). */
  unknownFor = new Set<string>();
  live = true;
  disconnected = new Set<string>();
  reportFailures = new Set<string>();
  connected(id?: string) { return this.live && (id === undefined || !this.disconnected.has(id)); }
  delayMs = 0;
  reportCalls = 0;
  private listeners: ((ids: string[], urgent: boolean) => void)[] = [];

  constructor(items: WorkItem[]) {
    this.items = items;
  }
  async list() {
    return this.items.map((i) => ({ ...i }));
  }
  async report(id: string) {
    this.reportCalls++;
    if (this.reportFailures.has(id)) throw new Error("report unavailable");
    return this.reports.get(id) ?? { text: `Report for ${id}.`, question: null };
  }
  /** Each item's earlier replies, newest first; by default just its report's reply. */
  past = new Map<string, PastReply[]>();
  async replies(id: string): Promise<PastReply[]> {
    const rep = await this.report(id);
    return this.past.get(id) ?? (rep.reply ? [{ ...rep.reply, text: rep.text, prompt: null }] : []);
  }
  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.executed.push({ action, key });
    if (this.unknownFor.has(targetOf(action))) return { ok: false, error: "T3 socket closed (1006)", unknown: true };
    if (this.failFor.has(targetOf(action))) return { ok: false, error: "disk is full" };
    if (action.kind === "start_work") {
      // Like T3: the same key launches once, and a retry gets the same thread back.
      const id = this.launched.get(key) ?? `new-${this.launched.size + 1}`;
      if (!this.launched.has(key)) {
        this.launched.set(key, id);
        this.items.push(item(id, { title: action.title, group: this.places().find((p) => p.id === action.placeId)?.name ?? "proj", status: "running" }));
      }
      return { ok: true, itemId: id };
    }
    return { ok: true };
  }
  /** Where work can start; by default one project, "proj". */
  placeList: Place[] = [{ id: "p-proj", name: "proj", activeAt: null }];
  launched = new Map<string, string>();
  places() {
    return this.live ? this.placeList : [];
  }
  visits: { itemId: string; watermark: string; key: string }[] = [];
  visitResult: Receipt | "unsupported" = { ok: true };
  async markRead(itemId: string, watermark: string, key: string): Promise<Receipt | "unsupported"> {
    this.visits.push({ itemId, watermark, key });
    return this.visitResult;
  }
  watch(l: (ids: string[], urgent: boolean) => void) {
    this.listeners.push(l);
    return () => {};
  }
  emit(ids: string[], urgent = false) {
    for (const l of this.listeners) l(ids, urgent);
  }
  async close() {}
}

