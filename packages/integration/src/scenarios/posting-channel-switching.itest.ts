/**
 * Integration scenario — posting-channel switching (CAU-92) over a REAL HTTP
 * backbone, driven through REAL {@link CaucusSession}s (the layer that owns the
 * per-call `channel` override + join-gate).
 *
 * The join-gate lives in the mcp-server session, not the backbone — so this
 * scenario stands up two sessions (distinct token-anchored identities) over the
 * wire-backed {@link httpConnector} backbone and exercises the eight CAU-92 ACs
 * end-to-end:
 *
 *  - **Cross-room post** — session-1 (home A) JOINS B via caucus_join_channel,
 *    then caucus_post_finding({channel:B}); reading B back over the wire shows
 *    the finding, stamped session-1's server-anchored identity (ADR-C7).
 *  - **Per-channel ledgers** — session-1 claims T in B; session-2 (home B)
 *    claims T in B → loses (already_claimed); session-1 claims T in A → granted
 *    (independent ledgers).
 *  - **Guard-rail negative** — a never-joined channel:X post is rejected with a
 *    value-free NotJoinedError (no channel/body in the message — ADR-C12) and
 *    X's head is unchanged.
 *  - **Hook consistency** — after the cross-post, caucus_status still reports A,
 *    caucus_subscribe bookmarks A, and the home (sessionId, A) checkpoint is
 *    never advanced toward B (status/subscribe both key off session.channel).
 *  - **Seatbelt isolation** — with a low injected per-channel cap, filling A's
 *    window still admits a cross-post into B (separate per-(channel, agent_id)
 *    window).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimitedError } from "@caucus/backbone";
import {
  createSession,
  NotJoinedError,
  postFindingTool,
  claimTool,
  statusTool,
  subscribeTool,
  joinChannelTool,
  type CaucusSession,
} from "@caucus/mcp-server";

import { httpConnector, identityForId, type Connector } from "../index.js";

/** Two rooms: A is session-1's home, B is session-2's home. */
const A = "incident-room-a";
const B = "incident-room-b";

/** Parse a tool result's JSON text envelope (asserting it's not an error). */
function envelope<T>(result: { isError?: boolean; content: unknown[] }): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  return JSON.parse(first.text) as T;
}

interface GrantedClaim {
  outcome: "granted";
  msg_id: string;
  cursor: number;
}
interface TakenClaim {
  outcome: "already_claimed";
  by: { agent_id: string; owner: string };
}
interface StatusReport {
  agent_id: string;
  owner: string;
  channel: string;
  head: number | null;
}

