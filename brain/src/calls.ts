// What a brain tells 10 & 2 Ops' registry of calls (docs/launch/ops-app.md §2): when each session starts, ends and is
// confirmed over, and when the user flags a moment. Counts, timings, kinds and versions only: never what was said, a
// thread or a flag's text. Lattice has no registry; the cloud keeps each report until the registry has it.

export type CallEvent =
  | { kind: "started"; sessionId: string; at: number; opening: string; phoneBuild: string | null; brainRev: string; configVersion: number | null }
  /** `end`: the EndReason kind. */
  | { kind: "ended"; sessionId: string; at: number; end: string; billedS: number | null; turns: number; firstAudioMs: number | null; answerP50Ms: number | null }
  /** OpenAI confirmed the session over: it no longer bills. */
  | { kind: "closed"; sessionId: string; at: number }
  /** `file`: where the flag is among the brain's files (`flags/…md`). */
  | { kind: "flagged"; sessionId: string; at: number; file: string };

/** Never awaited by a call, and never throws into one. */
export type Calls = { report(event: CallEvent): void };

/** A live session, as its heartbeat says: only one in a brain's memory beats. */
export type Beat = { sessionId: string; turns: number; answerP50Ms: number | null };

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
