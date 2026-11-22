// Settings → Privacy's two engine settings (docs/launch/engine.md §2, §6; stage 2a item 12): whether thread names show on
// the lock screen, and how 10 & 2 checks it's you before anything is sent. The account's own, kept in its brain's store
// beside Questions go stale (briefing.ts `staleAfterDays`), demo mode or not; the phone sends them with
// `PUT /api/account/privacy` and `GET /api/account` reads them back.
import type { ConfirmLevels } from "./proposals.ts";
import type { Store } from "./store.ts";

/**
 * "Check it's you before sending": `none` (Never), `unlocked` (Unlock the phone first, the default and today's), `faceid`
 * (Face ID every time). Its word in each question's push is `auth`, which picks the buttons' options (§6).
 */
export type Security = "none" | "unlocked" | "faceid";
/**
 * `asks` (stage 3.4; Fable, topic 13): What agents ask and say on the lock screen. Off, notifications say only that a
 * thread asked or replied: none of the agent's words, no answer buttons. On by default (as before it existed).
 */
export type Privacy = { names: boolean; security: Security; asks: boolean };

export const PRIVACY_DEFAULT: Privacy = { names: true, security: "unlocked", asks: true };
const SECURITIES: readonly string[] = ["none", "unlocked", "faceid"] satisfies Security[];
const KEY = "privacy";

/** The account's Privacy settings: what it set, else the defaults (names shown, unlock first). */
export function privacyOf(store: Pick<Store, "get">): Privacy {
  try {
    const p = JSON.parse(store.get(KEY) ?? "null");
    return p && typeof p.names === "boolean" && SECURITIES.includes(p.security) ? { names: p.names, security: p.security, asks: p.asks !== false } : PRIVACY_DEFAULT;
  } catch {
    return PRIVACY_DEFAULT;
  }
}

/** Privacy's settings kept; `asks` left out is on (as before it existed). */
export function setPrivacy(store: Pick<Store, "set">, p: Omit<Privacy, "asks"> & { asks?: boolean }) {
  store.set(KEY, JSON.stringify(p));
}

/**
 * `PUT /api/account/privacy`'s body: names and the level, each as it may be, and What agents ask and say (`asks`) if
 * given; an older phone leaves it out, and the account's stays as it was (`kept`). Undefined for anything else.
 */
export function privacyFrom(body: unknown, kept: Pick<Privacy, "asks"> = PRIVACY_DEFAULT): Privacy | undefined {
  const b = body as { names?: unknown; security?: unknown; asks?: unknown } | null;
  return b && typeof b === "object" && typeof b.names === "boolean" && typeof b.security === "string" && SECURITIES.includes(b.security) && (b.asks === undefined || typeof b.asks === "boolean")
    ? { names: b.names, security: b.security as Security, asks: typeof b.asks === "boolean" ? b.asks : kept.asks }
    : undefined;
}

/**
 * A call's confirm levels under Privacy's level: at Face ID every time a reply and a start go only with Send on the
 * phone (`tap`), whatever the phone sent for them, so a spoken yes is refused (proposals.ts) in every call, a call-back
 * answered on the lock screen included. Below it, the phone's own, as today. A new call's levels are made with it, and
 * Proposals applies it again at each yes and each send, so a level raised during a call holds at once.
 */
export function confirmUnder(levels: ConfirmLevels, p: Pick<Privacy, "security">): ConfirmLevels {
  return p.security === "faceid" ? { ...levels, reply: "tap", start: "tap" } : levels;
}
