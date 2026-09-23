// slack_channel_digest — per-channel "what moved since you last read" for a
// caller-declared list of channel ids (the watchlist lives in the caller's
// policy file; this tool holds no list of its own).
//
// Window is a DAYS floor, not oldest=last_read: conversations.history omits
// thread replies entirely, so a last_read window would miss every thread that
// moved under an already-read root. Instead each root in the window is
// partitioned on declared fields:
//   new_top_level      — root ts > channel last_read
//   threads_moved      — root latest_reply > the root's OWN last_read
//   unknown_read_state — root with replies but no own last_read (it is absent
//                        exactly when subscribed:false) → CANNOT-CHECK, never
//                        "read". moved_since_channel_read is reported beside it
//                        as evidence only.
// Roots older than `days` are not examined (horizon_days, every run).

import type { WebClient } from "@slack/web-api";
import { mapWithConcurrencySettled } from "../../utils/concurrency.js";
import { validateChannelId, clampLimit } from "../../utils/validate.js";
import {
  clampConcurrency,
  createBotResolver,
  errorMessage,
  parseIdList,
  requirePositiveNumber,
  textPreview,
  tsAfter,
  tsNumber,
  buildPermalink,
  type BotResolver,
  type Outcome,
} from "../../utils/threadCoverage.js";

export type ChannelDigestClient = Pick<WebClient, "conversations" | "users" | "auth">;

export interface ChannelDigestDeps {
  client: ChannelDigestClient;
  now?: () => number;
}

export interface ChannelDigestParams {
  channel_ids: string;
  days: number;
  limit: number;
  concurrency: number;
  bot_user_ids?: string;
}

interface HistoryMessage {
  ts?: string;
  user?: string;
  subtype?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  last_read?: string;
  subscribed?: boolean;
}

type IsBot = boolean | "cannot_check";

// Message subtypes that are still a person posting. Every other subtype
// (channel_join, channel_topic, pinned_item, …) is a Slack system event and
// never counts toward new_top_level_human.
const HUMAN_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);

export interface DigestRoot {
  ts?: string;
  user?: string;
  username?: string;
  is_bot: IsBot;
  by_me?: true;
  subtype?: string;
  text?: string;
  truncated?: true;
  reply_count?: number;
  latest_reply?: string;
  last_read?: string;
  subscribed?: boolean;
  new_top_level?: boolean;
  thread_moved?: boolean;
  read_state?: "own" | "unknown";
  moved_since_channel_read?: boolean;
  permalink?: string;
}

export interface DigestChannel {
  channel_id: string;
  channel_name?: string;
  last_read?: string;
  history_messages: number;
  new_top_level: number | null;
  new_top_level_human: number | null;
  threads_moved: number;
  unknown_read_state: number;
  newest?: { ts?: string; user?: string; username?: string; is_bot: IsBot; text?: string; truncated?: true };
  roots: DigestRoot[];
  truncated: boolean;
  horizon_days: number;
}

export interface DigestCannotCheck {
  level: "channel" | "read_state" | "bot" | "coverage";
  channel_id: string;
  channel_name?: string;
  ts?: string;
  reason: string;
  count?: number;
}

async function isBotOf(bots: BotResolver, user: string | undefined): Promise<{ is_bot: IsBot; name?: string; error?: string }> {
  try {
    const v = await bots.resolve(user);
    return { is_bot: v.is_bot, ...(v.name ? { name: v.name } : {}) };
  } catch (err) {
    return { is_bot: "cannot_check", error: errorMessage(err) };
  }
}

