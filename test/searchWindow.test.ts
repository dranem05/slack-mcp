import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchWindow, trimToWindow } from "../src/utils/searchWindow.js";
import { connectConversationsTools } from "./helpers/toolHarness.js";
import { fixtureClient } from "./helpers/fixture.js";

describe("searchWindow", () => {
  it("after: is the UTC date two days before the floor", () => {
    const w = searchWindow(24, Date.parse("2026-09-21T01:00:00Z"));
    expect(w).toMatchObject({ floor_iso: "2026-09-20T01:00:00.000Z", slack_after: "2026-09-18" });
    // the public bug: floor date itself as after: (exclusive) → the floor day is lost
    expect(w.slack_after < w.floor_iso.slice(0, 10)).toBe(true);
  });

  it("an evening-ET floor still covers its ET day and the UTC day (both boundary readings)", () => {
    // 2026-09-20 22:06 ET = 2026-09-21 02:06 UTC
    const w = searchWindow(1, Date.parse("2026-09-21T03:06:00Z"));
    expect(w.slack_after).toBe("2026-09-19"); // exclusive → 09-20 onward in either zone
  });

  it("trims to ts >= floor, keeps the floor itself, keeps unparsable ts", () => {
    const floor = 1790000000;
    const { kept, trimmed_out } = trimToWindow(
      [{ ts: "1790000000.000000" }, { ts: "1789999999.999999" }, { ts: "junk" }, {}],
      floor
    );
    expect(kept.map((m) => m.ts)).toEqual(["1790000000.000000", "junk", undefined]);
    expect(trimmed_out).toBe(1);
  });

  it("rejects a non-positive lookback", () => {
    expect(() => searchWindow(0)).toThrow();
  });
});

describe("slack_conversations_search_messages hours/days", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-22T18:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("routes through the window, forces timestamp desc, trims and reports reached_floor", async () => {
    const c = fixtureClient();
    const h = await connectConversationsTools(c);
    const out = JSON.parse(await h.call("slack_conversations_search_messages", { query: "hello", hours: 1, sort: "score" }));
    expect(c.search.messages).toHaveBeenCalledWith(expect.objectContaining({ query: "hello after:2026-09-20", sort: "timestamp", sort_dir: "desc" }));
    expect(out.matches.map((m: { ts: string }) => m.ts)).toEqual(["1790100000.000100"]);
    expect(out.window).toEqual({ floor_iso: "2026-09-22T17:00:00.000Z", slack_after: "2026-09-20", trimmed_out: 1 });
    expect(out.reached_floor).toBe(true);
  });

  it("days works; reached_floor false when nothing trimmed and more pages exist", async () => {
    const c = fixtureClient();
    c.search.messages.mockResolvedValueOnce({ ok: true, messages: { total: 300, matches: [], paging: { count: 20, total: 300, page: 1, pages: 3 } } } as never);
    const h = await connectConversationsTools(c);
    const out = JSON.parse(await h.call("slack_conversations_search_messages", { query: "x", days: 2 }));
    expect(out.reached_floor).toBe(false);
    expect(out.window.slack_after).toBe("2026-09-18");
  });

  it("hours and days together is an error", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(await h.call("slack_conversations_search_messages", { query: "x", days: 2, hours: 3 }));
    expect(out.ok).toBe(false);
  });

  it("my_mentions trims matches older than the floor", async () => {
    const c = fixtureClient();
    const h = await connectConversationsTools(c);
    const out = JSON.parse(await h.call("slack_my_mentions", { hours: 1 }));
    expect(out.matches).toHaveLength(1);
    expect(out.window.trimmed_out).toBe(1);
  });
});
