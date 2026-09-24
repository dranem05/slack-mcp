import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import { withErrorHandling } from "../../utils/errors.js";
import { validateChannelId, validateTs, clampLimit } from "../../utils/validate.js";
import { pruneMessages, pruneReplies } from "../../utils/pruning.js";
import { mapWithConcurrencySettled } from "../../utils/concurrency.js";
import { searchWindow, trimToWindow } from "../../utils/searchWindow.js";
import { ValidationError } from "../../utils/validate.js";
import { runMyThreads } from "./myThreads.js";
import {
  BLOCKS_DESCRIPTION,
  resolveMessageContent,
} from "../../utils/messageContent.js";

// add/edit_message also take `mrkdwn` — note the mutual exclusion.
const BLOCKS_WITH_MRKDWN_DESCRIPTION = `${BLOCKS_DESCRIPTION} Mutually exclusive with mrkdwn.`;

const MRKDWN_DESCRIPTION =
  "Render text as Slack rich-text blocks (real bullet/ordered lists, block quotes, and fenced code " +
  "blocks) using this server's local mrkdwn parser, instead of relying on Slack's plain-text mrkdwn " +
  "rendering — which displays those constructs as literal characters (e.g. a '- item' line shows up " +
  "as the literal text '- item', not an actual bullet). Mutually exclusive with blocks.";

const INCLUDE_RAW_DESCRIPTION =
  "Return full, unpruned message objects instead of the compact default (ts, user, text, thread_ts, reply_count, reactions, subtype, file names). Use this if you need attachments, blocks, or other fields the compact form drops.";

