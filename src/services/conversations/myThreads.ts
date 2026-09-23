// slack_my_threads — threads the authenticated user posted in, and DM
// conversations, classified by whose turn it is. See the tool description in
// ./index.ts for the contract; this module is the pipeline, kept free of MCP
// plumbing so tests can drive it against a fake WebClient.
//
// Every verdict keys on declared fields only:
//   owes        — newest message's `user` vs me (the newest message is the one
//                 whose ts === parent.latest_reply, never an array position)
//   freshness   — latest_reply vs the thread's own last_read (absent last_read
//                 ⇔ subscribed:false ⇒ cannot_check, never "seen")
//   acknowledged— my user id in the newest message's reactions[].users
//   is_bot      — no user / caller override / users.info(user).is_bot
//
// Coverage is reported for every stage; every cap, skip and failure is a
// counted field. Zero in-window matches is CANNOT_CHECK, never CLEAN.

import type { WebClient } from "@slack/web-api";
import { mapWithConcurrencySettled } from "../../utils/concurrency.js";
import { computeSearchWindow, trimToWindow } from "../../utils/searchWindow.js";
import type { TimezoneResolution } from "../../utils/identity.js";
import {
  permalinkThreadTs,
  pruneSearchMatch,
  type PrunedSearchMatch,
  type SearchMatchSource,
} from "../../utils/pruning.js";
import {
  clampConcurrency,
  createBotResolver,
  errorMessage,
  parseIdList,
  reactedBy,
  requirePositiveInt,
  requirePositiveNumber,
  textPreview,
  tsAfter,
  tsNumber,
  buildPermalink,
  type BotResolver,
  type BotVerdict,
  type Outcome,
} from "../../utils/threadCoverage.js";

export type MyThreadsClient = Pick<WebClient, "search" | "conversations" | "users">;

export interface MyThreadsDeps {
  client: MyThreadsClient;
  getMyUserId: () => Promise<string>;
  getMyTimezone: () => Promise<TimezoneResolution>;
  now?: () => number;
}

export interface MyThreadsParams {
  scope: "threads" | "dms" | "both";
  days: number;
  max_units: number;
  concurrency: number;
  bot_user_ids?: string;
  include_raw: boolean;
}

// search.messages pages at most 100 per page (count > 100 silently falls back
// to 20). Ten pages is 1,000 matches — ~18x the measured 7-day volume.
export const SEARCH_PAGE_SIZE = 100;
export const MAX_SEARCH_PAGES = 10;

export const RESIDUAL_GAP =
  "Threads the user was mentioned in but never posted in, and threads whose last post by the user " +
  "is older than the window, are not enumerable under a user token (Slack has no 'my subscribed " +
  "threads' endpoint for xoxp). They are absent from this result by construction, not because they are quiet.";

type Freshness = "unseen" | "seen" | "cannot_check";

interface SearchMatch extends SearchMatchSource {
  reactions?: unknown;
}

interface ThreadMessage {
  ts?: string;
  user?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  last_read?: string;
  subscribed?: boolean;
  reactions?: unknown;
}

export interface CannotCheckEntry {
  scope: "threads" | "dms";
  /** "unit": the unit has no verdict. "freshness": owes is known, read state is not. "coverage": a counted gap. */
  level: "unit" | "freshness" | "coverage";
  reason: string;
  channel_id?: string;
  channel_name?: string;
  root_ts?: string;
  ts?: string;
  count?: number;
  permalink?: string;
}

interface SearchWalk {
  kept: SearchMatch[];
  search_calls: number;
  pages_seen: number;
  pages_total: number;
  pages_unfetched: number;
  reached_floor: boolean;
  matches: number;
  matches_in_window: number;
  trimmed_out: number;
  unparsable_ts: number;
  /** Matches seen on two pages (boundary shift mid-walk); counted once. */
  duplicates: number;
  search_error?: string;
}

