import { describe, expect, it } from "vitest";
import { runMyThreads, type MyThreadsParams } from "../src/services/conversations/myThreads.js";
import { fakeSlack, type Msg, type FakeSlackOptions } from "./helpers/fakeSlack.js";

// Shapes from a live workspace (2026-09-22), ids replaced with fakes; the fixture mirrors the
// A1 replay. NOW is 2026-09-22 23:00 ET.
const ME = "U0SELF00001";
const ALICE = "U0ALICE0001";
const BOB = "U0BOBB00001";
const MKT = "C0MKTG00001";
const NOW = Date.parse("2026-09-23T03:00:00Z");
const VENDOR_ROOT = "1789403350.366999";
const VENDOR_NEWEST = "1790014456.608419";
const MY_VENDOR_REPLY = "1790011447.230239";

const HUMANS = {
  [ME]: { is_bot: false, name: "sam" },
  [ALICE]: { is_bot: false, name: "alice" },
  [BOB]: { is_bot: false, name: "bob" },
};

function match(channel: string, ts: string, opts: { user?: string; root?: string | null; im?: boolean; mpim?: boolean; name?: string; permalink?: string } = {}): Msg {
  const pl =
    opts.permalink ??
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}` +
      (opts.root ? `?thread_ts=${opts.root}&cid=${channel}` : "");
  return {
    channel: { id: channel, name: opts.name ?? "marketing", is_im: opts.im ?? false, is_mpim: opts.mpim ?? false },
    ...(opts.user === undefined && "user" in opts ? {} : { user: opts.user ?? ME }),
    username: "sam",
    ts,
    text: "some text",
    permalink: pl,
    no_reactions: true,
  };
}

function vendorReplies(newestExtra: Msg = {}): Msg[] {
  return [
    { ts: VENDOR_ROOT, user: BOB, text: "vendor root", thread_ts: VENDOR_ROOT, reply_count: 10, reply_users_count: 3,
      latest_reply: VENDOR_NEWEST, last_read: VENDOR_NEWEST, subscribed: true },
    { ts: "1790008565.235439", user: ALICE, text: "a", thread_ts: VENDOR_ROOT },
    { ts: MY_VENDOR_REPLY, user: ME, text: "b", thread_ts: VENDOR_ROOT },
    { ts: VENDOR_NEWEST, user: ALICE, text: "Sounds good, thanks!", thread_ts: VENDOR_ROOT,
      reactions: [{ name: "thumbsup_all", count: 1, users: [ME] }], ...newestExtra },
  ];
}

const defaults: MyThreadsParams = { scope: "threads", days: 7, max_units: 40, concurrency: 6, include_raw: false };

async function run(o: FakeSlackOptions, p: Partial<MyThreadsParams> = {}) {
  const client = fakeSlack({ users: HUMANS, ...o });
  const out = await runMyThreads(
    {
      client: client as never,
      getMyUserId: async () => ME,
      getMyTimezone: async () => ({ tz: "America/New_York", source: "slack" as const }),
      now: () => NOW,
    },
    { ...defaults, ...p }
  );
  return { out, client };
}

describe("slack_my_threads — threads scope", () => {
  it("A1: Vendor replay — owes me, newest Alice, acknowledged by my reaction", async () => {
    const { out } = await run({
      threadPages: [[match(MKT, MY_VENDOR_REPLY, { root: VENDOR_ROOT })]],
      replies: { [`${MKT}|${VENDOR_ROOT}`]: vendorReplies() },
    });
    expect(out.units).toHaveLength(1);
    const u = out.units[0] as Record<string, unknown>;
    expect(u).toMatchObject({
      kind: "thread", channel_id: MKT, root_ts: VENDOR_ROOT, owes: "me", newest_user: ALICE,
      latest_reply: VENDOR_NEWEST, acknowledged: true, freshness: "seen", newest_is_bot: false,
      subscribed: true, newest_username: "alice",
    });
    // Acknowledged is not a row, so nothing is owed-and-open.
    expect(out.outcome).toBe("CLEAN");
    expect(String(u.evidence)).toContain("acknowledged");
  });

  it("A1b: open ask stays a row; my reaction on the newest moves it to acknowledged (false-negative direction)", async () => {
    const root = "1789503318.984789";
    const newest = "1789575979.019499";
    const asker = "U0ASKER0001";
    const replies = (reactions?: unknown): Msg[] => [
      { ts: root, user: BOB, reply_count: 12, latest_reply: newest, last_read: newest, subscribed: true },
      { ts: "1789574906.616659", user: ME, thread_ts: root },
      { ts: newest, user: asker, text: "can you share what Claude found?", thread_ts: root, ...(reactions ? { reactions } : {}) },
    ];
    const base = {
      threadPages: [[match(MKT, "1789574906.616659", { root })]],
      users: { ...HUMANS, [asker]: { is_bot: false, name: "carol" } },
    };
    const open = await run({ ...base, replies: { [`${MKT}|${root}`]: replies() } });
    expect(open.out.units[0]).toMatchObject({ owes: "me", acknowledged: false });
    expect(open.out.outcome).toBe("FINDINGS");

    const acked = await run({
      ...base,
      replies: { [`${MKT}|${root}`]: replies([{ name: "+1", count: 2, users: ["U0000000009", ME] }]) },
    });
    expect(acked.out.units[0]).toMatchObject({ owes: "me", acknowledged: true });
    expect(acked.out.outcome).toBe("CLEAN");
  });

  it("A2: flip — a later reply by me makes it owes them", async () => {
    const later = "1790020000.000100";
    const r = vendorReplies();
    r[0] = { ...r[0], latest_reply: later, reply_count: 11 };
    r.push({ ts: later, user: ME, text: "on it", thread_ts: VENDOR_ROOT });
    const { out } = await run({
      threadPages: [[match(MKT, later, { root: VENDOR_ROOT })]],
      replies: { [`${MKT}|${VENDOR_ROOT}`]: r },
    });
    expect(out.units[0]).toMatchObject({ owes: "them", newest_user: ME, freshness: "unseen" });
  });

  it("A3: false negative — self last, then a non-self reply is injected: absent, then present", async () => {
    const root = "1790000000.000100";
    const mine = "1790010000.000100";
    const theirs = "1790015000.000100";
    const thread = (withTheirs: boolean): Msg[] => [
      { ts: root, user: BOB, reply_count: withTheirs ? 2 : 1, latest_reply: withTheirs ? theirs : mine, last_read: mine, subscribed: true },
      { ts: mine, user: ME, thread_ts: root },
      ...(withTheirs ? [{ ts: theirs, user: ALICE, thread_ts: root }] : []),
    ];
    const pages = [[match(MKT, mine, { root })]];
    const before = await run({ threadPages: pages, replies: { [`${MKT}|${root}`]: thread(false) } });
    expect(before.out.units.filter((u) => u.owes === "me")).toHaveLength(0);
    expect(before.out.outcome).toBe("CLEAN");

    const after = await run({ threadPages: pages, replies: { [`${MKT}|${root}`]: thread(true) } });
    expect(after.out.units.filter((u) => u.owes === "me")).toHaveLength(1);
    expect(after.out.units[0]).toMatchObject({ owes: "me", freshness: "unseen", newest_user: ALICE });
    expect(after.out.outcome).toBe("FINDINGS");
  });

  it("A4: unsubscribed — absent last_read is cannot_check freshness, listed, not advanced and not clean", async () => {
    const root = "1790000000.000100";
    const mine = "1790010000.000100";
    const { out } = await run({
      threadPages: [[match(MKT, mine, { root })]],
      replies: {
        [`${MKT}|${root}`]: [
          { ts: root, user: BOB, reply_count: 1, latest_reply: mine, subscribed: false },
          { ts: mine, user: ME, thread_ts: root },
        ],
      },
    });
    expect(out.units[0]).toMatchObject({ freshness: "cannot_check", subscribed: false });
    expect(out.units[0]).not.toHaveProperty("last_read");
    expect(out.cannot_check).toContainEqual(
      expect.objectContaining({ level: "freshness", root_ts: root, channel_id: MKT })
    );
    expect(out.coverage.threads?.freshness_cannot_check).toBe(1);
    expect(out.units.filter((u) => u.freshness === "unseen" || u.freshness === "seen")).toHaveLength(0);
  });

  it("A5: zero matches is CANNOT_CHECK, not CLEAN", async () => {
    const { out } = await run({ threadPages: [[]] });
    expect(out.outcome).toBe("CANNOT_CHECK");
    expect(out.outcomes.threads).toBe("CANNOT_CHECK");
    expect(out.coverage.threads?.matches).toBe(0);
  });

  it("A5b: a search failure is CANNOT_CHECK with the error, never an empty success", async () => {
    const { out } = await run({ search: async () => { throw Object.assign(new Error("x"), { data: { error: "ratelimited" } }); } });
    expect(out.outcome).toBe("CANNOT_CHECK");
    expect(out.coverage.threads?.search_error).toContain("ratelimited");
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "coverage" }));
  });

  it("A5c: a malformed search response (no matches array) is CANNOT_CHECK", async () => {
    const { out } = await run({ search: async () => ({ ok: true, messages: {} }) });
    expect(out.outcome).toBe("CANNOT_CHECK");
    expect(out.coverage.threads?.search_error).toMatch(/no 'messages.matches'/);
  });

  it("A6: coverage arithmetic holds", async () => {
    const rootA = "1790000000.000100";
    const rootB = "1790001000.000100";
    const pages = [[
      match(MKT, "1790012000.000100", { root: rootA }),
      match(MKT, "1790011000.000100", { root: rootA }), // same unit
      match(MKT, "1790010000.000100", { root: rootB }),
      match(MKT, "1790009000.000100", { root: null }), // standalone
      match("D0000000001", "1790008000.000100", { root: null, im: true }), // deferred to dms
      match(MKT, "1780000000.000100", { root: rootA }), // before floor — trimmed
    ]];
    const thread = (root: string): Msg[] => [
      { ts: root, user: BOB, reply_count: 1, latest_reply: "1790013000.000100", last_read: "1790013000.000100", subscribed: true },
      { ts: "1790013000.000100", user: ALICE, thread_ts: root },
    ];
    const { out } = await run({
      threadPages: pages,
      replies: { [`${MKT}|${rootA}`]: thread(rootA), [`${MKT}|${rootB}`]: thread(rootB) },
    });
    const c = out.coverage.threads!;
    expect(c.matches).toBe(6);
    expect(c.trimmed_out).toBe(1);
    expect(c.matches_in_window).toBe(5);
    expect(c.matches_in_window).toBe(
      c.threaded_matches + c.standalone + c.dm_matches_deferred_to_dms_scope + c.permalink_unparsable + c.unroutable
    );
    expect(c.threaded_matches).toBe(3);
    expect(c.units_total).toBe(2); // distinct (channel, root) over threaded matches
    expect(c.units_total).toBe(c.units_evaluated + c.units_skipped + c.capped);
    expect(out.awaiting_others).toHaveLength(1);
    expect(c.reached_floor).toBe(true);
  });

  it("A7: cap reporting — max_units 5 against 17 units reports capped 12, never silent", async () => {
    const pages: Msg[][] = [[]];
    const replies: Record<string, Msg[]> = {};
    for (let i = 0; i < 17; i++) {
      const root = `17900${String(10 + i).padStart(2, "0")}000.000100`;
      const mine = `17900${String(10 + i).padStart(2, "0")}500.000100`;
      pages[0].unshift(match(MKT, mine, { root }));
      replies[`${MKT}|${root}`] = [
        { ts: root, user: BOB, reply_count: 1, latest_reply: mine, last_read: mine, subscribed: true },
        { ts: mine, user: ME, thread_ts: root },
      ];
    }
    const { out, client } = await run({ threadPages: pages, replies }, { max_units: 5 });
    const c = out.coverage.threads!;
    expect(c.units_total).toBe(17);
    expect(c.units_evaluated).toBe(5);
    expect(c.capped).toBe(12);
    expect(client.conversations.replies).toHaveBeenCalledTimes(5);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "coverage", count: 12 }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("an unparsable permalink is CANNOT-CHECK, never silently skipped", async () => {
    const { out } = await run({ threadPages: [[match(MKT, "1790010000.000100", { permalink: "not a url" })]] });
    expect(out.coverage.threads?.permalink_unparsable).toBe(1);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "unit", reason: expect.stringMatching(/permalink/) }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("newest is selected by ts === latest_reply, not array position; missing newest is CANNOT-CHECK", async () => {
    const root = "1790000000.000100";
    const { out } = await run({
      threadPages: [[match(MKT, "1790010000.000100", { root })]],
      replies: {
        [`${MKT}|${root}`]: [
          { ts: root, user: BOB, reply_count: 5, latest_reply: "1790019999.000100", last_read: "1790019999.000100", subscribed: true },
          { ts: "1790010000.000100", user: ME, thread_ts: root }, // last in array, but not latest_reply
        ],
      },
    });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/newest_not_in_window/) }));
    expect(out.coverage.threads?.units_skipped).toBe(1);
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("a replies failure is a counted skip with the unit's identity", async () => {
    const root = "1790000000.000100";
    const { out } = await run({
      threadPages: [[match(MKT, "1790010000.000100", { root })]],
      replies: { [`${MKT}|${root}`]: Object.assign(new Error("boom"), { data: { error: "ratelimited" } }) },
    });
    expect(out.coverage.threads?.units_skipped).toBe(1);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ root_ts: root, reason: expect.stringContaining("ratelimited") }));
  });

  it("walks pages until the floor is crossed, and counts pages it could not fetch", async () => {
    const root = "1790000000.000100";
    const replies = {
      [`${MKT}|${root}`]: [
        { ts: root, user: BOB, reply_count: 1, latest_reply: "1790013000.000100", last_read: "1790013000.000100", subscribed: true },
        { ts: "1790013000.000100", user: ME, thread_ts: root },
      ],
    };
    const p1 = [match(MKT, "1790013000.000100", { root })];
    const p2 = [match(MKT, "1790012000.000100", { root })];
    const { client, out } = await run({ threadPages: [p1, p2], replies });
    expect(client.search.messages).toHaveBeenCalledTimes(2);
    expect(out.coverage.threads).toMatchObject({ pages_seen: 2, pages_total: 2, pages_unfetched: 0 });

    const many = Array.from({ length: 12 }, () => [match(MKT, "1790013000.000100", { root })]);
    const capped = await run({ threadPages: many, replies });
    expect(capped.out.coverage.threads).toMatchObject({ pages_seen: 10, pages_total: 12, pages_unfetched: 2 });
    expect(capped.out.outcome).toBe("CANNOT_CHECK");
  });
});

describe("slack_my_threads — bots (A1c)", () => {
  const root = "1790000000.000100";
  const botUser = "U0BOTUSR001";
  const threadBy = (user: string | undefined): FakeSlackOptions => ({
    threadPages: [[match(MKT, "1790010000.000100", { root })]],
    replies: {
      [`${MKT}|${root}`]: [
        { ts: root, user: BOB, reply_count: 2, latest_reply: "1790011000.000100", last_read: "1790010000.000100", subscribed: true },
        { ts: "1790010000.000100", user: ME, thread_ts: root },
        { ts: "1790011000.000100", ...(user ? { user } : {}), thread_ts: root, text: "notice" },
      ],
    },
  });

  it("an unknown author Slack flags is_bot drops out of the rows", async () => {
    const { out } = await run({ ...threadBy(botUser), users: { ...HUMANS, [botUser]: { is_bot: true, name: "claude" } } });
    expect(out.units[0]).toMatchObject({ owes: "me", newest_is_bot: true, newest_bot_source: "users.info" });
    expect(out.outcome).toBe("CLEAN");
  });

  it("a human newest author is a row (control for the bot case)", async () => {
    const { out } = await run({ ...threadBy(ALICE) });
    expect(out.units[0]).toMatchObject({ owes: "me", newest_is_bot: false });
    expect(out.outcome).toBe("FINDINGS");
  });

  it("a failed users.info lookup is CANNOT-CHECK for that unit, never human", async () => {
    const { out } = await run({ ...threadBy(botUser), users: { ...HUMANS, [botUser]: new Error("ratelimited") } });
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "unit", reason: expect.stringMatching(/bot_lookup_failed/) }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("caller override wins without a lookup; no-user posts are bots", async () => {
    const o = await run({ ...threadBy(botUser), users: HUMANS }, { bot_user_ids: ` ${botUser} ,` });
    expect(o.out.units[0]).toMatchObject({ newest_is_bot: true, newest_bot_source: "override" });
    expect(o.client.users.info).not.toHaveBeenCalledWith({ user: botUser });

    const n = await run({ ...threadBy(undefined) });
    expect(n.out.units[0]).toMatchObject({ newest_is_bot: true, newest_bot_source: "no_user" });
  });

  it("users.info is cached per run — one lookup per distinct author", async () => {
    const pages = [[
      match(MKT, "1790010000.000100", { root: "1790000000.000100" }),
      match(MKT, "1790010001.000100", { root: "1790000001.000100" }),
    ]];
    const thread = (r: string): Msg[] => [
      { ts: r, user: BOB, reply_count: 1, latest_reply: "1790012000.000100", last_read: "1790012000.000100", subscribed: true },
      { ts: "1790012000.000100", user: ALICE, thread_ts: r },
    ];
    const { client, out } = await run({
      threadPages: pages,
      replies: { [`${MKT}|1790000000.000100`]: thread("1790000000.000100"), [`${MKT}|1790000001.000100`]: thread("1790000001.000100") },
    }, { concurrency: 1 });
    expect(client.users.info).toHaveBeenCalledTimes(1);
    expect(out.coverage.bot_lookups).toBe(1);
  });
});

describe("slack_my_threads — dms scope", () => {
  const D1 = "D0B00000001";
  const G1 = "C0C00000001";

  it("groups by conversation; newest match is the unit; reactions come from the fetched message", async () => {
    const newest = "1790110405.408759";
    const { out, client } = await run(
      {
        dmPages: [[
          match(D1, newest, { user: ALICE, im: true, name: ALICE }),
          match(D1, "1790100000.000100", { user: ME, im: true, name: ALICE }),
          match(G1, "1790090000.000100", { user: ME, mpim: true, name: "mpdm-a--b" }),
        ]],
        info: { [D1]: { last_read: "1790100000.000100" }, [G1]: { last_read: "1790090000.000100" } },
        replies: {
          [`${D1}|${newest}`]: [{ ts: newest, user: ALICE, text: "hi", reactions: [{ name: "tada", users: [ME] }] }],
          [`${G1}|1790090000.000100`]: [{ ts: "1790090000.000100", user: ME, text: "sent" }],
        },
      },
      { scope: "dms" }
    );
    expect(out.coverage.dms).toMatchObject({ dm_conversations: 2, units_total: 2, units_evaluated: 2, matches_in_window: 3 });
    const d = out.units.find((u) => u.channel_id === D1)!;
    expect(d).toMatchObject({ kind: "dm", owes: "me", freshness: "unseen", acknowledged: true, matches_in_window: 2 });
    const g = out.units.find((u) => u.channel_id === G1)!;
    expect(g).toMatchObject({ owes: "them", freshness: "seen", acknowledged: false });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(out.outcome).toBe("CLEAN"); // the only owes-me unit is acknowledged
  });

  it("DM newest not returned by replies(ts) is CANNOT-CHECK", async () => {
    const { out } = await run(
      {
        dmPages: [[match(D1, "1790110405.408759", { user: ALICE, im: true })]],
        info: { [D1]: { last_read: "1790100000.000100" } },
        replies: { [`${D1}|1790110405.408759`]: [{ ts: "1790000000.000100", user: ALICE }] },
      },
      { scope: "dms" }
    );
    expect(out.units).toHaveLength(0);
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ scope: "dms", reason: expect.stringMatching(/newest_not_returned/) }));
    expect(out.outcome).toBe("CANNOT_CHECK");
  });

  it("DM with no last_read is freshness cannot_check", async () => {
    const t = "1790110405.408759";
    const { out } = await run(
      {
        dmPages: [[match(G1, t, { user: ALICE, mpim: true })]],
        info: { [G1]: {} },
        replies: { [`${G1}|${t}`]: [{ ts: t, user: ALICE }] },
      },
      { scope: "dms" }
    );
    expect(out.units[0]).toMatchObject({ freshness: "cannot_check", owes: "me" });
    expect(out.cannot_check).toContainEqual(expect.objectContaining({ level: "freshness", scope: "dms" }));
  });

  it("scope both runs both pipelines; threads defers DM matches instead of double-counting", async () => {
    const t = "1790110405.408759";
    const { out } = await run(
      {
        threadPages: [[match(D1, "1790100000.000100", { im: true })]],
        dmPages: [[match(D1, t, { user: ALICE, im: true })]],
        info: { [D1]: { last_read: t } },
        replies: { [`${D1}|${t}`]: [{ ts: t, user: ALICE }] },
      },
      { scope: "both" }
    );
    expect(out.coverage.threads?.dm_matches_deferred_to_dms_scope).toBe(1);
    expect(out.coverage.threads?.units_total).toBe(0);
    expect(out.units).toHaveLength(1);
    expect(out.outcomes).toEqual({ threads: "CLEAN", dms: "FINDINGS" });
    expect(out.outcome).toBe("FINDINGS");
    expect(out.residual_gap).toMatch(/not enumerable/);
  });
});
