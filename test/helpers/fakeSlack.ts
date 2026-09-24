// Fake WebClient for slack_my_threads. Any table entry given as an Error is
// thrown, which drives the failure directions.
import { vi } from "vitest";

export type Msg = Record<string, unknown>;

export interface FakeSlackOptions {
  /** search pages by scope, keyed on the query prefix. */
  threads?: Msg[][];
  dms?: Msg[][];
  mentions?: Msg[][];
  searchError?: Partial<Record<"threads" | "dms" | "mentions", Error>>;
  /** Whole thread (parent first) or a lone message, keyed `${channel}|${ts}`. */
  replies?: Record<string, Msg[] | Error>;
  info?: Record<string, Msg | Error>;
  users?: Record<string, Msg | Error>;
}

export function fakeSlack(o: FakeSlackOptions = {}) {
  const lookup = <T>(table: Record<string, T | Error> | undefined, key: string, code: string): T => {
    const v = table?.[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw Object.assign(new Error(code), { data: { error: code } });
    return structuredClone(v);
  };
  const scopeOf = (q: string) => (q.startsWith("from:") ? "threads" : q.startsWith("is:dm") ? "dms" : "mentions");
  return {
    search: {
      messages: vi.fn(async ({ query, page = 1 }: { query: string; page?: number }) => {
        const s = scopeOf(query);
        if (o.searchError?.[s]) throw o.searchError[s];
        const pages = o[s] ?? [[]];
        const total = pages.reduce((n, p) => n + p.length, 0);
        return { ok: true, messages: { total, matches: structuredClone(pages[page - 1] ?? []), paging: { count: 100, total, page, pages: pages.length } } };
      }),
    },
    conversations: {
      // Live Slack: replies(root, limit N) = the parent plus the LATEST N
      // replies (not contiguous with the parent when cut).
      replies: vi.fn(async ({ channel, ts, limit }: { channel: string; ts: string; limit?: number }) => {
        const all = lookup(o.replies, `${channel}|${ts}`, "thread_not_found");
        const [parent, ...rest] = all;
        if (limit === undefined || rest.length <= limit) return { ok: true, messages: all, has_more: false };
        return { ok: true, messages: [parent, ...rest.slice(-limit)], has_more: true };
      }),
      info: vi.fn(async ({ channel }: { channel: string }) => ({ ok: true, channel: lookup(o.info, channel, "channel_not_found") })),
    },
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({ ok: true, user: lookup(o.users, user, "user_not_found") })),
    },
  };
}
