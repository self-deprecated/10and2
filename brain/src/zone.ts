// Time on the user's clock (docs/launch/engine.md §7, Time zones; §11 stage 3.6, with Fable's decisions, topics 1 and
// 15). The zone is the phone's (`ring_phone.tz`, the latest it sent), never named: nothing says a zone, an offset or
// "UTC". A one-off time is an instant fixed when it's made; "not before seven" is a clock time on the user's day,
// wherever the phone is when it comes, so it's kept as a local date and time and read in the zone of the moment.
//
// Two ways to say a time, one function each, so following the phone's own 12- or 24-hour setting later is one change:
// spoken (every readback and fixed spoken line: the half of the day is always said, since a bare hour is misheard), and
// shown (Watching, notifications: 24-hour, "19:00", with " tomorrow" when it isn't today's date as it's read).
//
// Stage 3.8 (§11 item 8) makes this the one zone module: main's `validZone`, spike/timed-send's reading of a local
// date-time (`localInstant`, for `parseUntil`), spike/scheduled-briefing's `nextBriefingAt` as `nextEvery` (with §7's one
// firing per local date, so a flight west after 8:00 doesn't fire it again), and a time named for a deadline or a
// check-in (`parseWhen`: a length from now, or a time of day on the phone's clock).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `zone` when it's a time zone this runtime knows (an IANA name, "Europe/Copenhagen"); else null. */
export function validZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone || zone.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** `at` on the clock in `zone`: its local date ("2026-11-19"), hour (0-23), minute and weekday. */
export function clockOf(at: number, zone: string): { date: string; hour: number; minute: number; weekday: string } {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long", hourCycle: "h23" });
    formats.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday };
}

/** The local date after `date` ("2026-11-19" → "2026-11-20"). */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY).toISOString().slice(0, 10);
}

/** The local date before `date`. */
export function prevDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY).toISOString().slice(0, 10);
}

/** A local date's weekday, 0 (Sunday) to 6. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** What the clock in `zone` reads at `at`, as if it were UTC: the wall time, to compare with another. */
function wallOf(at: number, zone: string): number {
  const c = clockOf(at, zone);
  const [y, m, d] = c.date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, c.hour, c.minute) + (at % MIN);
}

/**
 * The instant the clock in `zone` reads `time` ("19:00") on `date`. A time that doesn't exist that day (the spring
 * change) is the next valid minute; one that comes twice (the autumn change) is the first.
 */
export function instantOf(date: string, time: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // The offsets either side of any change near it: each gives one instant; one or both read the wall time.
  const tries = [...new Set([wall - (wallOf(wall - DAY, zone) - (wall - DAY)), wall - (wallOf(wall + DAY, zone) - (wall + DAY))])].sort((a, b) => a - b);
  const exact = tries.filter((t) => wallOf(t, zone) === wall);
  if (exact.length) return exact[0];
  // In the gap: the first minute whose wall time is at or past it.
  let lo = tries[0];
  let hi = tries[tries.length - 1];
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
    if (wallOf(mid, zone) >= wall) hi = mid;
    else lo = mid;
  }
  return wallOf(lo, zone) >= wall ? lo : hi;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The time as shown (Watching, notifications): "19:00", "03:05 tomorrow", or "Friday 08:00" further on. */
export function shownClock(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  const hm = `${pad(c.hour)}:${pad(c.minute)}`;
  if (c.date === today) return hm;
  return c.date === nextDate(today) ? `${hm} tomorrow` : `${c.weekday} ${hm}`;
}

