/** Session endings stay typed until they reach a log, the ledger or a public result. */
export type EndReason =
  | { kind: "goodbye" }
  | { kind: "paused" }
  | { kind: "waiting"; handle: string }
  /** Hung up so the phone can read a reply out in full (`read_aloud`). */
  | { kind: "reading"; handle: string }
  /** Hung up so the phone can record the user's reply to a thread in their own words (`dictate`). */
  | { kind: "dictating"; handle: string }
  | { kind: "idle" }
  | { kind: "max_duration" }
  | { kind: "user_stop" }
  | { kind: "replaced" }
  | { kind: "connection_closed" }
  | { kind: "closed"; detail: string }
  | { kind: "shutdown" }
  | { kind: "stopped_before_start" }
  | { kind: "phone_end" }
  | { kind: "restarted" }
  /** The cloud account's credits ran out during the call (contracts §4): Driver said so and goodbye. */
  | { kind: "out_of_credits" };

export function reasonText(reason: EndReason): string {
  switch (reason.kind) {
    case "goodbye": return "goodbye";
    case "paused": return "paused";
    case "waiting": return `waiting for ${reason.handle}`;
    case "reading": return `reading ${reason.handle} aloud`;
    case "dictating": return `dictating a reply to ${reason.handle}`;
    case "idle": return "idle";
    case "max_duration": return "max duration";
    case "user_stop": return "stopped by user";
    case "replaced": return "replaced by a new session";
    case "connection_closed": return "connection closed";
    case "closed": return `closed: ${reason.detail}`;
    case "shutdown": return "shutdown";
    case "stopped_before_start": return "stopped before it started";
    case "phone_end": return "ended by the phone";
    case "restarted": return "the brain restarted while it was open";
    case "out_of_credits": return "out of credits";
  }
}

/** A pause, or starred threads working when the conversation ends, can arrange a call-back. */
export function holdsAfter(reason: EndReason): boolean {
  return reason.kind === "paused" || reason.kind === "goodbye" || reason.kind === "idle" || reason.kind === "max_duration";
}

/** The user was on the line for these endings, so what Driver had said counts as heard. */
export function deliberate(reason: EndReason): boolean {
  return reason.kind === "goodbye" || reason.kind === "paused" || reason.kind === "waiting" || reason.kind === "reading" || reason.kind === "dictating" || reason.kind === "idle" ||
    reason.kind === "max_duration" || reason.kind === "user_stop" || reason.kind === "out_of_credits";
}
