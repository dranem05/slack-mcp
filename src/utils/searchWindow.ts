// Pure computation of the `after:` filter and client-side timestamp floor
// used when a tool turns an "N hours back" lookback into a Slack
// `search.messages` query.
//
// The naive `new Date(floorMs).toISOString().slice(0, 10)` has two
// compounding defects, each of which silently *drops* messages:
//
//  1. `after:` is EXCLUSIVE of the day it names. `after:2026-09-14`
//     returns nothing from 2026-09-14 at all. (Verified live: `on:` for
//     that date returned 9 messages, `after:` returned 4, zero overlap.)
//  2. Slack evaluates the date in the authenticated user's timezone, while
//     `toISOString()` renders it in UTC. For an evening local timestamp in
//     the Americas the UTC date has already rolled forward, shifting the
//     floor another day later.
//
// Net effect: an `hours=24` lookback can silently lose nearly two days of
// messages, with no error and no signal to the caller.
//
// The correct shape, implemented here:
//   a. derive the floor's calendar date in the USER'S timezone;
//   b. ask Slack for the day BEFORE that date, neutralizing exclusivity;
//   c. trim the resulting over-fetch back to the exact requested window
//      with a numeric floor on each match's `ts`.
//
// Step (c) is what keeps (b) from trading a false negative for
// imprecision. `parseFloat` on a Slack `ts` is genuinely numeric at
// Slack's resolution (473 adjacent-microsecond pairs sampled across
// ts 1.70e9-2.00e9 produced zero collisions).

import { ValidationError } from "./validate.js";

export interface SearchWindow {
  /** Exact requested floor, epoch milliseconds. Nothing older belongs in the result. */
  floorMs: number;
  /** Exact requested floor, epoch SECONDS — the unit a Slack `ts` is in. */
  floorSeconds: number;
  /** ISO 8601 rendering of the floor, so the caller can see what was actually searched. */
  floorIso: string;
  /** IANA timezone the calendar date was derived in. */
  tz: string;
  /** Value to send as `after:` — `daysWidened` days before the floor's local date. */
  slackAfter: string;
  /**
   * How many days the query was widened by. 1 when the timezone came from
   * Slack; more when it is a fallback guess, since a wrong zone can shift
   * the derived date and the widening is the only thing absorbing that.
   */
  daysWidened: number;
}

export interface TrimResult<T> {
  /** Matches at or after the floor, in the order Slack returned them. */
  kept: T[];
  /** How many matches the over-fetch pulled in that the caller did not ask for. */
  trimmedOut: number;
  /**
   * Matches kept despite an absent/unparseable `ts`. Dropping these would be a
   * silent false negative, so they are kept and counted instead (CANNOT-CHECK,
   * not CLEAN).
   */
  unparsableTs: number;
}

// `after:` is exclusive, so one day back is exactly enough when the timezone
// is known. When it is a fallback guess the derived calendar date can be off
// by up to two days (the extremes are ~26h apart: UTC+14 vs UTC-11), so three
// days back is what guarantees coverage. The client-side trim removes the
// over-fetch either way, so widening costs bytes, never precision.
const DAYS_BACK_TZ_KNOWN = 1;
const DAYS_BACK_TZ_GUESSED = 3;

// Slack did not exist before 1970, and `Date` cannot render an instant outside
// +/-8.64e15 ms at all — an `hours` big enough to leave that range is a caller
// bug, and must surface as one rather than as a RangeError from toISOString().
const MIN_FLOOR_MS = 0;
const MAX_FLOOR_MS = 8.64e15;

