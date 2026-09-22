import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/utils/validate.js";
import {
  computeSearchWindow,
  isValidTimeZone,
  trimToWindow,
} from "../src/utils/searchWindow.js";

const ET = "America/New_York";

// What the buggy implementation did, kept here so the regressions below can
// assert the fix actually changes the outcome rather than just matching
// itself.
function buggyAfter(floorMs: number): string {
  return new Date(floorMs).toISOString().slice(0, 10);
}

function at(iso: string): () => number {
  const ms = Date.parse(iso);
  return () => ms;
}

describe("computeSearchWindow", () => {
  describe("exclusivity — Slack's after: drops the day it names", () => {
    it("asks for the day BEFORE the floor's local date, so the floor day survives", () => {
      // "Now" 2026-09-15 12:00 ET; hours=24 puts the floor on 2026-09-14.
      const w = computeSearchWindow(24, ET, at("2026-09-15T16:00:00Z"));
      expect(w.slackAfter).toBe("2026-09-13");
    });

    it("differs from the naive implementation, which excluded the floor day", () => {
      const now = at("2026-09-15T16:00:00Z");
      const w = computeSearchWindow(24, ET, now);
      // The naive code named the floor's own date. `after:` excludes that
      // day, so every message between the floor and local midnight at the
      // end of 2026-09-14 was silently lost.
      expect(buggyAfter(w.floorMs)).toBe("2026-09-14");
      expect(w.slackAfter).toBe("2026-09-13");
    });

    it("steps back across a month boundary", () => {
      // Floor: 2026-09-01 08:00 ET.
      const w = computeSearchWindow(1, ET, at("2026-09-01T13:00:00Z"));
      expect(w.slackAfter).toBe("2026-08-31");
    });

    it("steps back across a year boundary", () => {
      // Floor: 2026-01-01 09:00 ET.
      const w = computeSearchWindow(1, ET, at("2026-01-01T15:00:00Z"));
      expect(w.slackAfter).toBe("2025-12-31");
    });

    it("resolves Feb 28 vs Feb 29 against the real year, not a leap-year stand-in", () => {
      // 2026 is not a leap year: the day before Mar 1 is Feb 28.
      const nonLeap = computeSearchWindow(1, ET, at("2026-03-01T15:00:00Z"));
      expect(nonLeap.slackAfter).toBe("2026-02-28");

      // 2028 is: the day before Mar 1 is Feb 29.
      const leap = computeSearchWindow(1, ET, at("2028-03-01T15:00:00Z"));
      expect(leap.slackAfter).toBe("2028-02-29");
    });
  });

  describe("UTC rollover — the floor's local date, not its UTC date", () => {
    it("does not lose a day for an evening-ET floor whose UTC date already rolled forward", () => {
      // "Now" 2026-09-21 20:45 ET; hours=24 puts the floor at 2026-09-20
      // 20:45 ET == 2026-09-21T00:45Z. The naive code read that as
      // 2026-09-21 and, being exclusive, searched from 2026-09-22 — losing
      // the entire evening of 09-20 AND all of 09-21.
      const now = at("2026-09-22T00:45:00Z");
      const w = computeSearchWindow(24, ET, now);

      expect(buggyAfter(w.floorMs)).toBe("2026-09-21");
      expect(w.tz).toBe(ET);
      expect(w.slackAfter).toBe("2026-09-19");
    });

    it("keeps a previous-evening ET message inside the window", () => {
      // Same window as above; a message at 2026-09-20 22:06 ET.
      const w = computeSearchWindow(24, ET, at("2026-09-22T00:45:00Z"));
      const eveningTs = String(Date.parse("2026-09-21T02:06:00Z") / 1000) + "00";

      expect(parseFloat(eveningTs)).toBeGreaterThanOrEqual(w.floorSeconds);
      // ...and Slack would return it, since its local date (09-20) is after
      // the exclusive slackAfter date.
      expect(w.slackAfter < "2026-09-20").toBe(true);
    });

    it("resolves a different date for a UTC user than for an ET user at the same instant", () => {
      const now = at("2026-09-22T00:45:00Z");
      // Same floor instant; the floor falls on 09-21 in UTC and 09-20 in ET,
      // so the two users' windows legitimately differ by a day. Deriving in
      // UTC for an ET user is exactly the bug.
      expect(computeSearchWindow(24, "UTC", now).slackAfter).toBe("2026-09-20");
      expect(computeSearchWindow(24, ET, now).slackAfter).toBe("2026-09-19");
    });

    it("uses the local date for a zone ahead of UTC too", () => {
      // Floor 2026-09-15 08:30 Tokyo == 2026-09-14T23:30Z: UTC says the
      // 14th, Tokyo says the 15th.
      const now = at("2026-09-15T02:30:00Z");
      const w = computeSearchWindow(3, "Asia/Tokyo", now);
      expect(buggyAfter(w.floorMs)).toBe("2026-09-14");
      expect(w.slackAfter).toBe("2026-09-14");
      // Same string, different meaning: for Tokyo it is floor-date minus a
      // day (correct), for the naive code it was the floor date itself.
    });

    it("handles a floor that lands inside a DST spring-forward day", () => {
      // 2026-03-08 is the US DST transition. Floor 2026-03-08 06:00 ET.
      const w = computeSearchWindow(1, ET, at("2026-03-08T11:00:00Z"));
      expect(w.slackAfter).toBe("2026-03-07");
    });
  });

  describe("the reported window", () => {
    it("reports the exact floor, in both units and ISO form", () => {
      const now = at("2026-09-15T16:00:00Z");
      const w = computeSearchWindow(24, ET, now);
      expect(w.floorMs).toBe(Date.parse("2026-09-14T16:00:00Z"));
      expect(w.floorSeconds).toBe(w.floorMs / 1000);
      expect(w.floorIso).toBe("2026-09-14T16:00:00.000Z");
    });

    it("honours a fractional lookback", () => {
      const w = computeSearchWindow(1.5, ET, at("2026-09-15T16:00:00Z"));
      expect(w.floorMs).toBe(Date.parse("2026-09-15T14:30:00Z"));
    });
  });

  describe("refuses an unusable window rather than searching the wrong range", () => {
    it("throws ValidationError for an unrecognized timezone", () => {
      expect(() => computeSearchWindow(24, "Mars/Olympus_Mons")).toThrow(ValidationError);
    });

    it("throws ValidationError for an empty timezone", () => {
      expect(() => computeSearchWindow(24, "")).toThrow(ValidationError);
    });

    it.each([0, -5, NaN, Infinity])("throws ValidationError for hours=%s", (hours) => {
      expect(() => computeSearchWindow(hours, ET)).toThrow(ValidationError);
    });
  });
});

