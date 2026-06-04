import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ServerConfig } from "./config.js";
import { createSession } from "./session.js";

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

describe("createSession", () => {
  it("exposes the resolved identity and channel", () => {
    const session = createSession(config, new InMemoryBackbone());
    expect(session.identity).toEqual({ agent_id: "agent-1", owner: "alice" });
    expect(session.channel).toBe("incident-1");
  });

  it("post() appends a message carrying the session identity", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const result = await session.post({ type: "note", body: "looking into it" });
    expect(result.message.agent_id).toBe("agent-1");
    expect(result.message.owner).toBe("alice");

    const { messages } = await backbone.readSince("incident-1", 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.agent_id).toBe("agent-1");
    expect(messages[0]?.owner).toBe("alice");
    expect(messages[0]?.body).toBe("looking into it");
  });

  it("claim() grants a claim message carrying the session identity", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const result = await session.claim({
      type: "claim",
      body: "I'll take this",
      target: "hypothesis-7",
    });
    expect(result.outcome).toBe("granted");
    if (result.outcome === "granted") {
      expect(result.message.agent_id).toBe("agent-1");
      expect(result.message.owner).toBe("alice");
      expect(result.message.type).toBe("claim");
    }
  });

  it("does NOT route claims through post() (append rejects claim-typed)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await expect(
      session.post({
        type: "claim",
        body: "wrong path",
        target: "hypothesis-9",
      } as Parameters<typeof session.post>[0]),
    ).rejects.toThrow();
  });
});
