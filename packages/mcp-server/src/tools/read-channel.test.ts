import { describe, expect, it } from "vitest";
import { InMemoryBackbone, type Backbone } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { readChannelTool } from "./read-channel.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

interface ReadEnvelope {
  cursor: number;
  count: number;
  messages: AppendedMessage[];
}

function envelope(
  result: Awaited<ReturnType<typeof readChannelTool.handle>>,
): ReadEnvelope {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

async function createdSession(): Promise<{
  backbone: InMemoryBackbone;
  session: ReturnType<typeof createSession>;
}> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  return { backbone, session: createSession(config, backbone) };
}

describe("caucus_read_channel", () => {
  it("tolerates an as-yet-uncreated channel (empty page at cursor 0)", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.cursor).toBe(0);
    expect(result.count).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("reads an empty but existing channel", async () => {
    const { session } = await createdSession();
    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.cursor).toBe(0);
    expect(result.count).toBe(0);
  });

  it("returns messages in append order with identity + type", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "one" });
    await session.post({ type: "finding", body: "two" });

    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.count).toBe(2);
    expect(result.cursor).toBe(2);
    expect(result.messages.map((m) => m.body)).toEqual(["one", "two"]);
    expect(result.messages[0]?.agent_id).toBe("agent-1");
    expect(result.messages[0]?.owner).toBe("alice");
    expect(result.messages[0]?.type).toBe("note");
    expect(result.messages[1]?.type).toBe("finding");
  });

  it("AC2: since-cursor returns only what is new, then re-reading is empty", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "first" });

    // Read everything so far, capture the cursor c.
    const firstRead = envelope(await readChannelTool.handle(session, {}));
    expect(firstRead.count).toBe(1);
    const c = firstRead.cursor;
    expect(c).toBe(1);

    // Two more posts after the cursor.
    await session.post({ type: "status", body: "second" });
    await session.post({ type: "status", body: "third" });

    // read(since: c) returns EXACTLY the two new messages.
    const delta = envelope(await readChannelTool.handle(session, { since: c }));
    expect(delta.count).toBe(2);
    expect(delta.messages.map((m) => m.body)).toEqual(["second", "third"]);
    expect(delta.cursor).toBe(c + 2);

    // Re-reading at the advanced cursor yields nothing.
    const tail = envelope(
      await readChannelTool.handle(session, { since: delta.cursor }),
    );
    expect(tail.count).toBe(0);
    expect(tail.cursor).toBe(c + 2);
  });

  it("caps the page with `limit`", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "a" });
    await session.post({ type: "note", body: "b" });
    await session.post({ type: "note", body: "c" });

    const result = envelope(
      await readChannelTool.handle(session, { limit: 2 }),
    );
    expect(result.count).toBe(2);
    expect(result.cursor).toBe(2);
    expect(result.messages.map((m) => m.body)).toEqual(["a", "b"]);
  });

  it("propagates an unexpected reader failure untouched", async () => {
    const boom = new Error("backbone exploded");
    const backbone = {
      readSince: () => Promise.reject(boom),
    } as unknown as Backbone;
    const session = createSession(config, backbone);

    await expect(readChannelTool.handle(session, {})).rejects.toThrow(
      "backbone exploded",
    );
  });
});
