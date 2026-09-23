import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectConversationsTools } from "./helpers/toolHarness.js";
import { fakeSlack } from "./helpers/fakeSlack.js";
import {
  pruneThreadMessage,
  pruneThreadMessages,
  pruneSearchMatch,
  permalinkThreadTs,
  SEARCH_MATCH_TEXT_LIMIT,
} from "../src/utils/pruning.js";
import { createBotResolver, reactedBy, parseIdList, tsAfter } from "../src/utils/threadCoverage.js";

describe("A10: replies prune carries thread read-state", () => {
  it("keeps subscribed/last_read/latest_reply/reply_users_count when Slack sent them", () => {
    const p = pruneThreadMessage({
      ts: "1.000001", user: "U1", reply_count: 2, subscribed: true, last_read: "3.000001",
      latest_reply: "3.000001", reply_users_count: 2, blocks: [{}],
    } as never);
    expect(p).toMatchObject({ subscribed: true, last_read: "3.000001", latest_reply: "3.000001", reply_users_count: 2 });
    expect(p).not.toHaveProperty("blocks");
  });

  it("absent fields stay absent — never defaulted", () => {
    const p = pruneThreadMessage({ ts: "1.000001", user: "U1", subscribed: false });
    expect(Object.keys(p)).not.toContain("last_read");
    expect(JSON.stringify(p)).not.toContain("last_read");
    expect(p.subscribed).toBe(false);
    expect(pruneThreadMessages([{ ts: "1" }])).toHaveLength(1);
  });

  it("through the real tool: default output contains the fields", async () => {
    const client = fakeSlack({
      replies: {
        "C0000000001|1790000000.000100": [
          { ts: "1790000000.000100", user: "U1", reply_count: 1, latest_reply: "1790000001.000100", last_read: "1790000000.000100", subscribed: true, reply_users_count: 1 },
          { ts: "1790000001.000100", user: "U2", thread_ts: "1790000000.000100" },
        ],
      },
    });
    const h = await connectConversationsTools(client);
    const out = JSON.parse(await h.call("slack_conversations_replies", { channel_id: "C0000000001", thread_ts: "1790000000.000100" }));
    expect(out.messages[0]).toMatchObject({ last_read: "1790000000.000100", latest_reply: "1790000001.000100", subscribed: true, reply_users_count: 1 });
    expect(out.messages[1]).not.toHaveProperty("last_read");
  });
});

describe("pruneSearchMatch / permalinkThreadTs", () => {
  it("root from the permalink: string, null (no replies) or undefined (unknown)", () => {
    expect(permalinkThreadTs("https://x.slack.com/archives/C1/p1?thread_ts=1.5&cid=C1")).toBe("1.5");
    expect(permalinkThreadTs("https://x.slack.com/archives/C1/p1")).toBeNull();
    expect(permalinkThreadTs("nope")).toBeUndefined();
    expect(permalinkThreadTs(undefined)).toBeUndefined();
  });

  it("slims to the triage shape; bots by no-user or override only", () => {
    const long = "x".repeat(SEARCH_MATCH_TEXT_LIMIT + 5);
    const p = pruneSearchMatch({
      channel: { id: "C1", name: "m" }, user: "U1", username: "u", ts: "1.000001", text: long,
      permalink: "https://x.slack.com/archives/C1/p1?thread_ts=0.5", blocks: [{}], files: [{}],
    } as never);
    expect(p).toEqual({
      channel_id: "C1", channel_name: "m", user: "U1", username: "u", ts: "1.000001",
      permalink: "https://x.slack.com/archives/C1/p1?thread_ts=0.5", thread_ts: "0.5",
      text: "x".repeat(SEARCH_MATCH_TEXT_LIMIT), truncated: true,
    });
    expect(pruneSearchMatch({ ts: "1" }).is_bot).toBe(true);
    expect(pruneSearchMatch({ ts: "1", user: "UB" }, new Set(["UB"])).is_bot).toBe(true);
    expect(pruneSearchMatch({ ts: "1", user: "U1" })).not.toHaveProperty("is_bot");
  });
});

describe("threadCoverage helpers", () => {
  it("reactedBy keys on reactions[].users only", () => {
    expect(reactedBy([{ name: "a", users: ["U1"] }], "U1")).toBe(true);
    expect(reactedBy([{ name: "a", users: ["U2"] }], "U1")).toBe(false);
    expect(reactedBy(undefined, "U1")).toBe(false);
    expect(reactedBy([{ name: "a" }], "U1")).toBe(false);
  });
  it("tsAfter is numeric and undefined on unreadable input", () => {
    expect(tsAfter("1790000000.000101", "1790000000.000100")).toBe(true);
    expect(tsAfter("1790000000.000100", "1790000000.000100")).toBe(false);
    expect(tsAfter(undefined, "1")).toBeUndefined();
    expect(tsAfter("x", "1")).toBeUndefined();
  });
  it("parseIdList trims, drops empties, dedupes", () => {
    expect(parseIdList(" U1, ,U2,U1 ")).toEqual(["U1", "U2"]);
    expect(parseIdList(undefined)).toEqual([]);
  });
  it("bot resolver: a users.info response without is_bot rejects rather than reading human", async () => {
    const r = createBotResolver({ users: { info: async () => ({ ok: true, user: { name: "x" } }) } } as never, []);
    await expect(r.resolve("U1")).rejects.toThrow(/is_bot/);
  });
});

