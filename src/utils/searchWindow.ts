import { ValidationError } from "./validate.js";

// Slack `after:` is exclusive of the day it names and the day boundary may be
// UTC or the user's zone, so query two days before the floor's UTC date and
// trim client-side to the exact floor. The widening costs bytes, never matches.
export const WIDEN_DAYS = 2;

export interface SearchWindow {
  floor_iso: string;
  slack_after: string;
  floorSeconds: number;
}

export function searchWindow(hours: number, nowMs = Date.now()): SearchWindow {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 3650) {
    throw new ValidationError(`lookback must be between 0 and 3650 days, got ${hours} hours`);
  }
  const floorMs = nowMs - hours * 3600_000;
  return {
    floor_iso: new Date(floorMs).toISOString(),
    slack_after: new Date(floorMs - WIDEN_DAYS * 86400_000).toISOString().slice(0, 10),
    floorSeconds: floorMs / 1000,
  };
}

// Keeps matches at or after the floor. A match whose ts does not parse is kept
// (dropping it would be a silent false negative).
export function trimToWindow<T extends { ts?: string }>(matches: readonly T[], floorSeconds: number) {
  const kept = matches.filter((m) => !(parseFloat(m.ts ?? "") < floorSeconds));
  return { kept, trimmed_out: matches.length - kept.length };
}
