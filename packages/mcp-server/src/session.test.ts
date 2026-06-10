import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ServerConfig } from "./config.js";
import { createSession } from "./session.js";
import { NotJoinedError } from "./errors.js";

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

  describe("createChannel() — sanctioned write, owner anchored server-side (CAU-12)", () => {
    it("creates a channel attributed to the session owner (created_by cannot be forged)", async () => {
      const backbone = new InMemoryBackbone();
      const session = createSession(config, backbone);

      const descriptor = await session.createChannel({
        channel: "war-room-2",
        purpose: "checkout 500s",
      });
      expect(descriptor.channel).toBe("war-room-2");
      expect(descriptor.purpose).toBe("checkout 500s");
      // Owner is taken from the session identity, NOT supplied by the caller:
      // SessionCreateChannelOptions has no created_by field to forge.
      expect(descriptor.created_by).toBe("alice");
      expect(descriptor.kind).toBe("ephemeral");

      // It really landed on the backbone.
      const described = await backbone.describeChannel("war-room-2");
      expect(described.created_by).toBe("alice");
    });

    it("propagates ChannelExistsError when the channel already exists", async () => {
      const backbone = await freshBackbone(); // "incident-1" already created
      const session = createSession(config, backbone);

      await expect(
        session.createChannel({ channel: "incident-1", purpose: "dup" }),
      ).rejects.toThrow();
    });
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

  describe("CAU-92 — per-call channel override + join-gate", () => {
    /** A backbone with home (`incident-1`) and a second room (`war-room-2`). */
    async function twoRoomBackbone(): Promise<InMemoryBackbone> {
      const backbone = new InMemoryBackbone();
      await backbone.createChannel({
        channel: "incident-1",
        purpose: "home",
        created_by: "alice",
      });
      await backbone.createChannel({
        channel: "war-room-2",
        purpose: "other",
        created_by: "carol",
      });
      return backbone;
    }

    it("post(draft, 'war-room-2') routes to that room once joined, stamped server-side", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);
      session.noteJoined("war-room-2");

      const result = await session.post(
        { type: "finding", body: "cross-room finding" },
        "war-room-2",
      );
      // Identity is welded server-side regardless of target.
      expect(result.message.agent_id).toBe("agent-1");
      expect(result.message.owner).toBe("alice");

      // It landed in war-room-2, NOT home.
      const there = await backbone.readSince("war-room-2", 0);
      expect(there.messages).toHaveLength(1);
      expect(there.messages[0]?.body).toBe("cross-room finding");
      expect(there.messages[0]?.agent_id).toBe("agent-1");
      expect(there.messages[0]?.owner).toBe("alice");

      const home = await backbone.readSince("incident-1", 0);
      expect(home.messages).toHaveLength(0);
    });

    it("claim(draft, 'war-room-2') writes that room's ledger once joined", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);
      session.noteJoined("war-room-2");

      const result = await session.claim(
        { type: "claim", body: "I'll take this", target: "hypothesis-7" },
        "war-room-2",
      );
      expect(result.outcome).toBe("granted");

      // The granted claim is in war-room-2's log, not home's.
      const there = await backbone.readSince("war-room-2", 0);
      expect(there.messages).toHaveLength(1);
      expect(there.messages[0]?.type).toBe("claim");
      const home = await backbone.readSince("incident-1", 0);
      expect(home.messages).toHaveLength(0);
    });

    it("post(draft, 'war-room-2') throws NotJoinedError when NOT joined — head unchanged", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);
      // Deliberately NOT joined.

      let thrown: unknown;
      await session
        .post({ type: "finding", body: "should be rejected" }, "war-room-2")
        .catch((e) => {
          thrown = e;
        });
      expect(thrown).toBeInstanceOf(NotJoinedError);
      expect((thrown as NotJoinedError).code).toBe("not_joined");
      // Value-free (ADR-C12): the message names neither the target nor the body.
      const message = (thrown as Error).message;
      expect(message).not.toContain("war-room-2");
      expect(message).not.toContain("should be rejected");

      // Nothing was appended to the target — the gate fires BEFORE the backbone.
      const there = await backbone.readSince("war-room-2", 0);
      expect(there.messages).toHaveLength(0);
    });

    it("claim(draft, 'war-room-2') throws NotJoinedError when NOT joined — ledger untouched", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);

      await expect(
        session.claim(
          { type: "claim", body: "nope", target: "t" },
          "war-room-2",
        ),
      ).rejects.toBeInstanceOf(NotJoinedError);
      const there = await backbone.readSince("war-room-2", 0);
      expect(there.messages).toHaveLength(0);
    });

    it("post(draft) and post(draft, undefined) still go home (regression)", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);

      await session.post({ type: "note", body: "no target" });
      await session.post({ type: "note", body: "explicit undefined" }, undefined);

      const home = await backbone.readSince("incident-1", 0);
      expect(home.messages.map((m) => m.body)).toEqual([
        "no target",
        "explicit undefined",
      ]);
      const there = await backbone.readSince("war-room-2", 0);
      expect(there.messages).toHaveLength(0);
    });

    it("post(draft, home) is allowed without an explicit join (your own channel never needs a join)", async () => {
      const backbone = await twoRoomBackbone();
      const session = createSession(config, backbone);

      await session.post({ type: "note", body: "naming home explicitly" }, "incident-1");
      const home = await backbone.readSince("incident-1", 0);
      expect(home.messages).toHaveLength(1);
    });
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

      // createChannel is a SANCTIONED write: it MUST be reachable on the session
      // (no @ts-expect-error here — this line must typecheck) but NOT on the
      // reader (probed above). It's the create path the channel tools use, with
      // created_by anchored server-side.
      expect(typeof session.createChannel).toBe("function");

      // Touch the session so the test has a runtime assertion too.
      expect(session.channel).toBe("incident-1");
    });
  });
});
