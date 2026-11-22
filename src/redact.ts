// Best effort at the outbound boundary: keep prose useful without sending common credential shapes.
/** A word matched in any case, letter by letter ("key" is `[kK][eE][yY]`), so a name's ending is read however it's cased. */
const anyCase = (w: string) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
/**
 * What a secret's name ends in, in any case and after any name (`PGPASSWORD`, `db_password`, `TF_VAR_db_password`,
 * `dbPassword`, `apiKey`, npm's `_authToken`: the skeptic's should and both reviews' nits on fix5); a key only when the
 * name says it's a secret's, so `S3_BUCKET_KEY` and `ENV_KEY` are shown.
 */
const SECRET_END = ["password", "passwd", "secret", "token", "api_?key", "secret_?key", "access_?key", "private_?key"];
const SECRET_NAME = `[A-Za-z0-9_]*(?:${SECRET_END.map(anyCase).join("|")})`;
/**
 * A value taken whole from the shell, which is no secret and stays shown: a variable alone (`$TF_TOKEN`, `${PW}`, bare or
 * in double quotes) or a command's output (`$(…)`). A literal written after `$` is masked (`$'hunter2'`, `$"hunter2"`, a
 * `${TF_TOKEN:-hunter2}` default, `'$T'` in single quotes: both reviews' nits on fix6).
 */
const FROM_SHELL = String.raw`"?\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})(?=["\s,;&]|$)|"?\$\(`;
/** Each credential shape and what's shown in its place, in the order they're masked (each on what the ones before left). */
const MASKS: [RegExp, (span: string, key: string) => string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|ek_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g, () => "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, () => "[REDACTED]"],
  // Stripe's secret and restricted keys, Google's API keys, GitLab's and npm's access tokens, Hugging Face's tokens.
  [/\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[0-9A-Za-z_-]{20,}|npm_[0-9A-Za-z]{20,}|hf_[0-9A-Za-z]{20,})/g, () => "[REDACTED]"],
  // Bearer tokens in Authorization headers or prose.
  [/\b(Bearer\s+)[^\s"'`]+/gi, (_, key) => `${key}[REDACTED]`],
  // A database's or a service's address with its password in it: the user and host stay shown.
  [/\b((?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?):\/\/[^:/@\s]+:)[^@\s]+@/g, (_, key) => `${key}[REDACTED]@`],
  // A value not in quotes ends at a quote: `-var "token=abc"` keeps its closing quote, so the value is all that's masked.
  // In a URL it ends at its `@` too, an empty one as well (the skeptic's nits on fix4 and fix5): `https://token=@host/x`
  // keeps the host shown. One already masked (`token=sk-…`) isn't masked again: its own piece is what it hides. One taken
  // from the shell (`-var token=$TF_TOKEN`, as the agent is told to give it) is no secret, so it's shown, as a name's is
  // (both reviews' should on fix5: it was stopped again); a literal after `$` (`$'hunter2'`) is masked whole.
  [new RegExp(String.raw`\b(password|token)\s*=\s*(?!${FROM_SHELL}|["']?\[REDACTED)(?:\$?"[^"\r\n]*"|\$?'[^'\r\n]*'|(?<=:\/\/[^\s"'@]*)[^\s,;&"'@]*|[^\s,;&"']+)`, "gi"), (_, key) => `${key}=[REDACTED]`],
  // A name for a secret (`PGPASSWORD=hunter2 dropdb shop`, Fable's nit on stage 4's fix4): its literal value; one taken from
  // the shell (`NPM_TOKEN=$NPM_TOKEN`) is no secret, so it stays shown.
  [new RegExp(String.raw`\b(${SECRET_NAME})=(?!${FROM_SHELL}|["']?\[REDACTED)(?:\$?"[^"\r\n]*"|\$?'[^'\r\n]*'|\$?[^\s,;&"'$]+)`, "g"), (_, key) => `${key}=[REDACTED]`],
  // Colon-delimited secrets in prose/YAML/headers (`api_key: value`, `secret: value`).
  [new RegExp(String.raw`\b(${SECRET_NAME}\s*:\s+)(?!${FROM_SHELL}|["']?\[REDACTED)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"']+)`, "g"), (_, key) => `${key}[REDACTED]`],
];

/** `text` masked, each piece masked given to `seen` as it was before (what a masked command hides: gate.ts `hidesCode`). */
function mask(text: string, seen?: (span: string) => void): string {
  return MASKS.reduce((s, [re, to]) => s.replace(re, (span: string, key: string) => { seen?.(span); return to(span, key); }), text);
}

export const redactText = (text: string): string => mask(text);

/** The pieces of `text` that `redactText` masks, as they were. */
export function maskedSpans(text: string): string[] {
  const spans: string[] = [];
  mask(text, (span) => spans.push(span));
  return spans;
}

// `label`: a check's (stage 3.10), only ever a runner's name, redacted too should one ever carry a credential's shape.
// `headings`: a linked document's section headings.
const TEXT_FIELDS = new Set(["title", "group", "name", "text", "progress", "question", "prompt", "error", "message", "label", "headings"]);

/** Redact display text throughout snapshots and RPC results, keeping routing ids and reply refs intact. */
export function redactOutbound(value: unknown, field = ""): unknown {
  // A resource's contents are JSON text redacted field by field before encoding; redacting the encoding would break it.
  if (field === "contents") return value;
  if (typeof value === "string") return TEXT_FIELDS.has(field) || field === "value" ? redactText(value) : value;
  if (Array.isArray(value)) return value.map((v) => redactOutbound(v, field));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactOutbound(v, key)]));
  return value;
}
