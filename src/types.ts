import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebClient } from "@slack/web-api";
import { BrowserApi } from "./utils/browserApi.js";
import { TimezoneResolution } from "./utils/identity.js";

export interface ServiceContext {
  client: WebClient;
  browserApi?: BrowserApi;
  // Workspace slug (e.g. "acme-slack-com") — used by the error wrapper to
  // name the right SLACK_TOKEN_<SLUG> env var in remediation hints.
  slug: string;
  // Memoized auth.test() lookup, shared across every tool that needs "who
  // am I" (my_mentions, usergroups_me). See utils/identity.ts.
  getMyUserId: () => Promise<string>;
  // Memoized users.info() timezone lookup for the authenticated user, with
  // an explicit fallback source. Slack evaluates search date filters in the
  // user's timezone. See utils/identity.ts.
  getMyTimezone: () => Promise<TimezoneResolution>;
}

export type RegisterTools = (server: McpServer, ctx: ServiceContext) => void;
