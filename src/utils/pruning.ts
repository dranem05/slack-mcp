// Compaction helpers for tool output. Slack messages and drafts carry a lot
// of payload (blocks, attachments, thumbnail URLs, etc.) that's irrelevant
// noise for an LLM reading tool output — these functions cut each down to
// the handful of fields actually useful for a conversation/drafts workflow.

// Structural subset of @slack/web-api's MessageElement (history & replies
// each define their own near-identical copy of this type, so we don't
// import either directly — any object with at least these fields works).
export interface PruneableMessage {
  ts?: string;
  user?: string;
  // Bot-authored messages carry bot_id (and often a display username)
  // instead of user — without these a bot message prunes to authorless.
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: unknown;
  subtype?: string;
  files?: Array<{ name?: string }>;
}

export interface PrunedMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: unknown;
  subtype?: string;
  files?: string[];
}

export function pruneMessage(msg: PruneableMessage): PrunedMessage {
  const pruned: PrunedMessage = {
    ts: msg.ts,
    user: msg.user,
    bot_id: msg.bot_id,
    username: msg.username,
    text: msg.text,
    thread_ts: msg.thread_ts,
    reply_count: msg.reply_count,
    reactions: msg.reactions,
    subtype: msg.subtype,
  };

  const names = (msg.files ?? [])
    .map((f) => f.name)
    .filter((name): name is string => typeof name === "string");
  if (names.length > 0) {
    pruned.files = names;
  }

  return pruned;
}

export function pruneMessages(messages: readonly PruneableMessage[]): PrunedMessage[] {
  return messages.map(pruneMessage);
}

// conversations.replies only: also keep the thread read state when Slack
// sends it (never defaulted). history keeps pruneMessages unchanged.
const THREAD_STATE_KEYS = ["subscribed", "last_read", "latest_reply", "reply_users_count"] as const;

