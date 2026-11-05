// Speech for reading replies aloud (milestone 3): OpenAI's text-to-speech, much cheaper than a GPT-Live session
// (about $0.015 a minute of speech, against $0.05 a minute open). Each segment's audio is kept (on disk, or in R2), so
// hearing a reply again costs nothing.
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { Files } from "../files.ts";
import { describe, limiter } from "../util.ts";

/** GPT-Live's voices, as the SDK lists them: what a conversation can be held in. */
export const CONVERSATION_VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam", "marin", "meridian",
  "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;

/** OpenAI's text-to-speech voices; it recommends marin and cedar. */
export const READING_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;

/** How it's read. Never thread text: the reply goes only in `input`, so nothing in it can steer the voice. */
const INSTRUCTIONS = "Read this aloud clearly and naturally, at a calm, steady pace, like a colleague reading their report to a developer who is driving.";

/** Turns text into AAC audio; tests swap in a fake. */
export type Synthesize = (text: string, voice: string) => Promise<Buffer>;

export function openAiSpeech(apiKey: string, model: string): Synthesize {
  // One retry at most: a retried request is billed again.
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000 });
  return async (text, voice) => {
    const res = await client.audio.speech.create({ model, voice, input: text, instructions: INSTRUCTIONS, response_format: "aac" });
    return Buffer.from(await res.arrayBuffer());
  };
}

/**
 * Speech with a cache: audio files named by what they say and how, readable only by the brain's user, deleted after
 * `days` and, oldest first, while all of them take more than `maxMb`. The same text asked for twice at once is made once.
 */
export class Speech {
  private readonly making = new Map<string, Promise<Buffer>>();
  /** Paid: three at a time, however many segments a phone asks for. */
  private readonly speaking = limiter(3);
  private written = 0;
  private readonly files: Files;
  private readonly opts: { synthesize: Synthesize; model: string; days: number; maxMb: number; log: (m: string) => void };

  /** The audio goes in `files`' `speech/`. Call `prune` now and then (main.ts: hourly) to keep to the limits. */
  constructor(files: Files, opts: Speech["opts"]) {
    this.files = files;
    this.opts = opts;
  }

  audio(text: string, voice: string): Promise<Buffer> {
    const key = createHash("sha256").update(JSON.stringify([this.opts.model, voice, INSTRUCTIONS, text])).digest("hex").slice(0, 32);
    let made = this.making.get(key);
    if (!made) {
      const path = `speech/${key}.aac`;
      made = this.files.read(path).catch(() => null).then((kept) => kept ? Buffer.from(kept) : this.speaking(() => this.opts.synthesize(text, voice)).then(async (audio) => {
        try {
          await this.files.write(path, audio);
          // The size limit holds between the hourly tidies too.
          if (++this.written % 20 === 0) void this.prune();
        } catch (e) {
          this.opts.log(`speech: couldn't keep the audio (${describe(e)})`);
        }
        return audio;
      })).finally(() => this.making.delete(key));
      this.making.set(key, made);
    }
    return made;
  }

  async prune(now = Date.now()) {
    try {
      const files = (await this.files.list("speech")).filter((f) => f.path.endsWith(".aac")).sort((a, b) => a.at - b.at);
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (now - f.at <= this.opts.days * 86_400_000 && total <= this.opts.maxMb * (1 << 20)) continue;
        await this.files.remove(f.path);
        total -= f.size;
      }
    } catch (e) {
      this.opts.log(`speech: couldn't tidy the audio cache (${describe(e)})`);
    }
  }
}
