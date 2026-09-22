import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdentityLookup,
  createTimezoneLookup,
  FAILURE_TTL_MS,
} from "../src/utils/identity.js";

function fakeClient(userId: string | undefined) {
  const authTest = vi.fn(async () => ({ ok: true, user_id: userId }));
  return { auth: { test: authTest } };
}

describe("createIdentityLookup", () => {
  it("resolves the authenticated user id", async () => {
    const client = fakeClient("U123");
    const getMyUserId = createIdentityLookup(client as never);
    expect(await getMyUserId()).toBe("U123");
  });

  it("memoizes across calls — auth.test is only invoked once per process", async () => {
    const client = fakeClient("U123");
    const getMyUserId = createIdentityLookup(client as never);

    await getMyUserId();
    await getMyUserId();
    await getMyUserId();

    expect(client.auth.test).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when auth.test doesn't return a user_id", async () => {
    const client = fakeClient(undefined);
    const getMyUserId = createIdentityLookup(client as never);
    await expect(getMyUserId()).rejects.toThrow(/user ID/);
  });
});

function fakeTzClient(user: unknown, opts: { fail?: boolean } = {}) {
  const info = vi.fn(async () => {
    if (opts.fail) {
      throw new Error("An API error occurred: ratelimited");
    }
    return { ok: true, user };
  });
  return { users: { info } };
}

const getMyUserId = async () => "U123";

describe("createTimezoneLookup", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("returns the Slack-reported timezone and says so", async () => {
    const client = fakeTzClient({ tz: "America/New_York" });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    expect(await getMyTimezone()).toEqual({
      tz: "America/New_York",
      source: "slack",
    });
  });

  it("memoizes a successful lookup — users.info is only invoked once", async () => {
    const client = fakeTzClient({ tz: "America/New_York" });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    await getMyTimezone();
    await getMyTimezone();

    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("falls back to process.env.TZ and reports the degradation explicitly", async () => {
    process.env.TZ = "Asia/Tokyo";
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    const res = await getMyTimezone();
    expect(res.tz).toBe("Asia/Tokyo");
    expect(res.source).toBe("env");
    expect(res.error).toMatch(/ratelimited/);
  });

  it("never returns a degraded timezone without an error explaining it", async () => {
    process.env.TZ = "Asia/Tokyo";
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    const res = await getMyTimezone();
    expect(res.source === "slack" || !!res.error).toBe(true);
  });

  it("treats a missing tz field as a failure rather than a blank answer", async () => {
    const client = fakeTzClient({ name: "example-user" });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    const res = await getMyTimezone();
    expect(res.source).not.toBe("slack");
    expect(res.error).toMatch(/no tz field/);
  });

  it("rejects a tz string Intl doesn't recognize", async () => {
    const client = fakeTzClient({ tz: "Mars/Olympus_Mons" });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    const res = await getMyTimezone();
    expect(res.source).not.toBe("slack");
    expect(res.error).toMatch(/unrecognized tz/);
  });

  it("falls through an unusable process.env.TZ to the host timezone", async () => {
    process.env.TZ = "Mars/Olympus_Mons";
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId);

    const res = await getMyTimezone();
    expect(res.source).toBe("system");
    expect(res.error).toBeTruthy();
  });

  it("does not cache a failure past its short TTL — a later success still wins", async () => {
    let fail = true;
    let t = 0;
    const client = {
      users: {
        info: vi.fn(async () => {
          if (fail) throw new Error("An API error occurred: ratelimited");
          return { ok: true, user: { tz: "America/New_York" } };
        }),
      },
    };
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId, () => t);

    expect((await getMyTimezone()).source).not.toBe("slack");
    fail = false;
    t += FAILURE_TTL_MS;
    expect(await getMyTimezone()).toEqual({
      tz: "America/New_York",
      source: "slack",
    });
  });

  it("caches a failure briefly, so a persistent outage doesn't re-pay the retry budget every call", async () => {
    let t = 0;
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId, () => t);

    await getMyTimezone();
    t += FAILURE_TTL_MS - 1;
    await getMyTimezone();
    await getMyTimezone();

    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("retries once the failure TTL has elapsed", async () => {
    let t = 0;
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId, () => t);

    await getMyTimezone();
    t += FAILURE_TTL_MS;
    await getMyTimezone();

    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  it("still explains the degradation on a TTL-cached failure", async () => {
    let t = 0;
    process.env.TZ = "Asia/Tokyo";
    const client = fakeTzClient(undefined, { fail: true });
    const getMyTimezone = createTimezoneLookup(client as never, getMyUserId, () => t);

    await getMyTimezone();
    t += 1;
    const cached = await getMyTimezone();
    expect(cached.source).toBe("env");
    expect(cached.error).toMatch(/ratelimited/);
  });
});