export async function runChannelDigest(deps: ChannelDigestDeps, params: ChannelDigestParams) {
  const days = requirePositiveNumber(params.days, "days");
  const limit = clampLimit(params.limit, { max: 200, field: "limit" });
  const concurrency = clampConcurrency(params.concurrency);
  const ids = parseIdList(params.channel_ids);
  const now = (deps.now ?? Date.now)();
  const floorSeconds = now / 1000 - days * 86400;
  const oldest = floorSeconds.toFixed(6);
  const bots = createBotResolver(deps.client, parseIdList(params.bot_user_ids));
  const cannot: DigestCannotCheck[] = [];

  // Permalink base from auth.test().url — deterministic construction, since
  // conversations.history returns no permalinks.
  // auth.test also names me: my own posts are never "new" to me.
  let teamUrl: string | undefined;
  let me: string | undefined;
  let permalinkError: string | undefined;
  try {
    const auth = await deps.client.auth.test();
    teamUrl = typeof auth.url === "string" && auth.url ? auth.url : undefined;
    me = typeof auth.user_id === "string" ? auth.user_id : undefined;
    if (!teamUrl) permalinkError = "auth.test returned no url";
  } catch (err) {
    permalinkError = errorMessage(err);
  }
  if (!me) {
    // Without knowing who I am, "new from someone else" is unmeasurable.
    throw new Error(`Could not determine the authenticated user (auth.test: ${permalinkError ?? "no user_id"}).`);
  }

  const settled = await mapWithConcurrencySettled(ids, concurrency, async (id) => {
    try {
      validateChannelId(id);
    } catch (err) {
      return { cannot: { level: "channel" as const, channel_id: id, reason: errorMessage(err) } };
    }
    let info, history;
    try {
      [info, history] = await Promise.all([
        deps.client.conversations.info({ channel: id }),
        deps.client.conversations.history({ channel: id, oldest, limit }),
      ]);
    } catch (err) {
      return { cannot: { level: "channel" as const, channel_id: id, reason: `lookup failed: ${errorMessage(err)}` } };
    }
    const ch = (info.channel ?? {}) as { name?: string; last_read?: string };
    const channelLastRead = ch.last_read;
    const messages = (history.messages ?? []) as HistoryMessage[];
    const gaps: DigestCannotCheck[] = [];

    let newTop = 0;
    let newTopHuman = 0;
    let moved = 0;
    let unknown = 0;

    interface Classified {
      m: HistoryMessage;
      isNew?: boolean;
      threadMoved?: boolean;
      readState?: "own" | "unknown";
      movedSinceChannelRead?: boolean;
    }
    const classified: Classified[] = [];
    for (const m of messages) {
      const isNew = channelLastRead === undefined ? undefined : tsAfter(m.ts, channelLastRead);
      const c: Classified = { m, isNew };
      if (typeof m.reply_count === "number" && m.reply_count > 0) {
        if (m.latest_reply !== undefined && m.last_read !== undefined) {
          c.threadMoved = tsAfter(m.latest_reply, m.last_read);
          c.readState = c.threadMoved === undefined ? "unknown" : "own";
        } else {
          // No own cursor (subscribed:false), or replies with no declared
          // latest_reply: the thread's read state is unknown, never "read".
          c.readState = "unknown";
        }
        if (c.readState === "unknown") {
          unknown++;
          c.movedSinceChannelRead =
            channelLastRead === undefined ? undefined : tsAfter(m.latest_reply, channelLastRead);
        }
        if (c.threadMoved) moved++;
      }
      const interesting = isNew !== false || c.threadMoved === true || c.readState === "unknown";
      if (interesting) classified.push(c);
    }

    // Resolve distinct authors in parallel (cached per run), then build rows.
    const authors = [...new Set(classified.map((c) => c.m.user).filter((u): u is string => !!u))];
    const verdicts = new Map<string, Awaited<ReturnType<typeof isBotOf>>>();
    await Promise.all(authors.map(async (u) => verdicts.set(u, await isBotOf(bots, u))));

    const roots: DigestRoot[] = [];
    for (const { m, isNew, threadMoved, readState, movedSinceChannelRead } of classified) {
      const bot = m.user ? (verdicts.get(m.user) as Awaited<ReturnType<typeof isBotOf>>) : await isBotOf(bots, undefined);
      if (bot.error) {
        gaps.push({ level: "bot", channel_id: id, channel_name: ch.name, ts: m.ts, reason: `bot_lookup_failed: ${bot.error}` });
      }
      const byMe = m.user === me;
      if (isNew === true) {
        newTop++;
        // "Human" = someone else, users.info says not a bot, and not a Slack
        // system event (join/leave/topic…): declared subtype, not content.
        if (bot.is_bot === false && !byMe && (!m.subtype || HUMAN_SUBTYPES.has(m.subtype))) newTopHuman++;
      }
      const preview = textPreview(m.text);
      const link = buildPermalink(teamUrl, id, m.ts);
      roots.push({
        ts: m.ts,
        ...(m.user !== undefined ? { user: m.user } : {}),
        ...((m.username ?? bot.name) ? { username: m.username ?? bot.name } : {}),
        is_bot: bot.is_bot,
        ...(byMe ? { by_me: true as const } : {}),
        ...(m.subtype ? { subtype: m.subtype } : {}),
        ...(preview.text !== undefined ? { text: preview.text } : {}),
        ...(preview.truncated ? { truncated: true as const } : {}),
        ...(m.reply_count !== undefined ? { reply_count: m.reply_count } : {}),
        ...(m.latest_reply !== undefined ? { latest_reply: m.latest_reply } : {}),
        ...(m.last_read !== undefined ? { last_read: m.last_read } : {}),
        ...(m.subscribed !== undefined ? { subscribed: m.subscribed } : {}),
        ...(isNew !== undefined ? { new_top_level: isNew } : {}),
        ...(threadMoved !== undefined ? { thread_moved: threadMoved } : {}),
        ...(readState ? { read_state: readState } : {}),
        ...(movedSinceChannelRead !== undefined ? { moved_since_channel_read: movedSinceChannelRead } : {}),
        ...(link ? { permalink: link } : {}),
      });
    }

    if (unknown > 0) {
      gaps.push({
        level: "read_state",
        channel_id: id,
        channel_name: ch.name,
        reason: "thread roots with no own last_read (subscribed: false) — read state unknown, not 'read'",
        count: unknown,
      });
    }
    if (channelLastRead === undefined) {
      gaps.push({ level: "read_state", channel_id: id, channel_name: ch.name, reason: "conversations.info returned no last_read — new_top_level unknown" });
    }
    const truncated = history.has_more === true;
    if (truncated) {
      gaps.push({ level: "coverage", channel_id: id, channel_name: ch.name, reason: `history has_more at limit=${limit} — partial, older roots in the window not examined` });
    }

    let newest: DigestChannel["newest"];
    const newestMsg = messages.reduce<HistoryMessage | undefined>(
      (a, b) => (a === undefined || (tsNumber(b.ts) ?? -Infinity) > (tsNumber(a.ts) ?? -Infinity) ? b : a),
      undefined
    );
    if (newestMsg) {
      const bot = await isBotOf(bots, newestMsg.user);
      if (bot.error) {
        gaps.push({ level: "bot", channel_id: id, channel_name: ch.name, ts: newestMsg.ts, reason: `bot_lookup_failed: ${bot.error}` });
      }
      const preview = textPreview(newestMsg.text);
      newest = {
        ts: newestMsg.ts,
        ...(newestMsg.user !== undefined ? { user: newestMsg.user } : {}),
        ...((newestMsg.username ?? bot.name) ? { username: newestMsg.username ?? bot.name } : {}),
        is_bot: bot.is_bot,
        ...(preview.text !== undefined ? { text: preview.text } : {}),
        ...(preview.truncated ? { truncated: true as const } : {}),
      };
    }

    const channel: DigestChannel = {
      channel_id: id,
      ...(ch.name ? { channel_name: ch.name } : {}),
      ...(channelLastRead !== undefined ? { last_read: channelLastRead } : {}),
      history_messages: messages.length,
      new_top_level: channelLastRead === undefined ? null : newTop,
      new_top_level_human: channelLastRead === undefined ? null : newTopHuman,
      threads_moved: moved,
      unknown_read_state: unknown,
      ...(newest ? { newest } : {}),
      roots,
      truncated,
      horizon_days: days,
    };
    return { channel, gaps };
  });

  const channels: DigestChannel[] = [];
  let skipped = settled.skipped;
  let firstError = settled.firstError;
  for (const r of settled.results) {
    if ("cannot" in r && r.cannot) {
      skipped++;
      firstError ??= `${r.cannot.channel_id}: ${r.cannot.reason}`;
      cannot.push(r.cannot);
    } else if ("channel" in r && r.channel) {
      channels.push(r.channel);
      cannot.push(...r.gaps);
    }
  }
  if (settled.skipped > 0) {
    cannot.push({ level: "coverage", channel_id: "*", reason: `unexpected failure: ${settled.firstError}`, count: settled.skipped });
  }

  const findings = channels.some((c) => (c.new_top_level_human ?? 0) > 0 || c.threads_moved > 0);
  let outcome: Outcome;
  if (findings) outcome = "FINDINGS";
  else if (channels.length === 0 || cannot.length > 0) outcome = "CANNOT_CHECK";
  else outcome = "CLEAN";

  return {
    ok: true,
    outcome,
    window: { days, oldest, floor_iso: new Date(floorSeconds * 1000).toISOString() },
    coverage: {
      requested: ids.length,
      resolved: channels.length,
      skipped,
      ...(firstError ? { first_error: firstError } : {}),
      truncated_channels: channels.filter((c) => c.truncated).length,
      history_messages: channels.reduce((n, c) => n + c.history_messages, 0),
      bot_lookups: bots.lookups(),
      ...(permalinkError ? { permalinks_unavailable: permalinkError } : {}),
    },
    cannot_check: cannot,
    channels,
    horizon_days: days,
    horizon_note:
      "Roots posted before the window are not examined, even if their threads moved; widen days to reach them.",
  };
}
