import { describe, expect, it } from "vitest";
import {
  pruneMessage,
  pruneMessages,
  pruneDraft,
  pruneEmojiList,
  mergeUserInfo,
  pruneReminder,
  pruneReminders,
  prunePinnedItem,
  prunePinnedItems,
  pruneBookmark,
  pruneBookmarks,
  pruneChannelInfo,
  pruneUploadedFile,
  pruneUploadedFiles,
} from "../src/utils/pruning.js";

describe("pruneMessage", () => {
  it("keeps only the compact fields", () => {
    const raw = {
      ts: "1234567890.123456",
      user: "U123",
      text: "hello",
      thread_ts: "1234567890.000001",
      reply_count: 3,
      reactions: [{ name: "thumbsup", count: 2, users: ["U1", "U2"] }],
      subtype: "bot_message",
      // Fields that should be dropped entirely:
      blocks: [{ type: "rich_text" }],
      attachments: [{ text: "unfurled" }],
      client_msg_id: "abc-123",
    };

    expect(pruneMessage(raw)).toEqual({
      ts: "1234567890.123456",
      user: "U123",
      text: "hello",
      thread_ts: "1234567890.000001",
      reply_count: 3,
      reactions: [{ name: "thumbsup", count: 2, users: ["U1", "U2"] }],
      subtype: "bot_message",
    });
  });

  it("reduces files down to just their names", () => {
    const raw = {
      ts: "1234567890.123456",
      files: [
        { id: "F1", name: "report.pdf", url_private: "https://example.com/report.pdf" },
        { id: "F2", name: "notes.txt" },
      ],
    };

    const pruned = pruneMessage(raw);
    expect(pruned.files).toEqual(["report.pdf", "notes.txt"]);
    expect(pruned).not.toHaveProperty("url_private");
  });

  it("omits the files key entirely when there are no files", () => {
    const pruned = pruneMessage({ ts: "1234567890.123456" });
    expect(pruned).not.toHaveProperty("files");
  });

  it("drops files with no name rather than emitting undefined placeholders", () => {
    const pruned = pruneMessage({
      ts: "1",
      files: [{ id: "F1" }, { id: "F2", name: "keep.png" }],
    });
    expect(pruned.files).toEqual(["keep.png"]);
  });

  it("pruneMessages maps over an array preserving order", () => {
    const pruned = pruneMessages([{ ts: "1" }, { ts: "2" }]);
    expect(pruned.map((m) => m.ts)).toEqual(["1", "2"]);
  });

  it("keeps bot_id and username so bot messages aren't authorless", () => {
    const pruned = pruneMessage({
      ts: "1234567890.123456",
      text: "deploy finished",
      subtype: "bot_message",
      bot_id: "B0123456",
      username: "deploybot",
    });

    expect(pruned.bot_id).toBe("B0123456");
    expect(pruned.username).toBe("deploybot");
    expect(pruned.user).toBeUndefined();
  });
});

describe("pruneDraft", () => {
  it("extracts id, last_updated_ts, and destination", () => {
    const raw = {
      id: "draft-1",
      last_updated_ts: "1700000000.000000",
      destinations: [{ channel_id: "C123", thread_ts: "1699999999.000000" }],
      blocks: [],
    };

    const pruned = pruneDraft(raw);
    expect(pruned.id).toBe("draft-1");
    expect(pruned.last_updated_ts).toBe("1700000000.000000");
    expect(pruned.destination).toEqual({ channel_id: "C123", thread_ts: "1699999999.000000" });
  });

  it("flattens rich_text blocks into a plain-text preview", () => {
    const raw = {
      id: "draft-2",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Hello " },
                { type: "user", user_id: "U123" },
                { type: "text", text: "!" },
              ],
            },
          ],
        },
      ],
    };

    const pruned = pruneDraft(raw);
    expect(pruned.text).toBe("Hello <@U123>!");
  });

  it("returns undefined text when there are no blocks", () => {
    const pruned = pruneDraft({ id: "draft-3" });
    expect(pruned.text).toBeUndefined();
  });

  it("flattens a rich_text_list into one line per item", () => {
    const raw = {
      id: "draft-list",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
                { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
      ],
    };

    expect(pruneDraft(raw).text).toBe("one\ntwo");
  });

  it("flattens rich_text_quote and rich_text_preformatted content", () => {
    const raw = {
      id: "draft-mixed",
      blocks: [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_quote", elements: [{ type: "text", text: "quoted" }] },
            { type: "rich_text_preformatted", elements: [{ type: "text", text: "code();" }] },
          ],
        },
      ],
    };

    expect(pruneDraft(raw).text).toBe("quotedcode();");
  });

  it("passes through a bare destinations object that isn't wrapped in an array", () => {
    const pruned = pruneDraft({ id: "draft-4", destinations: { channel_id: "C1" } });
    expect(pruned.destination).toEqual({ channel_id: "C1" });
  });

  it("falls back to the raw draft when none of the known fields are present", () => {
    // drafts.list is undocumented — if Slack's real field names differ from
    // our inferred ones, pruning every field to undefined would silently
    // destroy the output. Unknown shapes must pass through unchanged.
    const raw = { draft_uuid: "abc", ts_updated: "123", body: "hello" };
    expect(pruneDraft(raw)).toBe(raw);
  });

  it("still prunes when at least one known field is present", () => {
    const pruned = pruneDraft({ id: "draft-5", unknown_field: "x" });
    expect(pruned).toEqual({
      id: "draft-5",
      last_updated_ts: undefined,
      destination: undefined,
      text: undefined,
    });
    expect(pruned).not.toHaveProperty("unknown_field");
  });
});

