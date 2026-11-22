/** Session endings stay typed until they reach a log, the ledger or a public result. */
export type EndReason =
  | { kind: "goodbye" }
  /** Hold: hung up with the phone listening for the wake word. `handOff`: the `hold` tool, which says nothing more, so the
   * brain hangs up as soon as it has answered (a pause the phrase check heard leaves a moment to talk over it). */
  | { kind: "paused"; handOff?: true }
  | { kind: "waiting"; handle: string }
  /** Hung up so the phone can read a reply out in full (`read_aloud`). */
  | { kind: "reading"; handle: string }
  /** Hung up so the phone can record the user's reply to a thread in their own words (`dictate`). */
  | { kind: "dictating"; handle: string }
  | { kind: "idle" }
  | { kind: "max_duration" }
  /** The session reached its time cap: the phone carries the call on in a new session of the same conversation. */
  | { kind: "rollover" }
  | { kind: "user_stop" }
  | { kind: "replaced" }
  | { kind: "connection_closed" }
  | { kind: "closed"; detail: string }
  | { kind: "shutdown" }
  | { kind: "stopped_before_start" }
  | { kind: "phone_end" }
  | { kind: "restarted" }
  /** The cloud account's credits ran out during the call (contracts §4): Driver said so and goodbye. */
  | { kind: "out_of_credits" }
  /** The anonymous demo drive reached its cap (`capMs`, the cloud's 2 minutes): Driver said so and goodbye. */
  | { kind: "demo_over" }
  /** Staff ended it from 10 & 2 Ops (docs/launch/ops-app.md §3): no call-back, and nothing counts as heard. */
  | { kind: "ended_by_staff" }
  /** The provider refused the backend's tools, so nothing could be done: Driver said so, and the call failed. */
  | { kind: "tools_refused" };

export function reasonText(reason: EndReason): string {
  switch (reason.kind) {
    case "goodbye": return "goodbye";
    case "paused": return "paused";
    case "waiting": return `waiting for ${reason.handle}`;
    case "reading": return `reading ${reason.handle} aloud`;
    // A new thread's prompt is "your new thread (in <project>)" (drafts.ts `newThreadName`).
    case "dictating": return reason.handle.startsWith("your new thread") ? `dictating ${reason.handle.replace(/^your /, "a ")}` : `dictating a reply to ${reason.handle}`;
    case "idle": return "idle";
    case "max_duration": return "max duration";
    case "rollover": return "rolled over to a new session";
    case "ended_by_staff": return "ended by staff";
    case "user_stop": return "stopped by user";
    case "replaced": return "replaced by a new session";
    case "connection_closed": return "connection closed";
    case "closed": return `closed: ${reason.detail}`;
    case "shutdown": return "shutdown";
    case "stopped_before_start": return "stopped before it started";
    case "phone_end": return "ended by the phone";
    case "restarted": return "the brain restarted while it was open";
    case "out_of_credits": return "out of credits";
    case "demo_over": return "the demo's time was up";
    case "tools_refused": return "failed: the backend's tools were refused";
  }
}

/**
 * A hand-off: the call goes on as a mode on the phone (reading a reply, recording one), with nothing more said. The brain
 * hangs up the moment its tool has answered, and tells a phone in the call at once (`GET /api/wait` with `handoff=1`),
 * which closes the call and starts the mode itself (docs/launch/voice-speed.md). A new mode handed to the phone (Hold,
 * say) is one more kind here and one more state in that answer.
 */
export function handsOff(reason: EndReason): boolean {
  return reason.kind === "reading" || reason.kind === "dictating" || (reason.kind === "paused" && reason.handOff === true);
}

/** A pause, or starred threads working when the conversation ends, can arrange a call-back. */
export function holdsAfter(reason: EndReason): boolean {
  return reason.kind === "paused" || reason.kind === "goodbye" || reason.kind === "idle" || reason.kind === "max_duration";
}

/**
 * The call is over with no live session for the phone's stop to end, so its stop, when it comes, ends nothing: the brain
 * ended it itself (the time limit, a dropped connection, the server closing it, a goodbye, idling, the minutes or the
 * demo's time up, staff, the brain shutting down, its tools refused), or the phone's stop came while its session was
 * being made. Not the phone's stop of a live session, which ends the call's proposals itself, nor a rollover, a new
 * session, a hand-off to the phone or a hold, which carry the conversation on (as does a restarted brain taking its live
 * session back).
 */
export function endsCall(kind: string): boolean {
  return ENDS_CALL.has(kind);
}
const ENDS_CALL: ReadonlySet<string> = new Set<EndReason["kind"]>([
  "max_duration", "connection_closed", "closed", "goodbye", "idle", "out_of_credits", "demo_over", "ended_by_staff", "shutdown", "stopped_before_start", "tools_refused",
]);

/** The user was on the line for these endings, so what Driver had said counts as heard. */
export function deliberate(reason: EndReason): boolean {
  return reason.kind === "goodbye" || reason.kind === "paused" || reason.kind === "waiting" || reason.kind === "reading" || reason.kind === "dictating" || reason.kind === "idle" ||
    reason.kind === "max_duration" || reason.kind === "rollover" || reason.kind === "user_stop" || reason.kind === "out_of_credits" || reason.kind === "demo_over";
}
