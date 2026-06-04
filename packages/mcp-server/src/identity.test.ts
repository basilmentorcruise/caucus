import { describe, expect, it } from "vitest";
import { isUlid, type MessageInput } from "@caucus/schema";
import type { SessionIdentity } from "./config.js";
import { stampIdentity, type ToolMessageDraft } from "./identity.js";

const identity: SessionIdentity = { agent_id: "agent-1", owner: "alice" };

describe("stampIdentity", () => {
  it("welds the session identity and a fresh ULID msg_id onto a draft", () => {
    const draft: ToolMessageDraft = { type: "note", body: "hello" };
    const stamped = stampIdentity(identity, draft);

    expect(stamped.agent_id).toBe("agent-1");
    expect(stamped.owner).toBe("alice");
    expect(stamped.type).toBe("note");
    expect(stamped.body).toBe("hello");
    expect(isUlid(stamped.msg_id)).toBe(true);
  });

  it("overwrites any forged identity smuggled in on the draft", () => {
    // Force-cast a draft carrying identity fields the type forbids; the runtime
    // spread-after must still win.
    const forged = {
      type: "note",
      body: "spoofed",
      agent_id: "attacker",
      owner: "mallory",
      msg_id: "FORGED",
    } as unknown as ToolMessageDraft;

    const stamped = stampIdentity(identity, forged);

    expect(stamped.agent_id).toBe("agent-1");
    expect(stamped.owner).toBe("alice");
    expect(stamped.msg_id).not.toBe("FORGED");
    expect(isUlid(stamped.msg_id)).toBe(true);
  });

  it("mints a distinct msg_id on each call", () => {
    const draft: ToolMessageDraft = { type: "note", body: "x" };
    const a = stampIdentity(identity, draft);
    const b = stampIdentity(identity, draft);
    expect(a.msg_id).not.toBe(b.msg_id);
  });

  it("preserves claim-specific fields on a claim draft", () => {
    const draft = {
      type: "claim",
      body: "claiming",
      target: "hypothesis-7",
    } as ToolMessageDraft;
    const stamped = stampIdentity(identity, draft) as Extract<
      MessageInput,
      { type: "claim" }
    >;
    expect(stamped.type).toBe("claim");
    expect(stamped.target).toBe("hypothesis-7");
  });
});