describe("pruneEmojiList", () => {
  it("splits emoji.list's flat name->value map into names and alias targets", () => {
    const raw = {
      party_parrot: "https://emoji.slack-edge.com/T1/party_parrot/abc.gif",
      partyparrot: "alias:party_parrot",
      thumbsup_all: "alias:thumbsup",
    };

    expect(pruneEmojiList(raw)).toEqual({
      names: ["party_parrot", "partyparrot", "thumbsup_all"],
      aliases: {
        partyparrot: "party_parrot",
        thumbsup_all: "thumbsup",
      },
    });
  });

  it("returns an empty result for an empty or missing emoji map", () => {
    expect(pruneEmojiList({})).toEqual({ names: [], aliases: {} });
    expect(pruneEmojiList(undefined)).toEqual({ names: [], aliases: {} });
  });

  it("omits the aliases key content when there are no aliases", () => {
    const pruned = pruneEmojiList({ custom_one: "https://example.com/1.png" });
    expect(pruned.names).toEqual(["custom_one"]);
    expect(pruned.aliases).toEqual({});
  });
});

describe("mergeUserInfo", () => {
  it("prefers users.profile.get's fields, falling back to users.info's nested profile", () => {
    const user = {
      id: "U123",
      name: "dchang",
      real_name: "David Chang",
      is_bot: false,
      is_admin: true,
      tz: "America/Los_Angeles",
      profile: {
        display_name: "erin (info)",
        title: "Engineer (info)",
        email: "erin@example.com",
        status_text: "in a meeting",
        status_emoji: ":calendar:",
      },
    };
    const profile = {
      display_name: "erin",
      title: "Staff Engineer",
      email: "erin@example.com",
      status_text: "in a meeting",
      status_emoji: ":calendar:",
    };

    expect(mergeUserInfo(user, profile)).toEqual({
      id: "U123",
      name: "dchang",
      real_name: "David Chang",
      display_name: "erin",
      title: "Staff Engineer",
      email: "erin@example.com",
      tz: "America/Los_Angeles",
      status_text: "in a meeting",
      status_emoji: ":calendar:",
      is_bot: false,
      is_admin: true,
    });
  });

  it("falls back to users.info's nested profile when users.profile.get returned nothing", () => {
    const user = {
      id: "U456",
      profile: { display_name: "fallback-name", title: "fallback-title" },
    };

    const merged = mergeUserInfo(user, undefined);
    expect(merged.display_name).toBe("fallback-name");
    expect(merged.title).toBe("fallback-title");
  });

  it("handles both sources being undefined without throwing", () => {
    expect(mergeUserInfo(undefined, undefined)).toEqual({
      id: undefined,
      name: undefined,
      real_name: undefined,
      display_name: undefined,
      title: undefined,
      email: undefined,
      tz: undefined,
      status_text: undefined,
      status_emoji: undefined,
      is_bot: undefined,
      is_admin: undefined,
    });
  });
});

