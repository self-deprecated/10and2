// The brain rings the phone (docs/launch/ring.md): a wait the user asked for ("call me back when it's done") is over
// with a real reply or question, and no phone is holding for it (the app was closed, or iOS ended it). The phone shows
// an incoming call (a VoIP push, CallKit); answering starts the call-back as a holding phone would. Declining costs
// nothing: the news is told at the next Start, as before.
import type { Track } from "./analytics.ts";
import type { Store } from "./store.ts";
import { describe, realClock, type Clock, type Timer } from "./util.ts";
import type { Wait, Waits } from "./waits.ts";

/** The phone's VoIP push token, and which of Apple's push services it's for (a development build's is the sandbox). */
export type Phone = { token: string; env: "sandbox" | "production"; at: number };

/** What one push asks the phone to show and start. */
export type Push = { caller: string; conversationId: string };

/** `gone`: Apple says the token is no longer the app's (uninstalled, or another build), so it's forgotten. */
export type RingSend = (phone: Phone, push: Push) => Promise<"sent" | "gone" | "failed">;

/**
 * How long a wait that's over is left for a holding phone to take before the brain rings: a holding phone's long poll
 * ends the moment the wait is over, and it asks again straight away, so a phone that hasn't asked in this long isn't
 * holding.
 */
export const RING_GRACE_MS = 6_000;

/** Whether a wait that's over rings: one the user asked for (not starred threads at a goodbye), with a reply or a question seen. */
export function rings(w: Wait): boolean {
  return !!w.ready && !w.auto && !w.rungAt && w.replies.some((r) => (r.outcome === "finished" || r.outcome === "question") && !r.gone);
}

/**
 * Whether a wait outlives the user's Stop (End on hold or in a call): one they asked for, while a phone can be rung
 * (Jordan, 14 November: "call back without me being on hold"). Starred threads at a goodbye are still called off, and
 * without a phone to ring, a Stop calls everything off as before. Declining the ring calls it off.
 */
export function keepsThroughStop(ringer: Ringer | undefined): (w: Wait) => boolean {
  return ringer?.canRing() ? (w) => !w.auto : () => false;
}

/** What the incoming call shows as the caller: the thread, and whether it replied or asks something. */
export function callerOf(w: Wait): string {
  const news = w.replies.filter((r) => (r.outcome === "finished" || r.outcome === "question") && !r.gone);
  if (news.length > 1) return `${news.length} threads replied`;
  const r = news[0] ?? w.replies[0];
  return r.outcome === "question" ? `${r.handle} asks something` : `${r.handle} replied`;
}

const PHONE_KEY = "ring_phone";

export class Ringer {
  private readonly waits: Waits;
  private readonly store: Store;
  private readonly send: RingSend | null;
  private readonly log: (m: string) => void;
  private readonly track: Track;
  private readonly clock: Clock;
  /** Long polls (`/api/wait`) in flight, per conversation, and when the last one ended. */
  private readonly asking = new Map<string, number>();
  private readonly asked = new Map<string, number>();
  private timer: Timer | null = null;
  private ticking: Promise<void> | null = null;

  /** Without `send` (a brain with no push key), a phone can register but nothing rings. */
  constructor(deps: { waits: Waits; store: Store; send?: RingSend; log: (m: string) => void; track?: Track; clock?: Clock }) {
    this.waits = deps.waits;
    this.store = deps.store;
    this.send = deps.send ?? null;
    this.log = deps.log;
    this.track = deps.track ?? (() => {});
    this.clock = deps.clock ?? realClock;
    deps.waits.onChange(() => this.soon());
  }

  phone(): Phone | null {
    try {
      const p = JSON.parse(this.store.get(PHONE_KEY) ?? "null");
      return p && typeof p.token === "string" && (p.env === "sandbox" || p.env === "production") ? p : null;
    } catch {
      return null;
    }
  }

  /** Whether a wait that's over would ring now: this brain can push, and a phone registered. */
  canRing(): boolean {
    return !!this.send && !!this.phone();
  }

  /** The phone that rings, replacing any other: one per account for now (the one signed in last). */
  register(token: string, env: "sandbox" | "production") {
    const had = this.phone();
    if (had?.token === token && had.env === env) return;
    this.store.set(PHONE_KEY, JSON.stringify({ token, env, at: this.clock.now() } satisfies Phone));
    this.log(`ring: a phone can be rung (${env}, ${token.slice(0, 8)}…)`);
  }

  /** Signed out, or the phone turned ringing off: nothing rings until a phone registers again. */
  forget(token?: string) {
    const had = this.phone();
    if (!had || (token && had.token !== token)) return;
    this.store.set(PHONE_KEY, "null");
    this.log("ring: no phone to ring");
  }

  /** A phone holding for `conversationId` is asking (`/api/wait`); call the result when its ask ends. */
  holding(conversationId: string): () => void {
    this.asking.set(conversationId, (this.asking.get(conversationId) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.asking.get(conversationId) ?? 1) - 1;
      if (n > 0) this.asking.set(conversationId, n);
      else this.asking.delete(conversationId);
      this.asked.set(conversationId, this.clock.now());
      this.soon();
    };
  }

  /** When a wait that's over may ring, if one is waiting for its grace to pass: for the cloud's alarm. */
  due(now = this.clock.now()): number | null {
    if (!this.send || !this.phone()) return null;
    // A conversation a phone is asking about is left out: the ask's end looks again (`holding`).
    const times = this.waits.all().filter((w) => rings(w) && !this.asking.has(w.conversationId)).map((w) => Math.max((w.readyAt ?? now) + RING_GRACE_MS, (this.asked.get(w.conversationId) ?? 0) + RING_GRACE_MS));
    return times.length ? Math.max(now, Math.min(...times)) : null;
  }

  /** Rings for every wait that's over, rings, and that no phone took within the grace. One ring at a time. */
  tick(now = this.clock.now()): Promise<void> {
    return (this.ticking ??= this.ring(now).finally(() => (this.ticking = null)));
  }

  private async ring(now: number) {
    const phone = this.phone();
    if (!this.send || !phone) return;
    for (const w of this.waits.all()) {
      if (!rings(w) || this.asking.has(w.conversationId)) continue;
      if (now - (w.readyAt ?? now) < RING_GRACE_MS || now - (this.asked.get(w.conversationId) ?? 0) < RING_GRACE_MS) continue;
      w.rungAt = now;
      this.waits.save(w);
      const caller = callerOf(w);
      const result = await this.send(phone, { caller, conversationId: w.conversationId }).catch((e) => {
        this.log(`ring: couldn't ring (${describe(e)})`);
        return "failed" as const;
      });
      this.log(`ring ${w.conversationId}: ${caller}: ${result}`);
      this.track("ring_sent", { conversation_id: w.conversationId, result, env: phone.env, wait_s: Math.round((now - w.startedAt) / 1000) });
      if (result === "gone") this.forget(phone.token);
    }
  }

  /** Looks again once the grace has passed, while the brain is awake; the cloud's alarm covers a brain that sleeps. */
  private soon() {
    if (this.timer || !this.send) return;
    const at = this.due();
    if (at === null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.tick().then(() => this.soon());
    }, at - this.clock.now() + 50);
    this.timer.unref();
  }
}
