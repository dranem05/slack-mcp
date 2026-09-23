import { describe, expect, it } from "vitest";
import { runChannelDigest, type ChannelDigestParams } from "../src/services/conversations/channelDigest.js";
import { fakeSlack, type FakeSlackOptions } from "./helpers/fakeSlack.js";

const ME = "U0SELF00001";
const PRODUCT = "C0PROD00001";
const MKT = "C0MKTG00001";
const NOW = Date.parse("2026-09-22T20:00:00Z");
// 2026-09-22 ET times as Slack ts
const t = (hhmm: string) => (Date.parse(`2026-09-22T${hhmm}:00-04:00`) / 1000).toFixed(6);
const HUMANS = { U1: { is_bot: false, name: "erin" }, U2: { is_bot: false, name: "dana" }, UBOT: { is_bot: true, name: "asana" } };

const defaults: ChannelDigestParams = { channel_ids: PRODUCT, days: 7, limit: 50, concurrency: 6 };

async function run(o: FakeSlackOptions, p: Partial<ChannelDigestParams> = {}) {
  const client = fakeSlack({ users: HUMANS, ...o });
  const out = await runChannelDigest({ client: client as never, now: () => NOW }, { ...defaults, ...p });
  return { out, client };
}

describe("slack_channel_digest", () => {
  it("A8: a root's own last_read drives threads_moved even when the channel cursor is past latest_reply", async () => {
    const { out, client } = await run({
      info: { [PRODUCT]: { id: PRODUCT, name: "-product", last_read: t("13:00") } },
      history: {
        [PRODUCT]: {
          messages: [
            { ts: t("11:08"), user: "U1", text: "root", reply_count: 3, latest_reply: t("12:43"), last_read: t("11:22"), subscribed: true },
          ],
        },
      },
    });
    const ch = out.channels[0];
    expect(ch.threads_moved).toBe(1);
    expect(ch.new_top_level).toBe(0);
    expect(ch.roots[0]).toMatchObject({ thread_moved: true, read_state: "own", new_top_level: false });
    expect(out.outcome).toBe("FINDINGS");
    // days floor, not oldest=last_read
    const call = client.conversations.history.mock.calls[0][0] as { oldest: string };
    expect(Number(call.oldest)).toBeCloseTo(NOW / 1000 - 7 * 86400, 3);
  });

  it("A8 control: own last_read at latest_reply is not moved; nothing new → CLEAN", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("13:00") } },
      history: {
        [PRODUCT]: { messages: [{ ts: t("11:08"), user: "U1", reply_count: 3, latest_reply: t("12:43"), last_read: t("12:43"), subscribed: true }] },
      },
    });
    expect(out.channels[0].threads_moved).toBe(0);
    expect(out.outcome).toBe("CLEAN");
  });

  it("new top-level posts count against the channel cursor; bot posts are counted but not human", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("10:00") } },
      history: {
        [PRODUCT]: {
          messages: [
            { ts: t("12:00"), user: "UBOT", text: "task done" },
            { ts: t("11:00"), user: "U2", text: "hello" },
            { ts: t("09:00"), user: "U2", text: "old" },
          ],
        },
      },
    });
    const ch = out.channels[0];
    expect(ch).toMatchObject({ new_top_level: 2, new_top_level_human: 1 });
    expect(ch.newest).toMatchObject({ ts: t("12:00"), is_bot: true, username: "asana" });
    expect(ch.roots.map((r) => r.ts)).toEqual([t("12:00"), t("11:00")]);
    expect(ch.roots[1].permalink).toBe(`https://acme.slack.com/archives/${PRODUCT}/p${t("11:00").replace(".", "")}`);
  });

  it("A4 (digest): unsubscribed root is unknown_read_state → CANNOT-CHECK, not read", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("13:00") } },
      history: {
        [PRODUCT]: { messages: [{ ts: t("11:08"), user: "U1", reply_count: 2, latest_reply: t("12:43"), subscribed: false }] },
      },
    });
    const ch = out.channels[0];
    expect(ch).toMatchObject({ threads_moved: 0, unknown_read_state: 1 });
    expect(ch.roots[0]).toMatchObject({ read_state: "unknown", moved_since_channel_read: false });
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "read_state", channel_id: PRODUCT, count: 1 }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("A9: a nonexistent channel id is a cannot_check entry; the others still resolve; skipped 1", async () => {
    const { out } = await run(
      {
        info: { [PRODUCT]: { name: "-product", last_read: t("13:00") } },
        history: { [PRODUCT]: { messages: [] } },
      },
      { channel_ids: `${PRODUCT},C0NOTREAL01, not-an-id` }
    );
    expect(out.coverage).toMatchObject({ requested: 3, resolved: 1, skipped: 2 });
    expect(out.coverage.first_error).toBeDefined();
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "channel", channel_id: "C0NOTREAL01", reason: expect.stringContaining("channel_not_found") }));
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "channel", channel_id: "not-an-id" }));
    expect(out.channels.map((c) => c.channel_id)).toEqual([PRODUCT]);
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("has_more is truncated: a partial, never a clean", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("13:00") } },
      history: { [PRODUCT]: { messages: [{ ts: t("12:00"), user: "U1" }], has_more: true } },
    });
    expect(out.channels[0].truncated).toBe(true);
    expect(out.coverage.truncated_channels).toBe(1);
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("no channel last_read → new_top_level null and CANNOT-CHECK", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product" } },
      history: { [PRODUCT]: { messages: [{ ts: t("12:00"), user: "U1" }] } },
    });
    expect(out.channels[0].new_top_level).toBeNull();
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("empty channel_ids resolves nothing and is CANNOT_CHECK", async () => {
    const { out } = await run({}, { channel_ids: " , " });
    expect(out.coverage.requested).toBe(0);
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("a failed bot lookup on a new post is a counted gap, and is_bot reads cannot_check", async () => {
    const { out } = await run({
      users: { U1: new Error("ratelimited") },
      info: { [MKT]: { name: "marketing", last_read: t("10:00") } },
      history: { [MKT]: { messages: [{ ts: t("12:00"), user: "U1" }] } },
    }, { channel_ids: MKT });
    expect(out.channels[0].roots[0].is_bot).toBe("cannot_check");
    expect(out.channels[0].new_top_level_human).toBe(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "bot" }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });
});

