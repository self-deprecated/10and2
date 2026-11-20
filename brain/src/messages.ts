// Messages to users (docs/launch/messages.md): what a message may say, whom its filters match, and which one an
// account gets. Pure: Ops checks a message with it before saving, and each account's brain chooses with it on
// `GET /api/account`. Nothing here reads storage or the clock.
import { FORBIDDEN } from "./user-text.ts";

export const KINDS = ["sheet", "card", "banner"] as const;
export type Kind = (typeof KINDS)[number];
export const STATES = ["draft", "staff", "live", "paused", "ended"] as const;
export type State = (typeof STATES)[number];
export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** The app's own icons a message may use: never an uploaded picture. */
export const ICONS = ["info", "ear", "bell", "phone", "sparkles", "car", "computer", "clock", "gear", "star", "bolt"] as const;
export type Icon = (typeof ICONS)[number];
export type Platform = "ios" | "android";

/** The most characters each field may have, after trimming. */
export const LIMITS = { title: 40, rowTitle: 30, rowLine: 80, sheetText: 240, cardText: 160, bannerText: 140, button: 24, note: 200, rows: 3, conditions: 3 } as const;
/** A message ends at most this long after it starts. */
export const MAX_DAYS = 90;
export const DEFAULT_CAP = 50;
const CAP_MAX = 1_000_000;
const DAY_MS = 86_400_000;
/** A bundle older than this serves no message: Ops couldn't be asked, and a stopped message mustn't come back. */
export const STALE_MS = 3600_000;

/** Whole days since 1 January 1970 (UTC): what the account's record keeps instead of times. */
export const dayNumber = (ms: number) => Math.floor(ms / DAY_MS);

/**
 * Where a button can go: a place in the app, never a link. `ios` and `android` are the first build on each that can
 * open it; a platform without one can't be shown a message that goes there. The first phone builds with the messages
 * code write their numbers here (steps 6 and 7 of the plan); until then no place opens anywhere.
 */
export type PlaceInfo = { label: string; ios?: string; android?: number };
export const PLACES = {
  settings: { label: "Settings" },
  "settings.calls": { label: "Settings → Calls" },
  "settings.listening": { label: "Settings → Listening" },
  "settings.reading": { label: "Settings → Reading replies" },
  "settings.privacy": { label: "Settings → Privacy" },
  "settings.memory": { label: "Settings → Memory" },
  account: { label: "Settings → Account" },
  plans: { label: "The paywall" },
  connect: { label: "Connect a computer" },
  drafts: { label: "Drafts" },
  timeline: { label: "Timeline" },
  update: { label: "Update the app" },
  "try.at-ear": { label: "Try raising it" },
} satisfies Record<string, PlaceInfo>;
export type Place = keyof typeof PLACES;
export type Places = Record<string, PlaceInfo>;

/**
 * What someone can have done, for the Has done filter. `read`: answered from what the brain already keeps (the ledger,
 * the plan), complete from the account's first day. `brain` and `phone`: the last day it happened is kept in the
 * account's record, from when that began; the phone reports its own (`POST /api/actions`).
 */
export type ActionInfo = { label: string; by: "read" | "brain" | "phone" };
export const ACTIONS = {
  call: { label: "Made a call", by: "read" },
  bought: { label: "Bought minutes", by: "read" },
  plan: { label: "Started a plan", by: "read" },
  reply: { label: "Sent a reply", by: "brain" },
  new_thread: { label: "Started a thread by voice", by: "brain" },
  dictated: { label: "Dictated a reply", by: "brain" },
  kept: { label: "Kept a reply for later", by: "brain" },
  wait: { label: "Asked to hear when a thread replies", by: "brain" },
  rung: { label: "Was called back", by: "brain" },
  reading: { label: "Had replies read aloud", by: "brain" },
  flagged: { label: "Flagged a moment in a call", by: "brain" },
  call_ear: { label: "Started a call at the ear", by: "phone" },
  call_raised: { label: "Raised the phone to the ear in a call", by: "phone" },
  call_hands_free: { label: "Started a call without opening the app", by: "phone" },
  briefing: { label: "Played the briefing", by: "phone" },
  paywall: { label: "Saw the paywall", by: "phone" },
} satisfies Record<string, ActionInfo>;
export type ActionName = keyof typeof ACTIONS;

