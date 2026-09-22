import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SlackAuth } from "./auth.js";
import { ServiceContext } from "./types.js";
import { createIdentityLookup, createTimezoneLookup } from "./utils/identity.js";
import { registerConversationsTools } from "./services/conversations/index.js";
import { registerChannelsTools } from "./services/channels/index.js";
import { registerUsersTools } from "./services/users/index.js";
import { registerUsergroupsTools } from "./services/usergroups/index.js";
import { registerDraftsTools } from "./services/drafts/index.js";
import { registerReactionsTools } from "./services/reactions/index.js";
import { registerScheduledTools } from "./services/scheduled/index.js";
import { registerDiscoveryTools } from "./services/discovery/index.js";
import { registerRemindersTools } from "./services/reminders/index.js";
import { registerStatusTools } from "./services/status/index.js";
import { registerPinsTools } from "./services/pins/index.js";
import { registerBookmarksTools } from "./services/bookmarks/index.js";
import { registerFilesTools } from "./services/files/index.js";
import { registerCanvasTools } from "./services/canvas/index.js";

export function createServer(auth: SlackAuth): McpServer {
  const server = new McpServer({
    name: "slack-mcp",
    version: "0.1.0",
  });

  const getMyUserId = createIdentityLookup(auth.client);
  const ctx: ServiceContext = {
    ...auth,
    getMyUserId,
    getMyTimezone: createTimezoneLookup(auth.client, getMyUserId),
  };

  registerConversationsTools(server, ctx);
  registerChannelsTools(server, ctx);
  registerUsersTools(server, ctx);
  registerUsergroupsTools(server, ctx);
  registerDraftsTools(server, ctx);
  registerReactionsTools(server, ctx);
  registerScheduledTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerRemindersTools(server, ctx);
  registerStatusTools(server, ctx);
  registerPinsTools(server, ctx);
  registerBookmarksTools(server, ctx);
  registerFilesTools(server, ctx);
  registerCanvasTools(server, ctx);

  return server;
}
