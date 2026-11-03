// Device-code pairing (contracts §2): the connector asks to be paired, the user approves it on the website signed in
// with Clerk, and the connector collects its credential once.
export type Pairing = { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number };
export type Deps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tells the user where to go and what code to check; called once the pairing exists. */
  show: (p: Pairing) => void;
  signal?: AbortSignal;
};

/** The brain's https origin, from the policy's `wss://…/connector` (or an origin as given). */
export function originOf(brain: string): string {
  const u = new URL(brain);
  const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return `${protocol}//${u.host}`;
}
export const linkUrl = (origin: string) => `${origin.replace(/^http/, "ws")}/connector`;

async function post(f: typeof fetch, url: string, body: object, signal?: AbortSignal): Promise<any> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const json: any = await res.json().catch(() => null);
  if (res.status === 404) throw new Error(`There's no 10 & 2 at ${new URL(url).host}. Check the address you gave with --brain.`);
  if (!res.ok) throw new Error(json?.error ? String(json.error) : `10 & 2 couldn't start pairing (error ${res.status}). Try again in a minute.`);
  return json;
}

/** Pairs this machine; resolves with its credential, or throws when the code is denied, expires or the brain fails. */
export async function pair(origin: string, machine: { name: string; platform: string }, d: Deps): Promise<string> {
  const f = d.fetch ?? fetch;
  // Cancelling (Ctrl-C) ends the wait at once, not at the next poll.
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    d.signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  }));
  const p = await post(f, `${origin}/connector/pair`, machine, d.signal).catch((e) => {
    if (e instanceof TypeError) throw new Error(`Couldn't reach ${new URL(origin).host}. Check your internet connection and try again.`);
    throw e;
  }) as Pairing;
  if (typeof p?.deviceCode !== "string" || typeof p.userCode !== "string" || typeof p.verificationUrl !== "string") throw new Error("10 & 2's answer wasn't understood. Update with `npm i -g 10and2` and try again.");
  // Only open pages on the brain's own site: a compromised answer mustn't send the user elsewhere to sign in.
  if (new URL(p.verificationUrl).protocol !== "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(p.verificationUrl)) throw new Error("The approval page isn't on https.");
  d.show(p);
  const deadline = Date.now() + Math.max(1, p.expiresIn || 600) * 1000;
  const interval = Math.max(1, p.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (d.signal?.aborted) throw new Error("Pairing was cancelled.");
    const r = await post(f, `${origin}/connector/pair/poll`, { deviceCode: p.deviceCode }, d.signal).catch((e) => ({ status: "error", error: e }));
    if (r.status === "approved" && typeof r.credential === "string") return r.credential;
    if (r.status === "denied") throw new Error("This computer was turned down on the website.");
    if (r.status === "expired") throw new Expired();
    // pending, or a passing network failure: keep polling until the code expires.
  }
  throw new Expired();
}

/** The code ran out (10 minutes) before it was approved; setup offers a new one. */
export class Expired extends Error { constructor() { super("The code expired before it was approved."); } }
