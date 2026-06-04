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

  describe("AC2 — identity cannot be bypassed (type-enforced write narrowing)", () => {
    it("exposes only read methods on the reader's declared surface", async () => {
      const backbone = await freshBackbone();
      const session = createSession(config, backbone);

      // The reader is a delegating wrapper, not the backbone reference: the
      // four read methods are reachable, and the write paths are absent at
      // RUNTIME too — even a tool that casts the reader finds no
      // append/claim/createChannel on it.
      expect(typeof session.reader.describeChannel).toBe("function");
      expect(typeof session.reader.readSince).toBe("function");
      expect(typeof session.reader.listChannels).toBe("function");
      expect(typeof session.reader.subscribe).toBe("function");
      const cast = session.reader as Record<string, unknown>;
      expect(cast["append"]).toBeUndefined();
      expect(cast["claim"]).toBeUndefined();
      expect(cast["createChannel"]).toBeUndefined();
    });

    it("type-rejects reaching append/claim/createChannel off the session surface", async () => {
      const backbone = await freshBackbone();
      const session = createSession(config, backbone);

      // Compile-time probe: a tool holding a CaucusSession cannot reach the
      // write paths. Each `@ts-expect-error` REQUIRES the line below it to be a
      // type error; if the narrowing regresses (reader widened back to the full
      // Backbone, or the raw backbone re-exposed) these stop erroring and the
      // suite fails to typecheck. This — not a runtime check — is what makes
      // AC2 a type-enforced invariant rather than a convention.

      // @ts-expect-error append is not on the session
      void session.append;
      // @ts-expect-error append (forge an identity) is not on the reader
      void session.reader.append;
      // @ts-expect-error the claim-ledger write is not on the reader
      void session.reader.claim;
      // @ts-expect-error createChannel is not on the reader
      void session.reader.createChannel;
      // @ts-expect-error the raw backbone is no longer exposed under this name
      void session.backbone;

      // Touch the session so the test has a runtime assertion too.
      expect(session.channel).toBe("incident-1");
    });
  });
});