/** How many dates `date` is from `today` (both YYYY-MM-DD): 0 today, 1 tomorrow, -1 yesterday. */
const datesFrom = (today: string, date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/**
 * A date a week or more away, which its weekday alone can't name (the same weekday comes round), with its day of the
 * month: "Monday the 30th" (Fable on 3.9 and 3.10: "…not until Monday at 8 in the morning. It would end Monday at 6 in
 * the evening instead." named two Mondays). Null for one within the week, which its weekday names.
 */
function farDay(c: { date: string; weekday: string }, today: string): string | null {
  if (Math.abs(datesFrom(today, c.date)) < 7) return null;
  const d = Number(c.date.slice(8, 10));
  const th = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
  return `${c.weekday} the ${d}${th}`;
}

/** The time of day as said, with no day: "7 in the evening", "3:05 in the morning", "noon", "midnight". */
function spokenTime(c: { hour: number; minute: number }): string {
  if (c.hour === 0 && c.minute === 0) return "midnight";
  if (c.hour === 12 && c.minute === 0) return "noon";
  const hm = c.minute ? `${c.hour % 12 || 12}:${pad(c.minute)}` : `${c.hour % 12 || 12}`;
  return `${hm} in the ${c.hour < 12 ? "morning" : c.hour < 18 ? "afternoon" : "evening"}`;
}

/**
 * The time as said (every readback and fixed spoken line): "7 in the evening", "3:05 in the morning", "noon",
 * "midnight"; on the next date "7 tomorrow morning", "2:30 tomorrow afternoon", "noon tomorrow". Midnight starting
 * tomorrow is tonight's, "midnight". Later in the week by its weekday ("7 on Friday evening"); a week or more away,
 * with its date too ("8 in the morning on Monday the 30th").
 */
export function spokenClock(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  const far = farDay(c, today);
  if (far) return `${spokenTime(c)} on ${far}`;
  const tomorrow = nextDate(today);
  if (c.hour === 0 && c.minute === 0) return c.date === tomorrow || c.date === today ? "midnight" : c.date === nextDate(tomorrow) ? "midnight tomorrow" : `midnight on ${c.weekday}`;
  const when = c.date === today ? "" : c.date === tomorrow ? "tomorrow" : `on ${c.weekday}`;
  if (c.hour === 12 && c.minute === 0) return when ? `noon ${when}` : "noon";
  const hm = c.minute ? `${c.hour % 12 || 12}:${pad(c.minute)}` : `${c.hour % 12 || 12}`;
  const part = c.hour < 12 ? "morning" : c.hour < 18 ? "afternoon" : "evening";
  if (!when) return `${hm} in the ${part}`;
  return when === "tomorrow" ? `${hm} tomorrow ${part}` : `${hm} ${when} ${part}`;
}

/**
 * A time as Away's fixed lines say it (stage 3.9; Fable, 3.9-E): as `spokenClock` today and tomorrow ("8 in the
 * morning", "8 tomorrow morning"); a day past tomorrow, or before today, leads with its weekday ("Monday at 8 in the
 * morning", "Friday at 6 in the evening"), yesterday with "yesterday" ("yesterday at 2 in the afternoon"), and a day a
 * week or more away with its date too ("Monday the 30th at 8 in the morning").
 */
export function spokenDay(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  if (c.date === today || c.date === nextDate(today)) return spokenClock(at, zone, now);
  return `${c.date === prevDate(today) ? "yesterday" : (farDay(c, today) ?? c.weekday)} at ${spokenTime(c)}`;
}

/**
 * A length as said, what is kept and no rounder (Fable's finding on 3.6 to 3.8): "an hour", "2 hours", "90 minutes"
 * (minutes under two hours when not whole hours), "a minute"; from two hours, a half as "2 and a half hours", anything
 * else as hours and minutes, "2 hours 15 minutes".
 */
export function spokenLength(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MIN));
  if (minutes % 60 === 0) return minutes === 60 ? "an hour" : `${minutes / 60} hours`;
  if (minutes < 120) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 30 ? `${hours} and a half hours` : `${hours} hours ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

const HOURS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const UNITS = "one|two|three|four|five|six|seven|eight|nine";
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
/** Minutes in words: "oh five", "ten", "fifteen", "twenty", "forty five", "fifty". */
const MINUTE_WORDS = `(?:oh (?:${UNITS})|(?:${Object.keys(TENS).join("|")})(?: (?:${UNITS}))?|${Object.keys(TEENS).join("|")})`;
/** An hour as said: digits, a word, noon or midnight. */
const HOUR_TOKEN = `(\\d{1,2}|${Object.keys(HOURS).join("|")}|noon|midday|midnight)`;
/**
 * Any number left over once a time is read, a half or a quarter too: the time heard is unclear ("8 or 9", "after two and
 * a half"), so none is guessed.
 */
const LEFT_OVER = new RegExp(`\\b(\\d+|${[...Object.keys(HOURS), ...Object.keys(TEENS), ...Object.keys(TENS)].join("|")}|half|quarters?)\\b|[½¼¾]`);
/** A length's unit. */
const UNIT = /\b(hours?|hrs?|minutes?|mins?)\b/i;

/** Minutes as said in words or digits ("twenty five", "oh five", "10"). */
function minutesOf(said: string): number {
  if (/^\d+$/.test(said)) return Number(said);
  const [a, b] = said.replace(/^oh /, "").split(" ");
  return (TENS[a] ?? TEENS[a] ?? HOURS[a] ?? 0) + (b ? HOURS[b] : 0);
}

/** A clock time as heard: its hour (0-23 when its half is known, else 1-12), minute, and whether it was said for tomorrow. */
export type Heard = { hour: number; minute: number; half: "am" | "pm" | null; tomorrow: boolean };

/**
 * A time of day as the user said it ("seven", "7:30", "seven thirty", "seven fifty", "seven oh five", "seven in the
 * evening", "7pm", "19:00", "noon", "half past six", "twenty to eight", "half seven", "quarter to midnight", "tomorrow
 * morning at 8", "12 tonight", "3 in the night"), or null when it isn't one, or when a number is left over that it can't
 * place ("8 or 9"): never a rounder time guessed. A 24-hour clock is a leading zero ("07:00") or an hour past 12 ("19:00");
 * "10:30" is a bare hour, as "ten thirty" is, the next time it comes round. At night, 12 is midnight and 1 to 5 the
 * small hours.
 */
export function parseClock(said: string): Heard | null {
  const s = ` ${said.toLowerCase()} `.replace(/(\d)(am|pm|a\.m\.|p\.m\.)/g, "$1 $2").replace(/a\.m\.|\ba ?m\b/g, " am ").replace(/p\.m\.|\bp ?m\b/g, " pm ")
    .replace(/o'?clock/g, " ").replace(/(\p{L})-(\p{L})/gu, "$1 $2").replace(/[,!?]/g, " ").replace(/\s+/g, " ");
  const tomorrow = /\btomorrow\b/.test(s);
  /** The hour said, as a 24-hour clock when it's noon, midnight or written as one, else 1-12. */
  const hourOf = (t: string): { hour: number; clock24: boolean } | null => {
    if (t === "noon" || t === "midday") return { hour: 12, clock24: true };
    if (t === "midnight") return { hour: 0, clock24: true };
    if (/^\d+$/.test(t)) return { hour: Number(t), clock24: Number(t) > 12 || (t.length === 2 && t.startsWith("0")) };
    return { hour: HOURS[t], clock24: false };
  };
  let found: { hour: number; minute: number; clock24: boolean; span: string } | null = null;
  // "twenty to eight", "10 past 6", "quarter to midnight", "half past six", "five after seven".
  const rel = new RegExp(`\\b(quarter|half|${MINUTE_WORDS}|${UNITS}|\\d{1,2})(?: minutes?)? (past|after|to) ${HOUR_TOKEN}\\b`).exec(s);
  // "half seven" (half past it).
  const halfOf = !rel ? new RegExp(`\\bhalf ${HOUR_TOKEN}\\b`).exec(s) : null;
  // "7:30", "19.30", "7h30", "7"; then "seven", "seven fifty", "seven oh five"; then noon or midnight alone.
  const digits = !rel && !halfOf ? /\b(\d{1,2})(?:[:.h](\d{2}))?\b/.exec(s) : null;
  const words = !rel && !halfOf && !digits ? new RegExp(`\\b(${Object.keys(HOURS).join("|")})(?: (${MINUTE_WORDS}))?\\b`).exec(s) : null;
  const named = !rel && !halfOf && !digits && !words ? /\b(noon|midday|midnight)\b/.exec(s) : null;
  if (rel) {
    const h = hourOf(rel[3]);
    if (!h) return null;
    const m = rel[1] === "quarter" ? 15 : rel[1] === "half" ? 30 : minutesOf(rel[1]);
    if (m < 1 || m > 59) return null;
    if (rel[2] === "to") {
      const back = h.clock24 ? (h.hour + 23) % 24 : h.hour === 1 ? 12 : h.hour - 1;
      found = { hour: back, minute: 60 - m, clock24: h.clock24, span: rel[0] };
    } else found = { hour: h.hour, minute: m, clock24: h.clock24, span: rel[0] };
  } else if (halfOf) {
    const h = hourOf(halfOf[1]);
    if (!h) return null;
    found = { hour: h.hour, minute: 30, clock24: h.clock24, span: halfOf[0] };
  } else if (digits) {
    const h = hourOf(digits[1])!;
    found = { hour: h.hour, minute: digits[2] ? Number(digits[2]) : 0, clock24: h.clock24 || (digits[1].length === 2 && digits[1].startsWith("0")), span: digits[0] };
  } else if (words) {
    found = { hour: HOURS[words[1]], minute: words[2] ? minutesOf(words[2]) : 0, clock24: false, span: words[0] };
  } else if (named) {
    const h = hourOf(named[1])!;
    found = { hour: h.hour, minute: 0, clock24: true, span: named[0] };
  }
  if (!found) return null;
  // Noon and midnight both said ("midnight or noon") can't be told apart, nor noon and a word for the night or the
  // morning ("tonight at 12 noon", "12 am noon", "12 noon in the evening": both reviews' nits on fix6).
  if (/\b(noon|midday)\b/.test(s) && /\b(midnight|am|morning|evening|night|tonight)\b/.test(s)) return null;
  // "twelve midnight", "12 midnight": midnight, not noon (Fable's nit on fix4: "tomorrow at twelve midnight" was noon
  // tomorrow); midnight said beside any other time can't be told apart.
  if (/\bmidnight\b/.test(s.replace(found.span, " "))) {
    if ((found.hour !== 12 && found.hour !== 0) || found.minute !== 0) return null;
    found = { ...found, hour: 0, clock24: true };
  }
  // "12 noon", "twelve noon", "12 midday", "half past 12 noon": noon, never midnight (both reviews' should on fix5: "at 12
  // noon" said in the evening was midnight); noon beside any other hour can't be told apart.
  if (/\b(noon|midday)\b/.test(s.replace(found.span, " "))) {
    if (found.hour !== 12) return null;
    found = { ...found, clock24: true };
  }
  if (LEFT_OVER.test(s.replace(found.span, " "))) return null;
  let { hour } = found;
  const { minute } = found;
  if (hour > 23 || minute > 59) return null;
  let half: Heard["half"];
  if (found.clock24) half = hour >= 12 ? "pm" : "am";
  else if (/\b(am|morning)\b/.test(s)) half = "am";
  else if (/\b(pm|afternoon|evening)\b/.test(s)) half = "pm";
  else if (/\b(night|tonight)\b/.test(s)) half = hour === 12 || hour <= 5 ? "am" : "pm";
  else half = hour === 0 ? "am" : null;
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  return { hour, minute, half, tomorrow };
}

/**
 * The next moment a heard time comes round on the clock in `zone`, after `now`, as a local date and time and its
 * instant (Fable, topic 1): a bare hour ("seven") is whichever of 7 in the morning or 7 in the evening comes first; a
 * time with its half that has passed today is tomorrow's; said for tomorrow, tomorrow's (a bare 7-11 in the morning,
 * 12 noon, 1-6 in the afternoon, as a recurring line reads one).
 */
export function nextClock(h: Heard, zone: string, now: number): { date: string; time: string; at: number } {
  const today = clockOf(now, zone).date;
  const hours = h.half !== null ? [h.hour] : h.tomorrow ? [h.hour === 12 ? 12 : h.hour >= 7 ? h.hour : h.hour + 12] : [h.hour % 12, (h.hour % 12) + 12];
  const dates = h.tomorrow ? [nextDate(today)] : [today, nextDate(today)];
  const options = dates.flatMap((date) => hours.map((hour) => {
    const time = `${pad(hour)}:${pad(h.minute)}`;
    return { date, time, at: instantOf(date, time, zone) };
  })).filter((o) => h.tomorrow || o.at > now).sort((a, b) => a.at - b.at);
  return options[0];
}

/**
 * A local date-time as the model gives one, on the clock in `zone` (spike/timed-send's `parseAt`): "2026-11-20" is 8 in
 * the morning that day, "2026-11-20T14:30" that time; one with its own offset ("…Z", "…+01:00") is that instant. Null
 * when it isn't one, or names a date that doesn't exist.
 */
export function localInstant(s: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?)?$/.exec(s.trim());
  if (!m) return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim()) ? Date.parse(s) || null : null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const at = instantOf(date, m[4] ? `${m[4]}:${m[5]}` : "08:00", zone);
  return clockOf(at, zone).date === date ? at : null;
}

/** A number in words, up to ninety-nine ("a", "an", "five", "fifteen", "twenty five", "forty-five"), or null. */
function numberOf(said: string): number | null {
  if (said === "a" || said === "an") return 1;
  const [a, b] = said.split(/[ -]/);
  const n = TENS[a] ?? (a === "sixty" ? 60 : a === "seventy" ? 70 : a === "eighty" ? 80 : a === "ninety" ? 90 : null);
  if (n !== null) return b ? n + (HOURS[b] ?? NaN) : n;
  return b ? null : (TEENS[a] ?? HOURS[a] ?? null);
}
/** A number in words ("five", "fifteen", "forty-five"), but "a" or "an", which count only directly before their unit. */
const COUNT_WORDS = `(?:(?:${[...Object.keys(TENS), "sixty", "seventy", "eighty", "ninety"].join("|")})(?:[ -](?:${UNITS}))?|${Object.keys(TEENS).join("|")}|${UNITS})`;
const NUMBER_WORDS = `(?:${COUNT_WORDS}|an?)`;

/**
 * Words as heard, for reading a time or a length: lower case, no commas, "forty-five" as "forty five", and a fraction
 * written after a number in digits ("2½", "2 1/2" as "2 and a half"; "1/2 hour" as "half hour"), so "1/2" isn't read as
 * a date.
 */
function heardWords(said: string): string {
  return ` ${said.toLowerCase()} `.replace(/(\p{L})-(\p{L})/gu, "$1 $2").replace(/[,!?]/g, " ")
    .replace(/(\d)\s*½|(\d)\s+1\/2\b(?!\/)/g, "$1$2 and a half").replace(/(\d)\s*¼|(\d)\s+1\/4\b(?!\/)/g, "$1$2 and a quarter").replace(/(\d)\s*¾|(\d)\s+3\/4\b(?!\/)/g, "$1$2 and three quarters")
    .replace(/(^|\s)(?:½|1\/2)\s*(?=hours?\b)/g, "$1half ").replace(/\s+/g, " ");
}

/** A half or a quarter said with a number ("two and a half hours", "an hour and three quarters"), as a fraction of it. */
const FRACTION = "(?: and (a half|a quarter|three quarters?))";
const fractionOf = (said: string | undefined) => (!said ? 0 : said === "a half" ? 0.5 : said === "a quarter" ? 0.25 : 0.75);

/**
 * A length as heard, in ms: "2 hours", "an hour", "90 minutes", "twenty five minutes", "half an hour", "an hour and a
 * half", "two and a half hours", "2.5 hours", "2½ hours", "an hour and a quarter", "three quarters of an hour", "1 hour 30
 * minutes", "one hour thirty". Null when it names none, or when a number, a half or a quarter is left over that it can't
 * place ("an hour or two", "2 to 3 hours"): never a length guessed (Fable's and the Skeptic's findings on 3.6 to 3.8).
 * `only`: the words are one length as written and nothing else, so "15 minutes on quoth" or "15 minutes or 30 minutes"
 * is none (example 11's minutes, my-rules.ts `exampleOf`: the seventh reviews of 3.5), and so are lengths side by side
 * or a mark among them ("10 minutes, 20 minutes", "1 hour and 1 hour", "10 minutes?": the eighth reviews, which
 * added them up): one part, or hours then their minutes ("1 hour 30 minutes", "an hour and a half"). Since the ninth,
 * whole: whole hours before minutes under 60, "and" only between them or before a half or a quarter, whole minutes
 * ("1.5 hours and 30 minutes", "an hour and 60 minutes", "1 hour and", "14.99999999 minutes" were added or rounded).
 * The tenth reviews: what it adds up is checked by its shape alone (`ONE_LENGTH`, `HOURS_THEN_MINUTES`); a check of the
 * parts it read refused "one hour and fifty-nine minutes", whose "fifty" and "nine" it reads apart, and caught nothing
 * else.
 */
export function parseLength(said: string, only = false): number | null {
  if (only && /[,!?;:]/.test(said)) return null;
  if (only) {
    const h = heardWords(said).trim();
    const hm = HOURS_THEN_MINUTES.exec(h);
    const m = hm ? (/^\d/.test(hm[1]) ? Number(hm[1]) : numberOf(hm[1])) : null;
    if (!ONE_LENGTH.test(h) && !(m !== null && m < 60)) return null;
  }
  let s = heardWords(said);
  let total = 0;
  // Where each length read was, so what's said between two of them can be checked.
  const MARK = "\u0001";
  const take = (re: RegExp, ms: number) => {
    if (!re.test(s)) return;
    total += ms;
    s = s.replace(re, ` ${MARK} `);
  };
  // Not the half of "two and a half hour", which is the number's; after another word's "and" ("in 2 days and half an
  // hour", Fable's nit on fix6), half an hour.
  take(new RegExp(`(?<!\\b(?:\\d+(?:\\.\\d+)?|${NUMBER_WORDS}) and (?:a )?)\\b(?:half an? hour|a half hour|half hour)\\b`), 30 * MIN);
  take(/\bthree quarters of an hour\b/, 45 * MIN);
  take(/\b(?:a )?quarter of an hour\b|\ba quarter hour\b/, 15 * MIN);
  // "one hour thirty", "2 hours 15": the minutes said after the hours, with no unit of their own.
  s = s.replace(new RegExp(`\\b(hours?|hrs?)(?: and)? ((?:${Object.keys(TENS).join("|")})(?: (?:${UNITS}))?|${Object.keys(TEENS).join("|")}|[1-5]\\d)\\b(?! ?(?:hours?|hrs?|minutes?|mins?)\\b)`, "g"), "$1 $2 minutes");
  const parts = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORDS})${FRACTION}?\\s*(hours?|hrs?|minutes?|mins?)\\b${FRACTION}?`, "g");
  for (const p of s.matchAll(parts)) {
    const n = (/^\d/.test(p[1]) ? Number(p[1]) : numberOf(p[1])!) + fractionOf(p[2]) + fractionOf(p[4]);
    total += n * (p[3].startsWith("h") ? HOUR : MIN);
  }
  const rest = s.replace(parts, ` ${MARK} `);
  // Two lengths with anything but "and" between them ("2 hours or 3 hours", "2 hours, actually 3 hours", "3 hours not 2
  // hours"): a choice or a correction, never their sum (the skeptic's should on fix5, as with days).
  const between = rest.slice(rest.indexOf(MARK) + 1, rest.lastIndexOf(MARK));
  if (between.split(/\s+/).some((w) => w && w !== MARK && w !== "and")) return null;
  // A time of day left beside it ("an hour before midnight", Fable's nit on fix5): unclear, as a number left over is.
  if (LEFT_OVER.test(rest) || /\b(noon|midday|midnight)\b/.test(rest)) return null;
  // `only`: nothing else, the marks where lengths were and "and" between them aside.
  if (only && /\S/.test(rest.replaceAll(MARK, " ").replace(/\band\b/g, " "))) return null;
  if (only && Math.abs(total - Math.round(total / MIN) * MIN) > 1e-6) return null;
  return total > 0 && Number.isFinite(total) ? Math.round(total) : null;
}

