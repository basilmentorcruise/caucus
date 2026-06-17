/**
 * Integration scenario — `caucus_catch_me_up` over a shared backbone (CAU-19).
 *
 * Posts a realistic mixed war-room log (findings, claims with a resolve, a
 * couple of questions with one resolving answer, a steer) through TWO clients on
 * ONE shared {@link inProcessConnector} backbone, then drives the REAL
 * {@link catchMeUpTool} through a {@link createSession} in BOTH formats:
 *
 *  - structured → assert the deterministic counts match the posted mix
 *    (by_type, by_participant, open/resolved claims, unanswered question), and
 *    that the digest is read-only (the channel head is unchanged after the call);
 *  - markdown → assert the postmortem-skeleton sections are present and ordered.
 *
 * It exercises the SAME read seam (`session.reader.readSince`) the tool uses, so
 * this is the end-to-end proof for AC E1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type DigestStructured } from "@caucus/mcp-server";
import type { ServerConfig } from "@caucus/mcp-server";
import { catchMeUpTool } from "@caucus/mcp-server";
import { newMsgId, type MessageInput } from "@caucus/schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { inProcessConnector, type ClientHandle, type Connector } from "../index.js";

const CH = "incident-catch-me-up";

/** A `finding` MessageInput for `agent`/`owner` with a fresh ULID. */
function finding(agentId: string, owner: string, body: string): MessageInput {
  return { type: "finding", agent_id: agentId, owner, msg_id: newMsgId(), body };
}
/** A `claim` MessageInput for `target` (goes through `backbone.claim`). */
function claimMsg(agentId: string, owner: string, target: string): MessageInput {
  return { type: "claim", agent_id: agentId, owner, msg_id: newMsgId(), body: `claiming ${target}`, target };
}

/** Parse the structured JSON envelope from a tool result (asserting not an error). */
function structured(result: CallToolResult): DigestStructured {
  expect(result.isError).toBeFalsy();
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return JSON.parse(first.text) as DigestStructured;
}
/** The markdown text from a tool result. */
function markdown(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return first.text;
}

describe("CAU-19 caucus_catch_me_up — in-process shared backbone", () => {
  const connector = inProcessConnector() as Connector;
  let alice: ClientHandle;
  let bob: ClientHandle;

  beforeAll(async () => {
    await connector.boot();
    alice = await connector.connectClient("alice");
    bob = await connector.connectClient("bob");
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "checkout 500s spike",
      created_by: "alice",
    });

    // A realistic mixed log on the shared backbone.
    await alice.backbone.append(CH, finding("alice-agent", "alice", "p99 latency spiked at 14:02"));
    await alice.backbone.claim(CH, claimMsg("alice-agent", "alice", "auth-service"));
    await bob.backbone.append(CH, finding("bob-agent", "bob", "error rate up on /checkout"));
    await bob.backbone.claim(CH, claimMsg("bob-agent", "bob", "db-pool"));

    // A question alice leaves open, and one bob answers (resolved).
    const q1: MessageInput = { type: "question", agent_id: "alice-agent", owner: "alice", msg_id: newMsgId(), body: "should we roll back?" };
    await alice.backbone.append(CH, q1);
    const q2: MessageInput = { type: "question", agent_id: "bob-agent", owner: "bob", msg_id: newMsgId(), body: "is the cache warm?" };
    await bob.backbone.append(CH, q2);
    await alice.backbone.append(CH, {
      type: "answer",
      agent_id: "alice-agent",
      owner: "alice",
      msg_id: newMsgId(),
      body: "yes, warmed at 14:05",
      reply_to: q2.msg_id,
      status: "resolved",
    });

    // bob resolves his claim; alice steers.
    await bob.backbone.markClaimDone(CH, claimMsg("bob-agent", "bob", "db-pool"));
    await alice.backbone.append(CH, { type: "steer", agent_id: "alice-agent", owner: "alice", msg_id: newMsgId(), body: "focus on auth first" });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  function session() {
    const config: ServerConfig = {
      identity: { agent_id: "reader-agent", owner: "reader" },
      channel: CH,
    };
    return createSession(config, alice.backbone);
  }

  it("structured digest counts match the posted mix and the read is read-only", async () => {
    const headBefore = (await alice.backbone.describeChannel(CH)).head;
    const d = structured(
      (await catchMeUpTool.handle(session(), {})) as CallToolResult,
    );

    // Read-only: the head did not move.
    const headAfter = (await alice.backbone.describeChannel(CH)).head;
    expect(headAfter).toBe(headBefore);

    // by_type sums to message_count.
    const sum =
      d.by_type.finding +
      d.by_type.claim +
      d.by_type.status +
      d.by_type.question +
      d.by_type.answer +
      d.by_type.note +
      d.by_type.steer;
    expect(sum).toBe(d.window.message_count);

    expect(d.by_type.finding).toBe(2);
    expect(d.by_type.question).toBe(2);
    expect(d.by_type.answer).toBe(1);
    expect(d.by_type.steer).toBe(1);
    // 2 fresh claims + 1 resolving (markClaimDone) done message = 3 claim msgs.
    expect(d.by_type.claim).toBe(3);

    // Participants: alice then bob (first-appearance order).
    expect(d.by_participant.map((p) => p.owner)).toEqual(["alice", "bob"]);

    // Claims: auth-service open (alice), db-pool resolved (bob).
    expect(d.open_claims.map((c) => c.target)).toEqual(["auth-service"]);
    expect(d.open_claims[0]!.holder.owner).toBe("alice");
    expect(d.resolved_claims.map((c) => c.target)).toEqual(["db-pool"]);

    // Questions: alice's roll-back question is unanswered; bob's cache question is answered.
    expect(d.unanswered_questions.map((u) => u.body)).toEqual(["should we roll back?"]);
    expect(d.answered_questions_count).toBe(1);
  });

  it("markdown export has the expected sections in order", async () => {
    const md = markdown(
      (await catchMeUpTool.handle(session(), { format: "markdown" })) as CallToolResult,
    );

    // H1 is the incident identity (channel — purpose); hyphens are no longer
    // escaped (mid-line, not line-start-structural). The tool brand is a subtitle.
    expect(md).toContain("# incident-catch-me-up — checkout 500s spike");
    expect(md).toContain("_Caucus war-room digest._");
    const order = [
      "## Participants",
      "## Timeline of findings",
      "## Claims",
      "### Open",
      "### Resolved",
      "## Open questions",
      "## Counts",
    ];
    let prev = -1;
    for (const section of order) {
      const idx = md.indexOf(section);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    expect(md).toContain("p99 latency spiked at 14:02");
    // The claim target hyphen is no longer escaped (mid-line, not structural).
    expect(md).toContain("auth-service");
    expect(md).toContain("should we roll back?");
    expect(md).toMatch(/_Caucus digest · resume with since=\d+ · \d+ messages in this window\._/);
  });
});