describe("slack_conversations_search_messages — hours/days", () => {
  const NOW = Date.parse("2026-09-22T18:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const searchClient = () => {
    const matches = [
      { ts: "1790100000.000100", text: "in" },
      { ts: "1789000000.000100", text: "out" },
    ];
    return {
      search: {
        messages: vi.fn(async () => ({ ok: true, messages: { total: 2, matches: structuredClone(matches), paging: { pages: 1 } } })),
      },
    };
  };

  it("routes through the window helper: widened after:, trimmed matches, window object", async () => {
    const client = searchClient();
    const h = await connectConversationsTools(client);
    const out = JSON.parse(
      await h.call("slack_conversations_search_messages", { query: "in:#marketing", hours: 24, sort: "timestamp" })
    );
    expect(client.search.messages).toHaveBeenCalledWith(expect.objectContaining({ query: "in:#marketing after:2026-09-20" }));
    expect(out.matches.map((m: { text: string }) => m.text)).toEqual(["in"]);
    expect(out.window).toMatchObject({ hours: 24, slack_after: "2026-09-20", trimmed_out: 1, reached_floor: true, tz_source: "slack" });
  });

  it("days works; under score sort reached_floor is not claimed", async () => {
    const h = await connectConversationsTools(searchClient());
    const out = JSON.parse(await h.call("slack_conversations_search_messages", { query: "x", days: 1 }));
    expect(out.window).toMatchObject({ days: 1 });
    expect(out.window).not.toHaveProperty("reached_floor");
    expect(out.window.reached_floor_note).toBeDefined();
  });

  it("rejects hours+days, and hours with a date modifier already in the query", async () => {
    const h = await connectConversationsTools(searchClient());
    expect(JSON.parse(await h.call("slack_conversations_search_messages", { query: "x", hours: 1, days: 1 })).ok).toBe(false);
    const both = JSON.parse(await h.call("slack_conversations_search_messages", { query: "x after:2026-01-01", hours: 1 }));
    expect(both).toMatchObject({ ok: false, error: expect.stringMatching(/date modifier/) });
    const on = JSON.parse(await h.call("slack_conversations_search_messages", { query: "on:2026-01-01 x", days: 1 }));
    expect(on.ok).toBe(false);
  });
});

describe("slack_conversations_unreads — unavailable counts are reported, not zeroed", () => {
  it("channels with no declared unread_count are counted and named", async () => {
    const client = {
      users: {
        conversations: vi.fn(async () => ({
          ok: true,
          channels: [{ id: "C0000000001", name: "marketing" }, { id: "D0000000001", is_im: true }, { id: "C0000000002", name: "bi" }],
          response_metadata: { next_cursor: "" },
        })),
      },
      conversations: {
        info: vi.fn(async ({ channel }: { channel: string }) => ({
          ok: true,
          channel: channel.startsWith("D") ? { unread_count: 0 } : { last_read: "1" },
        })),
      },
    };
    const h = await connectConversationsTools(client);
    const out = JSON.parse(await h.call("slack_conversations_unreads", {}));
    expect(out.unreads).toEqual([]);
    expect(out.unread_count_unavailable).toBe(2);
    expect(out.unread_count_unavailable_channels).toEqual(["marketing", "bi"]);
  });
});

describe("new tools are registered and return the envelope through MCP", () => {
  it("slack_my_threads zero-match run is CANNOT_CHECK end to end", async () => {
    const h = await connectConversationsTools(fakeSlack({}), { me: "U0SELF00001" });
    const out = JSON.parse(await h.call("slack_my_threads", {}));
    expect(out).toMatchObject({ ok: true, outcome: "CANNOT_CHECK", scope: "both" });
    expect(out.coverage.threads.matches).toBe(0);
    expect(out.coverage.dms.matches).toBe(0);
  });

  it("slack_channel_digest bad input surfaces as ok:false, not a crash", async () => {
    const h = await connectConversationsTools(fakeSlack({}));
    const out = JSON.parse(await h.call("slack_channel_digest", { channel_ids: "C0000000001", concurrency: 0 }));
    expect(out.ok).toBe(false);
  });

  it("slack_my_threads rejects a non-positive days", async () => {
    const h = await connectConversationsTools(fakeSlack({}));
    expect(JSON.parse(await h.call("slack_my_threads", { days: 0 })).ok).toBe(false);
  });
});
