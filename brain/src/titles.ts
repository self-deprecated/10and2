// A new thread's title, made by the brain as the thread starts, so every work system (T3 Code, Claude Code, Codex,
// OpenCode, Pi) gets a real one and the start's answer can say it. The instructions are T3 Code's own for a thread's
// first title (packages/provider-core/src/server/textGenerationPrompts.ts, `INITIAL_THREAD_TITLE_PROMPT`), without the
// parts about tools, attachments and refining it later, which don't apply here; `cleanTitle` is its
// `sanitizeThreadTitle`, plus no leading dash (Claude Code and Pi refuse a title starting with one).

/** Names a new thread from its first prompt and its project; null when it has nothing usable. Rejects on failure. */
export type Titler = (message: string, project: string) => Promise<string | null>;

/** How long a start waits for its title before going without one: someone is waiting on the start. */
export const TITLE_MS = 4000;
/** The longest title kept, as T3 Code's. */
const TITLE_MAX = 120;
/** The most of the prompt read: the start and the end, as T3 Code's `limitTitleMessage`. */
const MESSAGE_MAX = 8000;
const TRUNCATED = "\n[Content truncated]\n";

const INSTRUCTIONS = `Generate a title that will help the user recognize this coding agent's thread weeks later.
Return JSON with the key title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when the message reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid the project's name (it is shown beside the title), quotes, labels, filler, and trailing punctuation.
- If a linked PR or issue is the only clue to the subject, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.`;

const SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

/** A long prompt's start and end, as T3 Code reads one: at most `MESSAGE_MAX` characters. */
export function limited(text: string): string {
  if (text.length <= MESSAGE_MAX) return text;
  const available = MESSAGE_MAX - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${TRUNCATED}${text.slice(-(available - head))}`;
}

/** A model's title made safe to send: one line, no wrapping quotes or leading dashes, at most `TITLE_MAX`; null if empty. */
export function cleanTitle(raw: string): string | null {
  const line = (raw.trim().split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").replace(/^[-\s'"`]+|['"`\s]+$/g, "");
  if (!line) return null;
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function modelTitler(llm: { json<T>(c: any, n: string, s: object): Promise<T> }, model: string): Titler {
  return async (message, project) => {
    const out = await llm.json<{ title: string }>(
      // Fast, and at most `TITLE_MS` with no retry: the user is waiting on the start.
      { model, effort: "low", fast: true, timeoutMs: TITLE_MS, instructions: INSTRUCTIONS, input: `Project: ${project}\n\nUser message:\n${limited(message)}` },
      "thread_title",
      SCHEMA,
    );
    return cleanTitle(out.title);
  };
}