export function registerConversationsTools(
  server: McpServer,
  ctx: ServiceContext
): void {
  const api = () => ctx.client;

  server.tool(
    "slack_conversations_history",
    "Get recent messages from a channel or DM",
    {
      channel_id: z.string().describe("Channel or DM ID"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Number of messages to return (max 200)"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor for next page"),
      oldest: z
        .string()
        .optional()
        .describe("Only messages after this Unix timestamp"),
      latest: z
        .string()
        .optional()
        .describe("Only messages before this Unix timestamp"),
      include_raw: z.boolean().optional().default(false).describe(INCLUDE_RAW_DESCRIPTION),
    },
    withErrorHandling(
      ctx.slug,
      async ({ channel_id, limit, cursor, oldest, latest, include_raw }) => {
        validateChannelId(channel_id);
        const clampedLimit = clampLimit(limit, { max: 200, field: "limit" });
        const res = await api().conversations.history({
          channel: channel_id,
          limit: clampedLimit,
          cursor,
          oldest,
          latest,
        });
        const messages = res.messages ?? [];
        return textResult({
          messages: include_raw ? messages : pruneMessages(messages),
          has_more: res.has_more,
          next_cursor: res.response_metadata?.next_cursor,
        });
      }
    )
  );

  server.tool(
    "slack_conversations_replies",
    "Get replies in a message thread",
    {
      channel_id: z.string().describe("Channel ID containing the thread"),
      thread_ts: z.string().describe("Timestamp of the parent message"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max replies to return (max 200)"),
      cursor: z.string().optional().describe("Pagination cursor"),
      include_raw: z.boolean().optional().default(false).describe(INCLUDE_RAW_DESCRIPTION),
    },
    withErrorHandling(
      ctx.slug,
      async ({ channel_id, thread_ts, limit, cursor, include_raw }) => {
        validateChannelId(channel_id);
        validateTs(thread_ts, "thread_ts");
        const clampedLimit = clampLimit(limit, { max: 200, field: "limit" });
        const res = await api().conversations.replies({
          channel: channel_id,
          ts: thread_ts,
          limit: clampedLimit,
          cursor,
        });
        const messages = res.messages ?? [];
        return textResult({
          messages: include_raw ? messages : pruneReplies(messages),
          has_more: res.has_more,
          next_cursor: res.response_metadata?.next_cursor,
        });
      }
    )
  );

  server.tool(
    "slack_conversations_add_message",
    "Post a message to a channel or thread",
    {
      channel_id: z.string().describe("Channel ID to post to"),
      text: z.string().describe("Message text (supports Slack mrkdwn)"),
      thread_ts: z
        .string()
        .optional()
        .describe("Thread timestamp to reply to"),
      blocks: z.string().optional().describe(BLOCKS_WITH_MRKDWN_DESCRIPTION),
      mrkdwn: z.boolean().optional().default(false).describe(MRKDWN_DESCRIPTION),
      unfurl_links: z
        .boolean()
        .optional()
        .describe("Enable unfurling of primarily text-based link previews. Slack default: enabled."),
      unfurl_media: z
        .boolean()
        .optional()
        .describe("Pass false to disable unfurling of media (image/video) link previews."),
    },
    withErrorHandling(
      ctx.slug,
      async ({ channel_id, text, thread_ts, blocks, mrkdwn, unfurl_links, unfurl_media }) => {
        validateChannelId(channel_id);
        if (thread_ts) validateTs(thread_ts, "thread_ts");
        const content = resolveMessageContent({ text, blocks, mrkdwn });
        const res = await api().chat.postMessage({
          channel: channel_id,
          text: content.text,
          thread_ts,
          unfurl_links,
          unfurl_media,
          ...(content.blocks ? { blocks: content.blocks } : {}),
        });
        return textResult({
          ok: res.ok,
          channel: res.channel,
          ts: res.ts,
          message: res.message,
        });
      }
    )
  );

  server.tool(
    "slack_conversations_edit_message",
    "Edit a previously sent message",
    {
      channel_id: z.string().describe("Channel ID containing the message"),
      ts: z.string().describe("Timestamp of the message to edit"),
      text: z.string().describe("New message text (supports Slack mrkdwn)"),
      blocks: z.string().optional().describe(BLOCKS_WITH_MRKDWN_DESCRIPTION),
      mrkdwn: z.boolean().optional().default(false).describe(MRKDWN_DESCRIPTION),
    },
    withErrorHandling(ctx.slug, async ({ channel_id, ts, text, blocks, mrkdwn }) => {
      validateChannelId(channel_id);
      validateTs(ts);
      const content = resolveMessageContent({ text, blocks, mrkdwn });
      const res = await api().chat.update({
        channel: channel_id,
        ts,
        text: content.text,
        ...(content.blocks ? { blocks: content.blocks } : {}),
      });
      return textResult({
        ok: res.ok,
        channel: res.channel,
        ts: res.ts,
        message: res.message,
      });
    })
  );

  server.tool(
    "slack_conversations_search_messages",
    "Search messages across the workspace; hours/days restrict it to that exact lookback, newest first.",
    {
      query: z.string().describe("Search query (supports Slack search syntax)"),
      count: z
        .number()
        .optional()
        .default(20)
        .describe("Number of results per page (max 100)"),
      sort: z
        .enum(["score", "timestamp"])
        .optional()
        .default("score")
        .describe("Sort order"),
      sort_dir: z
        .enum(["asc", "desc"])
        .optional()
        .default("desc")
        .describe("Sort direction"),
      page: z
        .number()
        .optional()
        .describe(
          "Page number of results to return (1-indexed, default 1). search.messages paginates by page rather than cursor — use the returned 'paging' metadata to know how many pages exist."
        ),
      hours: z.number().optional().describe("Lookback in hours (exclusive of days)"),
      days: z.number().optional().describe("Lookback in days (exclusive of hours)"),
    },
    withErrorHandling(ctx.slug, async ({ query, count, sort, sort_dir, page, hours, days }) => {
      // search.messages documents count as 1-100.
      const clampedCount = clampLimit(count, { max: 100, field: "count" });
      if (hours !== undefined && days !== undefined) throw new ValidationError("pass hours or days, not both");
      if (hours !== undefined || days !== undefined) {
        const w = searchWindow(hours ?? days! * 24);
        const res = await api().search.messages({
          query: `${query} after:${w.slack_after}`,
          count: clampedCount,
          sort: "timestamp",
          sort_dir: "desc",
          page,
        });
        const { kept, trimmed_out } = trimToWindow(res.messages?.matches ?? [], w.floorSeconds);
        const pages = res.messages?.paging?.pages;
        return textResult({
          total: res.messages?.total,
          matches: kept,
          paging: res.messages?.paging,
          window: { floor_iso: w.floor_iso, slack_after: w.slack_after, trimmed_out },
          // Newest first: a trimmed match or the last page means no later page is in-window.
          reached_floor: trimmed_out > 0 || (typeof pages === "number" && (page ?? 1) >= pages),
        });
      }
      const res = await api().search.messages({
        query,
        count: clampedCount,
        sort,
        sort_dir,
        page,
      });
      return textResult({
        total: res.messages?.total,
        matches: res.messages?.matches,
        paging: res.messages?.paging,
      });
    })
  );

  server.tool(
    "slack_conversations_unreads",
    "Get DMs with unread messages; Slack reports unread_count for 1:1 DMs only, so other conversations are listed " +
      "under unread_count_unavailable. Channels whose info lookup fails (e.g. rate-limited) " +
      "are skipped rather than failing the whole call — the response then includes skipped_channels " +
      "and first_error.",
    {
      types: z
        .string()
        .optional()
        .default("public_channel,private_channel,mpim,im")
        .describe("Comma-separated channel types to include"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max channels to scan across all pages (max 1000)"),
    },
    withErrorHandling(ctx.slug, async ({ types, limit }) => {
      const clampedLimit = clampLimit(limit, { max: 1000, field: "limit" });

      // users.conversations only returns up to `limit` per page (Slack API
      // limit param is a per-page size, not a total), so loop the cursor
      // until either the workspace is exhausted or we've scanned enough
      // channels to satisfy the caller's `limit`.
      const channels: Array<{
        id?: string;
        name?: string;
        is_im?: boolean;
        is_mpim?: boolean;
      }> = [];
      let cursor: string | undefined;
      do {
        const pageSize = Math.min(200, clampedLimit - channels.length);
        const res = await api().users.conversations({
          types,
          limit: pageSize,
          cursor,
          exclude_archived: true,
        });
        const page = res.channels || [];
        channels.push(...page);
        cursor = res.response_metadata?.next_cursor || undefined;
        // Guard against a degenerate response (empty page with a truthy
        // next_cursor) spinning this loop forever.
        if (page.length === 0) break;
      } while (cursor && channels.length < clampedLimit);

      const channelsWithIds = channels.filter(
        (ch): ch is typeof ch & { id: string } => !!ch.id
      );

      // Settled fan-out: one channel's conversations.info failing (e.g. a
      // 429 that exhausts its retry budget) skips just that channel rather
      // than discarding every other channel's result.
      const { results, skipped, firstError } = await mapWithConcurrencySettled(
        channelsWithIds,
        8,
        async (ch) => {
          const info = await api().conversations.info({ channel: ch.id });
          const declared = (info.channel as Record<string, unknown> | undefined)?.unread_count;
          return {
            measured: typeof declared === "number",
            row: {
              id: ch.id,
              name: ch.name || ch.id,
              is_im: ch.is_im,
              is_mpim: ch.is_mpim,
              unread_count: (declared as number | undefined) ?? 0,
            },
          };
        }
      );
      const unavailable = results.filter((r) => !r.measured).map((r) => r.row.name);

      return textResult({
        unreads: results
          .map((r) => r.row)
          .filter((u) => u.unread_count > 0)
          .sort((a, b) => b.unread_count - a.unread_count),
        ...(skipped > 0 ? { skipped_channels: skipped, first_error: firstError } : {}),
        unread_count_unavailable: unavailable.length,
        unread_count_unavailable_names: unavailable,
      });
    })
  );

  server.tool(
    "slack_my_mentions",
    "Find recent messages that mention the authenticated user (works across channel top-level posts and thread replies, regardless of read state). Use this to catch @mentions that slack_conversations_unreads misses — that tool only returns channels with top-level unreads, so it skips thread mentions and mentions in already-read channels. Matches are trimmed to exactly the last `hours` (see `window`).",
    {
      hours: z
        .number()
        .optional()
        .default(24)
        .describe("Look back this many hours (used to compute the search 'after:' date filter)"),
      count: z
        .number()
        .optional()
        .default(20)
        .describe("Max results to return per page (max 100)"),
      page: z
        .number()
        .optional()
        .describe(
          "Page number of results to return (1-indexed, default 1). search.messages paginates by page rather than cursor — use the returned 'paging' metadata to know how many pages exist."
        ),
    },
    withErrorHandling(ctx.slug, async ({ hours, count, page }) => {
      // search.messages documents count as 1-100.
      const clampedCount = clampLimit(count, { max: 100, field: "count" });
      const userId = await ctx.getMyUserId();

      const w = searchWindow(hours);
      const query = `<@${userId}> after:${w.slack_after}`;

      const res = await api().search.messages({
        query,
        count: clampedCount,
        sort: "timestamp",
        sort_dir: "desc",
        page,
      });

      const { kept, trimmed_out } = trimToWindow(res.messages?.matches ?? [], w.floorSeconds);
      return textResult({
        user_id: userId,
        query,
        total: res.messages?.total,
        matches: kept,
        paging: res.messages?.paging,
        window: { floor_iso: w.floor_iso, slack_after: w.slack_after, trimmed_out },
      });
    })
  );

  server.tool(
    "slack_my_threads",
    "Units (channel thread, DM thread, DM main line) from your posts, DMs and mentions, each with owes (me|them|nobody|cannot_check) " +
      "read from the newest human message, your reactions on it, acknowledged (one is in clearing_reactions), unseen and active. " +
      "Not covered: threads you were only mentioned in older than days, or last posted in before horizon_days.",
    {
      scope: z.enum(["threads", "dms", "mentions", "both"]).optional().default("both").describe("both = all three"),
      days: z.number().int().min(1).max(90).optional().default(7).describe("Active window; DM and mention lookback"),
      horizon_days: z.number().int().min(1).max(90).optional().default(30).describe("Threads-scope lookback (>= days)"),
      max_units: z.number().int().min(1).max(500).optional().default(60).describe("Per scope, newest first"),
      bot_user_ids: z.string().optional().describe("Comma-separated user ids to treat as bots"),
      clearing_reactions: z.string().optional().describe("Comma-separated reaction names that acknowledge a unit"),
    },
    withErrorHandling(ctx.slug, async (params) => {
      if (params.horizon_days < params.days) throw new ValidationError("horizon_days must be >= days");
      return textResult(await runMyThreads(api(), await ctx.getMyUserId(), params));
    })
  );

  server.tool(
    "slack_conversations_open",
    "Open or resume a direct message or multi-party DM. Returns the channel ID for messaging.",
    {
      users: z
        .string()
        .describe(
          "Comma-separated list of user IDs (1 for DM, 2+ for group DM)"
        ),
    },
    withErrorHandling(ctx.slug, async ({ users }) => {
      const res = await api().conversations.open({
        users,
        return_im: true,
      });
      return textResult({
        ok: res.ok,
        channel: res.channel?.id,
        already_open: res.already_open,
      });
    })
  );

  server.tool(
    "slack_conversations_mark",
    "Mark a channel or DM as read up to a given timestamp",
    {
      channel_id: z.string().describe("Channel ID to mark"),
      ts: z.string().describe("Timestamp to mark as read up to"),
    },
    withErrorHandling(ctx.slug, async ({ channel_id, ts }) => {
      validateChannelId(channel_id);
      validateTs(ts);
      const res = await api().conversations.mark({ channel: channel_id, ts });
      return textResult({ ok: res.ok });
    })
  );
}