/**
 * Example 11's length in only one shape as written (`parseLength(…, true)`): one part, with at most one half or quarter,
 * none after a decimal, and "a" or "an" only directly before its unit (the tenth reviews: "1 and a half hours and a
 * half", "0.5 hours and a half", "1.5 and a half hours" and "an and a half hours" were added up)…
 */
const WHOLE = `(?:\\d+|${NUMBER_WORDS})`;
const HOURS_SAID = "(?:hours?|hrs?)";
const ONE_LENGTH = new RegExp(`^(?:(?:\\d+|${COUNT_WORDS})${FRACTION} ?${HOURS_SAID}|(?:\\d+(?:\\.\\d+)?|${NUMBER_WORDS}) ?${HOURS_SAID}|${WHOLE} ?${HOURS_SAID}${FRACTION}|${WHOLE} ?(?:minutes?|mins?)|half an? hour|a half hour|half hour|three quarters of an hour|(?:a )?quarter of an hour|a quarter hour)$`);
/** …or whole hours then their minutes, under 60 ("1 hour 30 minutes", "an hour and 20", "one hour thirty"). */
const HOURS_THEN_MINUTES = new RegExp(`^${WHOLE} ?(?:hours?|hrs?)(?: and)? (${WHOLE})(?: ?(?:minutes?|mins?))?$`);

