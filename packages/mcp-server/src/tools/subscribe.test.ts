import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { subscribeTool } from "./subscribe.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

async function freshBackbone(): Promise<InMemoryBackbone> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  return backbone;
}

/** Parse the `{ cursor }` envelope subscribe returns. */
function cursorOf(
  result: Awaited<ReturnType<typeof subscribeTool.handle>>,
): number {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return (
    JSON.parse((first as { type: "text"; text: string }).text) as {
      cursor: number;
    }
  ).cursor;
}

describe("caucus_subscribe", () => {
  it("mints a cursor at the current head after K appends", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    // Use the session's own write path to seed messages with valid ids.
    await session.post({ type: "note", body: "one" });
    await session.post({ type: "note", body: "two" });
    await session.post({ type: "note", body: "three" });

    const cursor = cursorOf(await subscribeTool.handle(session, {}));
    const { head } = await backbone.describeChannel("incident-1");
    expect(cursor).toBe(head);
    expect(cursor).toBe(3);
  });

  it("returns only what arrives after the bookmark (AC2 core)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await session.post({ type: "note", body: "before" });

    const cursor = cursorOf(await subscribeTool.handle(session, {}));

    await session.post({ type: "note", body: "after-1" });
    await session.post({ type: "note", body: "after-2" });

    const { messages } = await backbone.readSince("incident-1", cursor);
    expect(messages).toHaveLength(2);
    expect(messages.map((m: AppendedMessage) => m.body)).toEqual([
      "after-1",
      "after-2",
    ]);
  });

  it("posts nothing — read-only (ADR-C6)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await subscribeTool.handle(session, {});
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });

  it("propagates an unknown-channel error (deliberate divergence from read-channel)", async () => {
    const backbone = new InMemoryBackbone(); // channel NOT created
    const session = createSession(config, backbone);

    await expect(subscribeTool.handle(session, {})).rejects.toThrow();
  });
});
