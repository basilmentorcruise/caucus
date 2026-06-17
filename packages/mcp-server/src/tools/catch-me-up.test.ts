/**
 * Unit tests for the `caucus_catch_me_up` tool (CAU-19) — the I/O seam over the
 * pure projection. Covers A1 (unknown channel → empty digest), A2 (read-only:
 * head unchanged), A3 (windowing + multi-page drain).
 */
import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import { newMsgId, type MessageInput } from "@caucus/schema";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { catchMeUpTool } from "./catch-me-up.js";
import type { DigestStructured } from "../digest.js";

/** A `finding` MessageInput for `agent`/`owner` with a fresh ULID. */
function finding(agentId: string, owner: string, body: string): MessageInput {
  return { type: "finding", agent_id: agentId, owner, msg_id: newMsgId(), body };
}

/** A `claim` MessageInput for `target` (goes through `backbone.claim`). */
function claimMsg(agentId: string, owner: string, target: string): MessageInput {
  return {
    type: "claim",
    agent_id: agentId,
    owner,
    msg_id: newMsgId(),
    body: `claiming ${target}`,
    target,
  };
}

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

/** Parse the structured JSON envelope from a tool result. */
function structured(result: Awaited<ReturnType<typeof catchMeUpTool.handle>>): DigestStructured {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

/** The markdown text from a tool result. */
function markdown(result: Awaited<ReturnType<typeof catchMeUpTool.handle>>): string {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return (first as { type: "text"; text: string }).text;
}

async function createdSession(opts?: { maxReadLimit?: number }): Promise<{
  backbone: InMemoryBackbone;
  session: ReturnType<typeof createSession>;
}> {
  const backbone = new InMemoryBackbone(opts);
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test catch-up",
    created_by: "alice",
  });
  return { backbone, session: createSession(config, backbone) };
}

describe("caucus_catch_me_up (A1 — unknown channel tolerance)", () => {
  it("a not-yet-created channel yields an empty digest, not an error", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const d = structured(await catchMeUpTool.handle(session, {}));
    expect(d.window).toEqual({ from_cursor: 0, to_cursor: 0, message_count: 0 });
    expect(d.by_participant).toEqual([]);
    expect(d.key_findings).toEqual([]);
  });

  it("an unknown channel still renders a valid markdown skeleton (C4)", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);
    const md = markdown(await catchMeUpTool.handle(session, { format: "markdown" }));
    // H1 is the channel identity; the hyphen is no longer escaped (mid-line).
    expect(md).toContain("# incident-1");
    expect(md).toContain("_Caucus war-room digest._");
    expect(md).toContain("_No findings yet._");
    expect(md).toContain("resume with since=0");
  });
});

describe("caucus_catch_me_up (A2 — read-only)", () => {
  it("does not advance the channel head", async () => {
    const { backbone, session } = await createdSession();
    await backbone.append("incident-1", finding("agent-1", "alice", "a finding"));
    const before = (await backbone.describeChannel("incident-1")).head;

    await catchMeUpTool.handle(session, {});
    await catchMeUpTool.handle(session, { format: "markdown" });

    const after = (await backbone.describeChannel("incident-1")).head;
    expect(after - before).toBe(0);
  });
});

describe("caucus_catch_me_up (A3 — windowing)", () => {
  it("a digest from the returned to_cursor reflects ONLY the new messages", async () => {
    const { backbone, session } = await createdSession();
    await backbone.append("incident-1", finding("agent-1", "alice", "first"));
    await backbone.append("incident-1", finding("agent-1", "alice", "second"));

    const d1 = structured(await catchMeUpTool.handle(session, {}));
    expect(d1.window.message_count).toBe(2);
    const resume = d1.window.to_cursor;

    // Two more after the first catch-up.
    await backbone.append("incident-1", finding("agent-2", "bob", "third"));
    await backbone.claim("incident-1", claimMsg("agent-2", "bob", "auth-svc"));

    const d2 = structured(await catchMeUpTool.handle(session, { since: resume }));
    expect(d2.window.from_cursor).toBe(resume);
    expect(d2.window.message_count).toBe(2);
    expect(d2.by_type.finding).toBe(1);
    expect(d2.by_type.claim).toBe(1);
    // bob is the only participant in the incremental window.
    expect(d2.by_participant.map((p) => p.owner)).toEqual(["bob"]);
    expect(d2.open_claims.map((c) => c.target)).toEqual(["auth-svc"]);
  });

  it("drains a multi-page backlog so the digest covers the WHOLE window", async () => {
    // maxReadLimit 2 forces ≥3 pages for 5 messages.
    const { backbone, session } = await createdSession({ maxReadLimit: 2 });
    for (let i = 0; i < 5; i++) {
      await backbone.append("incident-1", finding("agent-1", "alice", `finding ${i}`));
    }

    const d = structured(await catchMeUpTool.handle(session, {}));
    expect(d.window.message_count).toBe(5);
    expect(d.by_type.finding).toBe(5);
    expect(d.window.to_cursor).toBe(5);
  });
});

describe("caucus_catch_me_up (markdown title from descriptor)", () => {
  it("uses the channel purpose in the title", async () => {
    const { backbone, session } = await createdSession();
    await backbone.append("incident-1", finding("agent-1", "alice", "found it"));
    const md = markdown(await catchMeUpTool.handle(session, { format: "markdown" }));
    // H1 is `# channel — purpose`; hyphens are no longer escaped (mid-line).
    expect(md).toContain("# incident-1 — test catch-up");
    expect(md).toContain("found it");
  });
});