/**
 * What an analytics event (contracts §5) shows the account did, among the actions the brain records: read where the
 * event is sent, whether or not it goes anywhere.
 */
export function actionsOf(event: string, props: Record<string, unknown> = {}): ActionName[] {
  switch (event) {
    case "reply_sent": return [props.new_thread === true ? "new_thread" : "reply", ...(props.dictated === true ? ["dictated" as const] : [])];
    case "reply_kept": return props.action === "kept" ? ["kept"] : [];
    case "wait_started": return ["wait"];
    case "ring_sent": return props.result === "sent" ? ["rung"] : [];
    case "reading_prepared": return ["reading"];
    case "debug_flagged": return ["flagged"];
    default: return [];
  }
}

export const PLAN_KINDS = ["none", "trial", "commute", "road_trip", "long_haul", "own_key", "demo"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const LABELS = ["tester", "presenter", "staff"] as const;
export type Label = (typeof LABELS)[number];
export const SEEN = ["seen", "tapped", "dismissed", "not_seen"] as const;

/** All that are given must hold; none given matches everyone. */
export type Filters = {
  platforms?: Platform[];
  /** The asking phone's build, each end included. A build filter holds back only its own platform's phones. */
  iosBuild?: { from?: string; to?: string };
  androidBuild?: { from?: number; to?: number };
  /** ISO 3166 alpha-2, upper case. A phone whose country isn't known matches neither. */
  country?: { is: string[] } | { not: string[] };
  joined?: { moreThanDays?: number; fewerThanDays?: number };
  plans?: PlanKind[];
  minutes?: "has" | "out";
  /** Any of them. */
  labels?: Label[];
  /** `connected`: a computer is paired now; `never`: none is. */
  computer?: "connected" | "never";
  did?: { action: ActionName; done: boolean; withinDays?: number }[];
  messages?: { id: string; is: (typeof SEEN)[number] }[];
};

export type Row = { icon: Icon; title: string; line: string };
export type Content = {
  icon: Icon;
  title?: string;
  text?: string;
  rows?: Row[];
  /** A sheet's and a card's button; a banner's has no label: the line itself opens the place. */
  button?: { label?: string; place: Place };
};

/** What staff write (Ops checks it with `parseMessage`). */
export type Draft = {
  kind: Kind;
  priority: Priority;
  /** Null: when it goes live. */
  startsAt: number | null;
  endsAt: number;
  content: Content;
  filters: Filters;
  /** It pauses after this many accounts have been shown it. */
  cap: number;
  note: string;
};

/** A message as the bundle carries it to every brain: only those with staff or live, inside their dates. */
export type Served = { id: string; kind: Kind; state: "staff" | "live"; priority: Priority; startsAt: number; endsAt: number; content: Content; filters: Filters };

export const MESSAGE_ID = /^m_[a-z0-9]{10}$/;
const COUNTRY = /^[A-Z]{2}$/;
const IOS_BUILD = /^\d{12}$/;

/** Why some words can't be shown, or null: one line of plain text within `max` characters that names no provider. */
export function textProblem(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.trim() === "") return "needs some words";
  if (v !== v.trim()) return "has spaces at an end";
  if ([...v].length > max) return `is longer than ${max} characters`;
  if (/[\u0000-\u001f\u007f\u2028\u2029<>]/.test(v)) return "must be one line of plain text";
  if (/https?:\/\/|\bwww\./i.test(v)) return "has a link: a button opens a place in the app instead";
  if (/[*`]|__|\]\(|^#/.test(v)) return "has Markdown: the app shows it as written";
  if (FORBIDDEN.test(v)) return "names the AI provider or a model, which messages never do (say \"AI\" or \"the voice model\")";
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** A list of some of `all`, each once. */
const some = <T extends string>(v: unknown, all: readonly T[]): v is T[] => Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every((x) => (all as readonly unknown[]).includes(x));
/** The keys of `o` that aren't in `known`. */
const extra = (o: Record<string, unknown>, known: readonly string[]) => Object.keys(o).filter((k) => !known.includes(k));

function parseContent(kind: Kind, raw: unknown, problems: string[], places: Places): Content | null {
  if (!isObject(raw)) return (problems.push("content must be an object"), null);
  for (const k of extra(raw, ["icon", "title", "text", "rows", "button"])) problems.push(`content has no ${k}`);
  const say = (what: string, why: string | null) => why && problems.push(`${what} ${why}`);
  if (!(ICONS as readonly unknown[]).includes(raw.icon)) problems.push(`icon must be one of ${ICONS.join(", ")}`);
  const content: Content = { icon: raw.icon as Icon };
  if (kind === "banner") {
    if (raw.title !== undefined || raw.rows !== undefined) problems.push("a banner is one line: no title or rows");
  } else {
    say("title", textProblem(raw.title, LIMITS.title));
    content.title = raw.title as string;
  }
  if (kind === "sheet" && raw.rows !== undefined) {
    if (raw.text !== undefined) problems.push("a sheet has rows or text, not both");
    if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > LIMITS.rows) problems.push(`rows must be 1 to ${LIMITS.rows}`);
    else {
      content.rows = raw.rows.map((r, i) => {
        if (!isObject(r)) return (problems.push(`row ${i + 1} must be an object`), r as Row);
        for (const k of extra(r, ["icon", "title", "line"])) problems.push(`row ${i + 1} has no ${k}`);
        if (!(ICONS as readonly unknown[]).includes(r.icon)) problems.push(`row ${i + 1}'s icon must be one of ${ICONS.join(", ")}`);
        say(`row ${i + 1}'s bold words`, textProblem(r.title, LIMITS.rowTitle));
        say(`row ${i + 1}'s line`, textProblem(r.line, LIMITS.rowLine));
        return { icon: r.icon as Icon, title: r.title as string, line: r.line as string };
      });
    }
  } else {
    if (raw.rows !== undefined) problems.push("only a sheet has rows");
    say("text", textProblem(raw.text, kind === "sheet" ? LIMITS.sheetText : kind === "card" ? LIMITS.cardText : LIMITS.bannerText));
    content.text = raw.text as string;
  }
  if (raw.button === undefined) {
    if (kind !== "banner") problems.push("a button to a place is needed");
    return content;
  }
  if (!isObject(raw.button)) return (problems.push("button must be an object"), content);
  for (const k of extra(raw.button, ["label", "place"])) problems.push(`button has no ${k}`);
  const place = raw.button.place;
  if (typeof place !== "string" || !Object.hasOwn(places, place)) problems.push(`the button's place must be one of ${Object.keys(places).join(", ")}`);
  if (kind === "banner") {
    if (raw.button.label !== undefined) problems.push("a banner's button has no label: the line opens the place");
    content.button = { place: place as Place };
  } else {
    say("the button", textProblem(raw.button.label, LIMITS.button));
    content.button = { label: raw.button.label as string, place: place as Place };
  }
  return content;
}

