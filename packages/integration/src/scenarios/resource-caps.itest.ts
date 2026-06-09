/**
 * Integration scenario — CAU-74 resource caps & eviction, parameterized over
 * BOTH connectors (in-process and HTTP).
 *
 * Three resource gates, each with its own low-knob connector so it trips
 * deterministically (no real-time waits):
 *
 * 1. **Create throttle** — a channel-mint loop hits `rate_limited` on the
 *    create past the cap; the channels that DID get created remain fully
 *    readable and postable.
 * 2. **Per-channel message cap** — filling a channel yields `channel_full`
 *    over the wire; a reader holding a pre-cap cursor still catches up
 *    cleanly on the capped log.
 * 3. **Global cross-channel rate cap** — posts spread across two channels
 *    trip `rate_limited` even though each channel's own budget has room.
 *
 * Heavy concurrent-claim load against the caps is deliberately NOT here
 * (that's CAU-76).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
  finding,
} from "../index.js";

// ---------------------------------------------------------------------------
// 1. Create throttle — a channel-mint loop is cut off at the cap.
// ---------------------------------------------------------------------------

/** Low creates/min cap so the third create trips without waiting. */
const CREATE_CAP = 2;

const CREATE_CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector({ maxChannelCreatesPerMinute: CREATE_CAP })],
  ["http", () => httpConnector({ maxChannelCreatesPerMinute: CREATE_CAP })],
];

describe.each(CREATE_CONNECTORS)(
  "create throttle — channel-mint loop cut off at the cap — %s connector (CAU-74)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("rejects the create past the cap; existing channels stay readable and postable", async () => {
      // The mint loop: the first CREATE_CAP creates succeed…
      for (let i = 0; i < CREATE_CAP; i++) {
        await alice.backbone.createChannel({
          channel: `mint-${i}`,
          purpose: "mint loop",
          created_by: "alice",
        });
      }
      // …and the next one is throttled per creator identity.
      let err: unknown;
      await alice.backbone
        .createChannel({ channel: "mint-overflow", purpose: "x", created_by: "alice" })
        .catch((e) => {
          err = e;
        });
      expect((err as { code?: string }).code).toBe("rate_limited");
      expect((err as Error).message).toContain(
        `at most ${CREATE_CAP} channel creates/min per owner`,
      );

      // The channels that DID get created are unaffected: still listed,
      // readable, and postable.
      const listed = await alice.backbone.listChannels();
      expect(listed.map((c) => c.channel).sort()).toEqual(["mint-0", "mint-1"]);
      const cursor = await alice.backbone.subscribe("mint-0");
      await alice.backbone.append(
        "mint-0",
        finding("alice-agent", "alice", { body: "still alive" }),
      );
      const read = await alice.backbone.readSince("mint-0", cursor);
      expect(read.messages.map((m) => m.body)).toEqual(["still alive"]);
    });
  },
);

// ---------------------------------------------------------------------------
// 2. Per-channel message cap — channel_full over the wire, cursors intact.
// ---------------------------------------------------------------------------

/** Low log cap so the channel fills in three posts. */
const LOG_CAP = 3;

const LOG_CAP_CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector({ maxMessagesPerChannel: LOG_CAP })],
  ["http", () => httpConnector({ maxMessagesPerChannel: LOG_CAP })],
];

describe.each(LOG_CAP_CONNECTORS)(
  "per-channel message cap — channel_full, pre-cap cursor catches up — %s connector (CAU-74)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;
    let bob: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
      bob = await connector.connectClient("bob");
      await alice.backbone.createChannel({
        channel: "capped",
        purpose: "log cap",
        created_by: "alice",
      });
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("rejects the post past the cap with channel_full; a pre-cap reader catches up cleanly", async () => {
      // Bob subscribes BEFORE the channel fills.
      const bobCursor = await bob.backbone.subscribe("capped");

      // Alice fills the channel to the cap…
      for (let i = 0; i < LOG_CAP; i++) {
        await alice.backbone.append(
          "capped",
          finding("alice-agent", "alice", { body: `m${i}` }),
        );
      }
      // …and the next post is rejected as capacity, not pacing.
      let err: unknown;
      await alice.backbone
        .append("capped", finding("alice-agent", "alice", { body: "overflow" }))
        .catch((e) => {
          err = e;
        });
      expect((err as { code?: string }).code).toBe("channel_full");
      expect((err as Error).message).toContain(`at most ${LOG_CAP} messages`);
      expect((err as Error).message).not.toContain("overflow");

      // Bob's pre-cap cursor still catches up on exactly the capped log.
      const read = await bob.backbone.readSince("capped", bobCursor);
      expect(read.messages.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
      expect(read.cursor).toBe(bobCursor + LOG_CAP);
      // And the head is pinned at the cap.
      expect(await bob.backbone.subscribe("capped")).toBe(LOG_CAP);
    });
  },
);

// ---------------------------------------------------------------------------
// 3. Global cross-channel rate cap — spreading across channels doesn't help.
// ---------------------------------------------------------------------------

/** Per-channel budget with room to spare when the GLOBAL budget runs out. */
const PER_CHANNEL_CAP = 3;
const GLOBAL_CAP = 4;

const GLOBAL_CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  [
    "in-process",
    () =>
      inProcessConnector({
        maxPostsPerMinute: PER_CHANNEL_CAP,
        globalMaxPostsPerMinute: GLOBAL_CAP,
      }),
  ],
  [
    "http",
    () =>
      httpConnector({
        maxPostsPerMinute: PER_CHANNEL_CAP,
        globalMaxPostsPerMinute: GLOBAL_CAP,
      }),
  ],
];

describe.each(GLOBAL_CONNECTORS)(
  "global cross-channel rate cap — %s connector (CAU-74)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;
    let bob: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
      bob = await connector.connectClient("bob");
      for (const channel of ["room-a", "room-b"]) {
        await alice.backbone.createChannel({
          channel,
          purpose: "global cap",
          created_by: "alice",
        });
      }
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("posts spread across two channels trip the global cap; another agent is unaffected", async () => {
      // Alice exhausts room-a's per-channel budget, then posts once in room-b:
      // 4 posts total = the global cap.
      for (let i = 0; i < PER_CHANNEL_CAP; i++) {
        await alice.backbone.append(
          "room-a",
          finding("alice-agent", "alice", { body: `a${i}` }),
        );
      }
      await alice.backbone.append(
        "room-b",
        finding("alice-agent", "alice", { body: "b0" }),
      );

      // room-b's own budget has room (1 of 3 used), but alice's GLOBAL budget
      // is spent — spreading across channels does not multiply the budget.
      let err: unknown;
      await alice.backbone
        .append("room-b", finding("alice-agent", "alice", { body: "b1" }))
        .catch((e) => {
          err = e;
        });
      expect((err as { code?: string }).code).toBe("rate_limited");
      expect((err as Error).message).toContain(
        `at most ${GLOBAL_CAP} posts/min per agent across all channels`,
      );

      // The global budget is per-agent: bob posts to room-b just fine.
      await expect(
        bob.backbone.append(
          "room-b",
          finding("bob-agent", "bob", { body: "bob unaffected" }),
        ),
      ).resolves.toBeDefined();
    });
  },
);
