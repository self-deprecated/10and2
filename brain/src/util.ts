import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which brain this is: the revision Nix baked into the package (`revision`, next to `src/`), or else the commit of the
 * checkout it runs from, or "dev". Read once at start.
 */
export function brainRev(root = fileURLToPath(new URL("..", import.meta.url).href)): string {
  try {
    const baked = readFileSync(join(root, "revision"), "utf8").trim();
    if (baked) return baked;
  } catch {}
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}
/** Runs `f` over `xs` with at most `n` in flight. */
export async function mapLimit<T>(xs: T[], n: number, f: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) {
      const k = i++;
      await f(xs[k], k);
    }
  }));
}

/** Runs at most `n` of the calls given to it at once; the rest wait their turn. */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await f();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** A pending timer, as `Clock` hands it out. */
export type Timer = { unref(): unknown };

/** Time and timers for a voice session and the waits: tests move a fake one on instead of sleeping. */
export type Clock = {
  now(): number;
  setTimeout(f: () => void, ms: number): Timer;
  setInterval(f: () => void, ms: number): Timer;
  clear(t: Timer): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  setInterval: (f, ms) => setInterval(f, ms),
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
};

/** How long ago, for the ear: "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
/** This machine as it's said: its host name, capitalized ("Lattice"). */
export function spokenHost(): string {
  const here = hostname().split(".")[0];
  return here.charAt(0).toUpperCase() + here.slice(1);
}

export function ago(at: string | number, now: number): string {
  const m = Math.round((now - (typeof at === "number" ? at : Date.parse(at))) / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} ${h === 1 ? "hour" : "hours"} ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * An error for the log. Socket failures often have no message of their own: Node's `AggregateError` keeps the reasons in
 * `errors` (one per address tried), and the OpenAI SDK copies the empty message and keeps the original in `cause`.
 * Credentials that a nested message can quote (a URL's password, a token in its query, a bearer token) are masked, and
 * describing never throws, so it can't hide the failure it describes.
 */
export function describe(e: unknown): string {
  try {
    return redact(explain(e, 0));
  } catch {
    return "(an error that couldn't be described)";
  }
}

function explain(e: unknown, depth: number): string {
  if (!(e instanceof Error)) return String(e);
  const { code, errors, cause } = e as Error & { code?: unknown; errors?: unknown[]; cause?: unknown };
  let text = e.message || (typeof code === "string" ? code : e.name);
  if (typeof code === "string" && !text.includes(code)) text += ` (${code})`;
  if (depth < 3 && Array.isArray(errors) && errors.length) text += `: ${errors.map((x) => explain(x, depth + 1)).join("; ")}`;
  else if (depth < 3 && cause !== undefined && cause !== e) text += `: ${explain(cause, depth + 1)}`;
  return text;
}

/** A query parameter that holds a credential: the name has one of these as a whole word ("auth[token]", "api_key"). */
const SECRET_PARAM =
  /(?:^|[^a-z])(?:access_?token|token|api_?key|key|secret|password|passwd|pwd|auth|authorization|cookie|sig|signature)(?:[^a-z]|$)/i;

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Names that hold a credential, case-insensitive, with `-`/`_` or camelCase: api_key, apiKey, x-api-key, client_secret,
 * password/passwd/pwd, any *_token or *Token (access_token, refreshToken, id_token…), authorization, cookie/set-cookie,
 * secret, private_key, the access code. `redact` and the session recordings' field filter both use it. A name is one
 * word of at most 64 characters, so testing one takes no time.
 */
const CREDENTIAL_END = /(?:api[-_]?key|secret|password|passwd|pwd|token|authorization|cookie|private[-_]?key|access[-_]?code|driver[-_]access)$/i;
export const credentialName = (name: string) => name.length <= 64 && /^[\w-]+$/.test(name) && CREDENTIAL_END.test(name);

/** `name: value` or `name=value`, the name quoted or not: where a credential's value may follow. */
const KEYED = /(?<![\w-])(["']?)([\w-]{1,64})\1([ \t]*[:=][ \t]*)/g;
/** Header names whose whole value is the credential (an auth scheme and its credential, every cookie). */
const WHOLE_HEADER = /(?:authorization|cookie)$/i;

/**
 * Where a credential's value starting at `i` ends. A quoted value is the whole quoted string, escapes and all. As a
 * header (`Authorization: …`, `Cookie: …`) it runs to the end of the line, or to the quote the header sits in
 * (`-H 'Authorization: …'`); as prose (`password: two words`) to the end of the line, sentence or clause; given with
 * `=` (`api_key=…`) to the next space or separator. One pass over the value, so the whole of `redact` stays linear.
 */
function valueEnd(text: string, i: number, name: string, colon: boolean, outer: string | undefined): number {
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === quote) return j + 1;
      else if (text[j] === "\n" || text[j] === "\r") return j;
    }
    return text.length;
  }
  const header = colon && WHOLE_HEADER.test(name);
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\n" || c === "\r" || c === outer) return j;
    if (!colon) {
      if (/[\s"'&,;}#]/.test(c)) return j;
    } else if (!header) {
      if (",;}]".includes(c)) return j;
      if (".!?".includes(c) && (j + 1 === text.length || /\s/.test(text[j + 1]))) return j;
    }
  }
  return text.length;
}

/** Masks the value of every `name: value` or `name=value` whose name is a credential's. */
function maskKeyed(text: string): string {
  let out = "";
  let from = 0;
  KEYED.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = KEYED.exec(text)); ) {
    const [all, quote, name, sep] = m;
    if (!credentialName(name)) continue;
    const start = m.index + all.length;
    // A header inside a quoted string ends at that string's closing quote.
    const before = text[m.index - 1];
    const end = valueEnd(text, start, name, sep.includes(":"), !quote && (before === '"' || before === "'") ? before : undefined);
    if (end === start) continue;
    const q = text[start] === '"' || text[start] === "'" ? text[start] : "";
    out += text.slice(from, start) + (q ? `${q}***${end - start > 1 && text[end - 1] === q ? q : ""}` : "***");
    from = KEYED.lastIndex = end;
  }
  return out + text.slice(from);
}