export function pruneReplies(messages: readonly PruneableMessage[]): Array<PrunedMessage & Record<string, unknown>> {
  return messages.map((m) => {
    const out: PrunedMessage & Record<string, unknown> = { ...pruneMessage(m) };
    for (const k of THREAD_STATE_KEYS) {
      const v = (m as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
}

export interface PrunedDraft {
  id?: unknown;
  last_updated_ts?: unknown;
  destination?: unknown;
  text?: string;
}

// drafts.list is an undocumented, internal Slack endpoint (see
// utils/browserApi.ts) — there's no published response schema. Field names
// below are inferred from what this codebase already knows about the
// request shape: drafts.create/editMessage send `destinations` and
// `blocks` (see services/drafts/index.ts), and the drafts.delete handler's
// comment confirms the draft's own timestamp field is `last_updated_ts`.
// If a live workspace's response uses entirely different keys, pruning
// would reduce every draft to all-undefined fields — output that looks
// successful but is empty. To guard against that, a draft where no known
// field matched is returned raw instead of pruned.
export function pruneDraft(
  raw: Record<string, unknown>
): PrunedDraft | Record<string, unknown> {
  const destinations = raw.destinations;
  const destination = Array.isArray(destinations) ? destinations[0] : destinations;

  const pruned: PrunedDraft = {
    id: raw.id,
    last_updated_ts: raw.last_updated_ts,
    destination,
    text: blocksToText(raw.blocks),
  };

  const allUnknown =
    pruned.id === undefined &&
    pruned.last_updated_ts === undefined &&
    pruned.destination === undefined &&
    pruned.text === undefined;

  return allUnknown ? raw : pruned;
}

export interface PrunedEmojiList {
  names: string[];
  aliases: Record<string, string>;
}

const ALIAS_PREFIX = "alias:";

// emoji.list returns a flat { name: value } map where custom emoji point to
// an image URL and aliases point to another emoji's name as "alias:target".
// Splitting those apart gives the model both the full set of usable names
// and, separately, which ones just redirect to another real emoji.
export function pruneEmojiList(
  emoji: Record<string, string> | undefined
): PrunedEmojiList {
  const names: string[] = [];
  const aliases: Record<string, string> = {};

  for (const [name, value] of Object.entries(emoji ?? {})) {
    names.push(name);
    if (value.startsWith(ALIAS_PREFIX)) {
      aliases[name] = value.slice(ALIAS_PREFIX.length);
    }
  }

  return { names, aliases };
}

// Structural subsets of users.info's User (with its nested Profile) and
// users.profile.get's Profile — any object with at least these fields works,
// so callers don't need to import the @slack/web-api response types here.
export interface UserInfoSource {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_admin?: boolean;
  tz?: string;
  profile?: ProfileGetSource;
}

export interface ProfileGetSource {
  display_name?: string;
  title?: string;
  email?: string;
  status_text?: string;
  status_emoji?: string;
}

export interface MergedUserInfo {
  id?: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  title?: string;
  email?: string;
  tz?: string;
  status_text?: string;
  status_emoji?: string;
  is_bot?: boolean;
  is_admin?: boolean;
}

// Merges users.info + users.profile.get into the handful of fields a
// conversation actually needs. The two calls' profile fields overlap almost
// entirely; users.profile.get's copy wins on conflict since it's the
// purpose-built endpoint for profile data, falling back to users.info's
// nested profile if the profile.get call didn't return a value (e.g. a
// missing scope or a bot user with no profile).
export function mergeUserInfo(
  user: UserInfoSource | undefined,
  profile: ProfileGetSource | undefined
): MergedUserInfo {
  return {
    id: user?.id,
    name: user?.name,
    real_name: user?.real_name,
    display_name: profile?.display_name ?? user?.profile?.display_name,
    title: profile?.title ?? user?.profile?.title,
    email: profile?.email ?? user?.profile?.email,
    tz: user?.tz,
    status_text: profile?.status_text ?? user?.profile?.status_text,
    status_emoji: profile?.status_emoji ?? user?.profile?.status_emoji,
    is_bot: user?.is_bot,
    is_admin: user?.is_admin,
  };
}

interface RichTextLeaf {
  type?: string;
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  range?: string;
}

// A block-level entry inside a rich_text block's `elements` array — a
// section (inline content), a list (nested sections, one per item), or a
// quote/preformatted block (inline-leaf content directly, no nesting).
// Structural subset of utils/mrkdwn.ts's own block element types, so this
// module doesn't need to import that file's internal types.
interface RichTextBlockElement {
  type?: string;
  elements?: Array<RichTextLeaf | RichTextBlockElement>;
}

interface RichTextBlock {
  type?: string;
  elements?: RichTextBlockElement[];
}

// Best-effort flatten of the rich_text block structure produced by
// utils/mrkdwn.ts's mrkdwnToBlocks back into a plain-text preview. Styling
// (bold/italic/code) is intentionally not reconstructed — this is a preview,
// not a round-trip. Lists render one item per line; quotes and code fences
// render as their inline text content.
function blocksToText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;

  const parts: string[] = [];
  for (const block of blocks as RichTextBlock[]) {
    if (block?.type !== "rich_text" || !Array.isArray(block.elements)) continue;
    for (const element of block.elements) {
      parts.push(blockElementToText(element));
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

function blockElementToText(element: RichTextBlockElement | undefined): string {
  if (!element || !Array.isArray(element.elements)) return "";

  if (element.type === "rich_text_list") {
    return element.elements
      .map((item) => blockElementToText(item as RichTextBlockElement))
      .join("\n");
  }

  // rich_text_section, rich_text_quote, and rich_text_preformatted all hold
  // inline leaves directly.
  return (element.elements as RichTextLeaf[]).map(leafToText).join("");
}

function leafToText(leaf: RichTextLeaf): string {
  switch (leaf.type) {
    case "text":
      return leaf.text ?? "";
    case "link":
      return leaf.text ?? leaf.url ?? "";
    case "user":
      return leaf.user_id ? `<@${leaf.user_id}>` : "";
    case "channel":
      return leaf.channel_id ? `<#${leaf.channel_id}>` : "";
    case "broadcast":
      return leaf.range ? `<!${leaf.range}>` : "";
    default:
      return "";
  }
}

// Structural subset covering both reminders.add's and reminders.list's
// Reminder response shapes (the SDK types them slightly differently per
// endpoint — reminders.add's omits `channel`).
export interface ReminderSource {
  id?: string;
  text?: string;
  time?: number;
  complete_ts?: number;
  recurring?: boolean;
  recurrence?: { frequency?: string; weekdays?: string[] };
  creator?: string;
  user?: string;
  channel?: string;
}

export interface PrunedReminder {
  id?: string;
  text?: string;
  time?: number;
  complete_ts?: number;
  recurring?: boolean;
  recurrence?: { frequency?: string; weekdays?: string[] };
  creator?: string;
  user?: string;
  channel?: string;
}

export function pruneReminder(reminder: ReminderSource): PrunedReminder {
  return {
    id: reminder.id,
    text: reminder.text,
    time: reminder.time,
    complete_ts: reminder.complete_ts,
    recurring: reminder.recurring,
    recurrence: reminder.recurrence,
    creator: reminder.creator,
    user: reminder.user,
    channel: reminder.channel,
  };
}

export function pruneReminders(reminders: readonly ReminderSource[]): PrunedReminder[] {
  return reminders.map(pruneReminder);
}

// pins.list's real response includes `channel` and (for message pins) a
// nested `message` object, but @slack/web-api's PinsListResponse['Item']
// type doesn't model either — so this is our own structural type rather
// than an import, same reasoning as PruneableMessage above.
export interface PinnedItemSource {
  type?: string;
  created?: number;
  created_by?: string;
  channel?: string;
  message?: { ts?: string; text?: string; user?: string };
  file?: { id?: string; name?: string; title?: string };
}

export interface PrunedPinnedItem {
  type?: string;
  created?: number;
  created_by?: string;
  channel?: string;
  ts?: string;
  text?: string;
  file_name?: string;
}

export function prunePinnedItem(item: PinnedItemSource): PrunedPinnedItem {
  const pruned: PrunedPinnedItem = {
    type: item.type,
    created: item.created,
    created_by: item.created_by,
    channel: item.channel,
  };
  if (item.message) {
    pruned.ts = item.message.ts;
    pruned.text = item.message.text;
  }
  if (item.file) {
    pruned.file_name = item.file.name;
  }
  return pruned;
}

export function prunePinnedItems(items: readonly PinnedItemSource[]): PrunedPinnedItem[] {
  return items.map(prunePinnedItem);
}

// Structural subset of bookmarks.list's Bookmark response.
export interface BookmarkSource {
  id?: string;
  title?: string;
  link?: string;
  emoji?: string;
  type?: string;
  channel_id?: string;
  date_created?: number;
}

export interface PrunedBookmark {
  id?: string;
  title?: string;
  link?: string;
  emoji?: string;
  type?: string;
  channel_id?: string;
  date_created?: number;
}

export function pruneBookmark(bookmark: BookmarkSource): PrunedBookmark {
  return {
    id: bookmark.id,
    title: bookmark.title,
    link: bookmark.link,
    emoji: bookmark.emoji,
    type: bookmark.type,
    channel_id: bookmark.channel_id,
    date_created: bookmark.date_created,
  };
}

export function pruneBookmarks(bookmarks: readonly BookmarkSource[]): PrunedBookmark[] {
  return bookmarks.map(pruneBookmark);
}

// Structural subset of conversations.info's Channel response.
export interface ChannelInfoSource {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_general?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  num_members?: number;
  created?: number;
  creator?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface PrunedChannelInfo {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_general?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  num_members?: number;
  created?: number;
  creator?: string;
  topic?: string;
  purpose?: string;
}

export function pruneChannelInfo(channel: ChannelInfoSource): PrunedChannelInfo {
  return {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_archived: channel.is_archived,
    is_member: channel.is_member,
    is_general: channel.is_general,
    is_im: channel.is_im,
    is_mpim: channel.is_mpim,
    num_members: channel.num_members,
    created: channel.created,
    creator: channel.creator,
    topic: channel.topic?.value,
    purpose: channel.purpose?.value,
  };
}

// Structural subset of the File objects nested inside files.uploadV2's
// response (itself an array of files.completeUploadExternal-shaped groups,
// each with its own nested `files` array — see file-upload.d.ts).
export interface UploadedFileSource {
  id?: string;
  name?: string;
  title?: string;
  filetype?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
}

export interface PrunedUploadedFile {
  id?: string;
  name?: string;
  title?: string;
  filetype?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
}

export function pruneUploadedFile(file: UploadedFileSource): PrunedUploadedFile {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    filetype: file.filetype,
    mimetype: file.mimetype,
    size: file.size,
    permalink: file.permalink,
  };
}

export function pruneUploadedFiles(files: readonly UploadedFileSource[]): PrunedUploadedFile[] {
  return files.map(pruneUploadedFile);
}
