// Every voice session's sideband stream, kept as JSONL next to the database, so a session that went wrong can be read
// afterwards and replayed as a test (test/replay.ts). One file per session:
//   {"session", "conversation", "opening", "threads", "starred", …}   the header: what the session started with
//   {"t": 1234, "in": {…}}      an event from OpenAI, t ms after the session started
//   {"t": 1240, "out": {…}}     an event the brain sent
//   {"t": 1300, "brain": {…}}   the brain's own notes: tools run (with their results), log lines, closing, the end
//   {"t": 1400, "transport": "closed"}   the connection closed under the session
// Audio is never kept (only its size), nor credentials. Recording never holds up or breaks a session: a file that can't
// be written, a disk that doesn't keep up, or a file past its size cap is logged once and the session carries on.
import { createWriteStream, type WriteStream } from "node:fs";
import type { Files } from "../files.ts";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import type { LiveConn } from "./live.ts";
import { CallAudio, pruneCallAudio } from "./call-audio.ts";
import { copied, credentialName, describe, realClock, redact, REDACT_MAX, truncate, type Clock } from "../util.ts";

/** Keys never written, at any depth: the SDP (it carries ICE credentials) and every credential `redact` knows of. */
const secretKey = (key: string) => key.toLowerCase() === "sdp" || credentialName(key);
/** Where audio sits inside an audio part ("input_audio": {"data": …}, an "output_audio" part's "data"). */
const AUDIO_FIELD = /^(?:audio|delta|data)$/;
/** A field named for audio ("input_audio", "audio_chunk"); a transcript or text of audio ("audio_text") is text. */
const audioNamed = (key: string) => /audio/i.test(key) && !/transcript|text/i.test(key);
/** A string this long that is all base64 is binary (audio), wherever it is. */
const BLOB = /^[A-Za-z0-9+/]{256,}={0,2}$/;
/** An audio-typed part or event; transcripts of audio are text, kept. */
const audioTyped = (type: unknown) => typeof type === "string" && /audio/i.test(type) && !/transcript|text/i.test(type);

/** Decoded size of base64 audio, without decoding it. */
const audioBytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Already a size ("[3200 bytes]"): written as it is. */
const SIZED = /^\[\d+ bytes\]$/;
/** Base64 through its first `REDACT_MAX` characters: binary too long to look at whole, so sized. */
const BASE64 = /^[A-Za-z0-9+/]*$/;
const sized = (b64: string) => `[${audioBytes(b64)} bytes]`;

/** Past these an entry isn't looked into any further: it's written as `oversized`. Names are cut to `MAX_KEY`. */
const MAX_NODES = 5_000;
const MAX_DEPTH = 32;
const MAX_KEY = 256;
class Oversized extends Error {}
/** The entry is bigger than all the room left to queue it. */
class TooBig extends Error {}

/** What `clean` has seen of one entry: the size it keeps, values and depth, and the most it may keep. */
type Tally = { n: number; nodes: number; depth: number; limit: number; maxNodes: number };
const tally = (limit = Infinity, maxNodes = MAX_NODES): Tally => ({ n: 0, nodes: 0, depth: 0, limit, maxNodes });

/**
 * What may be written of a value, in two passes. `cut`, as an event is queued, only does what costs next to nothing:
 * audio becomes its size, credential fields are dropped, a string longer than `REDACT_MAX` is cut (or sized, if it's
 * base64), and what's kept is counted (strings, names, 8 bytes a value) into `t.n`. `scrub`, later, also sizes base64
 * blobs, cleans JSON inside strings and redacts every string, pausing (`yield`) before each, so it can be spread over
 * the event loop. Either stops (`Oversized`) past `t.maxNodes` values or `MAX_DEPTH` levels, and the cut (`TooBig`)
 * past `t.limit` bytes, so no entry costs much, however it's made.
 */
