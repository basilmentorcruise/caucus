/**
 * Integration scenario — claim lifecycle end-to-end (CAU-18).
 *
 * Two distinct client handles onto the SAME backbone exercise the lifecycle
 * transitions across clients, driven by a DETERMINISTIC injected clock (so lease
 * expiry is exact, with no real timers or sleeps):
 *
 *  1. Expiry frees a target: agent A claims with a short lease; after the lease
 *     lapses (the injected clock advances past it) agent B's claim is GRANTED and
 *     the ledger now points at B — proving a dead/stuck holder's claim eventually
 *     frees for a second agent.
 *  2. Reassignment: A claims, then hands the live target to B; a third claim then
 *     reports B as the holder.
 *  3. Done: A claims, marks it done (posting a status:resolved message), and B
 *     can then claim the freed target.
 *
 * Runs over BOTH connectors where the clock is injectable. The expiry case
 * requires the deterministic clock, so it uses the in-process connector with an
 * injected clock; the reassign/done cases also run over a real HTTP server to
 * prove the new `/reassign` and `/done` routes work over the wire under anchored
 * identity (CAU-13).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimMsg,
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
} from "../index.js";

const CH = "incident-lifecycle";

describe("claim lifecycle — expiry frees the target (in-process, injected clock)", () => {
  // A mutable injected clock shared by the one shared backbone the connector boots.
  let nowMs = 1_000_000;
  const connector: Connector = inProcessConnector({ clock: () => nowMs });
  let a: ClientHandle;
  let b: ClientHandle;

  beforeAll(async () => {
    await connector.boot();
    a = await connector.connectClient("a");
    b = await connector.connectClient("b");
    await a.backbone.createChannel({
      channel: CH,
      purpose: "lifecycle",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  it("a lapsed lease frees the target for a SECOND agent across the shared backbone", async () => {
    // Agent A claims with a 30s lease.
    const claimed = await a.backbone.claim(
      CH,
      claimMsg("a-agent", "alice", "db-shard", { lease_ttl: 30 }),
    );
    expect(claimed.outcome).toBe("granted");

    // Before the lease lapses, agent B (a SEPARATE handle on the SAME backbone)
    // loses first-write-wins.
    nowMs += 29_000;
    const tooEarly = await b.backbone.claim(
      CH,
      claimMsg("b-agent", "bob", "db-shard"),
    );
    expect(tooEarly.outcome).toBe("already_claimed");
    if (tooEarly.outcome !== "already_claimed") throw new Error("unreachable");
    expect(tooEarly.by.owner).toBe("alice");

    // The lease lapses (>= boundary). Agent B's NEXT claim is granted, and the
    // ledger now points at B — the dead holder's claim freed lazily.
    nowMs += 1_000; // total +30s
    const reclaimed = await b.backbone.claim(
      CH,
      claimMsg("b-agent", "bob", "db-shard"),
    );
    expect(reclaimed.outcome).toBe("granted");

    // A third agent now sees BOB holding the freed target.
    const probe = await a.backbone.claim(
      CH,
      claimMsg("a-agent", "alice", "db-shard"),
    );
    expect(probe.outcome).toBe("already_claimed");
    if (probe.outcome !== "already_claimed") throw new Error("unreachable");
    expect(probe.by.owner).toBe("bob");
  });
});

// Reassign + done over BOTH connectors. The http connector provisions a bearer
// per client id and anchors identity server-side (CAU-13), so the holder/owner
// match is enforced on the wire too.
const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector()],
  ["http", () => httpConnector({}, ["alice", "bob"])],
];

describe.each(CONNECTORS)(
  "claim lifecycle — reassign + done (%s connector)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;
    let bob: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
      bob = await connector.connectClient("bob");
      await alice.backbone.createChannel({
        channel: CH,
        purpose: "lifecycle",
        created_by: "alice",
      });
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("reassign hands a held target to a new holder (visible on the read path)", async () => {
      const target = "reassign-target";
      const headBefore = (await alice.backbone.describeChannel(CH)).head;
      const claimed = await alice.backbone.claim(
        CH,
        claimMsg("alice-agent", "alice", target),
      );
      expect(claimed.outcome).toBe("granted");

      const reassigned = await alice.backbone.reassignClaim(
        CH,
        claimMsg("alice-agent", "alice", target),
        { agent_id: "bob-agent", owner: "bob" },
      );
      expect(reassigned.outcome).toBe("granted");

      // The ledger points at bob: anyone else now loses to bob.
      const probe = await bob.backbone.claim(
        CH,
        claimMsg("carol-agent", "carol", target),
      );
      expect(probe.outcome).toBe("already_claimed");
      if (probe.outcome !== "already_claimed") throw new Error("unreachable");
      expect(probe.by.owner).toBe("bob");

      // Both the claim and the reassignment are visible on the read path.
      const { messages } = await bob.backbone.readSince(CH, headBefore);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.every((m) => m.type === "claim")).toBe(true);
    });

    it("done frees a target and posts a status:resolved message; a non-holder cannot close it", async () => {
      const target = "done-target";
      const claimed = await alice.backbone.claim(
        CH,
        claimMsg("alice-agent", "alice", target),
      );
      expect(claimed.outcome).toBe("granted");

      // Bob (a different owner) cannot close alice's claim — no-op.
      const headBeforeForeign = (await alice.backbone.describeChannel(CH)).head;
      const foreignDone = await bob.backbone.markClaimDone(
        CH,
        claimMsg("bob-agent", "bob", target),
      );
      expect(foreignDone.outcome).toBe("already_claimed");
      expect((await alice.backbone.describeChannel(CH)).head).toBe(
        headBeforeForeign,
      );

      // Alice (the holder) marks it done: a status:resolved message is posted.
      const headBeforeDone = (await alice.backbone.describeChannel(CH)).head;
      const done = await alice.backbone.markClaimDone(
        CH,
        claimMsg("alice-agent", "alice", target),
      );
      expect(done.outcome).toBe("granted");
      const { messages } = await alice.backbone.readSince(CH, headBeforeDone);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.status).toBe("resolved");

      // The target is freed: bob can now claim it.
      const reclaim = await bob.backbone.claim(
        CH,
        claimMsg("bob-agent", "bob", target),
      );
      expect(reclaim.outcome).toBe("granted");
    });
  },
);