async function walkSearch(
  client: MyThreadsClient,
  query: string,
  floorSeconds: number
): Promise<SearchWalk> {
  const walk: SearchWalk = {
    kept: [],
    search_calls: 0,
    pages_seen: 0,
    pages_total: 0,
    pages_unfetched: 0,
    reached_floor: false,
    matches: 0,
    matches_in_window: 0,
    trimmed_out: 0,
    unparsable_ts: 0,
    duplicates: 0,
  };
  const seenKeys = new Set<string>();

  let page = 1;
  while (page <= MAX_SEARCH_PAGES) {
    walk.search_calls++;
    let res;
    try {
      res = await client.search.messages({
        query,
        count: SEARCH_PAGE_SIZE,
        sort: "timestamp",
        sort_dir: "desc",
        page,
      });
    } catch (err) {
      walk.search_error = `page ${page}: ${errorMessage(err)}`;
      break;
    }
    const raw = res.messages?.matches;
    if (!Array.isArray(raw)) {
      // Malformed response — NOT zero matches.
      walk.search_error = `page ${page}: search.messages returned no 'messages.matches' array`;
      break;
    }
    walk.pages_seen++;
    const pagesDeclared = res.messages?.paging?.pages;
    if (typeof pagesDeclared !== "number" && raw.length >= SEARCH_PAGE_SIZE) {
      // A full page with no declared page count: more may exist, unknowably.
      walk.search_error = `page ${page}: full page with no paging.pages — cannot tell whether more pages exist`;
    }
    walk.pages_total = typeof pagesDeclared === "number" ? pagesDeclared : Math.max(walk.pages_total, page);
    walk.matches += raw.length;
    const { kept, trimmedOut, unparsableTs } = trimToWindow(raw as SearchMatch[], floorSeconds);
    for (const m of kept) {
      // Page boundaries shift if a message lands mid-walk; never count one twice.
      const key = `${m.channel?.id ?? "?"}|${m.ts ?? "?"}|${m.permalink ?? ""}`;
      if (seenKeys.has(key)) {
        walk.duplicates++;
        continue;
      }
      seenKeys.add(key);
      walk.kept.push(m);
    }
    walk.trimmed_out += trimmedOut;
    walk.unparsable_ts += unparsableTs;
    // sort timestamp desc: once a page trims anything the floor is crossed
    // and every later page is older still (see trimToWindow).
    if (trimmedOut > 0) {
      walk.reached_floor = true;
      break;
    }
    if (walk.search_error || page >= walk.pages_total) break;
    page++;
  }
  walk.matches_in_window = walk.kept.length;
  if (!walk.reached_floor && !walk.search_error) {
    walk.pages_unfetched = Math.max(0, walk.pages_total - walk.pages_seen);
  }
  return walk;
}

function walkCoverage(walk: SearchWalk) {
  return {
    search_calls: walk.search_calls,
    pages_seen: walk.pages_seen,
    pages_total: walk.pages_total,
    pages_unfetched: walk.pages_unfetched,
    reached_floor: walk.reached_floor,
    matches: walk.matches,
    matches_in_window: walk.matches_in_window,
    trimmed_out: walk.trimmed_out,
    unparsable_ts: walk.unparsable_ts,
    duplicates: walk.duplicates,
    ...(walk.search_error ? { search_error: walk.search_error } : {}),
  };
}

function permalinkOrigin(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  try {
    return new URL(permalink).origin;
  } catch {
    return undefined;
  }
}

function freshnessEvidence(freshness: Freshness, newestTs: string | undefined, lastRead: string | undefined) {
  if (freshness === "cannot_check") {
    return lastRead === undefined ? "last_read absent — read state CANNOT-CHECK" : "ts unreadable — read state CANNOT-CHECK";
  }
  return freshness === "unseen"
    ? `newest ${newestTs} > last_read ${lastRead} (unseen)`
    : `newest ${newestTs} <= last_read ${lastRead} (seen)`;
}

function freshnessOf(newestTs: string | undefined, lastRead: string | undefined): Freshness {
  if (lastRead === undefined) return "cannot_check";
  const after = tsAfter(newestTs, lastRead);
  if (after === undefined) return "cannot_check";
  return after ? "unseen" : "seen";
}

interface Verdict {
  owes: "me" | "them";
  acknowledged: boolean;
  newest_is_bot: boolean;
  newest_bot_source: BotVerdict["source"];
  newest_username?: string;
}