/** Words that make a time a repeating one ("every weekday at 8", "each morning"): not set up by voice in 3.8. */
const REPEATS = /\b(every|each|daily|weekly|weekdays|weekends|mornings|evenings|nightly)\b/i;

/**
 * A number of days said ("2 days", "two days", "a day"), or of a calendar's other units, each never an hour: nights
 * (days), weeks, fortnights, months and years (Fable's and the skeptic's on stage 4's fix4: "in 2 weeks" was 2 o'clock).
 */
const DAY_COUNT = new RegExp(`\\b(\\d+|${NUMBER_WORDS}) (days?|nights?|weeks?|fortnights?|months?|years?)\\b`);
/** Each of those units in days: a month and a year as near as needed to say one is too far ahead. */
const UNIT_DAYS: Record<string, number> = { d: 1, n: 1, w: 7, f: 14, m: 30, y: 365 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** A day named for a time within the next week: the day after tomorrow, or a weekday ("Friday", "on Sunday", "this Monday"). */
const DAY_NAMED = new RegExp(`\\b(?:on |this )?(?:(?:the )?day after tomorrow|(${WEEKDAYS.join("|")}))\\b`);

/** The local date `n` days after `date`. */
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
};

/**
 * Whether a number of days (`count`, in `s`) is said as a choice or a range beside it ("a day or two", "2 or 3 days", "2
 * to 3 days", "between 2 and 3 days", "in 2 days or 3 hours", "in 2 days or so"), as past ("2 days ago"), or with a time
 * before ("in 2 days before 3 pm"): no time, and which day can't be placed. An "or" elsewhere is the time's ("in 2 days at
 * 3 or 4": the skeptic's nit on fix5).
 */
