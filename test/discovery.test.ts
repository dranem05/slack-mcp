import { describe, expect, it, vi } from "vitest";
import { registerDiscoveryTools } from "../src/services/discovery/index.js";

function webApiError(data: Record<string, unknown>): Error {
  const err = new Error("web api error") as Error & { data: unknown };
  err.data = data;
  return err;
}

// registerDiscoveryTools only calls server.tool(name, description, schema,
// handler) — capture those calls instead of spinning up a real McpServer /
// transport, same narrow-seam approach as the other service tests.
function fakeServer() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: never) => {
      handlers.set(name, handler as (params: unknown) => Promise<unknown>);
    }),
    handlers,
  };
}

function fakeCtx(client: unknown) {
  return {
    client,
    slug: "acme-slack-com",
    getMyUserId: async () => "U_SELF",
  };
}

async function callUserInfo(server: ReturnType<typeof fakeServer>, user_id = "U0123456789") {
  const handler = server.handlers.get("slack_user_info")!;
  const result = (await handler({ user_id })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describe("slack_user_info", () => {
  it("falls back to users.info's profile when users.profile.get is missing the scope", async () => {
    const server = fakeServer();
    const client = {
      users: {
        info: vi.fn(async () => ({
          ok: true,
          user: {
            id: "U0123456789",
            name: "jdoe",
            real_name: "Jane Doe",
            tz: "America/Los_Angeles",
            is_bot: false,
            profile: { display_name: "jane (info)", title: "Engineer (info)" },
          },
        })),
        profile: {
          get: vi.fn(async () => {
            throw webApiError({ error: "missing_scope", needed: "users.profile:read" });
          }),
        },
      },
    };
    registerDiscoveryTools(server as never, fakeCtx(client) as never);

    const merged = await callUserInfo(server);

    expect(merged).toMatchObject({
      name: "jdoe",
      real_name: "Jane Doe",
      tz: "America/Los_Angeles",
      is_bot: false,
      display_name: "jane (info)",
      title: "Engineer (info)",
    });
  });

  it("still surfaces an error when users.info itself fails", async () => {
    const server = fakeServer();
    const client = {
      users: {
        info: vi.fn(async () => {
          throw webApiError({ error: "user_not_found" });
        }),
        profile: {
          get: vi.fn(async () => ({ ok: true, profile: {} })),
        },
      },
    };
    registerDiscoveryTools(server as never, fakeCtx(client) as never);

    const handler = server.handlers.get("slack_user_info")!;
    const result = (await handler({ user_id: "U0123456789" })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("user_not_found");
  });

  it("prefers users.profile.get's values over users.info's when both succeed", async () => {
    const server = fakeServer();
    const client = {
      users: {
        info: vi.fn(async () => ({
          ok: true,
          user: {
            id: "U0123456789",
            name: "jdoe",
            profile: { display_name: "jane (info)", title: "Engineer (info)" },
          },
        })),
        profile: {
          get: vi.fn(async () => ({
            ok: true,
            profile: { display_name: "jane", title: "Staff Engineer" },
          })),
        },
      },
    };
    registerDiscoveryTools(server as never, fakeCtx(client) as never);

    const merged = await callUserInfo(server);

    expect(merged.display_name).toBe("jane");
    expect(merged.title).toBe("Staff Engineer");
  });

  it("still surfaces any other users.profile.get error", async () => {
    const server = fakeServer();
    const client = {
      users: {
        info: vi.fn(async () => ({ ok: true, user: { id: "U0123456789", name: "jdoe" } })),
        profile: {
          get: vi.fn(async () => {
            throw webApiError({ error: "ratelimited" });
          }),
        },
      },
    };
    registerDiscoveryTools(server as never, fakeCtx(client) as never);

    const handler = server.handlers.get("slack_user_info")!;
    const result = (await handler({ user_id: "U0123456789" })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("ratelimited");
  });
});
