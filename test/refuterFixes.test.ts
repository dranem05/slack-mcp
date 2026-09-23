// Independent-refuter findings (2026-09-22). Each block is written to fail
// against dd82dad and pass after the fix, both directions.
import { describe, expect, it } from "vitest";
import { runMyThreads, type MyThreadsParams } from "../src/services/conversations/myThreads.js";
import { runChannelDigest } from "../src/services/conversations/channelDigest.js";
import { fakeSlack, type Msg, type FakeSlackOptions } from "./helpers/fakeSlack.js";

const ME = "U0SELF00001";
const HUMAN = "U0HUMAN0001";
const BOT = "U0BOT000001";
const C1 = "C0000000001";
const D1 = "D0000000001";
const G1 = "C0MPIM00001";
const NOW = Date.parse("2026-09-23T03:00:00Z");
const ROOT = "1790000000.000100";
const USERS = {
  [ME]: { is_bot: false, name: "sam" },
  [HUMAN]: { is_bot: false, name: "human" },
  [BOT]: { is_bot: true, name: "deploybot" },
  // Live: users.info says is_bot:false for both Slack system senders.
  USLACKBOT: { is_bot: false, name: "slackbot" },
  USLACK: { is_bot: false },
};

const ts = (n: number) => `17900${String(10000 + n)}.000100`;

function match(channel: string, t: string, o: { user?: string; root?: string; im?: boolean; mpim?: boolean } = {}): Msg {
  return {
    channel: { id: channel, name: "x", is_im: o.im ?? false, is_mpim: o.mpim ?? false },
    user: o.user ?? ME,
    ts: t,
    text: "t",
    permalink: `https://a.slack.com/archives/${channel}/p${t.replace(".", "")}` + (o.root ? `?thread_ts=${o.root}&cid=${channel}` : ""),
  };
}

const P: MyThreadsParams = { scope: "threads", days: 7, max_units: 40, concurrency: 2, include_raw: false };

async function run(o: FakeSlackOptions, p: Partial<MyThreadsParams> = {}) {
  const client = fakeSlack({ users: USERS, ...o });
  const out = await runMyThreads(
    { client: client as never, getMyUserId: async () => ME, getMyTimezone: async () => ({ tz: "America/New_York", source: "slack" as const }), now: () => NOW },
    { ...P, ...p }
  );
  return { out, client };
}

function thread(replies: Array<[number, string, Msg?]>, parentExtra: Msg = {}): Msg[] {
  const last = replies[replies.length - 1][0];
  return [
    { ts: ROOT, user: HUMAN, reply_count: replies.length, latest_reply: ts(last), last_read: ts(last), subscribed: true, ...parentExtra },
    ...replies.map(([n, user, extra]) => ({ ts: ts(n), user, thread_ts: ROOT, ...(extra ?? {}) })),
  ];
}

