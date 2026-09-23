// Drives the real registered tool handlers through an in-memory MCP
// client/server pair, against a hand-built fake WebClient. Lets tests assert
// on the exact bytes a tool returns — the same text the model would read.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConversationsTools } from "../../src/services/conversations/index.js";
import type { ServiceContext } from "../../src/types.js";
import type { TimezoneResolution } from "../../src/utils/identity.js";

export interface HarnessOptions {
  me?: string;
  tz?: TimezoneResolution;
}

export async function connectConversationsTools(
  fakeClient: unknown,
  opts: HarnessOptions = {}
): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<string> }> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const ctx: ServiceContext = {
    client: fakeClient as never,
    slug: "acme-slack-com",
    getMyUserId: async () => opts.me ?? "UME000001",
    getMyTimezone: async () => opts.tz ?? { tz: "America/New_York", source: "slack" },
  };
  registerConversationsTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    call: async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text: string }>;
      return content[0].text;
    },
  };
}