// Intl.DateTimeFormat construction is comparatively expensive and the same
// one or two zones are used for the life of the process.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string | undefined | null): boolean {
  if (!tz || typeof tz !== "string") {
    return false;
  }
  try {
    dateFormatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the search window for a lookback of `hours` evaluated in `tz`.
 *
 * Throws ValidationError for an unusable `hours` or an unrecognized `tz` —
 * a bad window must fail loudly rather than quietly search the wrong range.
 */
export function computeSearchWindow(
  hours: number,
  tz: string,
  now: () => number = Date.now,
  tzIsApproximate = false
): SearchWindow {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ValidationError(
      `hours must be a positive number, got ${hours}`
    );
  }
  if (!isValidTimeZone(tz)) {
    throw new ValidationError(
      `"${tz}" is not a recognized IANA timezone (expected something like "America/New_York").`
    );
  }

  const floorMs = now() - hours * 3600 * 1000;
  if (floorMs < MIN_FLOOR_MS || floorMs > MAX_FLOOR_MS) {
    throw new ValidationError(
      `hours=${hours} puts the search floor outside the representable range ` +
        `(it resolves to before 1970 or beyond year 275760). Use a smaller lookback.`
    );
  }

  const daysWidened = tzIsApproximate ? DAYS_BACK_TZ_GUESSED : DAYS_BACK_TZ_KNOWN;

  return {
    floorMs,
    floorSeconds: floorMs / 1000,
    floorIso: new Date(floorMs).toISOString(),
    tz,
    // Earlier than the floor's LOCAL date: `after:` excludes the day it
    // names, so naming the floor's own date would drop every message between
    // the floor and local midnight at the end of that day.
    slackAfter: shiftCalendarDays(localCalendarDate(floorMs, tz), -daysWidened),
    daysWidened,
  };
}

/**
 * Drop the part of the over-fetch that falls before the true floor.
 *
 * Safe to apply per page: `search.messages` is requested with
 * `sort: timestamp, sort_dir: desc`, so the over-fetched messages are the
 * OLDEST ones and therefore sit at the tail of the globally sorted result
 * set. Trimming can only remove the end of a page, never hide a match that
 * a later page would have carried — so a caller walking `paging` still sees
 * every in-window result, and a page that trims to empty means the floor
 * has been crossed.
 *
 * That rests on Slack sorting each match by its OWN ts rather than its
 * thread parent's, which matters because most matches are thread replies.
 * Measured against a live workspace: 120 matches, 92 of them replies, order
 * strictly non-increasing in own ts, including 64 replies whose root was
 * 4-7 days older than the match sorted immediately below them.
 */
export function trimToWindow<T extends { ts?: string }>(
  matches: T[],
  floorSeconds: number
): TrimResult<T> {
  const kept: T[] = [];
  let trimmedOut = 0;
  let unparsableTs = 0;

  for (const match of matches) {
    const ts = parseFloat(match?.ts ?? "");
    if (Number.isNaN(ts)) {
      unparsableTs++;
      kept.push(match);
      continue;
    }
    if (ts >= floorSeconds) {
      kept.push(match);
    } else {
      trimmedOut++;
    }
  }

  return { kept, trimmedOut, unparsableTs };
}

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

function dateFormatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) {
    return cached;
  }
  // Throws RangeError for an unrecognized zone — that is how isValidTimeZone
  // detects one.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    calendar: "gregory",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(tz, formatter);
  return formatter;
}

function localCalendarDate(ms: number, tz: string): CalendarDate {
  const parts = dateFormatterFor(tz).formatToParts(new Date(ms));
  const part = (type: "year" | "month" | "day"): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) {
      throw new ValidationError(
        `Could not read the ${type} of the search floor in timezone "${tz}".`
      );
    }
    return Number(found.value);
  };
  return { year: part("year"), month: part("month"), day: part("day") };
}

// Calendar arithmetic only — done in UTC space so it is immune to DST
// transitions in the source zone (a local day can be 23 or 25 hours long,
// but "the previous calendar date" is unaffected by that).
function shiftCalendarDays({ year, month, day }: CalendarDate, days: number): string {
  const d = new Date(0);
  // setUTCFullYear (not Date.UTC) so years 0-99 aren't remapped to 1900-1999,
  // and so the year is in place before the day shift — otherwise a Mar 1
  // floor would resolve Feb 28 vs Feb 29 against the wrong year.
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