function* clean(value: unknown, key: string, inAudio: boolean, mode: "cut" | "scrub", t: Tally, depth = 0): Generator<void, unknown> {
  t.depth = Math.max(t.depth, depth);
  if (++t.nodes > t.maxNodes || depth > MAX_DEPTH) throw new Oversized();
  t.n += 8;
  if (t.n > t.limit) throw new TooBig();
  if (typeof value === "string") {
    // What's kept counts towards the size, whatever it was.
    const keep = (text: string) => {
      t.n += text.length;
      if (t.n > t.limit) throw new TooBig();
      return text;
    };
    if (SIZED.test(value)) return keep(value);
    if ((inAudio && AUDIO_FIELD.test(key)) || audioNamed(key)) return keep(sized(value));
    if (value.length > REDACT_MAX) return keep(BASE64.test(value.slice(0, REDACT_MAX)) ? sized(value) : truncate(value));
    if (mode === "cut") return keep(value);
    if (BLOB.test(value)) return sized(value);
    const json = /^\s*[[{]/.test(value) ? parsed(value) : undefined;
    if (json && typeof json === "object") return JSON.stringify(yield* clean(json, key, inAudio, mode, t, depth + 1));
    yield;
    return redact(value);
  }
  if (Array.isArray(value)) {
    if (t.nodes + value.length > t.maxNodes) {
      t.nodes += value.length;
      throw new Oversized();
    }
    const out = [];
    for (const v of value) out.push(yield* clean(v, key, inAudio, mode, t, depth + 1));
    return out;
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  // A sideband audio event is only its type and size.
  if (typeof obj.type === "string" && obj.type.startsWith("session.") && audioTyped(obj.type)) {
    const payload = [obj.audio, obj.delta, obj.data].find((v) => typeof v === "string") as string | undefined;
    if (payload !== undefined) return { type: obj.type, bytes: audioBytes(payload) };
  }
  const audio = inAudio || audioTyped(obj.type);
  const out: Record<string, unknown> = {};
  // `for…in` stops where the budget does, without listing every name first.
  for (const k in obj) {
    if (!Object.hasOwn(obj, k) || secretKey(k)) continue;
    const name = k.length > MAX_KEY ? copied(k.slice(0, MAX_KEY)) : k;
    t.n += name.length;
    out[name] = yield* clean(obj[k], name, audio || audioNamed(name), mode, t, depth + 1);
  }
  return out;
}

/** An entry too big to look into, as it's written: each part's type, and how far `clean` got. */
function oversized(entry: Record<string, unknown>, t: Tally): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(entry).slice(0, 8)) {
    const v = entry[k] as { type?: unknown } | undefined;
    const type = typeof v?.type === "string" ? copied(v.type.slice(0, MAX_KEY)) : undefined;
    out[k] = k === "t" ? entry.t : { type, oversized: true, nodes: t.nodes, depth: t.depth };
  }
  return out;
}

/** Runs a `clean` pass straight through. */
function run<T>(pass: Generator<void, T>): T {
  for (;;) {
    const step = pass.next();
    if (step.done) return step.value;
  }
}

/** One line of a recording: audio becomes its size, credentials are dropped or masked. */
export function recordLine(entry: Record<string, unknown>): string {
  const t = tally();
  try {
    return JSON.stringify(run(clean(entry, "", false, "scrub", t)));
  } catch (e) {
    if (e instanceof Oversized) return JSON.stringify(oversized(entry, t));
    throw e;
  }
}

/** How much of a recording may wait for the disk, and how big one file may grow. */
export const MAX_QUEUED = 1 << 20;
export const MAX_FILE = 20 << 20;
/** Events waiting to be cleaned and written, by their size once cut; past this they come faster than they can be. */
export const MAX_PENDING = 2 << 20;
/** How long cleaning and writing may take before the event loop gets a turn. */
const SLICE_MS = 4;

export class Recording {
  private readonly now: () => number;
  private readonly started: number;
  private readonly out: Writable;
  private readonly file: string;
  private readonly maxQueued: number;
  private readonly maxBytes: number;
  private readonly maxPending: number;
  private bytes = 0;
  private headerBytes = 0;
  private stopped = false;
  /** Events, cut down as they came, cleaned and written after the session has handled them, a slice at a time. */
  private pending: { entry: Record<string, unknown>; size: number }[] = [];
  private pendingBytes = 0;
  /** The entry being cleaned, part way through. */
  private current: { pass: Generator<void, unknown>; entry: Record<string, unknown>; tally: Tally; size: number } | null = null;
  private scheduled = false;
  private closing = false;
  /** Settles once the file is finished (or failed). */
  readonly done: Promise<void>;
  private closed?: Promise<void>;
  private readonly log: (m: string) => void;
  /** The tester's own microphone audio, kept beside the recording when they've switched it on (call-audio.ts). */
  private readonly audio?: CallAudio;

  /** `now` is a monotonic clock in ms (a test's fake one); `open` gives the file's stream (a test's stalled disk). */
  constructor(
    file: string,
    header: Record<string, unknown>,
    opts: {
      log: (m: string) => void;
      now?: () => number;
      maxQueued?: number;
      maxBytes?: number;
      maxPending?: number;
      open?: (file: string) => Writable;
      audio?: CallAudio;
    },
  ) {
    this.file = file;
    this.audio = opts.audio;
    this.log = opts.log;
    this.now = opts.now ?? (() => performance.now());
    this.maxQueued = opts.maxQueued ?? MAX_QUEUED;
    this.maxBytes = opts.maxBytes ?? MAX_FILE;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
    this.started = this.now();
    this.out = (opts.open ?? ((f: string): WriteStream => createWriteStream(f, { flags: "a", mode: 0o600 })))(file);
    this.out.on("error", (e) => this.stop(`couldn't write it (${describe(e)})`));
    const out = this.out;
    this.done = new Promise((resolve) => {
      out.once("finish", resolve);
      out.once("close", resolve);
      out.once("error", () => resolve());
    });
    // The header lists every thread: it may be bigger than an event.
    this.write(header, 50_000);
  }

  /** An event from OpenAI. */
  incoming = (ev: unknown) => {
    const t = this.elapsed();
    const e = ev as { type?: unknown; audio?: unknown } | null;
    if (this.audio && e?.type === "session.input_audio.append" && typeof e.audio === "string") this.audio.feed(t, e.audio);
    this.write({ t, in: ev });
  };
  /** An event the brain sent. */
  outgoing = (ev: unknown) => this.write({ t: this.elapsed(), out: ev });
  /** The brain's own note (`VoiceSession`'s `record`). */
  note = (ev: object) => this.write({ t: this.elapsed(), brain: ev });

  /** The connection, with everything that goes over it recorded. Hanging it up ends the recording. */
  wrap(conn: LiveConn): LiveConn {
    // First, so the closing is written before the session's own listener ends it (and the recording).
    conn.onClose(() => this.write({ t: this.elapsed(), transport: "closed" }));
    return {
      send: (ev) => {
        this.outgoing(ev);
        conn.send(ev);
      },
      onEvent: (l) =>
        conn.onEvent((ev) => {
          this.incoming(ev);
          l(ev);
        }),
      onClose: (l) => conn.onClose(l),
      terminate: () => {
        conn.terminate();
        this.close();
      },
    };
  }

  /** Ends the recording once what's pending is written; settles when the file is finished, or after `ms` at most. */
  close(ms = 2000): Promise<void> {
    if (!this.stopped && !this.closing) {
      this.closing = true;
      this.schedule();
    }
    const finished = this.audio ? Promise.all([this.done, this.audio.close()]).then(() => {}) : this.done;
    return (this.closed ??= Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]));
  }

  private elapsed() {
    return Math.round(this.now() - this.started);
  }

  /**
   * Queues an entry cut down (`clean`'s cut: no audio, no credential fields, no string past `REDACT_MAX`), which is all
   * the session waits for; cleaning and writing it come later. Past `maxPending` bytes queued, recording stops.
   */
  private write(entry: Record<string, unknown>, maxNodes = MAX_NODES) {
    if (this.stopped || this.closing) return;
    const t = tally(this.maxPending - this.pendingBytes, maxNodes);
    let cut: Record<string, unknown>;
    try {
      cut = run(clean(entry, "", false, "cut", t)) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof TooBig) return this.stop("events came faster than they could be written");
      if (!(e instanceof Oversized)) return this.stop(`couldn't write it (${describe(e)})`);
      cut = oversized(entry, t);
      t.n = 256;
    }
    this.pending.push({ entry: cut, size: t.n });
    this.pendingBytes += t.n;
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  /** Cleans and writes for `SLICE_MS` at most, a string at a time, then lets the event loop have a turn. */
  private flush() {
    this.scheduled = false;
    const until = performance.now() + SLICE_MS;
    try {
      while (!this.stopped) {
        if (performance.now() >= until) return this.schedule();
        if (!this.current) {
          const next = this.pending.shift();
          if (!next) break;
          const t = tally(Infinity, Infinity);
          this.current = { pass: clean(next.entry, "", false, "scrub", t), entry: next.entry, tally: t, size: next.size };
        }
        let done: unknown;
        try {
          const step = this.current.pass.next();
          if (!step.done) continue;
          done = step.value;
        } catch (e) {
          // JSON inside a string that turns out too big to look into.
          if (!(e instanceof Oversized)) throw e;
          done = oversized(this.current.entry, this.current.tally);
        }
        this.pendingBytes -= this.current.size;
        this.current = null;
        this.writeLine(JSON.stringify(done) + "\n");
      }
    } catch (e) {
      return this.stop(`couldn't write it (${describe(e)})`);
    }
    if (this.closing && !this.stopped) {
      this.stopped = true;
      this.out.end();
    }
  }

  private writeLine(line: string) {
    try {
      const size = Buffer.byteLength(line);
      // Never wait for the disk: what it hasn't taken yet is held in memory, so past a limit the recording stops. The
      // header, however many threads it lists, is queued before the file has even opened: it's allowed on top.
      if (!this.bytes) this.headerBytes = size;
      else if (this.out.writableLength + size > this.maxQueued + this.headerBytes) return this.stop("the disk isn't keeping up");
      if (this.bytes + size > this.maxBytes) {
        this.out.write(recordLine({ t: this.elapsed(), brain: { type: "truncated", bytes: this.bytes } }) + "\n");
        return this.stop(`it reached ${Math.round(this.maxBytes / (1 << 20))} MB`);
      }
      this.bytes += size;
      this.out.write(line);
    } catch (e) {
      this.stop(`couldn't write it (${describe(e)})`);
    }
  }

  /** Stops recording this session, once, and says why; the session carries on. */
  private stop(why: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = [];
    this.current = null;
    this.pendingBytes = 0;
    this.log(`recording: stopped recording ${this.file}: ${why}; the session carries on`);
    this.out.end();
  }
}

