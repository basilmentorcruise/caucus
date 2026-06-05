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

/** A second client bound to the same channel under a different identity. */
async function connectSecondClient(
  backbone: InMemoryBackbone,
): Promise<Client> {
  const server = createCaucusServer({
    config: {
      identity: { agent_id: "agent-2", owner: "bob" },
      channel: "incident-1",
    },
    backbone,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client-2", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("CAU-11 AC1 — claim surfaces granted vs already_claimed over MCP", () => {
  it("first claim is granted; a different principal's claim of the same target is already_claimed (NOT isError)", async () => {
    const backbone = await createdBackbone();
    const alice = await connectClient(backbone);
    const bob = await connectSecondClient(backbone);

    const granted = jsonOf<{ outcome: string; msg_id: string; cursor: number }>(
      (await alice.callTool({
        name: "caucus_claim",
        arguments: { target: "db", note: "taking the db angle" },
      })) as CallToolResult,
    );
    expect(granted.outcome).toBe("granted");
    expect(typeof granted.msg_id).toBe("string");

    // A different principal claiming the same target loses — and that is a
    // NORMAL result, not an error: the agent is told to pick different work.
    const takenResult = (await bob.callTool({
      name: "caucus_claim",
      arguments: { target: "db" },
    })) as CallToolResult;
    expect(takenResult.isError).toBeFalsy();
    const taken = jsonOf<{
      outcome: string;
      by: { agent_id: string; owner: string; ts: string; msg_id: string };
    }>(takenResult);
    expect(taken.outcome).toBe("already_claimed");
    expect(taken.by.agent_id).toBe("agent-1");
    expect(taken.by.owner).toBe("alice");
    // Wire contract: the full holder identity survives the transport.
    expect(taken.by.ts).toBeTruthy();
    expect(taken.by.msg_id).toBeTruthy();
  });
});

describe("CAU-11 AC2 — subscribe mints a cursor; read_channel(since) returns the delta", () => {
  it("subscribe -> 2 posts -> read_channel{since:cursor} returns exactly the 2 new", async () => {
    const client = await connectClient(await createdBackbone());

    // Some history exists before the bookmark.
    await client.callTool({
      name: "caucus_post",
      arguments: { type: "note", body: "old" },
    });

    // subscribe stands in for the CAU-14 hook's cursor mint: it bookmarks
    // "now", then read_channel(since) returns only what arrived afterward.
    const { cursor } = jsonOf<{ cursor: number }>(
      (await client.callTool({
        name: "caucus_subscribe",
        arguments: {},
      })) as CallToolResult,
    );

    await client.callTool({
      name: "caucus_post",
      arguments: { type: "status", body: "new-1" },
    });
    await client.callTool({
      name: "caucus_post",
      arguments: { type: "finding", body: "new-2" },
    });

    const delta = jsonOf<{ count: number; messages: { body: string }[] }>(
      (await client.callTool({
        name: "caucus_read_channel",
        arguments: { since: cursor },
      })) as CallToolResult,
    );
    expect(delta.count).toBe(2);
    expect(delta.messages.map((m) => m.body)).toEqual(["new-1", "new-2"]);
  });
});

describe("CAU-11 AC3 — claim/subscribe descriptions carry the conventions", () => {
  it("lists both tools with convention-bearing descriptions", async () => {
    const client = await connectClient(await createdBackbone());
    const { tools } = await client.listTools();

    const claim = tools.find((t) => t.name === "caucus_claim");
    const subscribe = tools.find((t) => t.name === "caucus_subscribe");
    expect(claim).toBeDefined();
    expect(subscribe).toBeDefined();
    expect(claim?.description).toBeTruthy();
    expect(subscribe?.description).toBeTruthy();

    // Claim coaches: claim BEFORE investigating, and already_claimed ⇒ build on
    // / pick different work, not a failure.
    expect(claim?.description).toMatch(/BEFORE/i);
    expect(claim?.description).toMatch(/already_claimed|build on/i);
    // Subscribe explains the since-cursor contract.
    expect(subscribe?.description).toMatch(/since/i);
  });
});

describe("CAU-12 AC1 — create a channel via tool over MCP", () => {
  it("caucus_create_channel mints a room attributed to the session owner", async () => {
    const client = await connectClient(await createdBackbone());

    const created = jsonOf<{
      channel: string;
      purpose: string;
      kind: string;
      created_by: string;
    }>(
      (await client.callTool({
        name: "caucus_create_channel",
        arguments: { channel: "war-room", purpose: "checkout 500s" },
      })) as CallToolResult,
    );
    expect(created.channel).toBe("war-room");
    expect(created.purpose).toBe("checkout 500s");
    expect(created.kind).toBe("ephemeral");
    // created_by is server-anchored (no arg for it) — it is the session owner.
    expect(created.created_by).toBe("alice");
  });
});

describe("CAU-12 AC2 — list/describe reflect reality over MCP", () => {
  it("a tool-created channel shows up in list and describe", async () => {
    const client = await connectClient(await createdBackbone());

    await client.callTool({
      name: "caucus_create_channel",
      arguments: { channel: "war-room", purpose: "checkout 500s" },
    });

    const list = jsonOf<{
      count: number;
      channels: { channel: string }[];
    }>(
      (await client.callTool({
        name: "caucus_list_channels",
        arguments: {},
      })) as CallToolResult,
    );
    expect(list.channels.map((c) => c.channel).sort()).toEqual([
      "incident-1",
      "war-room",
    ]);

    const described = jsonOf<{ channel: string; purpose: string }>(
      (await client.callTool({
        name: "caucus_describe_channel",
        arguments: { channel: "war-room" },
      })) as CallToolResult,
    );
    expect(described.channel).toBe("war-room");
    expect(described.purpose).toBe("checkout 500s");

    // describe with no arg defaults to the session channel.
    const self = jsonOf<{ channel: string }>(
      (await client.callTool({
        name: "caucus_describe_channel",
        arguments: {},
      })) as CallToolResult,
    );
    expect(self.channel).toBe("incident-1");
  });

  it("describing an unknown room is surfaced as an error over MCP", async () => {
    const client = await connectClient(await createdBackbone());
    const result = (await client.callTool({
      name: "caucus_describe_channel",
      arguments: { channel: "ghost" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("CAU-12 — join yields a working read cursor over MCP", () => {
  it("create -> join another room -> post there (via a 2nd session) -> read the delta", async () => {
    const backbone = await createdBackbone();
    const alice = await connectClient(backbone); // posts to incident-1

    // Create a second room and join it for reading.
    await alice.callTool({
      name: "caucus_create_channel",
      arguments: { channel: "incident-2", purpose: "other room" },
    });
    const joined = jsonOf<{ channel: string; cursor: number; head: number }>(
      (await alice.callTool({
        name: "caucus_join_channel",
        arguments: { channel: "incident-2" },
      })) as CallToolResult,
    );
    expect(joined.channel).toBe("incident-2");
    expect(joined.cursor).toBe(joined.head);

    // A session bound to incident-2 posts there; the joined cursor sees it.
    const bobServer = createCaucusServer({
      config: {
        identity: { agent_id: "agent-2", owner: "bob" },
        channel: "incident-2",
      },
      backbone,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await bobServer.connect(st);
    const bob = new Client({ name: "bob", version: "0.0.0" });
    await bob.connect(ct);
    await bob.callTool({
      name: "caucus_post",
      arguments: { type: "note", body: "in the other room" },
    });

    // THE AC FLOW: alice — whose session channel is incident-1 — consumes her
    // joined cursor through the tool surface by passing `channel`. Without the
    // override this would silently re-read incident-1 (the CAU-12 gate FAIL).
    const delta = jsonOf<{
      count: number;
      messages: { body: string; owner: string }[];
    }>(
      (await alice.callTool({
        name: "caucus_read_channel",
        arguments: { channel: "incident-2", since: joined.cursor },
      })) as CallToolResult,
    );
    expect(delta.count).toBe(1);
    expect(delta.messages[0]?.body).toBe("in the other room");
    expect(delta.messages[0]?.owner).toBe("bob");

    // And without `channel`, the same call reads alice's own (empty) room —
    // the default is unchanged for every pre-CAU-12 caller.
    const own = jsonOf<{ count: number }>(
      (await alice.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    expect(own.count).toBe(0);
  });
});

describe("CAU-12 — channel tools are listed with convention-bearing descriptions", () => {
  it("all four tools are present with non-empty descriptions and the right norms", async () => {
    const client = await connectClient(await createdBackbone());
    const { tools } = await client.listTools();

    const list = tools.find((t) => t.name === "caucus_list_channels");
    const describe_ = tools.find((t) => t.name === "caucus_describe_channel");
    const create = tools.find((t) => t.name === "caucus_create_channel");
    const join = tools.find((t) => t.name === "caucus_join_channel");

    for (const t of [list, describe_, create, join]) {
      expect(t).toBeDefined();
      expect(t?.description).toBeTruthy();
    }

    // list/describe teach discovery-before-create.
    expect(list?.description).toMatch(/discover|existing/i);
    expect(describe_?.description).toMatch(/before you create|existing/i);
    // create teaches ephemeral war-room semantics, the slug rule, and no secrets.
    expect(create?.description).toMatch(/ephemeral/i);
    expect(create?.description).toMatch(/\[a-z0-9\]/);
    expect(create?.description).toMatch(/secret/i);
    // join explains the read-cursor-only semantics honestly.
    expect(join?.description).toMatch(/CAUCUS_CHANNEL/);
    expect(join?.description).toMatch(/read cursor/i);
  });
});
