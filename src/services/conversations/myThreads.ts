// slack_my_threads: units (a channel thread, a DM thread, or a DM's main line)
// where a reply may be owed. Verdicts read declared fields only: `user`,
// `ts`, `reply_count`, `latest_reply`, `last_read`, `reactions[].users`,
// users.info `is_bot`, and the caller's bot/clearing lists. Anything that
// cannot be read is CANNOT-CHECK with a reason, never a quiet omission.
import type { WebClient } from "@slack/web-api";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import { searchWindow, trimToWindow } from "../../utils/searchWindow.js";

export type Scope = "threads" | "dms" | "mentions";
export interface MyThreadsParams {
  scope: Scope | "both";
  days: number;
  horizon_days: number;
  max_units: number;
  bot_user_ids?: string;
  clearing_reactions?: string;
}
type Client = Pick<WebClient, "search" | "conversations" | "users">;
type Msg = { ts?: string; user?: string; username?: string; text?: string; reply_count?: number; latest_reply?: string; last_read?: string; reactions?: unknown };
type Match = { ts?: string; permalink?: string; channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; user?: string } };
interface Candidate { scope: Scope; channel_id: string; channel_name?: string; root_ts?: string; declared: boolean; ts: string; im_user?: string; origin: string }
interface Cannot { scope: Scope; reason: string; channel_id?: string; ts?: string }

export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
const SYSTEM_USERS = new Set(["USLACKBOT", "USLACK"]); // users.info calls these human
export const RESIDUAL_GAP =
  "Threads the user was only mentioned in are covered for `days`; threads the user last posted in before `horizon_days` are not enumerable.";

const num = (ts: string | undefined) => parseFloat(ts ?? "");
const list = (s: string | undefined) => new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const errMsg = (e: unknown) => (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.message : String(e));

// All pages, newest first, until the floor is crossed or pages run out.
async function walk(client: Client, query: string, floorSeconds: number) {
  const kept: Match[] = [];
  let trimmed = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.search.messages({ query, count: PAGE_SIZE, sort: "timestamp", sort_dir: "desc", page });
    const raw = res.messages?.matches;
    if (!Array.isArray(raw)) throw new Error(`page ${page}: search returned no matches array`);
    const t = trimToWindow(raw as Match[], floorSeconds);
    kept.push(...t.kept);
    trimmed += t.trimmed_out;
    const pages = res.messages?.paging?.pages;
    if (t.trimmed_out > 0 || (typeof pages === "number" ? page >= pages : raw.length < PAGE_SIZE)) {
      return { kept, trimmed, page_capped: false };
    }
  }
  return { kept, trimmed, page_capped: true };
}