describe("fix 1 — owes is judged from the newest NON-bot message", () => {
  it("human asks me, then a bot posts last → owes me, a row (FINDINGS)", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, ME], [2, HUMAN], [3, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", newest_is_bot: true, newest_user: BOT, turn_user: HUMAN, turn_ts: ts(2) });
    expect(out.outcome).toBe("FINDINGS");
  });

  it("control: I replied, then a bot posts last → owes them, not a row", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(2), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, HUMAN], [2, ME], [3, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "them", newest_is_bot: true, turn_user: ME });
    expect(out.outcome).toBe("CLEAN");
  });

  it("acknowledged is read from the turn message (the human ask), not the bot post", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, ME], [2, HUMAN, { reactions: [{ name: "+1", users: [ME] }] }], [3, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", acknowledged: true });
    expect(out.outcome).toBe("CLEAN");
  });

  it("latest window all bots → fetches more (bounded) and finds the human ask", async () => {
    const { out, client } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, ME], [2, HUMAN], [3, BOT], [4, BOT], [5, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", turn_user: HUMAN });
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
    expect((client.conversations.replies.mock.calls[1][0] as { limit: number }).limit).toBeLessThanOrEqual(200);
  });

  it("no human in the extended window → CANNOT_CHECK with a counted reason, never CLEAN, never dropped", async () => {
    const replies: Array<[number, string]> = [[1, ME], [2, HUMAN]];
    for (let i = 3; i < 70; i++) replies.push([i, BOT]);
    const { out } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread(replies) },
    });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "unit", root_ts: ROOT, reason: expect.stringMatching(/no_human_in_window/) }));
    expect(out.coverage.threads).toMatchObject({ units_skipped: 1, no_human_in_window: 1 });
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("DM thread: bot replied to my message → owes them (the claude-DM shape)", async () => {
    const root = ts(1);
    const { out } = await run(
      {
        dmPages: [[match(D1, ts(2), { user: BOT, im: true, root }), match(D1, root, { user: ME, im: true, root })]],
        info: { [D1]: { is_im: true, user: BOT, last_read: ts(2) } },
        replies: {
          [`${D1}|${root}`]: [{ ts: root, user: ME, reply_count: 1, latest_reply: ts(2), last_read: ts(2), subscribed: true }, { ts: ts(2), user: BOT, thread_ts: root }],
          [`${D1}|${ts(2)}`]: [{ ts: ts(2), user: BOT, thread_ts: root }],
        },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ owes: "them", newest_is_bot: true, turn_user: ME });
  });

  it("DM main line: human asks, then a bot posts last → owes me (row)", async () => {
    const { out } = await run(
      {
        dmPages: [[match(G1, ts(3), { user: BOT, mpim: true }), match(G1, ts(2), { user: HUMAN, mpim: true })]],
        info: { [G1]: { last_read: ts(1) } },
        replies: { [`${G1}|${ts(3)}`]: [{ ts: ts(3), user: BOT }], [`${G1}|${ts(2)}`]: [{ ts: ts(2), user: HUMAN }] },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ owes: "me", newest_is_bot: true, turn_user: HUMAN, turn_ts: ts(2) });
    expect(out.outcome).toBe("FINDINGS");
  });

  it("DM, all-bot window in a group DM → fetches history; human earlier → owes me; none → CANNOT_CHECK", async () => {
    const base: FakeSlackOptions = {
      dmPages: [[match(G1, ts(3), { user: BOT, mpim: true })]],
      info: { [G1]: { last_read: ts(1) } },
      replies: { [`${G1}|${ts(3)}`]: [{ ts: ts(3), user: BOT }] },
    };
    const found = await run({ ...base, history: { [G1]: { messages: [{ ts: ts(3), user: BOT }, { ts: ts(0), user: HUMAN, text: "?" }] } } }, { scope: "dms" });
    expect(found.out.units[0]).toMatchObject({ owes: "me", turn_user: HUMAN, turn_ts: ts(0) });

    const bots = Array.from({ length: 60 }, (_, i) => ({ ts: ts(3 - i), user: BOT }));
    const none = await run({ ...base, history: { [G1]: { messages: bots } } }, { scope: "dms" });
    expect(none.out.units).toHaveLength(0);
    expect(none.out.cannot_check).toContainEqual(expect.objectContaining({ scope: "dms", reason: expect.stringMatching(/no_human_in_window/) }));
    expect(none.out.outcome).toBe("CANNOT_CHECK");
  });

  it("1:1 IM whose counterpart is a bot → owes nobody (declared), not a row, not a gap", async () => {
    const { out } = await run(
      {
        dmPages: [[match(D1, ts(3), { user: BOT, im: true }), match(D1, ts(2), { user: BOT, im: true })]],
        info: { [D1]: { is_im: true, user: BOT, last_read: ts(1) } },
        replies: { [`${D1}|${ts(3)}`]: [{ ts: ts(3), user: BOT }] },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ owes: "nobody", newest_is_bot: true });
    expect(out.outcome).toBe("CLEAN");
  });
});

describe("fix 2 — Slack system senders are bots by declared constant", () => {
  it("USLACK / USLACKBOT newest in an IM is never a human row, without a users.info call", async () => {
    const { out, client } = await run(
      {
        dmPages: [[match(D1, ts(3), { user: "USLACK", im: true })]],
        info: { [D1]: { is_im: true, user: "USLACK", last_read: ts(1) } },
        replies: { [`${D1}|${ts(3)}`]: [{ ts: ts(3), user: "USLACK", text: "<@U1> archived the channel" }] },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ newest_is_bot: true, newest_bot_source: "slack_system", owes: "nobody" });
    expect(client.users.info).not.toHaveBeenCalled();
    expect(out.outcome).toBe("CLEAN");
  });

  it("USLACKBOT in a channel thread counts as a bot too", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, ME], [2, "USLACKBOT"]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "them", newest_is_bot: true, newest_bot_source: "slack_system" });
  });

  it("digest: a USLACKBOT post is not new_top_level_human; a human post still is (control)", async () => {
    const client = fakeSlack({
      users: USERS,
      info: { [C1]: { name: "x", last_read: ts(0) } },
      history: { [C1]: { messages: [{ ts: ts(2), user: "USLACKBOT", text: "reminder" }, { ts: ts(1), user: "USLACK" }] } },
    });
    const out = await runChannelDigest({ client: client as never, now: () => NOW }, { channel_ids: C1, days: 7, limit: 50, concurrency: 2 });
    expect(out.channels[0]).toMatchObject({ new_top_level: 2, new_top_level_human: 0 });
    expect(out.outcome).toBe("CLEAN");

    const c2 = fakeSlack({
      users: USERS,
      info: { [C1]: { name: "x", last_read: ts(0) } },
      history: { [C1]: { messages: [{ ts: ts(2), user: HUMAN }] } },
    });
    const o2 = await runChannelDigest({ client: c2 as never, now: () => NOW }, { channel_ids: C1, days: 7, limit: 50, concurrency: 2 });
    expect(o2.channels[0].new_top_level_human).toBe(1);
  });
});

