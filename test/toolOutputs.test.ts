// Existing tools' output pinned against origin/main (21aa052). The snapshot
// file was written by running this file on origin/main before any source
// change; a later change that alters these bytes fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectConversationsTools } from "./helpers/toolHarness.js";
import { fixtureClient } from "./helpers/fixture.js";

const NOW = Date.parse("2026-09-22T18:00:00Z");

describe("existing tool output is byte-identical to origin/main", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("slack_conversations_search_messages (no new params)", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(await h.call("slack_conversations_search_messages", { query: "hello" })).toMatchSnapshot();
  });

  // Additive: `window`, and the widened after: date (the spec'd search-window
  // fix). Everything else keeps origin/main's bytes.
  it("slack_my_mentions", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(await h.call("slack_my_mentions", { hours: 24 }));
    expect(out.query).toBe("<@UME000001> after:2026-09-19");
    expect(out.window).toEqual({ floor_iso: "2026-09-21T18:00:00.000Z", slack_after: "2026-09-19", trimmed_out: 0 });
    delete out.window;
    out.query = "<@UME000001> after:2026-09-21"; // origin/main's query
    expect(JSON.stringify(out)).toMatchSnapshot();
  });

  it("slack_conversations_history", async () => {
    const h = await connectConversationsTools(fixtureClient());
    expect(await h.call("slack_conversations_history", { channel_id: "C0000000001" })).toMatchSnapshot();
  });

  // Additive: thread read-state keys on the compact replies output.
  it("slack_conversations_replies", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(
      await h.call("slack_conversations_replies", { channel_id: "C0000000001", thread_ts: "1790000000.000100" })
    );
    expect(out.messages[0]).toMatchObject({
      subscribed: true, last_read: "1790050000.000100", latest_reply: "1790100000.000100", reply_users_count: 1,
    });
    // Never defaulted: the reply carries none of them.
    expect(Object.keys(out.messages[1])).not.toContain("last_read");
    for (const m of out.messages) for (const k of ["subscribed", "last_read", "latest_reply", "reply_users_count"]) delete m[k];
    expect(JSON.stringify(out)).toMatchSnapshot();
  });

  it("slack_conversations_history does not gain the replies-only keys", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = await h.call("slack_conversations_history", { channel_id: "C0000000001" });
    expect(out).not.toContain("last_read");
  });

  // Additive: the unmeasurable conversations are counted and named.
  it("slack_conversations_unreads", async () => {
    const h = await connectConversationsTools(fixtureClient());
    const out = JSON.parse(await h.call("slack_conversations_unreads", {}));
    expect(out.unread_count_unavailable).toBe(1);
    expect(out.unread_count_unavailable_names).toEqual(["marketing"]);
    delete out.unread_count_unavailable;
    delete out.unread_count_unavailable_names;
    expect(JSON.stringify(out)).toMatchSnapshot();
  });
});