export async function runMyThreads(client: Client, me: string, p: MyThreadsParams, nowMs = Date.now()) {
  const scopes: Scope[] = p.scope === "both" ? ["threads", "dms", "mentions"] : [p.scope];
  const overrides = list(p.bot_user_ids);
  const clearing = list(p.clearing_reactions);
  const cannot: Cannot[] = [];
  const coverage: Record<string, Record<string, unknown>> = {};
  const units = new Map<string, Candidate>();
  const perScope: Record<string, Candidate[]> = {};
  const awaiting = new Set<string>();
  const query: Record<Scope, [string, number]> = {
    threads: [`from:<@${me}>`, p.horizon_days],
    dms: ["is:dm", p.days],
    mentions: [`<@${me}>`, p.days],
  };

  const searches = await Promise.allSettled(
    scopes.map(async (s) => {
      const w = searchWindow(query[s][1] * 24, nowMs);
      return { w, ...(await walk(client, `${query[s][0]} after:${w.slack_after}`, w.floorSeconds)) };
    })
  );
  // Fixed scope order: mention units dedupe against thread and DM units.
  scopes.forEach((scope, i) => {
    const r = searches[i];
    perScope[scope] = [];
    if (r.status === "rejected") {
      cannot.push({ scope, reason: `search failed: ${errMsg(r.reason)}` });
      coverage[scope] = { matches: 0, units: 0, skipped: 0, capped: 0 };
      return;
    }
    const { w, kept, trimmed, page_capped } = r.value;
    const cov = { matches: kept.length, units: 0, skipped: 0, capped: 0, window: { floor_iso: w.floor_iso, slack_after: w.slack_after, trimmed_out: trimmed } };
    coverage[scope] = cov;
    if (kept.length === 0) cannot.push({ scope, reason: "zero search matches in window" });
    if (page_capped) cannot.push({ scope, reason: `search stopped at ${MAX_PAGES} pages; older matches not fetched` });
    const capped = new Set<string>();
    for (const m of kept) {
      const ch = m.channel;
      let root: string | null | undefined;
      try {
        root = m.permalink ? new URL(m.permalink).searchParams.get("thread_ts") : undefined;
      } catch {
        root = undefined;
      }
      if (!ch?.id || !m.ts || root === undefined) {
        cannot.push({ scope, reason: "match lacks channel id, ts or a parsable permalink", channel_id: ch?.id, ts: m.ts });
        continue;
      }
      const dm = ch.is_im === true || ch.is_mpim === true;
      if (scope === "threads" && dm) { cov.skipped++; continue; } // DMs are the dms scope's
      if (scope === "threads" && root === null) { awaiting.add(`${ch.id}|${m.ts}`); continue; } // no replies yet
      // Unit root: the declared thread root; else a channel message is its own
      // (undeclared) root; a DM's non-thread messages share the main line.
      const rootTs = root ?? (dm ? undefined : m.ts);
      const key = `${ch.id}|${rootTs ?? "main"}`;
      if (units.has(key)) {
        if (units.get(key)!.scope !== scope) cov.skipped++; // already a unit from another scope
        continue;
      }
      // Cap per scope, newest first; a capped key stays open for later scopes.
      if (perScope[scope].length >= p.max_units) { capped.add(key); continue; }
      const c: Candidate = {
        scope, channel_id: ch.id, channel_name: ch.name, root_ts: rootTs, declared: root !== null, ts: m.ts,
        im_user: ch.is_im === true ? ch.user : undefined, origin: new URL(m.permalink!).origin,
      };
      units.set(key, c);
      perScope[scope].push(c);
    }
    cov.capped = capped.size;
  });
  const todo = scopes.flatMap((s) => perScope[s]);

  const botCache = new Map<string, Promise<{ is_bot: boolean; name?: string }>>();
  const lookup = (user: string) => {
    if (!botCache.has(user)) {
      botCache.set(user, client.users.info({ user }).then((r) => {
        const u = r.user as { is_bot?: unknown; name?: string } | undefined;
        if (typeof u?.is_bot !== "boolean") throw new Error(`users.info(${user}) returned no is_bot`);
        return { is_bot: u.is_bot, name: u.name };
      }));
    }
    return botCache.get(user)!;
  };
  const isBot = async (user: string | undefined) =>
    user === me ? false : !user || SYSTEM_USERS.has(user) || overrides.has(user) ? true : (await lookup(user)).is_bot;
  const activeFloor = nowMs / 1000 - p.days * 86400;
  const infoCache = new Map<string, Promise<string | undefined>>();
  const lastReadOf = (channel: string) => {
    if (!infoCache.has(channel)) {
      infoCache.set(channel, client.conversations.info({ channel }).then((r) => (r.channel as Msg | undefined)?.last_read));
    }
    return infoCache.get(channel)!;
  };

  const evaluate = async (c: Candidate) => {
    const target = c.root_ts ?? c.ts;
    // replies(ts, limit N) = the target plus the latest N replies. Main-line
    // units re-fetch the exact message, since search matches carry no reactions.
    const res = await client.conversations.replies({ channel: c.channel_id, ts: target, limit: c.root_ts ? 3 : 1 });
    const msgs = (res.messages ?? []) as Msg[];
    const parent = msgs.find((m) => m.ts === target);
    if (!parent) throw new Error("conversations.replies did not return the target message");
    const thread = c.root_ts !== undefined && typeof parent.reply_count === "number";
    if (c.declared && !thread) throw new Error("reply_count absent on a declared thread root");
    if (thread && parent.latest_reply && !msgs.some((m) => m.ts === parent.latest_reply)) {
      throw new Error("fetched replies do not include the declared latest_reply");
    }
    const replies = thread ? msgs.filter((m) => m !== parent) : [];
    // The parent may be the turn only when every reply was returned.
    const candidates = !thread ? [parent] : replies.length >= parent.reply_count! ? msgs : replies;
    const lastRead = thread ? parent.last_read : await lastReadOf(c.channel_id);
    const latest = thread ? parent.latest_reply : parent.ts;

    const sorted = [...candidates].sort((a, b) => num(b.ts) - num(a.ts));
    let turn: Msg | undefined;
    const botIm = c.im_user !== undefined && c.im_user !== me && (await isBot(c.im_user));
    if (!botIm) for (const m of sorted) if (!(await isBot(m.user))) { turn = m; break; }
    const owes = botIm ? "nobody" : !turn ? "cannot_check" : turn.user === me ? "them" : "me";
    if (owes === "cannot_check") cannot.push({ scope: c.scope, reason: "no human message among those fetched", channel_id: c.channel_id, ts: target });

    const shown = turn ?? sorted[0];
    const reactions = Array.isArray(turn?.reactions) ? (turn!.reactions as Array<{ name?: string; users?: unknown }>) : [];
    const my = reactions.filter((r) => typeof r.name === "string" && Array.isArray(r.users) && r.users.includes(me)).map((r) => r.name!);
    const newestTs = Math.max(...msgs.map((m) => num(m.ts)).filter(Number.isFinite));
    const pl = `${c.origin}/archives/${c.channel_id}/p${(shown.ts ?? "").replace(".", "")}`;
    return {
      kind: c.scope === "threads" ? "thread" : c.scope === "dms" ? "dm" : "mention",
      channel_id: c.channel_id,
      channel_name: c.channel_name,
      ...(c.root_ts ? { root_ts: c.root_ts } : {}),
      newest: {
        user: shown.user,
        username: shown.username ?? (shown.user && botCache.has(shown.user) ? (await botCache.get(shown.user)!).name : undefined),
        is_bot: turn ? false : await isBot(shown.user),
        ts: shown.ts,
        text: typeof shown.text === "string" ? shown.text.slice(0, 200) : undefined,
      },
      owes,
      my_reactions: my,
      acknowledged: my.some((n) => clearing.has(n.split("::")[0])), // skin tones share the base name
      unseen: lastRead === undefined || !Number.isFinite(num(latest)) ? null : num(latest) > num(lastRead),
      active: newestTs >= activeFloor,
      permalink: c.root_ts && c.root_ts !== shown.ts ? `${pl}?thread_ts=${c.root_ts}&cid=${c.channel_id}` : pl,
    };
  };

  const evaluated = await mapWithConcurrency(todo, 8, async (c) => {
    try {
      const u = await evaluate(c);
      coverage[c.scope].units = (coverage[c.scope].units as number) + 1;
      return u;
    } catch (e) {
      cannot.push({ scope: c.scope, reason: errMsg(e), channel_id: c.channel_id, ts: c.root_ts ?? c.ts });
      return undefined;
    }
  });
  const out = evaluated.filter((u) => u !== undefined).sort((a, b) => num(b.newest.ts) - num(a.newest.ts));
  const roots = new Set(todo.map((c) => `${c.channel_id}|${c.root_ts}`));
  return {
    user_id: me,
    coverage,
    units: out,
    cannot_check: cannot,
    awaiting_others: [...awaiting].filter((k) => !roots.has(k)).length,
    residual_gap: RESIDUAL_GAP,
  };
}
