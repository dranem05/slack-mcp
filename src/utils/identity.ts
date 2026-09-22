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
  /**
   * A timezone Intl recognizes. Usually an IANA zone name — but Intl also
   * accepts fixed offsets ("+05:30") and legacy abbreviations ("EST"), and a
   * value taken from process.env.TZ can be either, so downstream code must
   * not assume a full IANA zone with DST rules.
   */
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
 * A successful lookup is memoized for the life of the process, so a
 * transient API error never pins the process to the fallback. A failure is
 * cached only briefly (FAILURE_TTL_MS): long enough that a persistent
 * problem — a token without `users:read`, a rate-limited workspace — doesn't
 * re-pay the WebClient's retry budget on every single call, short enough
 * that recovery is picked up on its own.
 */
export const FAILURE_TTL_MS = 60_000;

export function createTimezoneLookup(
  client: WebClient,
  getMyUserId: () => Promise<string>,
  now: () => number = Date.now
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

  let lastFailure: { at: number; resolution: TimezoneResolution } | undefined;

  return async () => {
    if (lastFailure && now() - lastFailure.at < FAILURE_TTL_MS) {
      return lastFailure.resolution;
    }

    let reason: string;
    try {
      const resolved = { tz: await fetchSlackTz(), source: "slack" as const };
      lastFailure = undefined;
      return resolved;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    const degraded = (resolution: TimezoneResolution): TimezoneResolution => {
      lastFailure = { at: now(), resolution };
      return resolution;
    };

    const envTz = process.env.TZ;
    if (isValidTimeZone(envTz)) {
      return degraded({
        tz: envTz as string,
        source: "env",
        error: `Could not read the Slack user's timezone (${reason}); fell back to process.env.TZ.`,
      });
    }

    let systemTz: string | undefined;
    try {
      systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      systemTz = undefined;
    }
    if (isValidTimeZone(systemTz)) {
      return degraded({
        tz: systemTz as string,
        source: "system",
        error: `Could not read the Slack user's timezone (${reason}); fell back to this host's timezone.`,
      });
    }

    return degraded({
      tz: "UTC",
      source: "system",
      error: `Could not read the Slack user's timezone (${reason}) and this host reports no usable timezone; fell back to UTC.`,
    });
  };
}
