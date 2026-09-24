import { describe, expect, it } from "vitest";
import { runMyThreads, type MyThreadsParams } from "../src/services/conversations/myThreads.js";
import { fakeSlack, type FakeSlackOptions, type Msg } from "./helpers/fakeSlack.js";

const ME = "UME0000001";
const ANA = "UANA000001";
const BEN = "UBEN000001";
const BOT = "UBOT000001";
const CH = "C0000000001";
const DM = "D0000000001";
const NOW = Date.parse("2026-09-24T12:00:00Z");
const CLEAR = "done,white_check_mark,heavy_check_mark,shipit,100,heavy_plus_sign";
const ago = (h: number, us = 100) => `${NOW / 1000 - h * 3600}.${String(us).padStart(6, "0")}`;
const USERS = { [ME]: { is_bot: false, name: "me" }, [ANA]: { is_bot: false, name: "ana" }, [BEN]: { is_bot: false, name: "ben" }, [BOT]: { is_bot: true, name: "bot" } };

function match(channel: string, ts: string, root?: string, ch: Msg = {}): Msg {
  const pl = `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}` + (root ? `?thread_ts=${root}&cid=${channel}` : "");
  return { channel: { id: channel, name: "general", is_im: false, is_mpim: false, ...ch }, user: ME, ts, text: "t", permalink: pl, no_reactions: true };
}
const msg = (ts: string, user: string | undefined, extra: Msg = {}): Msg => ({ ts, ...(user ? { user } : {}), text: `from ${user}`, ...extra });
const root = (ts: string, user: string, replyCount: number | undefined, extra: Msg = {}): Msg =>
  msg(ts, user, { thread_ts: ts, ...(replyCount === undefined ? {} : { reply_count: replyCount }), ...extra });

const R = ago(48); // a thread root two days ago
function thread(replies: Msg[], rootExtra: Msg = {}): Msg[] {
  const latest = replies[replies.length - 1]?.ts;
  return [root(R, ANA, replies.length, { latest_reply: latest, last_read: ago(30), ...rootExtra }), ...replies];
}

async function run(o: FakeSlackOptions, p: Partial<MyThreadsParams> = {}) {
  const client = fakeSlack({ users: USERS, ...o });
  const out = await runMyThreads(client as never, ME, { scope: "threads", days: 7, horizon_days: 30, max_units: 60, clearing_reactions: CLEAR, ...p }, NOW);
  return { out, client };
}
const one = async (o: FakeSlackOptions, p: Partial<MyThreadsParams> = {}) => {
  const { out } = await run(o, p);
  expect(out.units).toHaveLength(1);
  return out.units[0];
};
const threadScope = (replies: Msg[], rootExtra: Msg = {}) => ({
  threads: [[match(CH, replies[replies.length - 1].ts as string, R)]],
  replies: { [`${CH}|${R}`]: thread(replies, rootExtra) },
});