async function verdictFor(
  newest: ThreadMessage,
  me: string,
  bots: BotResolver
): Promise<Verdict> {
  // My own message: owes is "them" and bot status is moot — no lookup, so a
  // failing users.info(me) cannot turn my own turn into CANNOT-CHECK.
  const bot: BotVerdict =
    newest.user === me ? { is_bot: false, source: "self" } : await bots.resolve(newest.user);
  return {
    owes: newest.user === me ? "them" : "me",
    acknowledged: reactedBy(newest.reactions, me),
    newest_is_bot: bot.is_bot,
    newest_bot_source: bot.source,
    ...(newest.username ?? bot.name ? { newest_username: newest.username ?? bot.name } : {}),
  };
}

function verdictEvidence(newestTs: string | undefined, newestUser: string | undefined, me: string, v: Verdict) {
  const who = newestUser === undefined ? "no user (app post)" : `user ${newestUser} ${newestUser === me ? "== me" : "!= me"}`;
  const ack = v.acknowledged ? "my reaction on newest (acknowledged)" : "no reaction from me on newest";
  const bot = v.newest_is_bot ? `; bot via ${v.newest_bot_source}` : "";
  return { who, ack, bot, ts: newestTs };
}

export interface ThreadUnit {
  kind: "thread";
  channel_id: string;
  channel_name?: string;
  root_ts: string;
  reply_count?: number;
  latest_reply?: string;
  last_read?: string;
  subscribed?: boolean;
  newest_ts?: string;
  newest_user?: string;
  newest_username?: string;
  newest_is_bot: boolean;
  newest_bot_source: BotVerdict["source"];
  newest_text?: string;
  newest_text_truncated?: true;
  owes: "me" | "them";
  freshness: Freshness;
  acknowledged: boolean;
  permalink?: string;
  evidence: string;
  raw?: unknown;
}

export interface DmUnit {
  kind: "dm";
  channel_id: string;
  channel_name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  matches_in_window: number;
  /** Present when the unit is a thread inside the DM; absent for the conversation's main line. */
  thread_root_ts?: string;
  newest_ts?: string;
  newest_user?: string;
  newest_username?: string;
  newest_is_bot: boolean;
  newest_bot_source: BotVerdict["source"];
  newest_text?: string;
  newest_text_truncated?: true;
  last_read?: string;
  /** Which declared cursor last_read came from: the conversation's, or the thread parent's when the newest is a thread reply. */
  read_cursor: "conversation" | "thread";
  owes: "me" | "them";
  freshness: Freshness;
  acknowledged: boolean;
  permalink?: string;
  evidence: string;
  raw?: unknown;
}

type EvalResult<U> = { unit: U; freshnessGap?: CannotCheckEntry } | { cannot: CannotCheckEntry };

function isRow(u: { owes: string; acknowledged: boolean; newest_is_bot: boolean }) {
  return u.owes === "me" && !u.acknowledged && !u.newest_is_bot;
}

// ---------------------------------------------------------------- threads

interface ThreadCandidate {
  channel_id: string;
  channel_name?: string;
  root_ts: string;
  newest_match_ts: number;
  origin?: string;
  my_match_count: number;
}