const dayRange = (s: string, count: RegExpExecArray) =>
  /\b(before|ago)\b/.test(s) || /^ (?:or|to)\b/.test(s.slice(count.index + count[0].length)) || new RegExp(`\\b(?:\\d+|${NUMBER_WORDS}) (?:or|to|and) $`).test(s.slice(0, count.index));

/**
 * The only words a number of days (said first, after nothing but "in" or "after") and a length may be said with to be
 * one length ("in 2 days and 3 hours", "2 days 3 hours from now"): anything else between or around them ("in 2 days,
 * actually 3 hours", "in 3 hours not 2 days", "in 2 days except 3 hours", "in 2 days, 3 hours earlier", "in 2 days for 3
 * hours") is no time, never their sum (the skeptic's should on fix5).
 */
const DAYS_AND_LENGTH = new RegExp(`^(?:and|from|now|time|half|quarters?|of|hours?|hrs?|minutes?|mins?|\\d+(?:\\.\\d+)?|${NUMBER_WORDS})$`);

/** Midnight, heard: which day's, the start or the end, can't be told when a day is named with it ("Friday at midnight"). */
const isMidnight = (h: Heard) => h.hour === 0 && h.minute === 0;

/**
 * A heard time on a day named (`date`, on the clock in `zone`): with its half, that hour; a bare hour on a later day as
 * a day's bare hour is read (7 to 11 in the morning, 12 noon, 1 to 6 in the afternoon: `nextClock`'s rule for
 * tomorrow), today whichever comes first. A weekday's time already past today is next week's.
 */
function onDay(date: string, h: Heard, zone: string, now: number): { at: number; clock: true; guessed?: true } {
  const today = clockOf(now, zone).date;
  const at = (d: string) => {
    const hours = h.half !== null ? [h.hour] : d === today ? [h.hour % 12, (h.hour % 12) + 12] : [h.hour === 12 ? 12 : h.hour >= 7 ? h.hour : h.hour + 12];
    return hours.map((hour) => instantOf(d, `${pad(hour)}:${pad(h.minute)}`, zone)).find((x) => x > now);
  };
  return { at: at(date) ?? at(addDays(date, 7))!, clock: true, ...(h.half === null ? { guessed: true as const } : {}) };
}

/**
 * A time named for a deadline or a check-in, as heard (Fable, topics 1 and 13): a length from now ("in 2 hours", "after
 * an hour", "in 2 days"), `ms` its length; or a time of day on the clock in `zone`, the next time it comes round ("6",
 * "by 6 in the evening", "at 3", "tomorrow at 9"), `clock` true. "repeats": a repeating time; "zone": a time of day with
 * no zone to read it in (none is guessed; a length works without one); null: neither. A number of days is never read as
 * an hour (Fable's review of stage 4: "in 2 days" was 2 o'clock).
 *
 * `days` (a send or a start for later, stage 4; its readback always says the day and the half of the day): a day named
 * too, "the day after tomorrow at 9", "Friday at 8", "at 3 on Sunday", "in 2 days at 3", and nights, weeks, months and
 * years as a length ("in a week", "in 2 months"), so one too far ahead is said to be; "next Friday" (which one isn't
 * certain), a date, and midnight with a day named ("Friday at midnight", "tomorrow at midnight": the start of that day or
 * its end) are no time. Without it, a calendar's units but days are no time either. "passed": a time said for today
 * ("today at 5", "tonight at 8", "this morning at 9") that has passed, in either mode.
 */
