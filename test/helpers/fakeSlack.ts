// Fake WebClient for the coverage tools. Every endpoint is a vi.fn so tests
// can assert call counts; any entry given as an Error is thrown, which is how
// the failure directions are driven.
import { vi } from "vitest";

export type Msg = Record<string, unknown>;

export interface FakeSlackOptions {
  /** search.messages pages for queries starting "from:" (threads scope). */
  threadPages?: Msg[][];
  /** search.messages pages for queries starting "is:dm". */
  dmPages?: Msg[][];
  /** Replace search.messages entirely. */
  search?: (args: { query: string; page?: number }) => Promise<unknown>;
  /** conversations.replies keyed by `${channel}|${ts}`. */
  replies?: Record<string, Msg[] | Error>;
  /** conversations.info keyed by channel id. */
  info?: Record<string, Msg | Error>;
  /** conversations.history keyed by channel id. */
  history?: Record<string, { messages: Msg[]; has_more?: boolean } | Error>;
  /** users.info keyed by user id. */
  users?: Record<string, Msg | Error>;
  teamUrl?: string;
  /**
   * Which replies conversations.replies returns under `limit` when asked for
   * a thread root. Live Slack (verified 2026-09-22, limit 2 and 3 on
   * reply_count 10/12 threads) returns the parent plus the LATEST `limit`
   * replies — "latest" models that. "oldest" models the documented-looking
   * alternative so tests can prove the pipeline fails safe if Slack changes.
   */
  repliesWindow?: "latest" | "oldest";
}

export function fakeSlack(o: FakeSlackOptions = {}) {
  const pageOf = (pages: Msg[][] | undefined, page: number) => {
    const all = pages ?? [[]];
    const matches = all[page - 1] ?? [];
    return {
      ok: true,
      messages: {
        total: all.reduce((n, p) => n + p.length, 0),
        matches: structuredClone(matches),
        paging: { count: 100, total: all.reduce((n, p) => n + p.length, 0), page, pages: all.length },
      },
    };
  };
  const lookup = <T>(table: Record<string, T | Error> | undefined, key: string, what: string): T => {
    const v = table?.[key];
    if (v instanceof Error) throw v;
    if (v === undefined) {
      const err = new Error(`An API error occurred: ${what}`) as Error & { data?: unknown };
      err.data = { error: what };
      throw err;
    }
    return structuredClone(v);
  };

  return {
    search: {
      messages: vi.fn(async (args: { query: string; page?: number }) => {
        if (o.search) return o.search(args);
        const page = args.page ?? 1;
        if (args.query.startsWith("from:")) return pageOf(o.threadPages, page);
        if (args.query.startsWith("is:dm")) return pageOf(o.dmPages, page);
        return pageOf([[]], page);
      }),
    },
    conversations: {
      replies: vi.fn(async ({ channel, ts, limit }: { channel: string; ts: string; limit?: number }) => {
        const all = lookup(o.replies, `${channel}|${ts}`, "thread_not_found");
        const [parent, ...rest] = all;
        if (limit === undefined || parent?.ts !== ts || rest.length <= limit) {
          return { ok: true, messages: all, has_more: false };
        }
        const window = (o.repliesWindow ?? "latest") === "latest" ? rest.slice(-limit) : rest.slice(0, limit);
        return { ok: true, messages: [parent, ...window], has_more: true };
      }),
      info: vi.fn(async ({ channel }: { channel: string }) => ({
        ok: true,
        channel: lookup(o.info, channel, "channel_not_found"),
      })),
      history: vi.fn(async ({ channel, limit }: { channel: string; limit?: number }) => {
        const h = lookup(o.history, channel, "channel_not_found");
        // history is newest-first; honor limit the way Slack does.
        const truncated = limit !== undefined && h.messages.length > limit;
        return {
          ok: true,
          messages: truncated ? h.messages.slice(0, limit) : h.messages,
          has_more: truncated || (h.has_more ?? false),
        };
      }),
    },
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        ok: true,
        user: lookup(o.users, user, "user_not_found"),
      })),
    },
    auth: {
      test: vi.fn(async () => ({ ok: true, url: o.teamUrl ?? "https://acme.slack.com/", user_id: "U0SELF00001" })),
    },
  };
}
