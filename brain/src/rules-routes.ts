// Your rules, Quiet for a while and the Focus filter over HTTP (docs/launch/engine.md §11, stage 3.4; contracts §3): the
// account's own, demo mode or not, so both hosts answer them before a demo world would (brain/src/server.ts
// `createBrain`, cloud/src/brain.ts), from the account's engine. One function, so the two hosts can't differ.
import type { Engine } from "./engine.ts";

/** A save refused because the file changed since it was opened (409), as the phone's alert says it (Fable, topic 3). */
export const RULES_CHANGED = "Your rules changed somewhere else.";
/** The reader couldn't read them in time, or failed (Fable, topic 11). */
export const COULDNT_READ = "Couldn't read your rules just now. Your earlier rules are still in use.";
/** Today's reads are used (Fable, topic 11): "Couldn't read 2 rules today. Try again tomorrow." */
export const readToday = (n: number) => `Couldn't read ${n === 1 ? "1 rule" : `${n} rules`} today. Try again tomorrow.`;

/**
 * The answer to one of these routes, or null for any other request:
 * - `GET /api/rules/file`: the file, each line with its row and reading, and the examples offered;
 * - `PUT /api/rules/file {text, ifV}`: saved over version `ifV` (0 before the first save), answered as GET is; 409 with
 *   the file as it is now when it changed since; 400 past its limits (30 rules, 200 characters each), with why;
 * - `PUT /api/quiet {until, by?}`: Quiet for a while until `until` (ms), at most 12 hours from now: `{quiet: {until}}`;
 * - `DELETE /api/quiet`: End now: `{ok, ended}`, `ended` false when it wasn't quiet;
 * - `PUT /api/focus {on}`: the Focus filter's report, `{ok}`.
 * Stage 3.5 (Fable, topic 11), each answered as GET is:
 * - `POST /api/rules/read`: the reader over the lines in your own words not read yet (at most 15 s); `problem`, what to
 *   show when it couldn't (the lines stay "Not read yet");
 * - `POST /api/rules/use {v, rv}`: Use these rules, every line read and not in use yet put in use now; 409 as a save's,
 *   and when a line was read or answered since the phone's copy (`rv`, the reads' version GET gives);
 * - `POST /api/rules/answer {line, choice}`: the answer to a line's question, by the line as written and the choice's
 *   number; 400 for a line with no such question, or one already in use.
 * Stage 3.5, "Allowing a call" (Fable's decision B): a call in your own words rings only once you allow it, here, with
 * the user's session only; each answered as GET is:
 * - `POST /api/rules/allow {v, line, reading, night}`: Allow (`night` true) or Only by day (false), a tap's
 *   (`by: "app"`); 409 with the file when `v` is stale or `reading` isn't the line's reading now, so the phone shows it
 *   again; 400 for a line with no call waiting to be allowed;
 * - `POST /api/rules/disallow {v, line}`: Stop calls; 409 when `v` is stale.
 */
export async function rulesRoute(engine: Engine | undefined, req: Request, path: string, body: () => Promise<unknown>): Promise<{ status: number; body: unknown } | null> {
  const read = async () => ((await body().catch(() => null)) ?? {}) as Record<string, unknown>;
  const none = { status: 404, body: { error: "not found" } };
  if (req.method === "GET" && path === "/api/rules/file") {
    if (!engine) return none;
    await engine.viewedOnce();
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "PUT" && path === "/api/rules/file") {
    if (!engine) return none;
    const b = await read();
    if (typeof b.text !== "string" || b.text.length > 20_000 || !Number.isInteger(b.ifV) || (b.ifV as number) < 0) return { status: 400, body: { error: "text, and ifV the version it was opened at, required" } };
    const r = engine.saveRules(b.text, b.ifV as number, b.by === "voice" ? "voice" : "app");
    if ("conflict" in r) return { status: 409, body: { error: RULES_CHANGED, file: engine.rulesFile() } };
    if ("error" in r) return { status: 400, body: { error: r.error } };
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "POST" && path === "/api/rules/read") {
    if (!engine) return none;
    const r = await engine.readRules();
    const file = engine.rulesFile();
    const unread = file.lines.filter((l) => l.status === "Not read yet").length;
    return { status: 200, body: { ...file, ...(r === "failed" ? { problem: COULDNT_READ } : r === "limit" && unread ? { problem: readToday(unread) } : {}) } };
  }
  if (req.method === "POST" && path === "/api/rules/use") {
    if (!engine) return none;
    const b = await read();
    if (!Number.isInteger(b.v)) return { status: 400, body: { error: "v, the version of your rules shown, required" } };
    const r = engine.useRules(b.v as number, undefined, typeof b.rv === "string" ? b.rv : undefined);
    if ("conflict" in r) return { status: 409, body: { error: RULES_CHANGED, file: engine.rulesFile() } };
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "POST" && path === "/api/rules/answer") {
    if (!engine) return none;
    const b = await read();
    if (typeof b.line !== "string" || !Number.isInteger(b.choice) || !engine.answerRule(b.line, b.choice as number)) return { status: 400, body: { error: "line, a rule with a question, and choice, one of its choices, required" } };
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "POST" && path === "/api/rules/allow") {
    if (!engine) return none;
    const b = await read();
    if (!Number.isInteger(b.v) || typeof b.line !== "string" || typeof b.reading !== "string" || typeof b.night !== "boolean") return { status: 400, body: { error: "v, line, reading and night required" } };
    const r = engine.allowRule(b.line, b.reading, b.night, "app", { v: b.v as number });
    if (r === "conflict") return { status: 409, body: { error: RULES_CHANGED, file: engine.rulesFile() } };
    if (r === "none") return { status: 400, body: { error: "line, a rule in use with a call waiting for your OK, required" } };
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "POST" && path === "/api/rules/disallow") {
    if (!engine) return none;
    const b = await read();
    if (!Number.isInteger(b.v) || typeof b.line !== "string") return { status: 400, body: { error: "v and line required" } };
    if (engine.disallowRule(b.line, b.v as number) === "conflict") return { status: 409, body: { error: RULES_CHANGED, file: engine.rulesFile() } };
    return { status: 200, body: engine.rulesFile() };
  }
  if (req.method === "PUT" && path === "/api/quiet") {
    if (!engine) return none;
    const b = await read();
    const until = typeof b.until === "number" && Number.isFinite(b.until) ? b.until : NaN;
    const set = Number.isFinite(until) ? engine.setQuiet(until, b.by === "siri" || b.by === "voice" ? b.by : "app") : null;
    if (!set) return { status: 400, body: { error: "until must be a time to come, in ms" } };
    return { status: 200, body: { quiet: set } };
  }
  if (req.method === "DELETE" && path === "/api/quiet") return engine ? { status: 200, body: { ok: true, ended: engine.endQuiet() } } : none;
  if (req.method === "PUT" && path === "/api/focus") {
    if (!engine) return none;
    const b = await read();
    if (typeof b.on !== "boolean") return { status: 400, body: { error: "on must be true or false" } };
    engine.setFocus(b.on);
    return { status: 200, body: { ok: true } };
  }
  return null;
}