describe("owes / turn", () => {
  it("owes me when the newest human is someone else; them when it is me", async () => {
    expect((await one(threadScope([msg(ago(40), ME), msg(ago(10), ANA)]))).owes).toBe("me");
    expect((await one(threadScope([msg(ago(40), ANA), msg(ago(10), ME)]))).owes).toBe("them");
  });

  it("turn is the newest NON-bot message: a bot posting last does not hide the ask", async () => {
    const u = await one(threadScope([msg(ago(40), ANA), msg(ago(10), BOT)]));
    expect(u.owes).toBe("me");
    expect(u.newest).toMatchObject({ user: ANA, is_bot: false });
    // break it: the human is me → the bot still does not take the turn
    expect((await one(threadScope([msg(ago(40), ME), msg(ago(10), BOT)]))).owes).toBe("them");
  });

  it.each([
    ["user absent", undefined, {}],
    ["USLACKBOT", "USLACKBOT", {}],
    ["USLACK", "USLACK", {}],
    ["bot_user_ids override", BEN, { bot_user_ids: ` ${BEN} ,` }],
    ["users.info is_bot", BOT, {}],
  ])("bot rule: %s is not the turn", async (_n, user, p) => {
    const u = await one(threadScope([msg(ago(40), ME), msg(ago(10), user)]), p as Partial<MyThreadsParams>);
    expect(u.owes).toBe("them");
  });

  it("the same user counts as human without the override (false-negative direction)", async () => {
    expect((await one(threadScope([msg(ago(40), ME), msg(ago(10), BEN)]))).owes).toBe("me");
  });

  it("USLACKBOT is a bot even though users.info would call it human", async () => {
    const u = await one({ ...threadScope([msg(ago(40), ME), msg(ago(10), "USLACKBOT")]), users: { ...USERS, USLACKBOT: { is_bot: false } } });
    expect(u.owes).toBe("them");
  });

  it("a failed users.info lookup makes the unit CANNOT-CHECK, never human", async () => {
    const { out } = await run({ ...threadScope([msg(ago(40), ME), msg(ago(10), BEN)]), users: { ...USERS, [BEN]: new Error("ratelimited") } });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toEqual([expect.objectContaining({ scope: "threads", reason: "ratelimited", channel_id: CH })]);
    // users.info with no is_bot field is also a failure
    const r2 = await run({ ...threadScope([msg(ago(40), ME), msg(ago(10), BEN)]), users: { ...USERS, [BEN]: { name: "ben" } } });
    expect(r2.out.cannot_check[0].reason).toMatch(/no is_bot/);
  });

  it("no human among the fetched → owes cannot_check (and listed)", async () => {
    const { out } = await run(threadScope([msg(ago(12), BOT), msg(ago(11), BOT), msg(ago(10), BOT), msg(ago(9), BOT)]));
    expect(out.units[0].owes).toBe("cannot_check");
    expect(out.units[0].newest.is_bot).toBe(true);
    expect(out.cannot_check).toEqual([expect.objectContaining({ reason: "no human message among those fetched" })]);
  });

  it("parent is the turn only when every reply was returned", async () => {
    // 4 bot replies, limit 3 → parent + latest 3: the human parent must not stand in
    const cut = await one(threadScope([msg(ago(40), ME), msg(ago(12), BOT), msg(ago(11), BOT), msg(ago(10), BOT)]));
    expect(cut.owes).toBe("cannot_check");
    // complete (2 replies ≤ 3): the parent (ANA) may be the turn
    const full = await one(threadScope([msg(ago(11), BOT), msg(ago(10), BOT)]));
    expect(full.owes).toBe("me");
    expect(full.newest.ts).toBe(R);
  });

  it("replies is called with limit 3 on the root", async () => {
    const { client } = await run(threadScope([msg(ago(10), ANA)]));
    expect(client.conversations.replies).toHaveBeenCalledWith({ channel: CH, ts: R, limit: 3 });
  });
});

describe("reactions", () => {
  const withReaction = (name: string, users = [ME]) =>
    threadScope([msg(ago(40), ME), msg(ago(10), ANA, { reactions: [{ name, count: users.length, users }] })]);

  it("eyes keeps the row and is shown; white_check_mark clears it", async () => {
    const eyes = await one(withReaction("eyes"));
    expect(eyes).toMatchObject({ owes: "me", my_reactions: ["eyes"], acknowledged: false });
    const done = await one(withReaction("white_check_mark"));
    expect(done).toMatchObject({ my_reactions: ["white_check_mark"], acknowledged: true });
  });

  it("thumbsup_all is shown but does not clear (Vendor)", async () => {
    expect(await one(withReaction("thumbsup_all"))).toMatchObject({ my_reactions: ["thumbsup_all"], acknowledged: false });
  });

  it("someone else's clearing reaction is not mine", async () => {
    expect(await one(withReaction("white_check_mark", [ANA]))).toMatchObject({ my_reactions: [], acknowledged: false });
  });

  it("skin-tone variants match the declared base name", async () => {
    const u = await one(withReaction("heavy_plus_sign::skin-tone-3"));
    expect(u.acknowledged).toBe(true);
    expect((await run(withReaction("heavy_plus_sign::skin-tone-3"), { clearing_reactions: "done" })).out.units[0].acknowledged).toBe(false);
  });

  it("no clearing list → nothing clears", async () => {
    expect((await run(withReaction("done"), { clearing_reactions: undefined })).out.units[0].acknowledged).toBe(false);
  });

  it("reactions are read from the turn message, not a newer bot post", async () => {
    const u = await one(threadScope([msg(ago(20), ANA), msg(ago(10), BOT, { reactions: [{ name: "done", users: [ME] }] })]));
    expect(u).toMatchObject({ my_reactions: [], acknowledged: false });
  });
});

