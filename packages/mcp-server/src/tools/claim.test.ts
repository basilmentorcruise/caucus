import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import { isUlid, normalizeTarget, MalformedMessageError } from "@caucus/schema";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { claimTool } from "./claim.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

/** A second principal in the same channel — used to contend a claim. */
const config2: ServerConfig = {
  identity: { agent_id: "agent-2", owner: "bob" },
  channel: "incident-1",
};

/** A fresh backbone with the session channel created. */
async function freshBackbone(): Promise<InMemoryBackbone> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  return backbone;
}

/** Parse the JSON envelope a claim result carries. */
function envelope<T>(
  result: Awaited<ReturnType<typeof claimTool.handle>>,
): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

/** Read the full log back. */
async function readAll(
  backbone: InMemoryBackbone,
): Promise<readonly AppendedMessage[]> {
  const { messages } = await backbone.readSince("incident-1", 0);
  return messages;
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

describe("caucus_claim — granted", () => {
  it("returns granted with a ULID msg_id and the new head cursor", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const env = envelope<GrantedEnvelope>(
      await claimTool.handle(session, { target: "db-pool" }),
    );
    expect(env.outcome).toBe("granted");
    expect(isUlid(env.msg_id)).toBe(true);
    expect(env.cursor).toBe(1); // head moved 0 -> 1
  });

  it("lands a claim-typed message stamped with identity and a NORMALIZED target", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    // A whitespace/NFC-variant target: surrounding spaces + a decomposed "é".
    const raw = "  café-outage  ";
    const env = envelope<GrantedEnvelope>(
      await claimTool.handle(session, { target: raw }),
    );

    const [msg] = await readAll(backbone);
    expect(msg?.type).toBe("claim");
    expect(msg?.agent_id).toBe("agent-1");
    expect(msg?.owner).toBe("alice");
    expect(msg?.msg_id).toBe(env.msg_id);
    // Stored target is the normalized key, not the raw input.
    expect((msg as { target?: string }).target).toBe(normalizeTarget(raw));
    expect((msg as { target?: string }).target).not.toBe(raw);
  });

  it("derives body from note when present, else a default", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await claimTool.handle(session, {
      target: "db-pool",
      note: "  checking pool exhaustion  ",
    });
    await claimTool.handle(session, { target: "auth-timeout" });

    const messages = await readAll(backbone);
    expect(messages[0]?.body).toBe("checking pool exhaustion"); // trimmed note
    expect(messages[1]?.body).toBe("claiming auth-timeout"); // default
  });

  it("passes thread + reply_to through when present", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await claimTool.handle(session, {
      target: "db-pool",
      thread: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      reply_to: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    });

    const [msg] = await readAll(backbone);
    expect(msg?.thread).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(msg?.reply_to).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
  });

  it("omits absent optional fields", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    await claimTool.handle(session, { target: "db-pool" });

    const [msg] = await readAll(backbone);
    const stored = msg as AppendedMessage;
    expect("thread" in stored).toBe(false);
    expect("reply_to" in stored).toBe(false);
  });
});

describe("caucus_claim — already_claimed", () => {
  it("a second principal claiming the same target loses, naming the first claimer — NOT isError", async () => {
    const backbone = await freshBackbone();
    const first = createSession(config, backbone);
    const second = createSession(config2, backbone);

    await claimTool.handle(first, { target: "db-pool" });

    const result = await claimTool.handle(second, { target: "db-pool" });
    // Losing a claim is a normal result, never an error.
    expect(result.isError).toBeFalsy();
    const env = envelope<TakenEnvelope>(result);
    expect(env.outcome).toBe("already_claimed");
    expect(env.by.agent_id).toBe("agent-1"); // the FIRST claimer
    expect(env.by.owner).toBe("alice");
    expect(isUlid(env.by.msg_id)).toBe(true);
  });

  it("a lost claim appends nothing (head unchanged)", async () => {
    const backbone = await freshBackbone();
    const first = createSession(config, backbone);
    const second = createSession(config2, backbone);

    await claimTool.handle(first, { target: "db-pool" });
    const before = (await readAll(backbone)).length;

    await claimTool.handle(second, { target: "db-pool" });
    const after = (await readAll(backbone)).length;
    expect(after).toBe(before); // no second append
    expect(after).toBe(1);
  });

  it("a normalized-variant target still collides (dedup not dodged by spacing/NFC)", async () => {
    const backbone = await freshBackbone();
    const first = createSession(config, backbone);
    const second = createSession(config2, backbone);

    await claimTool.handle(first, { target: "café-outage" }); // precomposed
    const result = await claimTool.handle(second, {
      target: "  café-outage  ", // decomposed + spaces
    });
    const env = envelope<TakenEnvelope>(result);
    expect(env.outcome).toBe("already_claimed");
    expect(env.by.agent_id).toBe("agent-1");
  });
});

describe("caucus_claim — errors propagate (ADR-C12, value-free)", () => {
  it("rejects a whitespace-only target without echoing it, and appends nothing", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    // The tool normalizes (trim + NFC) before drafting, so an all-whitespace
    // target is rejected at the schema's `normalizeTarget` — a value-free
    // MalformedMessageError that propagates untouched (ADR-C12). Either way it
    // never reaches the ledger.
    let thrown: unknown;
    await claimTool
      .handle(session, { target: "   \t\n  " })
      .catch((e) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(MalformedMessageError);
    // The error names no offending value.
    expect((thrown as Error).message).not.toMatch(/\t|\n/);
    // No message was appended.
    expect((await readAll(backbone)).length).toBe(0);
  });

  it("propagates an unknown-channel error", async () => {
    const backbone = new InMemoryBackbone(); // channel NOT created
    const session = createSession(config, backbone);

    await expect(
      claimTool.handle(session, { target: "db-pool" }),
    ).rejects.toThrow();
  });
});