describe("slack_channel_digest — review round 1", () => {
  it("my own posts and system-subtype events are counted raw but never as human new", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("10:00") } },
      history: {
        [PRODUCT]: {
          messages: [
            { ts: t("12:00"), user: ME, text: "mine" },
            { ts: t("11:30"), user: "U2", subtype: "channel_join", text: "<@U2> has joined the channel" },
            { ts: t("11:00"), user: "U2", subtype: "thread_broadcast", text: "also sent to channel" },
          ],
        },
      },
      users: { ...HUMANS, [ME]: { is_bot: false, name: "sam" } },
    });
    const ch = out.channels[0];
    expect(ch).toMatchObject({ new_top_level: 3, new_top_level_human: 1 });
    expect(ch.roots.find((r) => r.ts === t("12:00"))).toMatchObject({ by_me: true });
    expect(ch.roots.find((r) => r.ts === t("11:30"))).toMatchObject({ subtype: "channel_join" });
    expect(out.outcome).toBe("FINDINGS");
  });

  it("only-mine / only-system new posts do not make FINDINGS", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("10:00") } },
      history: { [PRODUCT]: { messages: [{ ts: t("12:00"), user: ME }, { ts: t("11:30"), user: "U2", subtype: "channel_join" }] } },
      users: { ...HUMANS, [ME]: { is_bot: false } },
    });
    expect(out.channels[0].new_top_level_human).toBe(0);
    expect(out.outcome).toBe("CLEAN");
  });

  it("replies with no declared latest_reply are unknown_read_state, not silently skipped", async () => {
    const { out } = await run({
      info: { [PRODUCT]: { name: "-product", last_read: t("13:00") } },
      history: { [PRODUCT]: { messages: [{ ts: t("11:08"), user: "U1", reply_count: 3, last_read: t("11:22") }] } },
    });
    expect(out.channels[0].unknown_read_state).toBe(1);
    expect(out.outcome).toBe("CANNOT_CHECK");
  });
});