describe("pruneReminder", () => {
  it("keeps the compact reminder fields", () => {
    const raw = {
      id: "Rm1",
      text: "stand up",
      time: 1700000000,
      complete_ts: 0,
      recurring: true,
      recurrence: { frequency: "daily" },
      creator: "U1",
      user: "U1",
      channel: "C1",
      // Extraneous field a real response might carry:
      team: "T1",
    };

    expect(pruneReminder(raw)).toEqual({
      id: "Rm1",
      text: "stand up",
      time: 1700000000,
      complete_ts: 0,
      recurring: true,
      recurrence: { frequency: "daily" },
      creator: "U1",
      user: "U1",
      channel: "C1",
    });
  });

  it("pruneReminders maps over an array preserving order", () => {
    const pruned = pruneReminders([{ id: "1" }, { id: "2" }]);
    expect(pruned.map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("prunePinnedItem", () => {
  it("extracts ts/text for a message pin", () => {
    const raw = {
      type: "message",
      created: 123,
      created_by: "U1",
      channel: "C1",
      message: { ts: "1.1", text: "hello", user: "U1" },
    };

    expect(prunePinnedItem(raw)).toEqual({
      type: "message",
      created: 123,
      created_by: "U1",
      channel: "C1",
      ts: "1.1",
      text: "hello",
    });
  });

  it("extracts just the file name for a file pin", () => {
    const raw = {
      type: "file",
      created: 123,
      created_by: "U1",
      channel: "C1",
      file: { id: "F1", name: "report.pdf", title: "Report" },
    };

    const pruned = prunePinnedItem(raw);
    expect(pruned.file_name).toBe("report.pdf");
    expect(pruned).not.toHaveProperty("ts");
  });

  it("prunePinnedItems maps over an array preserving order", () => {
    const pruned = prunePinnedItems([{ type: "message" }, { type: "file" }]);
    expect(pruned.map((p) => p.type)).toEqual(["message", "file"]);
  });
});

describe("pruneBookmark", () => {
  it("keeps the compact bookmark fields", () => {
    const raw = {
      id: "Bk1",
      title: "Runbook",
      link: "https://example.com/runbook",
      emoji: ":book:",
      type: "link",
      channel_id: "C1",
      date_created: 1700000000,
      // Extraneous field a real response might carry:
      last_updated_by_user_id: "U9",
    };

    expect(pruneBookmark(raw)).toEqual({
      id: "Bk1",
      title: "Runbook",
      link: "https://example.com/runbook",
      emoji: ":book:",
      type: "link",
      channel_id: "C1",
      date_created: 1700000000,
    });
  });

  it("pruneBookmarks maps over an array preserving order", () => {
    const pruned = pruneBookmarks([{ id: "1" }, { id: "2" }]);
    expect(pruned.map((b) => b.id)).toEqual(["1", "2"]);
  });
});

describe("pruneChannelInfo", () => {
  it("flattens topic/purpose to their string value and keeps the compact fields", () => {
    const raw = {
      id: "C1",
      name: "general",
      is_private: false,
      is_archived: false,
      is_member: true,
      is_general: true,
      is_im: false,
      is_mpim: false,
      num_members: 42,
      created: 1700000000,
      creator: "U1",
      topic: { value: "the topic", creator: "U1", last_set: 1 },
      purpose: { value: "the purpose", creator: "U1", last_set: 1 },
      // Extraneous fields a real response might carry:
      shared_team_ids: ["T1"],
      previous_names: ["old-name"],
    };

    expect(pruneChannelInfo(raw)).toEqual({
      id: "C1",
      name: "general",
      is_private: false,
      is_archived: false,
      is_member: true,
      is_general: true,
      is_im: false,
      is_mpim: false,
      num_members: 42,
      created: 1700000000,
      creator: "U1",
      topic: "the topic",
      purpose: "the purpose",
    });
  });

  it("handles missing topic/purpose without throwing", () => {
    expect(pruneChannelInfo({ id: "C1" }).topic).toBeUndefined();
    expect(pruneChannelInfo({ id: "C1" }).purpose).toBeUndefined();
  });
});

describe("pruneUploadedFile", () => {
  it("keeps the compact file fields", () => {
    const raw = {
      id: "F1",
      name: "report.pdf",
      title: "Report",
      filetype: "pdf",
      mimetype: "application/pdf",
      size: 1234,
      permalink: "https://example.com/files/F1",
      // Extraneous fields a real response might carry:
      url_private: "https://example.com/private/F1",
      thumb_360: "https://example.com/thumb/F1",
    };

    expect(pruneUploadedFile(raw)).toEqual({
      id: "F1",
      name: "report.pdf",
      title: "Report",
      filetype: "pdf",
      mimetype: "application/pdf",
      size: 1234,
      permalink: "https://example.com/files/F1",
    });
  });

  it("pruneUploadedFiles maps over an array preserving order", () => {
    const pruned = pruneUploadedFiles([{ id: "1" }, { id: "2" }]);
    expect(pruned.map((f) => f.id)).toEqual(["1", "2"]);
  });
});
