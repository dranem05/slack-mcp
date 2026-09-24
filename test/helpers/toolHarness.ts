// Drives the real registered conversations tools through an in-memory MCP
// client/server pair against a fake WebClient, so tests assert on the exact
// bytes a tool returns.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConversationsTools } from "../../src/services/conversations/index.js";
import type { ServiceContext } from "../../src/types.js";

export async function connectConversationsTools(fakeClient: unknown, me = "UME000001") {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const ctx: ServiceContext = { client: fakeClient as never, slug: "acme-slack-com", getMyUserId: async () => me };
  registerConversationsTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>): Promise<string> => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as Array<{ type: string; text: string }>)[0].text;
    },
  };
}