export function parseWhen(said: string, zone: string | null, now: number, o: { days?: boolean } = {}): { at: number; clock: boolean; ms?: number; guessed?: true } | "repeats" | "zone" | "passed" | null {
  const s = heardWords(said);
  if (REPEATS.test(s)) return "repeats";
  const count = DAY_COUNT.exec(s);
  if (count) {
    // A watch's time (no `days`): days only, as a length; any other unit is no time, as a date is.
    if (!o.days && !count[2].startsWith("d")) return null;
    const n = /^\d/.test(count[1]) ? Number(count[1]) : numberOf(count[1]);
    const days = n === null ? null : n * UNIT_DAYS[count[2][0]];
    const rest = s.replace(count[0], " ");
    if (days === null || DATE_WORDS.test(rest) || DAY_COUNT.test(rest) || /\b(today|tonight|tomorrow|days?|nights?)\b/.test(rest)) return null;
    // A choice or a range ("a day or two", "2 or 3 days", "2 to 3 days", "in 2 days or 3 hours"): no time, never one of
    // them guessed (the skeptic's on fix4: "in a day or two" was 2 tomorrow afternoon).
    if (dayRange(s, count)) return null;
    // Hours or minutes with it ("in 2 days and 3 hours"): one length, never the hours' number as a time of day.
    const past = new RegExp(`\\b(?:${MINUTE_WORDS}|${UNITS}|\\d{1,2}) minutes? (?:past|after|to) ${HOUR_TOKEN}\\b`).exec(rest);
    if (UNIT.test(past ? rest.replace(past[0], " ") : rest)) {
      // Only with the words of one length, nothing else ("in 2 days in 3 hours", "in 2 days at 3 hours", "in 2 days,
      // actually 3 hours": the skeptic's on fix4 and fix5).
      const words = (from: string) => from.split(/[\s']+/).filter(Boolean);
      if (!words(s.slice(0, count.index)).every((w) => w === "in" || w === "after") || !words(s.slice(count.index + count[0].length)).every((w) => DAYS_AND_LENGTH.test(w))) return null;
      const more = parseLength(rest);
      if (more === null) return null;
      return { at: now + days * DAY + more, clock: false, ms: days * DAY + more };
    }
    const heard = parseClock(rest);
    if (heard) {
      if (!o.days || isMidnight(heard)) return null;
      // A time of day with a number of days only when it's said as one: "at 3", "by 3", "3 pm", "8 in the morning"; a
      // number left beside them ("in 2 days 3") isn't one (the skeptic's on fix4).
      if (heard.half === null && !/\b(at|by)\b/.test(rest)) return null;
      if (!zone) return "zone";
      return onDay(addDays(clockOf(now, zone).date, days), heard, zone, now);
    }
    if (LEFT_OVER.test(rest)) return null;
    const ms = days * DAY;
    return { at: now + ms, clock: false, ms };
  }
  const day = o.days ? DAY_NAMED.exec(s) : null;
  if (day) {
    const rest = s.replace(day[0], " ");
    if (DATE_WORDS.test(rest) || /\b(next|last|today|tonight|tomorrow)\b/.test(rest)) return null;
    const heard = parseClock(rest);
    if (!heard || isMidnight(heard)) return null;
    if (!zone) return "zone";
    const today = clockOf(now, zone).date;
    let date = day[1] ? today : addDays(today, 2);
    if (day[1]) while (weekdayOf(date) !== WEEKDAYS.indexOf(day[1])) date = nextDate(date);
    return onDay(date, heard, zone, now);
  }
  // A date or a day it can't place ("by 6 on the 20th", "on Friday at 2"): never today's or tomorrow's time instead (the
  // Skeptic's finding on 3.6 to 3.8), nor a number of days as an hour.
  if (DATE_WORDS.test(s) || /\bdays?\b/.test(s)) return null;
  // Said with a length's unit, a length ("after 2 hours", "after two and a half hours", "in an hour and a quarter"),
  // unless the unit is a time of day's minutes, said before past, after or to with none after the hour ("twenty minutes
  // past seven", "5 minutes to 6"; the Skeptic's and Fable's findings on 3.6 to 3.8, and Fable's on the second review:
  // "after two and a half hours" was 2 o'clock).
  const minutesPast = new RegExp(`\\b(?:${MINUTE_WORDS}|${UNITS}|\\d{1,2}) minutes? (?:past|after|to) ${HOUR_TOKEN}\\b`).exec(s);
  if (UNIT.test(minutesPast ? s.replace(minutesPast[0], " ") : s)) {
    const ms = parseLength(s);
    return ms === null ? null : { at: now + ms, clock: false, ms };
  }
  const heard = parseClock(s);
  if (!heard || (o.days && heard.tomorrow && isMidnight(heard))) return null;
  if (!zone) return "zone";
  const next = nextClock(heard, zone, now);
  // Today said (or tonight, this morning, this afternoon, this evening), and that time has passed: "passed", never
  // tomorrow's instead (Fable's nit on fix5: "today at 5" at 17:40 was 5 tomorrow morning; both reviews' on fix6: "tonight
  // at 8" at 21:30 was tomorrow evening's). Tonight's small hours are tomorrow's date; midnight today is asked again.
  const today = clockOf(now, zone).date;
  const sameDay = /\b(today|tonight|this (?:morning|afternoon|evening))\b/.exec(s);
  // Tomorrow said too ("not today, tomorrow at 5", "tonight or tomorrow at 8"): two days, asked again, never "passed"
  // (both reviews of fix7).
  if (sameDay && /\btomorrow\b/.test(s)) return null;
  const smallHours = sameDay?.[1] === "tonight" && next.date === nextDate(today) && Number(next.time.slice(0, 2)) <= 5;
  if (sameDay && next.date !== today && !smallHours) return isMidnight(heard) ? null : "passed";
  return { at: next.at, clock: true, ...(heard.half === null ? { guessed: true as const } : {}) };
}

/**
 * Why a time for later that `parseWhen` couldn't read wasn't, so it's asked again in the words that help (later-lines.ts;
 * Fable's should on fix4): "day", a day or a date it can't place ("next Friday at 8", "on the 22nd at 3", "in a couple of
 * days", "in a day or two"); "midnight", midnight with a day it can place ("Friday at midnight", "tomorrow at 12 am");
 * "time", a day it can place with no time read ("tomorrow morning", "Friday night", "Saturday at 8 30", "in 2 days at 3 or
 * 4"); null, no day heard ("end of day"), or days with a length not read as one ("in 2 days or 3 hours").
 */
export function whyUnread(said: string): "day" | "midnight" | "time" | null {
  // "first thing tomorrow", "end of day": a time of day said loosely, never a date (Fable's should on fix5).
  const s = heardWords(said).replace(/\bfirst thing\b|\b(?:the )?end of (?:the )?day\b/g, " ");
  if (!DATE_WORDS.test(s) && !DAY_COUNT.test(s) && !/\b(today|tonight|tomorrow|days?|nights|weeks?)\b/.test(s)) return null;
  const count = DAY_COUNT.exec(s);
  // A number of days with a length it wasn't read with ("in 2 days or 3 hours", "in 2 days, actually 3 hours"): when,
  // not which day.
  if (count && UNIT.test(s)) return null;
  const named = DAY_NAMED.exec(s);
  const rest = [count?.[0], named?.[0]].reduce((r: string, x) => (x ? r.replace(x, " ") : r), s);
  const days = (count ? 1 : 0) + (named ? 1 : 0) + (rest.match(/\b(today|tonight|tomorrow|this (?:morning|afternoon|evening))\b/g)?.length ?? 0);
  // "night" beside a day it places is that day's ("tomorrow night", "Friday night at 12": Fable's should on fix5).
  if (days !== 1 || DATE_WORDS.test(rest) || /\b(next|last|days?|nights|weeks?)\b/.test(rest)) return "day";
  // A number of days with a part of one ("in a day and a half", "in 1.5 days"), another unit, or as a choice or a range.
  if (count && (!/^[dn]/.test(count[2]) || dayRange(s, count) || /\b(half|quarters?)\b|\d\.\d/.test(s))) return "day";
  const heard = parseClock(rest);
  return /\bmidnight\b/.test(s) || (heard && isMidnight(heard)) ? "midnight" : "time";
}

/** A date or a day said with a time ("on the 20th", "on Friday", "next week", "November 20"), which `parseWhen` can't place. */
const DATE_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week|month|january|february|april|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|day after)\b|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}/i;

/** A repeating time (a line's `every`): on these weekdays (0 Sunday … 6 Saturday), at this time ("08:00"). */
export type Every = { days: number[]; time: string };

/**
 * When a repeating time next fires, on the clock in `zone` now (spike/scheduled-briefing's `nextBriefingAt`, with §7's
 * rule): once per local date, so `last.date` (the local date it last fired for) never fires again, wherever the phone
 * has flown since; never fired, its first is after `last.at` (when it was made: set on Friday afternoon, Monday's). A
 * date it's due on and hasn't fired (a flight east past it, a wake that came late) fires now, once: the latest such date
 * only. A time the clocks skip is the next valid minute, one they repeat the first (`instantOf`). Null with no days.
 */
