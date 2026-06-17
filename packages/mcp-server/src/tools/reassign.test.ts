/**
 * `caucus_reassign` tool unit tests (CAU-18).
 *
 * Drive the tool against a real {@link InMemoryBackbone} through two sessions
 * (alice = holder, bob = assignee). Covers: a holder reassigns to a named
 * assignee (granted; the ledger then names bob); a non-holder is rejected
 * (already_claimed, ledger unchanged); the assignee identity is poster-asserted
 * data, not the caller's anchored identity; and result strings stay value-free
 * with control bytes stripped (ADR-C12 / CAU-73).
 */
import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { claimTool } from "./claim.js";
import { reassignTool } from "./reassign.js";

// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

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

function envelope<T>(result: Awaited<ReturnType<typeof reassignTool.handle>>): T {
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

describe("caucus_reassign", () => {
  it("the holder reassigns to a named assignee → granted; the ledger names the assignee", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);

    await claimTool.handle(alice, { target: "db-pool" });
    const env = envelope<GrantedEnvelope>(
      await reassignTool.handle(alice, {
        target: "db-pool",
        assignee_owner: "bob",
        assignee_agent: "agent-2",
      }),
    );
    expect(env.outcome).toBe("granted");

    // A third party now finds BOB holding it (the ledger points at the assignee).
    const probe = await backbone.claim("incident-1", {
      type: "claim",
      agent_id: "agent-3",
      owner: "carol",
      msg_id: "01J0000000000000000000000C",
      body: "claiming",
      target: "db-pool",
    });
    expect(probe.outcome).toBe("already_claimed");
    if (probe.outcome !== "already_claimed") throw new Error("unreachable");
    expect(probe.by.owner).toBe("bob");
    expect(probe.by.agent_id).toBe("agent-2");
  });

  it("a non-holder reassign attempt → already_claimed naming the holder; ledger unchanged", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);
    const mallory = createSession(malloryCfg, backbone);

    await claimTool.handle(alice, { target: "db-pool" });
    const headBefore = (await backbone.describeChannel("incident-1")).head;

    const env = envelope<TakenEnvelope>(
      await reassignTool.handle(mallory, {
        target: "db-pool",
        assignee_owner: "mallory",
        assignee_agent: "agent-m",
      }),
    );
    expect(env.outcome).toBe("already_claimed");
    expect(env.by.owner).toBe("alice");
    // No message appended on a rejected reassign.
    expect((await backbone.describeChannel("incident-1")).head).toBe(headBefore);
  });

  it("the appended message is authored by the AUTHENTICATED holder, not the assignee", async () => {
    const backbone = await freshBackbone();
    const alice = createSession(aliceCfg, backbone);

    await claimTool.handle(alice, { target: "db-pool" });
    const head = (await backbone.describeChannel("incident-1")).head;
    await reassignTool.handle(alice, {
      target: "db-pool",
      assignee_owner: "bob",
      assignee_agent: "agent-2",
    });
    const { messages } = await backbone.readSince("incident-1", head - 1);
    const reassignMsg = messages[messages.length - 1];
    // Identity on the message is alice's (anchored caller), never bob's.
    expect(reassignMsg?.owner).toBe("alice");
    expect(reassignMsg?.agent_id).toBe("agent-1");
  });

  it("sanitizes control bytes out of the already_claimed holder identity (CAU-73)", async () => {
    // The write path REJECTS control bytes (CAU-71), so the read-side layer is
    // exercised against a stub whose ledger already holds dirty identity bytes —
    // proving the reassign tool strips them before they reach the caller's model.
    const backbone = {
      reassignClaim: () =>
        Promise.resolve({
          outcome: "already_claimed" as const,
          by: {
            agent_id: "evil\x9b\x1b[2J",
            owner: "mallory\x1b]0;pwned\x07",
            ts: "2026-06-09T00:00:00.000Z#000000000001",
            msg_id: "01J0000000000000000000000A",
          },
        }),
    } as unknown as InMemoryBackbone;
    const mallory = createSession(malloryCfg, backbone);
    const result = await reassignTool.handle(mallory, {
      target: "db-pool",
      assignee_owner: "mallory",
      assignee_agent: "agent-m",
    });
    const raw = (result.content[0] as { type: "text"; text: string }).text;
    expect(raw).not.toMatch(CONTROL_CHARS);
    const env = JSON.parse(raw) as TakenEnvelope;
    expect(env.outcome).toBe("already_claimed");
    expect(CONTROL_CHARS.test(env.by.owner)).toBe(false);
    expect(CONTROL_CHARS.test(env.by.agent_id)).toBe(false);
  });
});