describe("fix 3 — absent reply_count on a declared thread root is CANNOT_CHECK", () => {
  it("permalink says thread, parent has no reply_count → CANNOT_CHECK, not 'root is newest'", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: {
        [`${C1}|${ROOT}`]: [{ ts: ROOT, user: ME, latest_reply: ts(2) }, { ts: ts(1), user: ME, thread_ts: ROOT }, { ts: ts(2), user: HUMAN, thread_ts: ROOT }],
      },
    });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/reply_count absent/) }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("control: reply_count 0 declared → root is the newest", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ROOT, { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: [{ ts: ROOT, user: HUMAN, reply_count: 0, last_read: ROOT, subscribed: true }] },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", newest_ts: ROOT });
  });
});

describe("fix 4 — the replies window is parent + latest N (undocumented Slack behaviour)", () => {
  const long: Array<[number, string]> = [];
  for (let i = 1; i <= 9; i++) long.push([i, i % 2 ? ME : HUMAN]);
  long.push([10, HUMAN]);

  it("fake honors limit as parent + latest N", async () => {
    const client = fakeSlack({ replies: { [`${C1}|${ROOT}`]: thread(long) } });
    const r = await client.conversations.replies({ channel: C1, ts: ROOT, limit: 3 });
    expect(r.messages.map((m) => m.ts)).toEqual([ROOT, ts(8), ts(9), ts(10)]);
    expect(r.has_more).toBe(true);
  });

  it("10-reply thread: the newest (10th) reply is in the window → verdict owes me", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ts(9), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread(long) },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", newest_ts: ts(10) });
  });

  it("if Slack ever returned the OLDEST replies, the guard reports CANNOT_CHECK — never a wrong verdict", async () => {
    const { out } = await run({
      repliesWindow: "oldest",
      threadPages: [[match(C1, ts(9), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread(long) },
    });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/newest_not_in_window/) }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });
});

describe("fix 5 — horizon_days is emitted every run", () => {
  it("top level and per channel, including an empty run", async () => {
    const client = fakeSlack({ info: { [C1]: { last_read: ts(0) } }, history: { [C1]: { messages: [] } } });
    const out = await runChannelDigest({ client: client as never, now: () => NOW }, { channel_ids: C1, days: 5, limit: 50, concurrency: 2 });
    expect(out.horizon_days).toBe(5);
    expect(out.channels[0].horizon_days).toBe(5);
    const empty = await runChannelDigest({ client: client as never, now: () => NOW }, { channel_ids: "", days: 5, limit: 50, concurrency: 2 });
    expect(empty.horizon_days).toBe(5);
  });
});

describe("fix 1 — the parent only takes the turn when the reply window is complete", () => {
  it("human root, my reply, then 3 bot replies: latest-3 window is all bots; the root must NOT stand in → owes them", async () => {
    const { out, client } = await run({
      threadPages: [[match(C1, ts(1), { root: ROOT })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, ME], [2, BOT], [3, BOT], [4, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "them", turn_user: ME });
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
  });

  it("complete window: human root, only bot replies → the root takes the turn → owes me", async () => {
    const { out } = await run({
      threadPages: [[match(C1, ROOT, { root: ROOT, user: HUMAN })]],
      replies: { [`${C1}|${ROOT}`]: thread([[1, BOT], [2, BOT]]) },
    });
    expect(out.units[0]).toMatchObject({ owes: "me", turn_ts: ROOT, turn_user: HUMAN });
  });
});