describe("CAU-92 posting-channel switching over HTTP", () => {
  // A LOW per-(channel, agent) seatbelt cap so the isolation AC can fill a
  // channel's window cheaply; the agent-global cap is left high so it is the
  // per-channel window — not the global one — that gates the test.
  const connector: Connector = httpConnector({
    maxPostsPerMinute: 3,
    // Keep the agent-global cap high so it is the per-(channel, agent) window —
    // not the cross-channel global one — that gates the seatbelt-isolation AC.
    globalMaxPostsPerMinute: 1_000,
  });
  let s1: CaucusSession; // home A, identity alice
  let s2: CaucusSession; // home B, identity bob

  beforeAll(async () => {
    await connector.boot();
    const alice = await connector.connectClient("alice");
    const bob = await connector.connectClient("bob");
    // Each session's identity matches the bearer the HttpBackbone carries, so
    // the server's anchored identity == the session config identity.
    s1 = createSession({ identity: identityForId("alice"), channel: A }, alice.backbone);
    s2 = createSession({ identity: identityForId("bob"), channel: B }, bob.backbone);

    // Create both rooms over the wire (createChannel is itself token-gated).
    await s1.createChannel({ channel: A, purpose: "room A" });
    await s2.createChannel({ channel: B, purpose: "room B" });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  it("guard-rail: a never-joined channel:B post is rejected value-free; B head unchanged", async () => {
    const beforeHead = (await s1.reader.describeChannel(B)).head;

    let thrown: unknown;
    await postFindingTool
      .handle(s1, { body: "secret-leak-body", channel: B })
      .catch((e) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(NotJoinedError);
    // ADR-C12: the error carries no caller content.
    const message = (thrown as Error).message;
    expect(message).not.toContain(B);
    expect(message).not.toContain("secret-leak-body");

    // The gate fired before the backbone — B never moved.
    const afterHead = (await s1.reader.describeChannel(B)).head;
    expect(afterHead).toBe(beforeHead);
  });

  it("after caucus_join_channel(B), session-1 posts a finding into B, stamped its identity", async () => {
    const before = (await s1.reader.describeChannel(B)).head;

    // The deliberate join opens the gate for B.
    const joined = envelope<{ channel: string; cursor: number }>(
      await joinChannelTool.handle(s1, { channel: B }),
    );
    expect(joined.channel).toBe(B);

    await postFindingTool.handle(s1, {
      body: "cross-room finding from session-1",
      channel: B,
    });

    // Read B back OVER THE WIRE: the finding is present and stamped session-1's
    // SERVER-ANCHORED identity (ADR-C7), regardless of its home being A.
    const read = await s2.reader.readSince(B, before);
    const cross = read.messages.find(
      (m) => m.body === "cross-room finding from session-1",
    );
    expect(cross).toBeDefined();
    expect(cross?.type).toBe("finding");
    expect(cross?.owner).toBe("alice");
    expect(cross?.agent_id).toBe("alice-agent");
  });

  it("per-channel ledgers: T claimed in B by s1 beats s2; T still claimable in A by s1", async () => {
    const TARGET = "shared-hypothesis";

    // session-1 already joined B above; it claims T in B and wins.
    const s1InB = envelope<GrantedClaim>(
      await claimTool.handle(s1, { target: TARGET, channel: B }),
    );
    expect(s1InB.outcome).toBe("granted");

    // session-2 (home B) claims the same T in its OWN home B → loses.
    const s2InB = envelope<TakenClaim>(
      await claimTool.handle(s2, { target: TARGET }),
    );
    expect(s2InB.outcome).toBe("already_claimed");
    expect(s2InB.by.owner).toBe("alice"); // the cross-poster holds it

    // Per-channel ledgers: the SAME T is independently claimable in A (s1 home).
    const s1InA = envelope<GrantedClaim>(
      await claimTool.handle(s1, { target: TARGET }),
    );
    expect(s1InA.outcome).toBe("granted");
  });

  it("hook consistency: caucus_status + caucus_subscribe still key off home A after the cross-post", async () => {
    // caucus_status reports the HOME channel A — never the cross-post target B.
    const status = envelope<StatusReport>(await statusTool.handle(s1, {}));
    expect(status.channel).toBe(A);
    expect(status.agent_id).toBe("alice-agent");
    expect(status.owner).toBe("alice");

    // caucus_subscribe bookmarks A at A's head — the checkpoint the out-of-
    // process hook follows. It must equal A's head, NOT B's, proving the
    // cross-post never advanced the (sessionId, A) checkpoint toward B.
    const headA = (await s1.reader.describeChannel(A)).head;
    const headB = (await s1.reader.describeChannel(B)).head;
    const { cursor } = envelope<{ cursor: number }>(
      await subscribeTool.handle(s1, {}),
    );
    expect(cursor).toBe(headA);
    // B has had cross-room writes; A's bookmark must be unrelated to B's head.
    expect(cursor).not.toBe(headB);
  });

  it("seatbelt isolation: filling A's per-channel window still admits a cross-post into B", async () => {
    // Use a fresh pair of rooms so this test's window accounting is clean.
    const A2 = "seatbelt-home-a";
    const B2 = "seatbelt-room-b";
    const alice2 = await connector.connectClient("alice");
    const carol = await connector.connectClient("carol");
    const home = createSession(
      { identity: identityForId("alice"), channel: A2 },
      alice2.backbone,
    );
    const other = createSession(
      { identity: identityForId("carol"), channel: B2 },
      carol.backbone,
    );
    await home.createChannel({ channel: A2, purpose: "seatbelt home" });
    await other.createChannel({ channel: B2, purpose: "seatbelt other" });
    // Join B2 through the real tool to open home's cross-room posting gate.
    await joinChannelTool.handle(home, { channel: B2 });

    // Fill A2's per-(channel, alice) window (cap = 3) with home posts.
    for (let i = 0; i < 3; i++) {
      await postFindingTool.handle(home, { body: `home fill ${i}` });
    }
    // The 4th HOME post must be rate-limited (A2's window is full).
    await expect(
      postFindingTool.handle(home, { body: "over the home cap" }),
    ).rejects.toBeInstanceOf(RateLimitedError);

    // ...but a cross-post into B2 is charged against B2's SEPARATE
    // per-(channel, alice) window, so it is admitted.
    const beforeB2 = (await home.reader.describeChannel(B2)).head;
    await postFindingTool.handle(home, {
      body: "cross-post under a separate window",
      channel: B2,
    });
    const afterB2 = (await home.reader.describeChannel(B2)).head;
    expect(afterB2).toBe(beforeB2 + 1);
  });
});