function parseFilters(raw: unknown, problems: string[]): Filters {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) return (problems.push("filters must be an object"), {});
  const known = ["platforms", "iosBuild", "androidBuild", "country", "joined", "plans", "minutes", "labels", "computer", "did", "messages"];
  for (const k of extra(raw, known)) problems.push(`there's no ${k} filter`);
  const f: Filters = {};
  const given = (k: string) => raw[k] !== undefined && raw[k] !== null;
  if (given("platforms")) some(raw.platforms, ["ios", "android"] as const) ? (f.platforms = raw.platforms) : problems.push("platforms must be ios, android or both");
  if (given("iosBuild")) {
    const b = raw.iosBuild as { from?: unknown; to?: unknown };
    const ok = isObject(b) && !extra(b, ["from", "to"]).length && [b.from, b.to].every((x) => x === undefined || (typeof x === "string" && IOS_BUILD.test(x))) && (b.from !== undefined || b.to !== undefined);
    if (!ok) problems.push("the iPhone build is from, to or both, each 12 digits");
    else if (b.from !== undefined && b.to !== undefined && (b.from as string) > (b.to as string)) problems.push("the iPhone build's from is after its to");
    else f.iosBuild = b as Filters["iosBuild"];
  }
  if (given("androidBuild")) {
    const b = raw.androidBuild as { from?: unknown; to?: unknown };
    const ok = isObject(b) && !extra(b, ["from", "to"]).length && [b.from, b.to].every((x) => x === undefined || whole(x, 1, 2_100_000_000)) && (b.from !== undefined || b.to !== undefined);
    if (!ok) problems.push("the Android build is from, to or both, each a version code");
    else if (b.from !== undefined && b.to !== undefined && (b.from as number) > (b.to as number)) problems.push("the Android build's from is after its to");
    else f.androidBuild = b as Filters["androidBuild"];
  }
  // A build filter for a platform the message leaves out says two different things.
  if (f.platforms && f.iosBuild && !f.platforms.includes("ios")) problems.push("an iPhone build is given, but the iPhone isn't one of the platforms");
  if (f.platforms && f.androidBuild && !f.platforms.includes("android")) problems.push("an Android build is given, but Android isn't one of the platforms");
  if (given("country")) {
    const c = raw.country as { is?: unknown; not?: unknown };
    const list = isObject(c) && Object.keys(c).length === 1 ? (c.is ?? c.not) : null;
    if (!Array.isArray(list) || !list.length || list.length > 250 || new Set(list).size !== list.length || !list.every((x) => typeof x === "string" && COUNTRY.test(x))) {
      problems.push("country is `is` or `not`, with two-letter country codes in capitals");
    } else f.country = c as Filters["country"];
  }
  if (given("joined")) {
    const j = raw.joined as { moreThanDays?: unknown; fewerThanDays?: unknown };
    const ok = isObject(j) && !extra(j, ["moreThanDays", "fewerThanDays"]).length && [j.moreThanDays, j.fewerThanDays].every((x) => x === undefined || whole(x, 0, 3650)) && (j.moreThanDays !== undefined || j.fewerThanDays !== undefined);
    if (!ok) problems.push("joined is more than, fewer than or both, in whole days");
    else if (j.moreThanDays !== undefined && j.fewerThanDays !== undefined && (j.fewerThanDays as number) - (j.moreThanDays as number) < 2) problems.push("joined leaves no day between more than and fewer than");
    else f.joined = j as Filters["joined"];
  }
  if (given("plans")) some(raw.plans, PLAN_KINDS) ? (f.plans = raw.plans) : problems.push(`plans must be some of ${PLAN_KINDS.join(", ")}`);
  if (given("minutes")) raw.minutes === "has" || raw.minutes === "out" ? (f.minutes = raw.minutes) : problems.push("minutes is has or out");
  if (given("labels")) some(raw.labels, LABELS) ? (f.labels = raw.labels) : problems.push(`labels must be some of ${LABELS.join(", ")}`);
  if (given("computer")) raw.computer === "connected" || raw.computer === "never" ? (f.computer = raw.computer) : problems.push("computer is connected or never");
  if (given("did")) {
    const ok = Array.isArray(raw.did) && raw.did.length >= 1 && raw.did.length <= LIMITS.conditions && raw.did.every((d) =>
      isObject(d) && !extra(d, ["action", "done", "withinDays"]).length && typeof d.action === "string" && Object.hasOwn(ACTIONS, d.action) && typeof d.done === "boolean" && (d.withinDays === undefined || whole(d.withinDays, 1, 3650)));
    ok ? (f.did = raw.did as Filters["did"]) : problems.push(`has done is 1 to ${LIMITS.conditions} conditions: an action, done or not, and optionally within so many days`);
  }
  if (given("messages")) {
    const ok = Array.isArray(raw.messages) && raw.messages.length >= 1 && raw.messages.length <= LIMITS.conditions && raw.messages.every((m) =>
      isObject(m) && !extra(m, ["id", "is"]).length && typeof m.id === "string" && MESSAGE_ID.test(m.id) && (SEEN as readonly unknown[]).includes(m.is));
    ok ? (f.messages = raw.messages as Filters["messages"]) : problems.push(`messages is 1 to ${LIMITS.conditions} conditions: a message's id, and ${SEEN.join(", ")}`);
  }
  return f;
}