/**
 * Where sessions are recorded, and for how long they're kept: recordings older than `days` are deleted, and the oldest
 * go while all of them together are over `maxMb`. That's done at start and every hour, whether or not recording is on.
 */
/** How long a recording a flag names is kept (the rest: `days`, default 14). */
export const FLAGGED_DAYS = 90;

export class Recordings {
  private readonly files: Files;
  private readonly keepMs: number;
  private readonly maxTotal: number;
  private readonly log: (m: string) => void;
  private readonly now?: () => number;
  private readonly open = new Set<Recording>();

  /** Recordings go in `files`' `sessions/`. Call `prune` now and then (main.ts: hourly) to keep to the limits. */
  constructor(files: Files, opts: { days: number; maxMb?: number; log: (m: string) => void; now?: () => number }) {
    this.files = files;
    this.keepMs = opts.days * 86_400_000;
    this.maxTotal = (opts.maxMb ?? 500) * (1 << 20);
    this.log = opts.log;
    this.now = opts.now;
  }

  /** The sessions flags name, as the start of their recordings' names (a flag's file name keeps the id's first 16 characters). */
  private async flagged(): Promise<Set<string>> {
    // Reviewed ones too (on Lattice a reviewer moves the file to reviewed/ next to it): it's still a flag.
    const dirs = ["flags", "demo-flags", "flags/reviewed", "demo-flags/reviewed"];
    const names = (await Promise.all(dirs.map((dir) => this.files.list(dir).catch(() => [])))).flat();
    const fragments = new Set<string>();
    for (const f of names) {
      const m = /^\d{8}-\d{6}-([\w-]{8,16})\.md$/.exec(f.path.split("/").pop()!);
      if (m) fragments.add(m[1]);
    }
    return fragments;
  }

