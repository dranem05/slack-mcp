// A11 — existing tools' public output is byte-identical to pre-Phase-2 on
// the same fixture. The snapshots in __snapshots__/toolOutputs.test.ts.snap
// were written by running this file against 936b1ae (before any Phase 2
// change) and are the contract: a Phase 2 change that alters any of these
// bytes fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectConversationsTools } from "./helpers/toolHarness.js";

const NOW = Date.parse("2026-09-22T18:00:00Z");

function fixtureClient() {
  const searchMatches = [
    {
      iid: "i1",
      channel: { id: "C0000000001", name: "marketing", is_im: false, is_mpim: false },
      user: "U0000000002",
      username: "alice",
      ts: "1790100000.000100",
      text: "hello <@UME000001>",
      permalink: "https://acme.slack.com/archives/C0000000001/p1790100000000100?thread_ts=1790000000.000100",
      blocks: [{ type: "rich_text" }],
      no_reactions: true,
    },
    {
      iid: "i2",
      channel: { id: "C0000000001", name: "marketing" },
      user: "U0000000003",
      username: "frank",
      ts: "1789000000.000100", // older than the 24h floor — trimmed by my_mentions
      text: "old",
      permalink: "https://acme.slack.com/archives/C0000000001/p1789000000000100",
    },
  ];
  const threadRoot = {
    ts: "1790000000.000100",
    user: "U0000000002",
    text: "root",
    thread_ts: "1790000000.000100",
    reply_count: 2,
    reply_users_count: 2,
    latest_reply: "1790100000.000100",
    reply_users: ["U0000000002", "UME000001"],
    subscribed: true,
    last_read: "1790050000.000100",
    reactions: [{ name: "eyes", count: 1, users: ["UME000001"] }],
    blocks: [{ type: "rich_text" }],
  };
  return {
    search: {
      messages: vi.fn(async () => ({
        ok: true,
        messages: {
          total: 2,
          matches: structuredClone(searchMatches),
          paging: { count: 20, total: 2, page: 1, pages: 1 },
        },
      })),
    },
    conversations: {
      history: vi.fn(async () => ({
        ok: true,
        messages: [structuredClone(threadRoot), { ts: "1790000001.000100", user: "U0000000003", text: "plain" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      })),
      replies: vi.fn(async () => ({
        ok: true,
        messages: [
          structuredClone(threadRoot),
          { ts: "1790100000.000100", user: "U0000000002", text: "reply", thread_ts: "1790000000.000100" },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      })),
      info: vi.fn(async ({ channel }: { channel: string }) => ({
        ok: true,
        channel: channel.startsWith("D")
          ? { id: channel, last_read: "1790000000.000100", unread_count: 2 }
          : { id: channel, last_read: "1790000000.000100" },
      })),
    },
    users: {
      conversations: vi.fn(async () => ({
        ok: true,
        channels: [
          { id: "C0000000001", name: "marketing" },
          { id: "D0000000001", is_im: true },
        ],
        response_metadata: { next_cursor: "" },
      })),
    },
    chat: {
      postMessage: vi.fn(async () => ({
        ok: true,
        channel: "C0000000001",
        ts: "1790200000.000100",
        message: { ts: "1790200000.000100", text: "hi", user: "UME000001" },
      })),
    },
  };
}

describe("A11: existing tool output is byte-identical", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("slack_conversations_search_messages (no new params)", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(await h.call("slack_conversations_search_messages", { query: "hello" })).toMatchSnapshot();
  });

  it("slack_my_mentions", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(await h.call("slack_my_mentions", { hours: 24 })).toMatchSnapshot();
  });

  it("slack_conversations_history", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(await h.call("slack_conversations_history", { channel_id: "C0000000001" })).toMatchSnapshot();
  });

  it("slack_conversations_add_message", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(
      await h.call("slack_conversations_add_message", { channel_id: "C0000000001", text: "hi" })
    ).toMatchSnapshot();
  });

  it("slack_conversations_replies — pre-Phase-2 fields unchanged", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(
      await h.call("slack_conversations_replies", { channel_id: "C0000000001", thread_ts: "1790000000.000100" })
    );
    // Phase 2 adds read-state keys (A10); every pre-existing key keeps its value.
    const PHASE2_KEYS = ["subscribed", "last_read", "latest_reply", "reply_users_count"];
    for (const m of out.messages) for (const k of PHASE2_KEYS) delete m[k];
    expect(JSON.stringify(out)).toMatchSnapshot();
  });

  it("slack_conversations_unreads — the unreads list itself unchanged", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(await h.call("slack_conversations_unreads", {}));
    expect(JSON.stringify(out.unreads)).toMatchSnapshot();
  });
});