async function runThreads(
  deps: MyThreadsDeps,
  me: string,
  afterDate: string,
  floorSeconds: number,
  params: MyThreadsParams,
  bots: BotResolver,
  botIds: ReadonlySet<string>
) {
  const query = `from:<@${me}> after:${afterDate}`;
  const walk = await walkSearch(deps.client, query, floorSeconds);
  const cannot: CannotCheckEntry[] = [];
  const awaiting: Array<PrunedSearchMatch & { reason: string }> = [];

  let threadedMatches = 0;
  let standalone = 0;
  let dmMatches = 0;
  let permalinkUnparsable = 0;
  let unroutable = 0;
  const candidates = new Map<string, ThreadCandidate>();

  for (const m of walk.kept) {
    const channelId = m.channel?.id;
    if (!channelId) {
      unroutable++;
      cannot.push({ scope: "threads", level: "unit", reason: "match has no channel id", ts: m.ts, permalink: m.permalink });
      continue;
    }
    if (m.channel?.is_im === true || m.channel?.is_mpim === true) {
      // DM/mpim traffic is scope "dms"' job: there the unit is the
      // conversation, not the thread, and "no replies yet" is meaningless.
      dmMatches++;
      continue;
    }
    const root = permalinkThreadTs(m.permalink);
    if (root === undefined) {
      permalinkUnparsable++;
      cannot.push({
        scope: "threads",
        level: "unit",
        reason: "permalink absent or unparsable — thread root unknown",
        channel_id: channelId,
        channel_name: m.channel?.name,
        ts: m.ts,
      });
      continue;
    }
    if (root === null) {
      // No thread_ts in the permalink ⇔ nobody has replied (P3).
      standalone++;
      awaiting.push({ ...pruneSearchMatch(m, botIds), reason: "no replies (permalink carries no thread_ts)" });
      continue;
    }
    threadedMatches++;
    const key = `${channelId}|${root}`;
    const matchTs = tsNumber(m.ts) ?? Number.POSITIVE_INFINITY;
    const existing = candidates.get(key);
    if (existing) {
      existing.my_match_count++;
      existing.newest_match_ts = Math.max(existing.newest_match_ts, matchTs);
    } else {
      candidates.set(key, {
        channel_id: channelId,
        channel_name: m.channel?.name,
        root_ts: root,
        newest_match_ts: matchTs,
        origin: permalinkOrigin(m.permalink),
        my_match_count: 1,
      });
    }
  }

  const ordered = [...candidates.values()].sort((a, b) => b.newest_match_ts - a.newest_match_ts);
  const toEvaluate = ordered.slice(0, params.max_units);
  const capped = ordered.length - toEvaluate.length;

  const settled = await mapWithConcurrencySettled(
    toEvaluate,
    params.concurrency,
    async (c): Promise<EvalResult<ThreadUnit>> => {
      const base = { scope: "threads" as const, channel_id: c.channel_id, channel_name: c.channel_name, root_ts: c.root_ts };
      let messages: ThreadMessage[];
      try {
        const res = await deps.client.conversations.replies({ channel: c.channel_id, ts: c.root_ts, limit: 3 });
        messages = (res.messages ?? []) as ThreadMessage[];
      } catch (err) {
        return { cannot: { ...base, level: "unit", reason: `conversations.replies failed: ${errorMessage(err)}` } };
      }
      const parent = messages.find((m) => m.ts === c.root_ts);
      if (!parent) {
        return { cannot: { ...base, level: "unit", reason: "root_not_returned — replies did not return the root ts" } };
      }
      let newest: ThreadMessage | undefined;
      if (typeof parent.reply_count !== "number" || parent.reply_count === 0) {
        newest = parent;
      } else if (parent.latest_reply === undefined) {
        return { cannot: { ...base, level: "unit", reason: "latest_reply absent on a parent with reply_count" } };
      } else {
        newest = messages.find((m) => m.ts === parent.latest_reply);
        if (!newest) {
          return { cannot: { ...base, level: "unit", reason: "newest_not_in_window — no returned message has ts === latest_reply" } };
        }
      }

      let v: Verdict;
      try {
        v = await verdictFor(newest, me, bots);
      } catch (err) {
        return {
          cannot: { ...base, level: "unit", ts: newest.ts, reason: `bot_lookup_failed: ${errorMessage(err)}` },
        };
      }

      const latestRef = parent.latest_reply ?? parent.ts;
      const freshness = freshnessOf(latestRef, parent.last_read);
      const e = verdictEvidence(newest.ts, newest.user, me, v);
      const newestRef = newest === parent ? "newest = root (no replies)" : `newest ts=latest_reply ${newest.ts}`;
      const preview = textPreview(newest.text);
      const unit: ThreadUnit = {
        kind: "thread",
        channel_id: c.channel_id,
        ...(c.channel_name ? { channel_name: c.channel_name } : {}),
        root_ts: c.root_ts,
        ...(parent.reply_count !== undefined ? { reply_count: parent.reply_count } : {}),
        ...(parent.latest_reply !== undefined ? { latest_reply: parent.latest_reply } : {}),
        ...(parent.last_read !== undefined ? { last_read: parent.last_read } : {}),
        ...(parent.subscribed !== undefined ? { subscribed: parent.subscribed } : {}),
        newest_ts: newest.ts,
        ...(newest.user !== undefined ? { newest_user: newest.user } : {}),
        ...(v.newest_username ? { newest_username: v.newest_username } : {}),
        newest_is_bot: v.newest_is_bot,
        newest_bot_source: v.newest_bot_source,
        ...(preview.text !== undefined ? { newest_text: preview.text } : {}),
        ...(preview.truncated ? { newest_text_truncated: true as const } : {}),
        owes: v.owes,
        freshness,
        acknowledged: v.acknowledged,
        permalink: buildPermalink(c.origin, c.channel_id, newest.ts, c.root_ts),
        evidence:
          `${newestRef} ${e.who} → owes ${v.owes}; ` +
          `${freshnessEvidence(freshness, latestRef, parent.last_read)}` +
          (parent.last_read === undefined && parent.subscribed !== undefined ? ` (subscribed: ${parent.subscribed})` : "") +
          `; ${e.ack}${e.bot}`,
        ...(params.include_raw ? { raw: { messages } } : {}),
      };
      const freshnessGap: CannotCheckEntry | undefined =
        freshness === "cannot_check"
          ? {
              ...base,
              level: "freshness",
              reason:
                parent.last_read === undefined
                  ? `last_read absent (subscribed: ${parent.subscribed ?? "absent"}) — read state unknown; owes ${v.owes} still declared`
                  : "latest_reply or last_read unreadable",
              permalink: unit.permalink,
            }
          : undefined;
      return { unit, freshnessGap };
    }
  );

  const units: ThreadUnit[] = [];
  for (const r of settled.results) {
    if ("cannot" in r) cannot.push(r.cannot);
    else {
      units.push(r.unit);
      if (r.freshnessGap) cannot.push(r.freshnessGap);
    }
  }
  const unitSkips = settled.results.filter((r) => "cannot" in r).length + settled.skipped;
  if (settled.skipped > 0) {
    cannot.push({ scope: "threads", level: "unit", reason: `unexpected failure: ${settled.firstError}`, count: settled.skipped });
  }
  if (capped > 0) {
    cannot.push({ scope: "threads", level: "coverage", reason: `capped by max_units=${params.max_units}; not resolved`, count: capped });
  }
  if (walk.pages_unfetched > 0) {
    cannot.push({ scope: "threads", level: "coverage", reason: `search pages not fetched (page cap ${MAX_SEARCH_PAGES})`, count: walk.pages_unfetched });
  }
  if (walk.search_error) {
    cannot.push({ scope: "threads", level: "coverage", reason: `search failed: ${walk.search_error}` });
  }

  const coverage = {
    query,
    ...walkCoverage(walk),
    threaded_matches: threadedMatches,
    standalone,
    dm_matches_deferred_to_dms_scope: dmMatches,
    permalink_unparsable: permalinkUnparsable,
    unroutable,
    units_total: ordered.length,
    units_evaluated: units.length,
    units_skipped: unitSkips,
    capped,
    freshness_cannot_check: units.filter((u) => u.freshness === "cannot_check").length,
  };

  const blocking =
    !!walk.search_error ||
    walk.pages_unfetched > 0 ||
    permalinkUnparsable > 0 ||
    unroutable > 0 ||
    unitSkips > 0 ||
    capped > 0;
  const outcome = decideOutcome(units, walk.matches_in_window, ordered.length, blocking);
  return { outcome, coverage, units, awaiting, cannot };
}