/** The most of one string `redact` looks at: the rest is cut, so no text, however odd, can hold up the brain. */
export const REDACT_MAX = 16 * 1024;

/** A string cut to `REDACT_MAX` at most, its marker ("[truncated N bytes]") included, so cutting it again changes nothing. */
export function truncate(text: string): string {
  if (text.length <= REDACT_MAX) return text;
  const keep = REDACT_MAX - 32;
  return `${copied(text.slice(0, keep))}[truncated ${Buffer.byteLength(text.slice(keep))} bytes]`;
}

/** A string in storage of its own: a slice of a long string would otherwise keep all of it in memory. */
export const copied = (text: string) => Buffer.from(text, "utf8").toString("utf8");

/**
 * Masks credentials a text may quote: URL userinfo, secret query parameters, keyed values (see `valueEnd`), bearer and
 * OpenAI keys. Text past `REDACT_MAX` is cut first. Every rule is linear in the text's length.
 */
export function redact(text: string): string {
  return redactWhole(truncate(text));
}

/**
 * `redact` without the cut: for text that must be kept whole (a reply read out in full). The rules are linear, so this
 * is bounded by the text's own length; callers bound that.
 */
export function redactWhole(text: string): string {
  return maskKeyed(
    text
      // Userinfo runs to the authority's last "@": a password can contain one.
      .replace(/(\/\/)[^\s/?#]*@/g, "$1***@")
      .replace(/([?&])([^=&?\s#]+)=([^&\s#]*)/g, (all, sep, name, value) => (SECRET_PARAM.test(decoded(name)) && value ? `${sep}${name}=***` : all))
      .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1***"),
  )
    .replace(/\bsk-[\w-]{8,}/g, "sk-***")
    // OpenAI's ephemeral client secrets.
    .replace(/\bek_[\w-]{8,}/g, "ek_***");
}
