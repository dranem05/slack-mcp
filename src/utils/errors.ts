// Shared error handling for tool handlers.
//
// WebClient throws on any `ok: false` response (see @slack/web-api's
// platformErrorFromResult), attaching the parsed body as `err.data`. This
// module turns that (and the internal browser-API client's own error type)
// into a compact, consistent, actionable shape instead of every tool
// handler doing its own try/catch and losing detail.

import { BrowserApiError } from "./browserApi.js";
import { textResult, type ToolResult } from "./formatting.js";
import { envSlug } from "./slug.js";

// Slack error codes that mean the credential itself is bad, as opposed to a
// one-off request problem (bad channel, missing scope, etc.).
const AUTH_ERROR_CODES = new Set(["invalid_auth", "token_revoked", "account_inactive"]);

export interface MappedSlackError {
  error: string;
  messages?: string[];
  needed?: string;
  provided?: string;
  hint?: string;
}

interface WebApiErrorShape {
  data?: {
    error?: string;
    response_metadata?: { messages?: string[] };
    needed?: string;
    provided?: string;
  };
  message?: string;
}

function isWebApiErrorShape(err: unknown): err is WebApiErrorShape {
  return typeof err === "object" && err !== null && "data" in err;
}

// Lets a caller treat one specific Slack error code as non-fatal (e.g. a
// profile lookup whose only use of the extra scope is a nice-to-have) while
// still letting every other error propagate normally.
export function isMissingScopeError(err: unknown): boolean {
  return isWebApiErrorShape(err) && err.data?.error === "missing_scope";
}

export function mapSlackError(err: unknown, slug: string): MappedSlackError {
  if (err instanceof BrowserApiError) {
    const result: MappedSlackError = { error: err.slackError };
    if (AUTH_ERROR_CODES.has(err.slackError)) {
      result.hint =
        "Browser-session token looks invalid or expired — re-extract xoxc/xoxd per README.";
    }
    return result;
  }

  if (isWebApiErrorShape(err) && typeof err.data?.error === "string") {
    const code = err.data.error;
    const result: MappedSlackError = { error: code };

    const messages = err.data.response_metadata?.messages;
    if (messages && messages.length > 0) {
      result.messages = messages;
    }

    if (code === "missing_scope") {
      if (err.data.needed) result.needed = err.data.needed;
      if (err.data.provided) result.provided = err.data.provided;
    }

    if (AUTH_ERROR_CODES.has(code)) {
      result.hint = `Set SLACK_TOKEN_${envSlug(slug)} in ~/.config/openbrain/.env with a valid xoxp token (see README).`;
    }

    return result;
  }

  if (err instanceof Error) {
    return { error: err.message };
  }

  return { error: String(err) };
}

// Wraps a tool handler so any thrown WebClient / browser-API error is caught
// and turned into a `{ ok: false, error, ... }` textResult instead of an
// unhandled rejection reaching the MCP transport.
export function withErrorHandling<Params>(
  slug: string,
  fn: (params: Params) => Promise<ToolResult>
): (params: Params) => Promise<ToolResult> {
  return async (params: Params) => {
    try {
      return await fn(params);
    } catch (err) {
      return textResult({ ok: false, ...mapSlackError(err, slug) });
    }
  };
}
