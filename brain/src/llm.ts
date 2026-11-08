// Thin wrappers over the Responses API for the brain's background work.
import OpenAI from "openai";

/** `fast`: someone is waiting on it, so it goes through Fast mode (the priority tier), at a higher price. */
export type LlmCall = { model: string; effort: "none" | "low" | "medium" | "high"; instructions: string; input: string; fast?: boolean };

export function makeLlm(apiKey: string) {
  // No retries in the SDK: callers decide; a retried request is never worth a duplicated bill here.
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000 });
  return {
    async json<T>(call: LlmCall, name: string, schema: object): Promise<T> {
      const res = await client.responses.create({
        model: call.model,
        instructions: call.instructions,
        input: call.input,
        reasoning: { effort: call.effort },
        text: { format: { type: "json_schema", name, strict: true, schema: schema as Record<string, unknown> } },
        ...(call.fast ? { service_tier: "priority" as const } : {}),
        store: false,
      });
      return JSON.parse(res.output_text) as T;
    },
    async text(call: LlmCall): Promise<string> {
      const res = await client.responses.create({
        model: call.model,
        instructions: call.instructions,
        input: call.input,
        reasoning: { effort: call.effort },
        ...(call.fast ? { service_tier: "priority" as const } : {}),
        store: false,
      });
      return res.output_text.trim();
    },
  };
}
export type Llm = ReturnType<typeof makeLlm>;