// -------------------------------------------------------------------- dms

interface DmCandidate {
  channel_id: string;
  thread_root_ts?: string;
  channel_name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  newest: SearchMatch;
  count: number;
}

async function runDms(
  deps: MyThreadsDeps,
  me: string,
  afterDate: string,
  floorSeconds: number,
  params: MyThreadsParams,
  bots: BotResolver
) {
  const query = `is:dm after:${afterDate}`;
  const walk = await walkSearch(deps.client, query, floorSeconds);
  const cannot: CannotCheckEntry[] = [];
  let unroutable = 0;

  // Unit = (conversation, thread root) for threaded messages and
  // (conversation, main line) for the rest. Grouping by conversation alone
  // let a newer main-line message hide an older unanswered thread reply.
  let permalinkUnparsable = 0;
  const groups = new Map<string, { channelId: string; root?: string; matches: SearchMatch[] }>();
  const conversations = new Set<string>();
  for (const m of walk.kept) {
    const channelId = m.channel?.id;
    if (!channelId) {
      unroutable++;
      cannot.push({ scope: "dms", level: "unit", reason: "match has no channel id", ts: m.ts, permalink: m.permalink });
      continue;
    }
    const root = permalinkThreadTs(m.permalink);
    if (root === undefined) {
      permalinkUnparsable++;
      cannot.push({
        scope: "dms",
        level: "unit",
        reason: "permalink absent or unparsable — thread vs main line unknown",
        channel_id: channelId,
        channel_name: m.channel?.name,
        ts: m.ts,
      });
      continue;
    }
    conversations.add(channelId);
    const key = `${channelId}|${root ?? "main"}`;
    const g = groups.get(key) ?? { channelId, ...(root ? { root } : {}), matches: [] };
    g.matches.push(m);
    groups.set(key, g);
  }

  const candidates: DmCandidate[] = [];
  let ambiguous = 0;
  for (const { channelId, root, matches } of groups.values()) {
    const g = { matches };
    const parsable = g.matches.filter((m) => tsNumber(m.ts) !== undefined);
    const first = g.matches[0];
    if (parsable.length !== g.matches.length) {
      // An unreadable ts might be the newest message — the unit's newest is unknown.
      ambiguous++;
      cannot.push({
        scope: "dms",
        level: "unit",
        reason: "a match in this unit has an unreadable ts — newest message unknown",
        channel_id: channelId,
        ...(root ? { root_ts: root } : {}),
        channel_name: first.channel?.name,
      });
      continue;
    }
    const newest = parsable.reduce((a, b) => ((tsNumber(b.ts) as number) > (tsNumber(a.ts) as number) ? b : a));
    candidates.push({
      channel_id: channelId,
      channel_name: first.channel?.name,
      is_im: first.channel?.is_im,
      is_mpim: first.channel?.is_mpim,
      ...(root ? { thread_root_ts: root } : {}),
      newest,
      count: g.matches.length,
    });
  }

  candidates.sort((a, b) => (tsNumber(b.newest.ts) as number) - (tsNumber(a.newest.ts) as number));
  const toEvaluate = candidates.slice(0, params.max_units);
  const capped = candidates.length - toEvaluate.length;

  const settled = await mapWithConcurrencySettled(
    toEvaluate,
    params.concurrency,
    async (c): Promise<EvalResult<DmUnit>> => {
      const base = {
        scope: "dms" as const,
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        ...(c.thread_root_ts ? { root_ts: c.thread_root_ts } : {}),
        ts: c.newest.ts,
      };
      const newestTs = c.newest.ts as string;
      // When the newest DM message is a thread reply, the conversation's
      // last_read does not cover it — the thread parent's own last_read does.
      const threadTs = c.thread_root_ts;
      const inThread = threadTs !== undefined;
      let lastRead: string | undefined;
      let readCursor: "conversation" | "thread" = "conversation";
      let message: ThreadMessage | undefined;
      try {
        // conversations.replies with a message's own ts returns that message
        // whether it is a thread reply, a root, or standalone. history with
        // latest=oldest=ts inclusive misses thread replies (verified live
        // 2026-09-22: 4 of 8 DM conversations' newest matches, including one
        // carrying my reaction) — so replies is the lookup.
        const [info, rep] = await Promise.all([
          inThread
            ? deps.client.conversations.replies({ channel: c.channel_id, ts: threadTs, limit: 1 })
            : deps.client.conversations.info({ channel: c.channel_id }),
          deps.client.conversations.replies({ channel: c.channel_id, ts: newestTs, limit: 1 }),
        ]);
        if (inThread) {
          readCursor = "thread";
          const parent = (((info as { messages?: ThreadMessage[] }).messages ?? []) as ThreadMessage[]).find(
            (m) => m.ts === threadTs
          );
          lastRead = parent?.last_read;
        } else {
          lastRead = ((info as { channel?: { last_read?: string } }).channel)?.last_read;
        }
        message = ((rep.messages ?? []) as ThreadMessage[]).find((m) => m.ts === newestTs);
      } catch (err) {
        return { cannot: { ...base, level: "unit", reason: `lookup failed: ${errorMessage(err)}` } };
      }
      if (!message) {
        return { cannot: { ...base, level: "unit", reason: "newest_not_returned — replies(ts) did not return the newest match" } };
      }

      let v: Verdict;
      try {
        v = await verdictFor({ ...message, username: message.username ?? c.newest.username }, me, bots);
      } catch (err) {
        return { cannot: { ...base, level: "unit", reason: `bot_lookup_failed: ${errorMessage(err)}` } };
      }

      const freshness = freshnessOf(newestTs, lastRead);
      const e = verdictEvidence(newestTs, message.user, me, v);
      const preview = textPreview(message.text ?? c.newest.text);
      const unit: DmUnit = {
        kind: "dm",
        channel_id: c.channel_id,
        ...(c.channel_name ? { channel_name: c.channel_name } : {}),
        ...(c.is_im !== undefined ? { is_im: c.is_im } : {}),
        ...(c.is_mpim !== undefined ? { is_mpim: c.is_mpim } : {}),
        matches_in_window: c.count,
        newest_ts: newestTs,
        ...(threadTs !== undefined ? { thread_root_ts: threadTs } : {}),
        ...(message.user !== undefined ? { newest_user: message.user } : {}),
        ...(v.newest_username ? { newest_username: v.newest_username } : {}),
        newest_is_bot: v.newest_is_bot,
        newest_bot_source: v.newest_bot_source,
        ...(preview.text !== undefined ? { newest_text: preview.text } : {}),
        ...(preview.truncated ? { newest_text_truncated: true as const } : {}),
        ...(lastRead !== undefined ? { last_read: lastRead } : {}),
        read_cursor: readCursor,
        owes: v.owes,
        freshness,
        acknowledged: v.acknowledged,
        ...(c.newest.permalink ? { permalink: c.newest.permalink } : {}),
        evidence:
          `newest in-window match ts=${newestTs} ${e.who} → owes ${v.owes}; ` +
          `${freshnessEvidence(freshness, newestTs, lastRead)} [${readCursor} cursor]; ${e.ack}${e.bot}`,
        ...(params.include_raw ? { raw: { match: c.newest, message } } : {}),
      };
      const freshnessGap: CannotCheckEntry | undefined =
        freshness === "cannot_check"
          ? {
              ...base,
              level: "freshness",
              reason: inThread
                ? "thread parent returned no last_read (subscribed: false) — read state unknown"
                : "conversations.info returned no last_read — read state unknown",
              permalink: unit.permalink,
            }
          : undefined;
      return { unit, freshnessGap };
    }
  );

  const units: DmUnit[] = [];
  for (const r of settled.results) {
    if ("cannot" in r) cannot.push(r.cannot);
    else {
      units.push(r.unit);
      if (r.freshnessGap) cannot.push(r.freshnessGap);
    }
  }
  const unitSkips = settled.results.filter((r) => "cannot" in r).length + settled.skipped + ambiguous;
  if (settled.skipped > 0) {
    cannot.push({ scope: "dms", level: "unit", reason: `unexpected failure: ${settled.firstError}`, count: settled.skipped });
  }
  if (capped > 0) {
    cannot.push({ scope: "dms", level: "coverage", reason: `capped by max_units=${params.max_units}; not resolved`, count: capped });
  }
  if (walk.pages_unfetched > 0) {
    cannot.push({ scope: "dms", level: "coverage", reason: `search pages not fetched (page cap ${MAX_SEARCH_PAGES})`, count: walk.pages_unfetched });
  }
  if (walk.search_error) {
    cannot.push({ scope: "dms", level: "coverage", reason: `search failed: ${walk.search_error}` });
  }

  const coverage = {
    query,
    ...walkCoverage(walk),
    unroutable,
    permalink_unparsable: permalinkUnparsable,
    dm_conversations: conversations.size,
    units_total: groups.size,
    units_evaluated: units.length,
    units_skipped: unitSkips,
    capped,
    freshness_cannot_check: units.filter((u) => u.freshness === "cannot_check").length,
  };
  const blocking =
    !!walk.search_error ||
    walk.pages_unfetched > 0 ||
    unroutable > 0 ||
    permalinkUnparsable > 0 ||
    unitSkips > 0 ||
    capped > 0;
  const outcome = decideOutcome(units, walk.matches_in_window, groups.size, blocking);
  return { outcome, coverage, units, cannot };
}

