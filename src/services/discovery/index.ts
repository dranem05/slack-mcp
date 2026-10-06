import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import { withErrorHandling, isMissingScopeError } from "../../utils/errors.js";
import { validateChannelId, validateUserId, validateTs } from "../../utils/validate.js";
import { memoizeWithTtl } from "../../utils/ttlCache.js";
import { pruneEmojiList, mergeUserInfo } from "../../utils/pruning.js";

export function registerDiscoveryTools(
  server: McpServer,
  ctx: ServiceContext
): void {
  const api = () => ctx.client;

  // Custom emoji rarely change within the life of a single (one process per
  // workspace) run — fetch once and share across calls, same reasoning as
  // utils/identity.ts's per-process auth.test() cache.
  const getEmojiList = memoizeWithTtl(async () => {
    const res = await api().emoji.list();
    return pruneEmojiList(res.emoji);
  }, Infinity);

  server.tool(
    "slack_emoji_list",
    "List custom emoji available in this workspace — real names and alias targets — so you " +
      "can pick an emoji that actually exists instead of guessing when reacting or messaging. " +
      "The list is cached for the lifetime of this server process, so custom emoji added " +
      "mid-session only appear after a restart.",
    {},
    withErrorHandling(ctx.slug, async () => {
      return textResult(await getEmojiList());
    })
  );

  server.tool(
    "slack_user_info",
    "Get a user's essential profile info: name, display name, title, timezone, and status",
    {
      user_id: z.string().describe("User ID to look up"),
    },
    withErrorHandling(ctx.slug, async ({ user_id }) => {
      validateUserId(user_id);
      // users.profile.get needs users.profile:read, a scope some tokens
      // don't have — treat that one error as "no extra profile data" rather
      // than failing the whole tool, since mergeUserInfo already falls back
      // to users.info's nested profile in that case. Any other profile.get
      // error (or a users.info failure) still propagates.
      const [infoRes, profileRes] = await Promise.all([
        api().users.info({ user: user_id }),
        api()
          .users.profile.get({ user: user_id })
          .catch((err) => {
            if (isMissingScopeError(err)) return undefined;
            throw err;
          }),
      ]);
      return textResult(mergeUserInfo(infoRes.user, profileRes?.profile));
    })
  );

  server.tool(
    "slack_get_permalink",
    "Get a permanent, shareable link (URL) to a specific message",
    {
      channel_id: z.string().describe("Channel ID containing the message"),
      ts: z.string().describe("Timestamp of the message"),
    },
    withErrorHandling(ctx.slug, async ({ channel_id, ts }) => {
      validateChannelId(channel_id);
      validateTs(ts);
      const res = await api().chat.getPermalink({
        channel: channel_id,
        message_ts: ts,
      });
      return textResult({ permalink: res.permalink });
    })
  );

  server.tool(
    "slack_delete_message",
    "Delete a message (must be one you sent, unless the token has admin delete permissions)",
    {
      channel_id: z.string().describe("Channel ID containing the message"),
      ts: z.string().describe("Timestamp of the message to delete"),
    },
    withErrorHandling(ctx.slug, async ({ channel_id, ts }) => {
      validateChannelId(channel_id);
      validateTs(ts);
      const res = await api().chat.delete({ channel: channel_id, ts });
      return textResult({ ok: res.ok, channel: res.channel, ts: res.ts });
    })
  );

  // Identity doesn't change for the life of a run — same reasoning as
  // utils/identity.ts's getMyUserId, but this keeps the full auth.test()
  // payload (team, team_id, ...) rather than just the user ID.
  const getIdentity = memoizeWithTtl(() => api().auth.test(), Infinity);

  server.tool(
    "slack_whoami",
    "Get the authenticated identity: workspace (team) and user info",
    {},
    withErrorHandling(ctx.slug, async () => {
      const res = await getIdentity();
      return textResult({
        team: res.team,
        team_id: res.team_id,
        user: res.user,
        user_id: res.user_id,
      });
    })
  );
}