export function nextEvery(e: Every, zone: string, last: { at: number; date: string | null }, now: number): { date: string; at: number } | null {
  if (!e.days.length) return null;
  const on = (date: string) => e.days.includes(weekdayOf(date));
  const after = (date: string, at: number) => (last.date !== null ? date > last.date : at > last.at);
  const today = clockOf(now, zone).date;
  let date = today;
  for (let i = 0; i < 8; i++, date = prevDate(date)) {
    if (!on(date)) continue;
    const at = instantOf(date, e.time, zone);
    if (at > now) continue;
    if (after(date, at)) return { date, at };
    break;
  }
  date = today;
  for (let i = 0; i < 9; i++, date = nextDate(date)) {
    if (!on(date)) continue;
    const at = instantOf(date, e.time, zone);
    if (at > now && after(date, at)) return { date, at };
  }
  return null;
}

/**
 * Since when, as a notification shows it on the clock in `zone` (stage 3.8; Fable, topic 16): "08:00" earlier the same
 * day as `now`, "yesterday 08:00", else its weekday, "Friday 08:00".
 */
export function shownSince(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  const hm = `${pad(c.hour)}:${pad(c.minute)}`;
  if (c.date === today) return hm;
  return nextDate(c.date) === today ? `yesterday ${hm}` : `${c.weekday} ${hm}`;
}

// --- a briefing since a time (stage 4; Fable's 4-I) ---

/**
 * A time a briefing counts from, as said (Fable's 4-I: "since 6 this morning", "since 6 yesterday evening", "since
 * Friday at 8 in the morning"): today "6 this morning", "2 this afternoon", "7 this evening", "noon", "midnight";
 * yesterday "6 yesterday morning", "2 yesterday afternoon", "6 yesterday evening", from 9 in the evening "11 last
 * night", "noon yesterday"; earlier as `spokenDay` says it ("Friday at 8 in the morning"). A day's start before today
 * is the day itself ("yesterday", "Friday"): "since yesterday at midnight" could be either midnight.
 */
export function spokenSince(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  const hm = c.minute ? `${c.hour % 12 || 12}:${pad(c.minute)}` : `${c.hour % 12 || 12}`;
  const part = c.hour < 12 ? "morning" : c.hour < 18 ? "afternoon" : "evening";
  const midnight = c.hour === 0 && c.minute === 0;
  const noon = c.hour === 12 && c.minute === 0;
  if (c.date === today) return midnight ? "midnight" : noon ? "noon" : `${hm} this ${part}`;
  const yesterday = c.date === prevDate(today);
  if (midnight && datesFrom(today, c.date) < 0) return yesterday ? "yesterday" : (farDay(c, today) ?? c.weekday);
  if (!yesterday) return spokenDay(at, zone, now);
  if (noon) return "noon yesterday";
  return c.hour >= 21 ? `${hm} last night` : `${hm} yesterday ${part}`;
}

/**
 * The words a time of day is said in for a since, and nothing else ("3", "10 this morning", "half past 9", "11 last
 * night", "8 a.m."): anything left over ("version 2", "the last 5", "the last 2 days") isn't a time, so none is guessed
 * (the skeptic's finding on 4-I).
 */
const CLOCK_ONLY = new RegExp(
  `\\b(?:\\d{1,2}(?:[:.h]\\d{2})?|${[...Object.keys(HOURS), ...Object.keys(TEENS), ...Object.keys(TENS)].join("|")}|oh|half|quarter|past|after|to|minutes?|at|about|around|noon|midday|midnight|am|pm|a|m|o'?clock|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening|night)|last night|tonight)\\b`,
  "g",
);

/** Whether `s` is only a time of day's words ("8am" as "8 am"). */
const clockOnly = (s: string) => !s.replace(/(\d)(am|pm)\b/g, "$1 $2").replace(CLOCK_ONLY, " ").trim();

/**
 * Since when a briefing counts, from the words the user said for it, fixed here so the cut-off is never a guess they
 * can't hear (Fable's 4-I): "this morning" is 06:00 today (asked before 06:00, yesterday's); "last night" 18:00
 * yesterday; "lunch" 12:00 today (yesterday's before noon); "yesterday" 00:00 yesterday; a time of day the last time it
 * came round ("3", "10 this morning", "15:00"); a weekday 00:00 that day, the last one come; "my last call", or nothing
 * said, `last` (the end of the last call or briefing, drives.ts). Fable's ruling on its review adds: "today" 00:00 today;
 * "this afternoon" 12:00 today, "this evening" and "tonight" 18:00 today, each only once it's past; "yesterday morning",
 * "afternoon", "evening" 06:00, 12:00, 18:00 yesterday; "N hours ago" and "the last N hours" now less N; "last <weekday>"
 * said on that weekday a week ago. The forms `spokenSince` says back are taken too ("6 yesterday evening", "noon
 * yesterday"), and on its second review: `spokenDay`'s, an earlier day with a time said with its half ("Thursday at 9 in
 * the morning", "Friday the 13th", "Friday the 13th at 8 in the morning", "yesterday at 2 in the afternoon"), the last
 * time it came round; "N minutes ago", "the last N minutes" now less N, and a number of minutes never an hour ("20
 * minutes": Since when?); a time said for this morning, this afternoon, this evening or tonight only once it's past.
 * On its third: a time said for last night, yesterday's from 6 in the evening, or today's small hours once past; a day
 * at midnight, and a weekday and date that came round twice in the month, Since when?.
 * "repeats" for a repeating time ("every morning at 8"); null when it's none of these ("the last 2 days", "version 2"),
 * or `last` is asked for and there's none: "Since when?".
 */