/**
 * A message as staff wrote it, checked: every reason it can't be saved, or the draft. `now` is when it would start if
 * it has no start of its own. The app copy rules (demo-mode.md) are the writer's: only a person can check those.
 */
export function parseMessage(raw: unknown, now: number, places: Places = PLACES): { ok: true; draft: Draft } | { ok: false; problems: string[] } {
  if (!isObject(raw)) return { ok: false, problems: ["a message must be an object"] };
  const problems: string[] = [];
  for (const k of extra(raw, ["kind", "priority", "startsAt", "endsAt", "content", "filters", "cap", "note"])) problems.push(`a message has no ${k}`);
  const kind = (KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as Kind) : null;
  if (!kind) problems.push(`kind must be one of ${KINDS.join(", ")}`);
  const priority = raw.priority === undefined ? "normal" : (raw.priority as Priority);
  if (!(PRIORITIES as readonly unknown[]).includes(priority)) problems.push(`priority must be one of ${PRIORITIES.join(", ")}`);
  const startsAt = raw.startsAt === undefined || raw.startsAt === null ? null : (raw.startsAt as number);
  if (startsAt !== null && !whole(startsAt, 0, Number.MAX_SAFE_INTEGER)) problems.push("startsAt must be a time in ms, or null for when it goes live");
  const endsAt = raw.endsAt as number;
  if (!whole(endsAt, 0, Number.MAX_SAFE_INTEGER)) problems.push("endsAt is needed, a time in ms");
  else {
    const start = typeof startsAt === "number" ? Math.max(startsAt, now) : now;
    if (endsAt <= start) problems.push("it ends before it starts");
    else if (endsAt - start > MAX_DAYS * DAY_MS) problems.push(`it ends more than ${MAX_DAYS} days after it starts`);
  }
  const cap = raw.cap === undefined ? DEFAULT_CAP : (raw.cap as number);
  if (!whole(cap, 1, CAP_MAX)) problems.push(`the cap must be a whole number from 1 to ${CAP_MAX}`);
  const note = typeof raw.note === "string" ? raw.note.trim().replace(/\s+/g, " ") : "";
  if (!note || note.length > LIMITS.note) problems.push(`a note of 1 to ${LIMITS.note} characters says why`);
  const content = kind ? parseContent(kind, raw.content, problems, places) : null;
  const filters = parseFilters(raw.filters, problems);
  if (problems.length || !kind || !content) return { ok: false, problems };
  return { ok: true, draft: { kind, priority, startsAt, endsAt, content, filters, cap, note } };
}

