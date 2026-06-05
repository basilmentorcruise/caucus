import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ChannelDescriptor } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import {
  listChannelsTool,
  describeChannelTool,
  createChannelTool,
  joinChannelTool,
} from "./channels.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

async function freshBackbone(): Promise<InMemoryBackbone> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "the session channel",
    created_by: "alice",
  });
  return backbone;
}

/** Parse a text tool result's JSON envelope (asserting it's not an error). */
function jsonOf<T>(
  result: Awaited<ReturnType<typeof listChannelsTool.handle>>,
): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

describe("caucus_list_channels", () => {
  it("returns count 0 and an empty list when no channels exist", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const { count, channels } = jsonOf<{
      count: number;
      channels: ChannelDescriptor[];
    }>(await listChannelsTool.handle(session, {}));
    expect(count).toBe(0);
    expect(channels).toEqual([]);
  });

  it("reflects every existing channel with its descriptor", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "second room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const { count, channels } = jsonOf<{
      count: number;
      channels: ChannelDescriptor[];
    }>(await listChannelsTool.handle(session, {}));
    expect(count).toBe(2);
    const names = channels.map((c) => c.channel).sort();
    expect(names).toEqual(["incident-1", "incident-2"]);
  });

  it("posts nothing — read-only (ADR-C6)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await listChannelsTool.handle(session, {});
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });
});

describe("caucus_describe_channel", () => {
  it("defaults to the session channel when `channel` is omitted", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await describeChannelTool.handle(session, {}),
    );
    expect(descriptor.channel).toBe("incident-1");
    expect(descriptor.purpose).toBe("the session channel");
  });

  it("describes an explicitly-named other channel", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "second room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await describeChannelTool.handle(session, { channel: "incident-2" }),
    );
    expect(descriptor.channel).toBe("incident-2");
    expect(descriptor.created_by).toBe("bob");
  });

  it("propagates UnknownChannelError for a non-existent channel (the answer to 'does it exist?')", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await expect(
      describeChannelTool.handle(session, { channel: "nope" }),
    ).rejects.toThrow();
  });
});

describe("caucus_create_channel", () => {
  it("creates the channel and returns its descriptor", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await createChannelTool.handle(session, {
        channel: "war-room",
        purpose: "checkout 500s spike",
      }),
    );
    expect(descriptor.channel).toBe("war-room");
    expect(descriptor.purpose).toBe("checkout 500s spike");
    expect(descriptor.kind).toBe("ephemeral");
  });

  it("anchors created_by to the SESSION owner — it cannot be forged via args", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    // There is no created_by argument; even smuggling one in the args object
    // (which the tool ignores) does not change attribution.
    const descriptor = jsonOf<ChannelDescriptor>(
      await createChannelTool.handle(session, {
        channel: "war-room",
        purpose: "p",
        created_by: "mallory",
      } as Record<string, unknown>),
    );
    expect(descriptor.created_by).toBe("alice");
  });

  it("propagates ChannelExistsError (value-free) on a duplicate name", async () => {
    const backbone = await freshBackbone(); // "incident-1" exists
    const session = createSession(config, backbone);

    await expect(
      createChannelTool.handle(session, {
        channel: "incident-1",
        purpose: "dup",
      }),
    ).rejects.toThrow();
  });
});

describe("caucus_join_channel", () => {
  it("verifies the room and mints a cursor at its current head", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    // Seed two messages so head is non-zero.
    await session.post({ type: "note", body: "one" });
    await session.post({ type: "note", body: "two" });

    const { channel, cursor, head } = jsonOf<{
      channel: string;
      cursor: number;
      head: number;
    }>(await joinChannelTool.handle(session, { channel: "incident-1" }));
    expect(channel).toBe("incident-1");
    expect(head).toBe(2);
    // join == subscribe-to-now: the cursor is the current head.
    expect(cursor).toBe(head);
  });

  it("yields a read cursor on a room OTHER than the session's posting channel", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "other room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const { channel, cursor } = jsonOf<{ channel: string; cursor: number }>(
      await joinChannelTool.handle(session, { channel: "incident-2" }),
    );
    expect(channel).toBe("incident-2");
    expect(cursor).toBe(0);
    // The session's posting channel is unchanged — join is read-only.
    expect(session.channel).toBe("incident-1");
  });

  it("propagates UnknownChannelError when joining a non-existent room", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await expect(
      joinChannelTool.handle(session, { channel: "ghost" }),
    ).rejects.toThrow();
  });

  it("posts nothing — read-only (ADR-C6)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await joinChannelTool.handle(session, { channel: "incident-1" });
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });
});
