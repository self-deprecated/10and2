// Best effort at the outbound boundary: keep prose useful without sending common credential shapes.
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(password|token)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi, "$1=[REDACTED]");
}

const TEXT_FIELDS = new Set(["title", "group", "name", "text", "progress", "question", "prompt", "error", "message"]);

/** Redact display text throughout snapshots and RPC results, keeping routing ids and reply refs intact. */
export function redactOutbound(value: unknown, field = ""): unknown {
  // A resource's contents are JSON text redacted field by field before encoding; redacting the encoding would break it.
  if (field === "contents") return value;
  if (typeof value === "string") return TEXT_FIELDS.has(field) || field === "value" ? redactText(value) : value;
  if (Array.isArray(value)) return value.map((v) => redactOutbound(v, field));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactOutbound(v, key)]));
  return value;
}
