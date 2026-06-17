/**
 * `caucus_mark_done` tool unit tests (CAU-18).
 *
 * Covers: the holder marks done (granted; a status:resolved message is posted;
 * the target is freed for re-claim); a non-holder is a no-op (already_claimed,
 * head unchanged); an unheld target → not_held; and value-free results
 * (ADR-C12).
 */
import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { claimTool } from "./claim.js";
import { markDoneTool } from "./mark-done.js";

const aliceCfg: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};
const malloryCfg: ServerConfig = {
  identity: { agent_id: "agent-m", owner: "mallory" },
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

function envelope<T>(result: Awaited<ReturnType<typeof markDoneTool.handle>>): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

interface GrantedEnvelope {
  outcome: "granted";
  msg_id: string;
  cursor: number;
}
interface TakenEnvelope {
  outcome: "already_claimed";
  by: { agent_id: string; owner: string; ts: string; msg_id: string };
}
interface NotHeldEnvelope {
  outcome: "not_held";
}

describe("caucus_mark_done", () => {
  it("the holder marks done → granted; posts a status:resolved message; frees the target", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);

    await claimTool.handle(alice, { target: "db-pool" });
    const head = (await backbone.describeChannel("incident-1")).head;

    const env = envelope<GrantedEnvelope>(
      await markDoneTool.handle(alice, { target: "db-pool", note: "fixed" }),
    );
    expect(env.outcome).toBe("granted");

    const { messages } = await backbone.readSince("incident-1", head);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("claim");
    expect(messages[0]?.status).toBe("resolved");

    // Freed: bob can now claim it.
    const next = await backbone.claim("incident-1", {
      type: "claim",
      agent_id: "agent-2",
      owner: "bob",
      msg_id: "01J0000000000000000000000B",
      body: "claiming",
      target: "db-pool",
    });
    expect(next.outcome).toBe("granted");
  });

  it("a non-holder done is a no-op → already_claimed, head unchanged", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);
    const mallory = createSession(malloryCfg, backbone);

    await claimTool.handle(alice, { target: "db-pool" });
    const headBefore = (await backbone.describeChannel("incident-1")).head;

    const env = envelope<TakenEnvelope>(
      await markDoneTool.handle(mallory, { target: "db-pool" }),
    );
    expect(env.outcome).toBe("already_claimed");
    expect(env.by.owner).toBe("alice");
    expect((await backbone.describeChannel("incident-1")).head).toBe(headBefore);
  });

  it("done on an unheld target → not_held, value-free", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);

    const env = envelope<NotHeldEnvelope>(
      await markDoneTool.handle(alice, { target: "ghost-target" }),
    );
    expect(env.outcome).toBe("not_held");
    expect(JSON.stringify(env)).not.toContain("ghost-target");
  });
});