describe("unseen / active / declared fields", () => {
  it("unseen = latest_reply > last_read; false when read; null when last_read absent", async () => {
    expect((await one(threadScope([msg(ago(10), ANA)]))).unseen).toBe(true);
    expect((await one(threadScope([msg(ago(10), ANA)], { last_read: ago(10) }))).unseen).toBe(false);
    expect((await one(threadScope([msg(ago(10), ANA)], { last_read: undefined }))).unseen).toBeNull();
  });

  it("active when the newest message is within days; older units still returned inactive", async () => {
    expect((await one(threadScope([msg(ago(24 * 6), ANA)]))).active).toBe(true);
    const OLD = ago(24 * 25);
    const old = await one({
      threads: [[match(CH, ago(24 * 20), OLD)]],
      replies: { [`${CH}|${OLD}`]: [root(OLD, ANA, 2, { latest_reply: ago(24 * 20) }), msg(ago(24 * 21), ME), msg(ago(24 * 20), ANA)] },
    });
    expect(old).toMatchObject({ active: false, owes: "me" });
  });

  it("threads horizon: a 20-day-old post is found at horizon 30, trimmed at horizon 7", async () => {
    const OLD = ago(24 * 25);
    const o = { threads: [[match(CH, ago(24 * 20), OLD)]], replies: { [`${CH}|${OLD}`]: [root(OLD, ANA, 1), msg(ago(24 * 20), ANA)] } };
    expect((await run(o)).out.units).toHaveLength(1);
    const { out } = await run(o, { horizon_days: 7 });
    expect(out.units).toHaveLength(0);
    expect(out.coverage.threads).toMatchObject({ matches: 0, window: { trimmed_out: 1 } });
    expect(out.cannot_check).toEqual([expect.objectContaining({ reason: "zero search matches in window" })]);
  });

  it("absent reply_count on a declared thread root → CANNOT-CHECK", async () => {
    const t = thread([msg(ago(10), ANA)]);
    delete t[0].reply_count;
    const { out } = await run({ threads: [[match(CH, ago(10), R)]], replies: { [`${CH}|${R}`]: t } });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check[0].reason).toBe("reply_count absent on a declared thread root");
  });

  it("text is cut to 200 chars", async () => {
    const u = await one(threadScope([msg(ago(10), ANA, { text: "x".repeat(500) })]));
    expect(u.newest.text).toHaveLength(200);
  });
});

describe("threads scope enumeration", () => {
  it("my post with no thread_ts is awaiting_others, not a unit", async () => {
    const { out } = await run({ threads: [[match(CH, ago(5))]] });
    expect(out.units).toHaveLength(0);
    expect(out.awaiting_others).toBe(1);
  });

  it("DM matches are skipped and counted; units dedupe on (channel, root)", async () => {
    const { out, client } = await run({
      threads: [[match(CH, ago(10), R), match(CH, ago(20), R), match(DM, ago(3), undefined, { is_im: true })]],
      replies: { [`${CH}|${R}`]: thread([msg(ago(20), ME), msg(ago(10), ME)]) },
    });
    expect(out.coverage.threads).toMatchObject({ matches: 3, units: 1, skipped: 1, capped: 0 });
    expect(client.conversations.replies).toHaveBeenCalledTimes(1);
  });

  it("max_units caps per scope and counts the cap", async () => {
    const R2 = ago(60);
    const { out } = await run(
      {
        threads: [[match(CH, ago(10), R), match(CH, ago(11), R2)]],
        replies: { [`${CH}|${R}`]: thread([msg(ago(10), ANA)]), [`${CH}|${R2}`]: [root(R2, ANA, 1), msg(ago(11), ANA)] },
      },
      { max_units: 1 }
    );
    expect(out.units).toHaveLength(1);
    expect(out.coverage.threads.capped).toBe(1);
  });

  it("walks every page until the floor, and a failed search is CANNOT-CHECK", async () => {
    const R2 = ago(60);
    const { out, client } = await run({
      threads: [[match(CH, ago(10), R)], [match(CH, ago(11), R2)]],
      replies: { [`${CH}|${R}`]: thread([msg(ago(10), ANA)]), [`${CH}|${R2}`]: [root(R2, ANA, 1), msg(ago(11), ANA)] },
    });
    expect(out.units).toHaveLength(2);
    expect(client.search.messages).toHaveBeenCalledTimes(2);
    const failed = await run({ searchError: { threads: new Error("boom") } });
    expect(failed.out.cannot_check).toEqual([{ scope: "threads", reason: "search failed: boom" }]);
  });

  it("a match with an unparsable permalink is CANNOT-CHECK, not dropped", async () => {
    const m = match(CH, ago(10), R);
    m.permalink = "not a url";
    const { out } = await run({ threads: [[m]] });
    expect(out.cannot_check[0].reason).toMatch(/parsable permalink/);
  });
});

