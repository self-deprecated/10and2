// Thin wrappers over the Responses API for the brain's background work.
import OpenAI from "openai";
import { tokensOf, type Spent } from "./spend.ts";

/** What a model call used, as the provider reported it (spend.ts prices it). */
export type Used = Pick<Spent, "model" | "tier" | "input" | "cached" | "cacheWrite" | "output" | "reasoning" | "retries">;

/**
 * `fast`: someone is waiting on it, so it goes through Fast mode (the priority tier), at a higher price. `spent`: given
 * what the call used once it's answered (spend.ts records it); a failed call reports nothing.
 */
export type LlmCall = { model: string; effort: "none" | "low" | "medium" | "high"; instructions: string; input: string; fast?: boolean; spent?: (u: Used) => void };

/** A header the SDK's requests carry only as far as `fetch` below, which strips it: which call a retry belongs to. */
const TAG = "x-driver-request";

/**
 * Counts each call's retries: the SDK numbers every attempt (`X-Stainless-Retry-Count`), and a call's requests are
 * tagged so its attempts are told apart from other calls' on the same client.
 */
export function retryCounter() {
  const seen = new Map<string, number>();
  return {
    fetch: (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const id = headers.get(TAG);
      if (id) {
        seen.set(id, Number(headers.get("x-stainless-retry-count") ?? 0) || 0);
        headers.delete(TAG);
      }
      return fetch(url, { ...init, headers });
    },
    /** One call: the header its requests carry, its retries once it's done, and forgetting it. */
    tag() {
      const id = crypto.randomUUID();
      return { headers: { [TAG]: id }, retries: () => seen.get(id) ?? 0, done: () => void seen.delete(id) };
    },
  };
}

export function makeLlm(apiKey: string) {
  // One retry at most in the SDK: a retried request is never worth a duplicated bill here. Each is counted.
  const counter = retryCounter();
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000, fetch: counter.fetch });
  const respond = async (call: LlmCall, text?: object) => {
    const tag = counter.tag();
    try {
      const res = await client.responses.create({
        model: call.model,
        instructions: call.instructions,
        input: call.input,
        reasoning: { effort: call.effort },
        ...(text ? { text } : {}),
        ...(call.fast ? { service_tier: "priority" as const } : {}),
        store: false,
      }, { headers: tag.headers });
      try {
        call.spent?.({ model: call.model, tier: res.service_tier ?? (call.fast ? "fast" : "standard"), ...tokensOf(res.usage), retries: tag.retries() });
      } catch {
        // Recording never fails the call.
      }
      return res;
    } finally {
      tag.done();
    }
  };
  return {
    async json<T>(call: LlmCall, name: string, schema: object): Promise<T> {
      const res = await respond(call, { format: { type: "json_schema", name, strict: true, schema: schema as Record<string, unknown> } });
      return JSON.parse(res.output_text) as T;
    },
    async text(call: LlmCall): Promise<string> {
      return (await respond(call)).output_text.trim();
    },
  };
}
export type Llm = ReturnType<typeof makeLlm>;