/**
 * Whether this code knows everything `m` asks for. A brain a deploy behind Ops (a live call keeps its code to the end)
 * mustn't serve a message whose newer filter it would ignore, to everyone that filter was meant to leave out.
 */
export function understood(m: Served): boolean {
  const problems: string[] = [];
  parseFilters(m.filters, problems);
  return !problems.length && (KINDS as readonly unknown[]).includes(m.kind) && Object.hasOwn(RANK, m.priority);
}

/** The phone that asks: its platform and build, from `x-driver-build` (iOS sends 12 digits, Android "android 0.1 (57)"). */
export type App = { platform: Platform; build: string };
export function appOf(header: string | null | undefined): App | null {
  const h = (header ?? "").trim();
  if (IOS_BUILD.test(h)) return { platform: "ios", build: h };
  const code = /^android\b.*\((\d{1,10})\)$/i.exec(h)?.[1];
  return code ? { platform: "android", build: String(Number(code)) } : null;
}

/** Whether `app` can open `place`: its build is the first with it, or later. */
export function opens(place: string, app: App, places: Places = PLACES): boolean {
  const p = Object.hasOwn(places, place) ? places[place] : null;
  if (!p) return false;
  return app.platform === "ios" ? !!p.ios && app.build >= p.ios : p.android !== undefined && Number(app.build) >= p.android;
}

/** What this account has had of a message, as its brain keeps it (`cloud_messages`). */
export type Seen = { servedAt?: number | null; shownAt?: number | null; tappedAt?: number | null; dismissedAt?: number | null };
/** Done for the account: a sheet once it's shown; a card or banner once its button, Not now or OK is tapped. */
export const done = (kind: Kind, seen: Seen | undefined): boolean => !!seen && !!(seen.tappedAt || seen.dismissedAt || (kind === "sheet" && seen.shownAt));

