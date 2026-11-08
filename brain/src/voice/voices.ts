// The voices Driver can speak in. Pure: the brain, the cloud, the eval runner and Ops all read it.

/** GPT-Live's voices, as the SDK lists them: what a conversation can be held in. */
export const CONVERSATION_VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam", "marin", "meridian",
  "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;

/** OpenAI's text-to-speech voices; it recommends marin and cedar. */
export const READING_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
