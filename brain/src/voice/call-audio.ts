// A tester's own call audio, kept only when they've switched it on (Jordan, 4 November; the privacy policy says so):
// the microphone as the voice model received it, from the sideband's `session.input_audio.append` frames (24 kHz
// 16-bit mono PCM). Driver's voice never passes through the brain (WebRTC goes phone ↔ model), so it isn't here.
//
// Files are `call-audio/<session>-<t>.wav`, `t` the ms into the session's recording where the piece starts, so they
// line up with `sessions/<session>.jsonl`. A piece is at most a minute, and a new one starts after a gap, so memory
// stays small and the timing stays right. They go after `CALL_AUDIO_DAYS`, like the other debugging records.
import type { Files } from "../files.ts";

export const CALL_AUDIO_DIR = "call-audio";
export const CALL_AUDIO_DAYS = 14;
export const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
/** A gap this long between frames starts a new piece, so a piece's samples are continuous. */
const GAP_MS = 500;

const safe = (sessionId: string) => sessionId.replace(/[^\w.-]/g, "_");

/** A WAV file of 16-bit mono PCM at `SAMPLE_RATE`. */
export function wav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class CallAudio {
  private readonly files: Files;
  private readonly name: string;
  private readonly log: (m: string) => void;
  private readonly maxBytes: number;
  private parts: Uint8Array[] = [];
  private size = 0;
  /** Where the piece being gathered starts, and where its audio ends, in ms into the recording. */
  private startT = 0;
  private endT = 0;
  private writes: Promise<void>[] = [];

  constructor(files: Files, sessionId: string, opts: { log: (m: string) => void; pieceSeconds?: number }) {
    this.files = files;
    this.name = safe(sessionId);
    this.log = opts.log;
    this.maxBytes = (opts.pieceSeconds ?? 60) * SAMPLE_RATE * 2;
  }

  /** A frame of microphone audio (base64 PCM) that arrived `t` ms into the recording. */
  feed(t: number, b64: string) {
    let pcm: Uint8Array;
    try { pcm = decode(b64); } catch { return; }
    if (pcm.length === 0) return;
    // The frame ends at `t`; it began its own length earlier.
    const begins = Math.max(0, t - pcm.length / BYTES_PER_MS);
    if (this.size > 0 && begins - this.endT > GAP_MS) this.flush();
    if (this.size === 0) this.startT = Math.round(begins);
    this.parts.push(pcm);
    this.size += pcm.length;
    this.endT = this.startT + this.size / BYTES_PER_MS;
    if (this.size >= this.maxBytes) this.flush();
  }

  private flush() {
    if (this.size === 0) return;
    const pcm = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) { pcm.set(p, at); at += p.length; }
    const path = `${CALL_AUDIO_DIR}/${this.name}-${String(this.startT).padStart(8, "0")}.wav`;
    this.parts = [];
    this.size = 0;
    this.writes.push(this.files.write(path, wav(pcm)).catch((e) => this.log(`call audio: couldn't save ${path} (${e instanceof Error ? e.message : String(e)})`)));
  }

  /** Saves what's left; settles when every piece is written. */
  async close() {
    this.flush();
    await Promise.all(this.writes);
  }
}

/** Deletes call audio older than `days`. */
export async function pruneCallAudio(files: Files, now = Date.now(), days = CALL_AUDIO_DAYS) {
  for (const f of await files.list(CALL_AUDIO_DIR).catch(() => [])) if (now - f.at > days * 86_400_000) await files.remove(f.path);
}

/** Deletes all of an account's call audio (the tester switched it off). */
export async function removeCallAudio(files: Files) {
  for (const f of await files.list(CALL_AUDIO_DIR).catch(() => [])) await files.remove(f.path);
}
