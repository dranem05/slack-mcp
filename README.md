# slack-mcp
Slack MCP server for Claude Code — messaging, threads, search, drafts, scheduling, reminders, pins, bookmarks, files, canvases, and workspace discovery.

## Tools

All tool families work with an xoxp user token except **drafts**, which require browser-session tokens (see Authentication below).

**Messaging & threads**
- `slack_conversations_history` / `slack_conversations_replies` — read channel/DM messages and thread replies (compact by default; `include_raw` for full payloads)
- `slack_conversations_add_message` / `slack_conversations_edit_message` — post/edit messages; support Block Kit via `blocks` (JSON array string) or `mrkdwn: true` (local rich-text conversion: real bullet/ordered lists, block quotes, code fences); `unfurl_links` / `unfurl_media` control link previews on post
- `slack_delete_message`, `slack_get_permalink`
- `slack_conversations_open` (start/resume DMs), `slack_conversations_mark` (mark read)
- `slack_conversations_search_messages`, `slack_conversations_unreads`, `slack_my_mentions`
- `slack_my_threads` (threads you posted in + DMs, classified by whose turn it is, with coverage and CANNOT-CHECK reporting), `slack_channel_digest` (what moved in a declared channel list since you last read)

**Scheduled messages**
- `slack_schedule_message` (ISO 8601 or epoch `post_at`; supports `blocks` + unfurl params), `slack_list_scheduled_messages`, `slack_delete_scheduled_message`

**Reactions**
- `slack_add_reaction`, `slack_remove_reaction`, `slack_get_reactions`

**Reminders** (user-token-only API family)
- `slack_add_reminder` (natural-language times supported), `slack_list_reminders`, `slack_complete_reminder`, `slack_delete_reminder`

**Status & presence**
- `slack_set_status` (text/emoji/expiration), `slack_set_presence` (auto/away)

**Pins & bookmarks**
- `slack_pin_message`, `slack_unpin_message`, `slack_list_pins`
- `slack_add_bookmark`, `slack_remove_bookmark`, `slack_list_bookmarks`

**Files & canvases**
- `slack_upload_file` — from a local path or inline content, optionally into a channel/thread (files.uploadV2)
- `slack_create_canvas` / `slack_edit_canvas` — markdown-based canvas create/replace

**Channels & metadata**
- `slack_channels_list` (member-scoped or workspace-wide), `slack_channel_info`, `slack_list_channel_members`
- `slack_set_channel_topic`, `slack_set_channel_purpose`

**Users & user groups**
- `slack_users_search`, `slack_user_info`, `slack_whoami`
- `slack_usergroups_list` / `create` / `update` / `users_update` / `me` (join/leave)

**Discovery**
- `slack_emoji_list` — custom emoji names + alias targets (cached per process)

**Drafts** (browser tokens required)
- `slack_drafts_list` / `create` / `edit` / `delete` — real Slack drafts, visible in the composer

## Authentication

Tools are gated by what tokens are available in env vars for the slug you pass with `--slug`.

| Tool group | Tokens required | Env var(s) |
|---|---|---|
| everything except drafts | xoxp user token | `SLACK_TOKEN_<SLUG>` |
| drafts (drafts.create / list / edit / delete) | xoxc client token + xoxd session cookie | `SLACK_XOXC_<SLUG>` and `SLACK_XOXD_<SLUG>` |

`<SLUG>` is the workspace slug, uppercased with `-` → `_` (e.g. `doromind-slack-com` → `SLACK_TOKEN_DOROMIND_SLACK_COM`).

If `SLACK_XOXC_<SLUG>` or `SLACK_XOXD_<SLUG>` is missing, the draft tools register but throw a clear error at call time. Everything else still works on xoxp alone.

Some families depend on the xoxp token's granted scopes (e.g. reminders, pins, bookmarks, canvases, files). A missing scope surfaces as a structured `missing_scope` error naming the needed scope rather than a silent failure. Reminders are additionally a user-token-only API — no bot token works for them.

## Extracting xoxc + xoxd from your browser

Slack's drafts API isn't exposed to xoxp tokens, so you need browser-session tokens. They're tied to your logged-in browser session and rotate when you sign out.

**`xoxd` (session cookie)**

1. Open Slack in a browser (`https://<workspace>.slack.com`) and sign in.
2. Open DevTools → **Application** → **Cookies** → `https://<workspace>.slack.com`.
3. Copy the value of the `d` cookie. It starts with `xoxd-`. This is `SLACK_XOXD_<SLUG>`.

**`xoxc` (client token, via Network tab)**

The Slack web app no longer stores `xoxc` in a predictable `localStorage` key, so grab it from a live request instead. This works regardless of Slack's client storage layout.

1. DevTools → **Network** tab. Filter for `api/`.
2. Click around in Slack to trigger traffic (switch channels, send a typing indicator, etc.).
3. Click any request to `/api/<method>` (e.g. `client.counts`, `conversations.history`).
4. In the request details, find **Payload** (or **Request** → **Form Data**). Look for the field named `token` — its value starts with `xoxc-`.
5. That value is `SLACK_XOXC_<SLUG>`.

Add both to `~/.config/openbrain/.env`:

```
SLACK_XOXC_DOROMIND_SLACK_COM=xoxc-...
SLACK_XOXD_DOROMIND_SLACK_COM=xoxd-...
```

Restart Claude Code (or reload MCPs) to pick up the new env.

## Usage

```bash
slack-mcp --slug doromind-slack-com
```