describe("isValidTimeZone", () => {
  it.each([ET, "UTC", "Asia/Tokyo", "Europe/London"])("accepts %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each([["", "empty"], ["Not/AZone", "unknown"]])("rejects %s (%s)", (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });

  it("rejects undefined and null", () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});

describe("trimToWindow", () => {
  const floorSeconds = 1758000000;

  it("drops a match older than the floor and counts it", () => {
    const matches = [
      { ts: "1758000500.000100" },
      { ts: "1757999999.999900" },
    ];
    const { kept, trimmedOut, unparsableTs } = trimToWindow(matches, floorSeconds);

    expect(kept).toEqual([{ ts: "1758000500.000100" }]);
    expect(trimmedOut).toBe(1);
    expect(unparsableTs).toBe(0);
  });

  it("keeps a match exactly on the floor (the boundary is inclusive)", () => {
    const { kept, trimmedOut } = trimToWindow([{ ts: "1758000000.000000" }], floorSeconds);
    expect(kept).toHaveLength(1);
    expect(trimmedOut).toBe(0);
  });

  it("discriminates at Slack's microsecond resolution", () => {
    const { kept, trimmedOut } = trimToWindow(
      [{ ts: "1758000000.000001" }, { ts: "1757999999.999999" }],
      floorSeconds
    );
    expect(kept.map((m) => m.ts)).toEqual(["1758000000.000001"]);
    expect(trimmedOut).toBe(1);
  });

  it("preserves Slack's ordering among kept matches", () => {
    const matches = [
      { ts: "1758000900.000000" },
      { ts: "1757999000.000000" },
      { ts: "1758000300.000000" },
    ];
    const { kept } = trimToWindow(matches, floorSeconds);
    expect(kept.map((m) => m.ts)).toEqual(["1758000900.000000", "1758000300.000000"]);
  });

  it("keeps — and counts — a match whose ts can't be read, rather than silently dropping it", () => {
    const matches = [
      { ts: "1758000500.000000" },
      { ts: undefined },
      { ts: "not-a-timestamp" },
    ];
    const { kept, trimmedOut, unparsableTs } = trimToWindow(matches, floorSeconds);

    expect(kept).toHaveLength(3);
    expect(trimmedOut).toBe(0);
    expect(unparsableTs).toBe(2);
  });

  it("reports an all-trimmed page distinctly from an empty one", () => {
    const allOld = trimToWindow([{ ts: "1757000000.000000" }], floorSeconds);
    const empty = trimToWindow([], floorSeconds);

    expect(allOld.kept).toHaveLength(0);
    expect(allOld.trimmedOut).toBe(1);
    expect(empty.kept).toHaveLength(0);
    expect(empty.trimmedOut).toBe(0);
  });

  it("carries non-ts fields through untouched", () => {
    const matches = [{ ts: "1758000500.000000", permalink: "https://x/p1", text: "hi" }];
    const { kept } = trimToWindow(matches, floorSeconds);
    expect(kept[0]).toEqual(matches[0]);
  });
});
