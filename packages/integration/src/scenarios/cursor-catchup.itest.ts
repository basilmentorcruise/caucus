/**
 * Integration scenario — subscribe mints at head; cross-client claim-grant
 * visibility (CAU-25, ADR-C5).
 *
 * Alice appends a finding BEFORE bob subscribes. Bob's subscription mints at the
 * current head, so that pre-subscription finding is invisible to him. Alice then
 * claims a target; bob's `readSince` from his cursor sees EXACTLY the claim
 * message (one message), with the correct agent_id / owner / target — i.e. a
 * claim one client wins is visible to the other through the shared log.
 */
import type { Cursor } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inProcessConnector,
  type ClientHandle,
  claimMsg,
  finding,
} from "../index.js";

const CH = "incident-catchup";
const TARGET = "auth-service";

const connector = inProcessConnector();
let alice: ClientHandle;
let bob: ClientHandle;

beforeAll(async () => {
  await connector.boot();
  alice = await connector.connectClient("alice");
  bob = await connector.connectClient("bob");
  await alice.backbone.createChannel({
    channel: CH,
    purpose: "subscribe-at-head + cross-client claim visibility",
    created_by: "alice",
  });
});

afterAll(async () => {
  await connector.teardown();
});

describe("subscribe mints at head (ADR-C5 cross-client claim visibility)", () => {
  it("bob misses the pre-subscription finding but sees alice's later claim", async () => {
    // Alice appends BEFORE bob subscribes.
    await alice.backbone.append(
      CH,
      finding("alice-agent", "alice", { body: "pre-subscribe finding" }),
    );

    // Bob subscribes now: cursor mints at head, so the prior finding is invisible.
    const bobCursor: Cursor = await bob.backbone.subscribe(CH);

    // Alice claims a target after bob subscribed.
    const claim = await alice.backbone.claim(
      CH,
      claimMsg("alice-agent", "alice", TARGET),
    );
    if (claim.outcome !== "granted") throw new Error("claim should be granted");

    // Bob's read from his cursor sees EXACTLY the claim — not the earlier finding.
    const bobRead = await bob.backbone.readSince(CH, bobCursor);
    expect(bobRead.messages).toHaveLength(1);

    const seen = bobRead.messages[0]!;
    expect(seen.type).toBe("claim");
    expect(seen.msg_id).toBe(claim.message.msg_id);
    expect(seen.agent_id).toBe("alice-agent");
    expect(seen.owner).toBe("alice");
    if (seen.type === "claim") {
      expect(seen.target).toBe(TARGET);
    }
    expect(bobRead.cursor).toBe(bobCursor + 1);
  });

  it.todo(
    "seatbelt: a rate-cap rejection on one client does not block the other " +
      "(CAU-6/8 — implement once seatbelts land)",
  );
});
