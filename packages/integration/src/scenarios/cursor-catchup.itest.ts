/**
 * Integration scenario — subscribe mints at head; cross-client claim-grant
 * visibility (CAU-25, ADR-C5), parameterized over BOTH connectors (CAU-7).
 *
 * Alice appends a finding BEFORE bob subscribes. Bob's subscription mints at the
 * current head, so that pre-subscription finding is invisible to him. Alice then
 * claims a target; bob's `readSince` from his cursor sees EXACTLY the claim
 * message (one message), with the correct agent_id / owner / target — i.e. a
 * claim one client wins is visible to the other through the shared log.
 *
 * Runs in-process AND over HTTP — over the wire this proves a granted claim
 * (CAU-7 route) propagates cross-client through the shared server log.
 */
import type { Cursor } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
  claimMsg,
  finding,
} from "../index.js";

const CH = "incident-catchup";
const TARGET = "auth-service";

const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", inProcessConnector],
  ["http", httpConnector],
];

describe.each(CONNECTORS)(
  "subscribe mints at head — %s connector (ADR-C5 cross-client claim visibility)",
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
        purpose: "subscribe-at-head + cross-client claim visibility",
        created_by: "alice",
      });
    });

    afterAll(async () => {
      await connector.teardown();
    });

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

  },
);

// ---------------------------------------------------------------------------
// CAU-8 seatbelt scenario (ADR-C8), over BOTH connectors with a LOW cap so it
// trips deterministically — no real-time waits, no clocks. alice loops an
// identical post (blocked with DuplicatePostError's actionable message) and
// floods past the cap (blocked with RateLimitedError); bob posts successfully
// and reads the log meanwhile, proving per-(channel, agent) isolation (AC3).
// ---------------------------------------------------------------------------

/** Low per-agent cap so a short flood trips it without any time-based waiting. */
const CAP = 2;
/** Each connector built with the low cap threaded through (CAU-8). */
const SEATBELT_CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector({ maxPostsPerMinute: CAP })],
  ["http", () => httpConnector({ maxPostsPerMinute: CAP })],
];

describe.each(SEATBELT_CONNECTORS)(
  "seatbelt — rate cap + loop/dup, per-agent isolated — %s connector (ADR-C8)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;
    let bob: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
      bob = await connector.connectClient("bob");
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("blocks alice's looped identical post with an actionable, body-free error (AC2)", async () => {
      const ch = "incident-loop";
      await alice.backbone.createChannel({
        channel: ch,
        purpose: "loop block",
        created_by: "alice",
      });

      // First post admits.
      await alice.backbone.append(
        ch,
        finding("alice-agent", "alice", { body: "looping the same line" }),
      );
      // The immediate identical repeat is a loop → DuplicatePostError.
      let err: unknown;
      await alice.backbone
        .append(
          ch,
          finding("alice-agent", "alice", { body: "looping the same line" }),
        )
        .catch((e) => {
          err = e;
        });
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("duplicate_post");
      const message = (err as Error).message;
      // Actionable instruction the agent can act on, and NO body echo (ADR-C12).
      expect(message).toContain("Vary the content or stop repeating");
      expect(message).not.toContain("looping the same line");
    });

    it("blocks alice's over-cap flood with RateLimitedError; bob is unaffected (AC1 + AC3)", async () => {
      const ch = "incident-flood";
      await alice.backbone.createChannel({
        channel: ch,
        purpose: "over-cap flood + per-agent isolation",
        created_by: "alice",
      });

      // alice posts up to the cap with DISTINCT bodies (so dup never fires first).
      for (let i = 0; i < CAP; i++) {
        await alice.backbone.append(
          ch,
          finding("alice-agent", "alice", { body: `alice update ${i}` }),
        );
      }
      // The next distinct post trips the per-agent rate cap.
      let err: unknown;
      await alice.backbone
        .append(ch, finding("alice-agent", "alice", { body: "one too many" }))
        .catch((e) => {
          err = e;
        });
      expect((err as { code?: string }).code).toBe("rate_limited");
      const message = (err as Error).message;
      expect(message).toContain(`at most ${CAP} posts/min`);
      expect(message).not.toContain("one too many");

      // AC3 — per-agent isolation: bob, on the SAME channel, posts fine and reads
      // the log while alice is throttled.
      const bobCursor = await bob.backbone.subscribe(ch);
      const posted = await bob.backbone.append(
        ch,
        finding("bob-agent", "bob", { body: "bob is not throttled" }),
      );
      expect(posted.message.agent_id).toBe("bob-agent");
      const bobRead = await bob.backbone.readSince(ch, bobCursor);
      expect(bobRead.messages).toHaveLength(1);
      expect(bobRead.messages[0]!.body).toBe("bob is not throttled");
    });
  },
);