/** What the brain knows of the account and the asking phone, for one choice. Nothing here is kept for it. */
export type Facts = {
  app: App;
  /** The store's country if the phone sent it, else the connection's guess; null when neither is known. */
  country: string | null;
  /** Today and the day the account started, as day numbers. */
  today: number;
  since: number;
  plan: PlanKind;
  outOfMinutes: boolean;
  labels: Label[];
  /** Computers paired now. */
  computers: number;
  /** The last day of each action: the record's, and those read from the ledger and the plan. None: never. */
  did: Partial<Record<ActionName, number>>;
  seen: Record<string, Seen>;
};

/** Whether `filters` match: every one given must hold. */
export function matches(filters: Filters, x: Facts): boolean {
  const { app } = x;
  if (filters.platforms && !filters.platforms.includes(app.platform)) return false;
  if (app.platform === "ios" && filters.iosBuild) {
    const { from, to } = filters.iosBuild;
    if ((from !== undefined && app.build < from) || (to !== undefined && app.build > to)) return false;
  }
  if (app.platform === "android" && filters.androidBuild) {
    const { from, to } = filters.androidBuild, build = Number(app.build);
    if ((from !== undefined && build < from) || (to !== undefined && build > to)) return false;
  }
  if (filters.country) {
    if (!x.country) return false;
    if ("is" in filters.country ? !filters.country.is.includes(x.country) : filters.country.not.includes(x.country)) return false;
  }
  if (filters.joined) {
    const days = x.today - x.since, { moreThanDays, fewerThanDays } = filters.joined;
    if ((moreThanDays !== undefined && !(days > moreThanDays)) || (fewerThanDays !== undefined && !(days < fewerThanDays))) return false;
  }
  if (filters.plans && !filters.plans.includes(x.plan)) return false;
  if (filters.minutes && (filters.minutes === "out") !== x.outOfMinutes) return false;
  if (filters.labels && !filters.labels.some((l) => x.labels.includes(l))) return false;
  if (filters.computer && (filters.computer === "connected") !== x.computers > 0) return false;
  for (const c of filters.did ?? []) {
    const last = x.did[c.action];
    const did = last !== undefined && (c.withinDays === undefined || x.today - last <= c.withinDays);
    if (did !== c.done) return false;
  }
  for (const c of filters.messages ?? []) {
    const s = x.seen[c.id];
    const is = c.is === "seen" ? !!s?.shownAt : c.is === "not_seen" ? !s?.shownAt : c.is === "tapped" ? !!s?.tappedAt : !!s?.dismissedAt;
    if (!is) return false;
  }
  return true;
}

/** What the brain holds when it chooses: the bundle's messages and its age, and when this account was last shown one. */
export type Choosing = { off: boolean; bundleAt: number | null; lastShownAt: number | null };

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The one message this account gets now, or null (docs/launch/messages.md, Which message an account gets). One it
 * was already served and isn't done with keeps its place; otherwise a new one only when none was shown in the last 24
 * hours, the highest priority first, then the earliest start, then the id. A message with staff reaches staff only,
 * whatever its filters.
 */
export function pick(messages: readonly Served[], state: Choosing, x: Facts, now: number, places: Places = PLACES): Served | null {
  if (state.off || state.bundleAt === null || now - state.bundleAt >= STALE_MS) return null;
  const staff = x.labels.includes("staff");
  const eligible = messages.filter((m) =>
    (m.state === "live" ? matches(m.filters, x) : m.state === "staff" && staff)
    && m.startsAt <= now && now < m.endsAt
    && (!m.content.button || opens(m.content.button.place, x.app, places))
    && !done(m.kind, x.seen[m.id])
    && understood(m));
  const order = (a: Served, b: Served) => RANK[a.priority] - RANK[b.priority] || a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1);
  const waiting = eligible.filter((m) => x.seen[m.id]?.servedAt).sort((a, b) => x.seen[a.id].servedAt! - x.seen[b.id].servedAt! || order(a, b));
  if (waiting.length) return waiting[0];
  if (state.lastShownAt !== null && now - state.lastShownAt < DAY_MS) return null;
  return eligible.sort(order)[0] ?? null;
}

/** A message as the phone gets it in `/api/account`: what to draw, nothing about whom it's for. */
export type Shown = { id: string; kind: Kind; icon: Icon; title?: string; text?: string; rows?: Row[]; button?: { label?: string; place: Place } };
export const shownOf = (m: Pick<Served, "id" | "kind" | "content">): Shown => ({ id: m.id, kind: m.kind, ...m.content });
