import { describe, expect, it } from "vitest";
import {
  ValidationError,
  validateChannelId,
  validateUserId,
  validateTs,
  clampLimit,
  parseBlocksJson,
} from "../src/utils/validate.js";

describe("validateChannelId", () => {
  it("accepts well-formed channel, DM, group, and org-shared IDs", () => {
    expect(validateChannelId("C0123456")).toBe("C0123456");
    expect(validateChannelId("D0123456")).toBe("D0123456");
    expect(validateChannelId("G0123456")).toBe("G0123456");
    expect(validateChannelId("U0123456")).toBe("U0123456");
  });

  it("rejects a channel name like #general with a friendly hint", () => {
    expect(() => validateChannelId("#general")).toThrow(ValidationError);
    try {
      validateChannelId("#general");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/slack_channels_list/);
    }
  });

  it("rejects an empty string", () => {
    expect(() => validateChannelId("")).toThrow(ValidationError);
  });

  it("rejects an ID that's too short", () => {
    expect(() => validateChannelId("C123")).toThrow(ValidationError);
  });

  it("rejects lowercase IDs", () => {
    expect(() => validateChannelId("c0123456")).toThrow(ValidationError);
  });
});

describe("validateUserId", () => {
  it("accepts classic U-prefixed user IDs", () => {
    expect(validateUserId("U0123456")).toBe("U0123456");
  });

  it("accepts W-prefixed Enterprise Grid user IDs", () => {
    expect(validateUserId("W0123456789")).toBe("W0123456789");
  });

  it("rejects a channel ID with an error message about user IDs", () => {
    expect(() => validateUserId("C0123456")).toThrow(ValidationError);
    try {
      validateUserId("C0123456");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/user ID/);
      expect((err as Error).message).not.toMatch(/channel ID/);
    }
  });

  it("rejects an @handle with a friendly hint to look the user up", () => {
    expect(() => validateUserId("@erin")).toThrow(ValidationError);
    try {
      validateUserId("@erin");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/slack_users_search/);
    }
  });

  it("rejects an empty string and lowercase IDs", () => {
    expect(() => validateUserId("")).toThrow(ValidationError);
    expect(() => validateUserId("u0123456")).toThrow(ValidationError);
  });

  it("rejects an ID that's too short", () => {
    expect(() => validateUserId("U123")).toThrow(ValidationError);
  });
});

describe("validateTs", () => {
  it("accepts a well-formed Slack timestamp", () => {
    expect(validateTs("1234567890.123456")).toBe("1234567890.123456");
  });

  it("rejects a bare unix timestamp with no fractional part", () => {
    expect(() => validateTs("1234567890")).toThrow(ValidationError);
  });

  it("rejects a timestamp with the wrong number of fractional digits", () => {
    expect(() => validateTs("1234567890.123")).toThrow(ValidationError);
  });

  it("includes the field name in the error message when provided", () => {
    try {
      validateTs("bogus", "thread_ts");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/thread_ts/);
    }
  });
});

describe("clampLimit", () => {
  it("returns the value unchanged when within bounds", () => {
    expect(clampLimit(50, { max: 200 })).toBe(50);
  });

  it("clamps values above max down to max", () => {
    expect(clampLimit(500, { max: 200 })).toBe(200);
  });

  it("clamps values below min up to min", () => {
    expect(clampLimit(0, { max: 200, min: 1 })).toBe(1);
  });

  it("throws ValidationError for non-integer values", () => {
    expect(() => clampLimit(1.5, { max: 200 })).toThrow(ValidationError);
  });

  it("defaults min to 1 when not provided", () => {
    expect(clampLimit(-5, { max: 200 })).toBe(1);
  });
});

describe("parseBlocksJson", () => {
  it("parses a well-formed Block Kit JSON array", () => {
    const json = JSON.stringify([
      { type: "section", text: { type: "mrkdwn", text: "hi" } },
      { type: "divider" },
    ]);
    expect(parseBlocksJson(json)).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "hi" } },
      { type: "divider" },
    ]);
  });

  it("throws ValidationError with a helpful hint on invalid JSON", () => {
    try {
      parseBlocksJson("{not valid json");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/valid JSON/);
      expect((err as Error).message).toMatch(/section/);
    }
  });

  it("throws ValidationError when the parsed JSON isn't an array", () => {
    try {
      parseBlocksJson(JSON.stringify({ type: "section" }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/array/);
      expect((err as Error).message).toMatch(/section/);
    }
  });

  it("throws ValidationError when an array element has no string type field", () => {
    expect(() => parseBlocksJson(JSON.stringify([{ text: "no type" }]))).toThrow(
      ValidationError
    );
    expect(() => parseBlocksJson(JSON.stringify(["not an object"]))).toThrow(
      ValidationError
    );
    expect(() => parseBlocksJson(JSON.stringify([null]))).toThrow(ValidationError);
  });

  it("accepts an empty array", () => {
    expect(parseBlocksJson("[]")).toEqual([]);
  });
});