// FINDINGS  — at least one row: owes me, not acknowledged, newest not a bot.
// CANNOT_CHECK — zero in-window matches (a failed search and a quiet week are
//   indistinguishable from a count), units exist but none evaluated, or any
//   counted gap (search error, unfetched page, skip, cap). Freshness-only
//   gaps do not block: the owes verdict is still declared.
// CLEAN     — everything in scope was evaluated and nothing is owed.
function decideOutcome(
  units: ReadonlyArray<{ owes: string; acknowledged: boolean; newest_is_bot: boolean }>,
  matchesInWindow: number,
  unitsTotal: number,
  blocking: boolean
): Outcome {
  if (units.some(isRow)) return "FINDINGS";
  if (matchesInWindow === 0) return "CANNOT_CHECK";
  if (unitsTotal > 0 && units.length === 0) return "CANNOT_CHECK";
  if (blocking) return "CANNOT_CHECK";
  return "CLEAN";
}

export function combineOutcomes(outcomes: Outcome[]): Outcome {
  if (outcomes.includes("FINDINGS")) return "FINDINGS";
  if (outcomes.includes("CANNOT_CHECK")) return "CANNOT_CHECK";
  return "CLEAN";
}

export async function runMyThreads(deps: MyThreadsDeps, params: MyThreadsParams) {
  const days = requirePositiveNumber(params.days, "days");
  requirePositiveInt(params.max_units, "max_units");
  const concurrency = clampConcurrency(params.concurrency);
  const p = { ...params, concurrency };

  const me = await deps.getMyUserId();
  const tz = await deps.getMyTimezone();
  const window = computeSearchWindow(days * 24, tz.tz, deps.now ?? Date.now, tz.source !== "slack");

  const botIds = new Set(parseIdList(params.bot_user_ids));
  const bots = createBotResolver(deps.client, botIds);

  const wantThreads = params.scope !== "dms";
  const wantDms = params.scope !== "threads";
  const [threads, dms] = await Promise.all([
    wantThreads ? runThreads(deps, me, window.slackAfter, window.floorSeconds, p, bots, botIds) : undefined,
    wantDms ? runDms(deps, me, window.slackAfter, window.floorSeconds, p, bots) : undefined,
  ]);

  const outcomes: Record<string, Outcome> = {};
  if (threads) outcomes.threads = threads.outcome;
  if (dms) outcomes.dms = dms.outcome;

  return {
    ok: true,
    outcome: combineOutcomes(Object.values(outcomes)),
    outcomes,
    me,
    scope: params.scope,
    window: {
      days,
      floor_iso: window.floorIso,
      tz: window.tz,
      tz_source: tz.source,
      ...(tz.error ? { tz_error: tz.error } : {}),
      slack_after: window.slackAfter,
      days_widened: window.daysWidened,
    },
    coverage: {
      ...(threads ? { threads: threads.coverage } : {}),
      ...(dms ? { dms: dms.coverage } : {}),
      bot_lookups: bots.lookups(),
      bot_overrides: botIds.size,
    },
    cannot_check: [...(threads?.cannot ?? []), ...(dms?.cannot ?? [])],
    units: [...(threads?.units ?? []), ...(dms?.units ?? [])],
    ...(threads ? { awaiting_others: threads.awaiting } : {}),
    residual_gap: RESIDUAL_GAP,
  };
}
