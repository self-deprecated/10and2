// The voices Driver can speak in. Pure: the brain, the cloud, the eval runner and Ops all read it.

/** GPT-Live's voices, as the SDK lists them: what a conversation can be held in. */
export const CONVERSATION_VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam", "marin", "meridian",
  "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;

/** OpenAI's text-to-speech voices; it recommends marin and cedar. */
export const READING_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;

/**
 * What every reading voice's sample says (`GET /api/voices/sample`) by default, so voices are heard side by side: a
 * reply as the reader would read one. Ops can change it (`sampleText` in settings.ts); new words make each sample
 * again, once.
 */
export const VOICE_SAMPLE_TEXT = "Here's the latest from your checkout thread. The tests pass now, and the fix is ready for you to look at once you've parked.";