  /** Where a session's recording is: `sessions/<id>.jsonl`. */
  static path = (sessionId: string) => `sessions/${sessionId.replace(/[^\w.-]/g, "_")}.jsonl`;

  /** Starts a session's recording; with `audio`, the user's microphone audio is kept beside it (call-audio.ts). */
  start(sessionId: string, header: Record<string, unknown>, opts: { audio?: boolean } = {}): Recording {
    const path = Recordings.path(sessionId);
    const audio = opts.audio ? new CallAudio(this.files, sessionId, { log: this.log }) : undefined;
    const recording = new Recording(path, { session: sessionId, startedAt: new Date().toISOString(), ...header, ...(audio ? { callAudio: true } : {}) }, { log: this.log, now: this.now, open: () => this.files.writer(path), audio });
    this.open.add(recording);
    void recording.done.then(() => this.open.delete(recording));
    return recording;
  }

  /** Finishes every recording still open (the brain is shutting down), waiting `ms` at most for each. */
  async close(ms = 2000) {
    await Promise.all([...this.open].map((r) => r.close(ms)));
  }

  /**
   * Deletes recordings past the retention, then the oldest while they take more than the cap. A recording a flag names
   * (`flags/`, `demo-flags/`: the user said "debug this") is kept for `FLAGGED_DAYS` and isn't counted against the cap,
   * as the privacy policy says, so a flag still has its recording when someone gets to it.
   */
  async prune(now = Date.now()) {
    try {
      const flagged = await this.flagged();
      const files = [];
      for (const f of await this.files.list("sessions")) {
        if (!f.path.endsWith(".jsonl")) continue;
        const name = f.path.split("/").pop()!;
        if ([...flagged].some((fragment) => name.startsWith(fragment))) {
          if (now - f.at > FLAGGED_DAYS * 86_400_000) await this.files.remove(f.path);
          continue;
        }
        if (now - f.at > this.keepMs) await this.files.remove(f.path);
        else files.push(f);
      }
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files.sort((a, b) => a.at - b.at)) {
        if (total <= this.maxTotal) break;
        await this.files.remove(f.path);
        total -= f.size;
      }
    } catch (e) {
      this.log(`recording: couldn't clear out old recordings (${describe(e)})`);
    }
    await pruneCallAudio(this.files, now).catch((e) => this.log(`recording: couldn't clear out old call audio (${describe(e)})`));
  }
}
