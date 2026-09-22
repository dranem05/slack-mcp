import { WebClient } from "@slack/web-api";
import { memoizeWithTtl } from "./ttlCache.js";
import { isValidTimeZone } from "./searchWindow.js";

// The authenticated identity doesn't change for the life of a (one
// process per workspace) run, so we fetch it via auth.test() once and
// share the result across every tool that needs "who am I" (my_mentions,
// usergroups_me).
export function createIdentityLookup(client: WebClient): () => Promise<string> {
  return memoizeWithTtl(async () => {
    const res = await client.auth.test();
    if (!res.user_id) {
      throw new Error("Could not determine authenticated user ID from auth.test()");
    }
    return res.user_id;
  }, Infinity);
}

export interface TimezoneResolution {
  /** IANA timezone name, guaranteed to be one Intl recognizes. */
  tz: string;
  /** Where it came from. Anything but "slack" is a degraded answer. */
  source: "slack" | "env" | "system";
  /** Why the Slack lookup didn't supply it. Present iff source !== "slack". */
  error?: string;
}

/**
 * The authenticated user's timezone, as Slack itself would use it.
 *
 * Slack evaluates search date filters (`on:`, `after:`, `before:`) in the
 * *user's* timezone, not UTC and not the host's — so any tool deriving a
 * date from a timestamp has to ask Slack what that timezone is.
 *
 * Reports which source answered rather than degrading silently: a wrong
 * timezone shifts a search window by a day and looks exactly like a quiet
 * day in Slack.
 *
 * A successful lookup is memoized for the life of the process; a failure is
 * not, so a transient API error doesn't pin the process to the fallback.
 */
export function createTimezoneLookup(
  client: WebClient,
  getMyUserId: () => Promise<string>
): () => Promise<TimezoneResolution> {
  const fetchSlackTz = memoizeWithTtl(async () => {
    const userId = await getMyUserId();
    const res = await client.users.info({ user: userId });
    const tz = (res.user as { tz?: string } | undefined)?.tz;
    if (!tz) {
      throw new Error(`users.info returned no tz field for ${userId}`);
    }
    if (!isValidTimeZone(tz)) {
      throw new Error(`users.info returned an unrecognized tz "${tz}" for ${userId}`);
    }
    return tz;
  }, Infinity);

  return async () => {
    let reason: string;
    try {
      return { tz: await fetchSlackTz(), source: "slack" };
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    const envTz = process.env.TZ;
    if (isValidTimeZone(envTz)) {
      return {
        tz: envTz as string,
        source: "env",
        error: `Could not read the Slack user's timezone (${reason}); fell back to process.env.TZ.`,
      };
    }

    let systemTz: string | undefined;
    try {
      systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      systemTz = undefined;
    }
    if (isValidTimeZone(systemTz)) {
      return {
        tz: systemTz as string,
        source: "system",
        error: `Could not read the Slack user's timezone (${reason}); fell back to this host's timezone.`,
      };
    }

    return {
      tz: "UTC",
      source: "system",
      error: `Could not read the Slack user's timezone (${reason}) and this host reports no usable timezone; fell back to UTC. Date-filtered results may be off by a day.`,
    };
  };
}