describe("dms scope", () => {
  const im = { is_im: true, name: ANA, user: ANA };
  it("main line: newest in-window match re-fetched by exact ts (limit 1) for reactions; last_read from conversations.info", async () => {
    const t1 = ago(10);
    const { out, client } = await run(
      {
        dms: [[match(DM, t1, undefined, im), match(DM, ago(20), undefined, im)]],
        replies: { [`${DM}|${t1}`]: [msg(t1, ANA, { reactions: [{ name: "eyes", users: [ME] }] })] },
        info: { [DM]: { id: DM, last_read: ago(15) } },
      },
      { scope: "dms" }
    );
    expect(client.conversations.replies).toHaveBeenCalledWith({ channel: DM, ts: t1, limit: 1 });
    expect(out.units).toEqual([expect.objectContaining({ kind: "dm", owes: "me", my_reactions: ["eyes"], unseen: true })]);
    expect(out.units[0].root_ts).toBeUndefined();
  });

  it("DM thread units use the thread parent's last_read, not the conversation's", async () => {
    const { out, client } = await run(
      {
        dms: [[match(DM, ago(10), R, im)]],
        replies: { [`${DM}|${R}`]: [root(R, ME, 1, { latest_reply: ago(10), last_read: ago(10) }), msg(ago(10), ANA)] },
        info: { [DM]: { id: DM, last_read: ago(40) } },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ root_ts: R, owes: "me", unseen: false });
    expect(client.conversations.info).not.toHaveBeenCalled();
  });

  it("per-thread DM units: a thread and the main line are separate units", async () => {
    const t1 = ago(5);
    const { out } = await run(
      {
        dms: [[match(DM, t1, undefined, im), match(DM, ago(10), R, im)]],
        replies: { [`${DM}|${t1}`]: [msg(t1, ME)], [`${DM}|${R}`]: [root(R, ME, 1), msg(ago(10), ANA)] },
        info: { [DM]: { id: DM, last_read: t1 } },
      },
      { scope: "dms" }
    );
    expect(out.units.map((u) => u.owes).sort()).toEqual(["me", "them"]);
  });

  it("a 1:1 IM whose other member is a bot owes nobody; the same IM with a human owes me", async () => {
    const t1 = ago(10);
    const base = { replies: { [`${DM}|${t1}`]: [msg(t1, BOT)] }, info: { [DM]: { id: DM, last_read: t1 } } };
    const bot = await one({ ...base, dms: [[match(DM, t1, undefined, { is_im: true, user: BOT })]] }, { scope: "dms" });
    expect(bot).toMatchObject({ owes: "nobody", newest: { is_bot: true } });
    const human = { replies: { [`${DM}|${t1}`]: [msg(t1, ANA)] }, info: base.info };
    expect((await one({ ...human, dms: [[match(DM, t1, undefined, im)]] }, { scope: "dms" })).owes).toBe("me");
  });

  it("main-line last_read absent → unseen null; info failure → CANNOT-CHECK", async () => {
    const t1 = ago(10);
    const o = { dms: [[match(DM, t1, undefined, im)]], replies: { [`${DM}|${t1}`]: [msg(t1, ANA)] } };
    expect((await one({ ...o, info: { [DM]: { id: DM } } }, { scope: "dms" })).unseen).toBeNull();
    const { out } = await run({ ...o, info: {} }, { scope: "dms" });
    expect(out.cannot_check[0]).toMatchObject({ scope: "dms", reason: "channel_not_found" });
  });
});

describe("mentions scope", () => {
  it("a mention in a thread I never posted in is a unit", async () => {
    const R2 = ago(30);
    const { out } = await run(
      {
        threads: [[]],
        mentions: [[match(CH, ago(10), R2)]],
        replies: { [`${CH}|${R2}`]: [root(R2, ANA, 1, { latest_reply: ago(10) }), msg(ago(10), BEN)] },
      },
      { scope: "both", clearing_reactions: CLEAR }
    );
    expect(out.units).toEqual([expect.objectContaining({ kind: "mention", root_ts: R2, owes: "me" })]);
    // and threads scope alone misses it (the gap this closes)
    expect((await run({ threads: [[]], mentions: [[match(CH, ago(10), R2)]] })).out.units).toHaveLength(0);
  });

  it("mentions dedupe against units from the other scopes", async () => {
    const { out, client } = await run(
      { threads: [[match(CH, ago(10), R)]], dms: [[]], mentions: [[match(CH, ago(10), R)]], replies: { [`${CH}|${R}`]: thread([msg(ago(10), ANA)]) } },
      { scope: "both" }
    );
    expect(out.units).toHaveLength(1);
    expect(out.units[0].kind).toBe("thread");
    expect(out.coverage.mentions).toMatchObject({ matches: 1, units: 0, skipped: 1 });
    expect(client.conversations.replies).toHaveBeenCalledTimes(1);
  });

  it("a top-level channel mention with no replies is its own unit, read state from conversations.info", async () => {
    const t1 = ago(10);
    const u = await one(
      { mentions: [[match(CH, t1)]], replies: { [`${CH}|${t1}`]: [msg(t1, ANA)] }, info: { [CH]: { id: CH, last_read: ago(20) } } },
      { scope: "mentions" }
    );
    expect(u).toMatchObject({ kind: "mention", root_ts: t1, owes: "me", unseen: true });
  });

  it("mentions use the days window, not the threads horizon", async () => {
    const { out } = await run({ mentions: [[match(CH, ago(24 * 10), R)]] }, { scope: "mentions" });
    expect(out.coverage.mentions).toMatchObject({ matches: 0, window: { trimmed_out: 1 } });
  });
});
