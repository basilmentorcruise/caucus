import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ServerConfig } from "./config.js";
import { createCaucusServer } from "./server.js";
import type { CaucusSession } from "./session.js";
import type { CaucusTool } from "./tools/registry.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

/**
 * Connect a {@link Client} to a Caucus server over an in-memory transport pair
 * (the same JSON-RPC handshake a real stdio connection performs), returning the
 * client. AC1 is testable in-process precisely because `createCaucusServer`
 * hands back an un-connected server.
 */
async function connectClient(
  backbone: InMemoryBackbone,
  tools?: readonly CaucusTool[],
): Promise<Client> {
  const server = createCaucusServer({ config, backbone, tools });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("createCaucusServer (AC1 — list + call tools over MCP)", () => {
  it("a connected client can list caucus_status with its description + schema", async () => {
    const client = await connectClient(new InMemoryBackbone());
    const { tools } = await client.listTools();

    const status = tools.find((t) => t.name === "caucus_status");
    expect(status).toBeDefined();
    expect(status?.description).toBeTruthy();
    expect(status?.inputSchema.type).toBe("object");
  });

  it("calling caucus_status returns the identity + channel", async () => {
    const client = await connectClient(new InMemoryBackbone());
    const result = (await client.callTool({
      name: "caucus_status",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const first = result.content[0];
    expect(first?.type).toBe("text");
    const report = JSON.parse((first as { type: "text"; text: string }).text);
    expect(report.agent_id).toBe("agent-1");
    expect(report.owner).toBe("alice");
    expect(report.channel).toBe("incident-1");
  });
});

describe("createCaucusServer (a throwing tool is surfaced, not fatal)", () => {
  it("returns isError with the message and the server still serves listTools", async () => {
    const throwingTool: CaucusTool = {
      name: "test_throws",
      description: "test-only: always throws",
      inputSchema: {},
      handle(): Promise<CallToolResult> {
        return Promise.reject(new Error("boom from a tool"));
      },
    };

    const client = await connectClient(new InMemoryBackbone(), [throwingTool]);

    const result = (await client.callTool({
      name: "test_throws",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type).toBe("text");
    expect((first as { type: "text"; text: string }).text).toContain(
      "boom from a tool",
    );

    // The server did not crash: a subsequent request is still answered.
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "test_throws")).toBeDefined();
  });
});

describe("createCaucusServer (AC2 — posts carry identity end-to-end)", () => {
  it("a tool's post lands in the backbone stamped with the session identity", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "test",
      created_by: "alice",
    });

    // A throwaway tool whose only job is to post through the session, so we can
    // prove identity stamping survives the full MCP transport round-trip.
    const postTool: CaucusTool = {
      name: "test_post",
      description: "test-only: post a fixed note via the session",
      inputSchema: {},
      async handle(session: CaucusSession): Promise<CallToolResult> {
        const { message } = await session.post({
          type: "note",
          body: "from a tool",
        });
        return { content: [{ type: "text", text: message.msg_id }] };
      },
    };

    const client = await connectClient(backbone, [postTool]);
    await client.callTool({ name: "test_post", arguments: {} });

    const { messages } = await backbone.readSince("incident-1", 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.agent_id).toBe("agent-1");
    expect(messages[0]?.owner).toBe("alice");
    expect(messages[0]?.body).toBe("from a tool");
  });
});

/** A backbone with the session channel already created. */
async function createdBackbone(): Promise<InMemoryBackbone> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  return backbone;
}

/** Parse a text tool result's JSON envelope. */
function jsonOf<T>(result: CallToolResult): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

describe("CAU-10 AC1 — post each type + post_finding, then read them back", () => {
  it("every posted message comes back in order, identity-stamped", async () => {
    const client = await connectClient(await createdBackbone());

    const types = ["status", "question", "answer", "note", "finding"] as const;
    for (const type of types) {
      await client.callTool({
        name: "caucus_post",
        arguments: { type, body: `body-${type}` },
      });
    }
    await client.callTool({
      name: "caucus_post_finding",
      arguments: { body: "a real finding" },
    });

    const read = jsonOf<{
      count: number;
      messages: { type: string; body: string; agent_id: string; owner: string }[];
    }>(
      (await client.callTool({
        name: "caucus_read_channel",
        arguments: {},
      })) as CallToolResult,
    );

    expect(read.count).toBe(6);
    expect(read.messages.map((m) => m.type)).toEqual([
      "status",
      "question",
      "answer",
      "note",
      "finding",
      "finding",
    ]);
    expect(read.messages.map((m) => m.body)).toEqual([
      "body-status",
      "body-question",
      "body-answer",
      "body-note",
      "body-finding",
      "a real finding",
    ]);
    for (const m of read.messages) {
      expect(m.agent_id).toBe("agent-1");
      expect(m.owner).toBe("alice");
    }
  });
});

describe("CAU-10 AC2 — read_channel(since) returns only new messages over MCP", () => {
  it("walks the cursor across the transport", async () => {
    const client = await connectClient(await createdBackbone());

    await client.callTool({
      name: "caucus_post",
      arguments: { type: "note", body: "first" },
    });

    const first = jsonOf<{ cursor: number; count: number }>(
      (await client.callTool({
        name: "caucus_read_channel",
        arguments: {},
      })) as CallToolResult,
    );
    expect(first.count).toBe(1);

    await client.callTool({
      name: "caucus_post",
      arguments: { type: "status", body: "second" },
    });

    const delta = jsonOf<{
      cursor: number;
      count: number;
      messages: { body: string }[];
    }>(
      (await client.callTool({
        name: "caucus_read_channel",
        arguments: { since: first.cursor },
      })) as CallToolResult,
    );
    expect(delta.count).toBe(1);
    expect(delta.messages[0]?.body).toBe("second");
  });
});

describe("CAU-10 AC3 — tool descriptions + schema state the conventions", () => {
  it("lists the three tools with convention-bearing descriptions and a claim-free type enum", async () => {
    const client = await connectClient(await createdBackbone());
    const { tools } = await client.listTools();

    const post = tools.find((t) => t.name === "caucus_post");
    const finding = tools.find((t) => t.name === "caucus_post_finding");
    const read = tools.find((t) => t.name === "caucus_read_channel");
    expect(post).toBeDefined();
    expect(finding).toBeDefined();
    expect(read).toBeDefined();

    // Stable convention markers (loose regexes so wording can evolve).
    expect(post?.description).toMatch(/claim/i);
    expect(post?.description).toMatch(/secret/i);
    expect(post?.description).toMatch(/sparingly|quiet/i);
    expect(finding?.description).toMatch(/secret/i);
    expect(finding?.description).toMatch(/claim/i);
    expect(read?.description).toMatch(/cursor|since/i);
    expect(read?.description).toMatch(/claim/i);

    // The post schema's `type` enum excludes "claim".
    const props = post?.inputSchema.properties as
      | Record<string, { enum?: string[] }>
      | undefined;
    const typeEnum = props?.type?.enum ?? [];
    expect(typeEnum).not.toContain("claim");
    expect(typeEnum).toEqual(
      expect.arrayContaining(["status", "question", "answer", "note", "finding"]),
    );
  });

  it("rejects a forced type=claim on caucus_post (zod enum rejects)", async () => {
    const client = await connectClient(await createdBackbone());
    const result = (await client.callTool({
      name: "caucus_post",
      arguments: { type: "claim", body: "should not pass" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
