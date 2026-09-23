// Shared, declared-field-only building blocks for the coverage tools
// (slack_my_threads, slack_channel_digest). Nothing here reads message
// content to reach a verdict: every decision keys on a field Slack declares
// (user, ts, latest_reply, last_read, subscribed, reactions, users.info
// is_bot) or on a list the caller declares.

import { WebClient } from "@slack/web-api";
import { ValidationError } from "./validate.js";

export type Outcome = "CLEAN" | "FINDINGS" | "CANNOT_CHECK";

// Numeric view of a Slack ts. Undefined for anything that does not parse —
// callers must treat that as unknown, never as zero.
export function tsNumber(ts: string | undefined | null): number | undefined {
  if (typeof ts !== "string") return undefined;
  const n = parseFloat(ts);
  return Number.isFinite(n) ? n : undefined;
}

// `a` is strictly later than `b`. Undefined when either side is unreadable.
export function tsAfter(a: string | undefined, b: string | undefined): boolean | undefined {
  const x = tsNumber(a);
  const y = tsNumber(b);
  if (x === undefined || y === undefined) return undefined;
  return x > y;
}

// Parse a comma-separated id list param. Empty entries are dropped; the
// result is de-duplicated but keeps first-seen order.
export function parseIdList(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

interface ReactionShape {
  users?: unknown;
}

// Did `userId` react to this message? Keys on the declared `reactions[].users`
// arrays only. Note Slack caps `users` per reaction on very popular
// reactions; for "did I react" on a working thread that cap is not reached.
export function reactedBy(reactions: unknown, userId: string): boolean {
  if (!Array.isArray(reactions)) return false;
  return (reactions as ReactionShape[]).some(
    (r) => Array.isArray(r?.users) && (r.users as unknown[]).includes(userId)
  );
}

export const TEXT_PREVIEW_LIMIT = 200;

export function textPreview(text: unknown): { text?: string; truncated?: true } {
  if (typeof text !== "string") return {};
  return text.length > TEXT_PREVIEW_LIMIT
    ? { text: text.slice(0, TEXT_PREVIEW_LIMIT), truncated: true }
    : { text };
}

export type BotSource = "no_user" | "override" | "users.info";

export interface BotVerdict {
  is_bot: boolean;
  source: BotSource;
  /** users.info `name`, when the lookup ran. */
  name?: string;
}

export interface BotResolver {
  /** Throws when Slack could not say — the caller maps that to CANNOT-CHECK. */
  resolve(user: string | undefined): Promise<BotVerdict>;
  /** Distinct users.info calls made this run. */
  lookups(): number;
}

// The bot rule, in declared order:
//   1. no `user` on the message  → app/webhook post
//   2. `user` in the caller's declared override list → bot
//   3. otherwise Slack's own users.info(user).is_bot
// Cached per run (one resolver per tool call), one lookup per distinct user.
// A failed lookup rejects — it is never read as "human". `username` is never
// consulted: it is the handle for humans too.
export function createBotResolver(
  client: Pick<WebClient, "users">,
  overrideIds: Iterable<string>
): BotResolver {
  const override = new Set(overrideIds);
  const cache = new Map<string, Promise<BotVerdict>>();
  let lookups = 0;

  return {
    resolve(user) {
      if (!user) return Promise.resolve({ is_bot: true, source: "no_user" });
      if (override.has(user)) return Promise.resolve({ is_bot: true, source: "override" });
      let pending = cache.get(user);
      if (!pending) {
        lookups++;
        pending = (async () => {
          const res = await client.users.info({ user });
          const u = res.user as { is_bot?: unknown; name?: unknown } | undefined;
          if (typeof u?.is_bot !== "boolean") {
            throw new Error(`users.info(${user}) returned no is_bot field`);
          }
          return {
            is_bot: u.is_bot,
            source: "users.info" as const,
            ...(typeof u.name === "string" ? { name: u.name } : {}),
          };
        })();
        cache.set(user, pending);
      }
      return pending;
    },
    lookups: () => lookups,
  };
}

export function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const data = (err as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string") return data.error;
  }
  return err instanceof Error ? err.message : String(err);
}

export function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`concurrency must be a positive integer, got ${value}`);
  }
  return Math.min(value, 10);
}

export function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer, got ${value}`);
  }
  return value;
}

export function requirePositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive number, got ${value}`);
  }
  return value;
}

// Deterministic permalink construction (conversations.history/replies return
// none). `origin` is the workspace URL with or without a trailing slash.
export function buildPermalink(
  origin: string | undefined,
  channel: string,
  ts: string | undefined,
  rootTs?: string
): string | undefined {
  if (!origin || !ts) return undefined;
  const base = `${origin.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return rootTs && rootTs !== ts ? `${base}?thread_ts=${rootTs}&cid=${channel}` : base;
}