export function parseSince(said: string | null | undefined, zone: string, now: number, last: number | null): number | "repeats" | null {
  const s = heardWords(said ?? "").replace(/[.]/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:since|from|after) /, "").replace(/^(?:the start of|the beginning of) /, "");
  if (REPEATS.test(s)) return "repeats";
  if (!s || /^(?:my |the )?(?:last|previous) (?:call|drive|briefing|time)$|^(?:i|we) (?:last )?(?:talked|spoke)$/.test(s)) return last;
  const today = clockOf(now, zone).date;
  const yesterday = prevDate(today);
  const before = (time: string) => {
    const at = instantOf(today, time, zone);
    return at <= now ? at : instantOf(yesterday, time, zone);
  };
  /** Today at `time`, once it's come; else null ("this evening" asked at 3: Since when?). */
  const past = (time: string) => {
    const at = instantOf(today, time, zone);
    return at <= now ? at : null;
  };
  const PARTS: Record<string, string> = { morning: "06:00", afternoon: "12:00", evening: "18:00" };
  if (/^(?:this |the )?morning$/.test(s)) return before("06:00");
  if (/^last night$/.test(s)) return instantOf(yesterday, "18:00", zone);
  if (/^lunch(?: ?time)?$/.test(s)) return before("12:00");
  if (s === "yesterday") return instantOf(yesterday, "00:00", zone);
  if (s === "today" || s === "this day") return instantOf(today, "00:00", zone);
  if (s === "this afternoon") return past("12:00");
  if (s === "this evening" || s === "tonight") return past("18:00");
  const part = /^yesterday (morning|afternoon|evening)$/.exec(s);
  if (part) return instantOf(yesterday, PARTS[part[1]], zone);
  // As `spokenSince` says it back: "6 yesterday evening", "8 yesterday morning", "noon yesterday".
  if (/^(?:noon|midday) yesterday$/.test(s)) return instantOf(yesterday, "12:00", zone);
  const back = /^(.+) yesterday (morning|afternoon|evening)$/.exec(s);
  if (back) {
    const h = clockOnly(back[1]) ? parseClock(`${back[1]} in the ${back[2]}`) : null;
    return h && !h.tomorrow && h.half !== null ? instantOf(yesterday, `${pad(h.hour)}:${pad(h.minute)}`, zone) : null;
  }
  // As `spokenDay` says an earlier day (Fable's and the skeptic's findings on 4-I's second review): "yesterday at 2 in
  // the afternoon"; a weekday, with its date ("Friday the 13th") or without, and with a time ("Thursday at 9 in the
  // morning") or without (its start), the last time it came round. A time only with its half: "Monday at 9" could be
  // either.
  const dayTime = (words: string | undefined): string | null => {
    if (words === undefined) return "00:00";
    const h = clockOnly(words) && !/\b(?:this|tonight|last)\b/.test(words) ? parseClock(words) : null;
    // Midnight on a day could be either end of it ("yesterday at midnight"), so it isn't guessed (the skeptic's finding
    // on 4-I's third review); `spokenSince` says a day's start as the day ("yesterday", "Friday").
    return h && !h.tomorrow && h.half !== null && (h.hour || h.minute) ? `${pad(h.hour)}:${pad(h.minute)}` : null;
  };
  const yesterdayAt = /^yesterday at (.+)$/.exec(s);
  if (yesterdayAt) {
    const time = dayTime(yesterdayAt[1]);
    return time === null ? null : instantOf(yesterday, time, zone);
  }
  const day = /^(?:on )?(?:(last) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: (?:the )?(\d{1,2})(?:st|nd|rd|th))?(?: at (.+))?$/.exec(s);
  if (day) {
    const time = dayTime(day[4]);
    if (time === null) return null;
    const weekday = WEEKDAYS.indexOf(day[2]);
    const nth = day[3] ? Number(day[3]) : null;
    // "last Friday" said on a Friday: a week ago. A date as `spokenSince` says one, in the last month: a weekday and date
    // that don't meet in it ("Thursday the 13th" when the 13th was a Friday) isn't a year back.
    let date = day[1] && weekdayOf(today) === weekday ? yesterday : today;
    const dates: number[] = [];
    for (let i = 0; i < 32; i++, date = prevDate(date)) {
      if (weekdayOf(date) !== weekday || (nth !== null && Number(date.slice(8, 10)) !== nth)) continue;
      const at = instantOf(date, time, zone);
      if (at > now) continue;
      if (nth === null) return at;
      dates.push(at);
    }
    // A weekday and date met twice in the month looked back over (after a 28-day February, "Saturday the 28th" on 30
    // March is 2 days back or 30) could be either, so neither is guessed (the skeptic's finding on 4-I's third review).
    return dates.length === 1 ? dates[0] : null;
  }
  // "2 hours ago", "the last 2 hours", "the past hour", "30 minutes ago", "the last 10 minutes": now less that long.
  const ago = /^(?:(?:the )?(?:last|past) (.+)|(.+) ago)$/.exec(s);
  if (ago && /\b(?:hours?|hrs?|minutes?|mins?)\b/.test(ago[1] ?? ago[2])) {
    const span = (ago[1] ?? ago[2]).replace(/^hour\b/, "an hour").replace(/^minute\b/, "a minute");
    const ms = /\b(?:days?|weeks?|months?|years?)\b/.test(span) ? null : parseLength(span);
    // To the minute, as it's said back.
    return ms === null ? null : Math.floor((now - ms) / MIN) * MIN;
  }
  // A time of day: its last occurrence, whichever half a bare hour is ("3" at 17:40 is 15:00 today). Only a time said
  // alone, in its own words; a number of minutes only before past, after or to and an hour ("20 minutes past 7"), never
  // an hour itself ("20 minutes" isn't 8 o'clock: Fable's finding on 4-I's second review).
  if (DATE_WORDS.test(s) || /\b(?:yesterday|today|ago|days?|weeks?|months?|years?)\b/.test(s) || !clockOnly(s)) return null;
  if (/\bminutes?\b/.test(s) && !MINUTES_PAST.test(s)) return null;
  const h = parseClock(s);
  if (!h || h.tomorrow) return null;
  const hm = `${pad(h.hour)}:${pad(h.minute)}`;
  // Said for last night ("11 last night", "last night at 10", "1 last night"): an evening's hour, from 6, is yesterday's,
  // whatever the time now; 12 and the small hours are today's once they've come; never this evening's (Fable's and the
  // skeptic's findings on 4-I's third review: at 23:30, "11 last night" was 30 minutes ago).
  if (/\blast night\b/.test(s)) {
    if (h.half === "pm" && h.hour >= 18) return instantOf(yesterday, hm, zone);
    return h.half === "am" && h.hour <= 5 ? past(hm) : null;
  }
  // Said for today ("3 this afternoon", "9 tonight"), today's, once it's past: never yesterday's instead (Fable's
  // finding on 4-I's second review). Tonight's small hours ("12 tonight") are after today's midnight, still to come.
  const todays = /\b(?:this (?:morning|afternoon|evening)|tonight)\b/.test(s);
  if (/\btonight\b/.test(s) && h.half === "am") return null;
  const hoursOf = h.half !== null ? [h.hour] : [h.hour % 12, (h.hour % 12) + 12];
  const pastAt = (todays ? [today] : [today, yesterday]).flatMap((date) => hoursOf.map((hour) => instantOf(date, `${pad(hour)}:${pad(h.minute)}`, zone))).filter((at) => at <= now);
  return pastAt.length ? Math.max(...pastAt) : null;
}

/** Minutes said before past, after or to and an hour ("twenty minutes past seven", "5 minutes to 6"): a time of day's. */
const MINUTES_PAST = new RegExp(`\\b(?:${MINUTE_WORDS}|${UNITS}|\\d{1,2}) minutes? (?:past|after|to) ${HOUR_TOKEN}\\b`);
