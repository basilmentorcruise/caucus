/**
 * Integration scenario — concurrent claim across multiple clients (CAU-25),
 * parameterized over BOTH connectors (CAU-7).
 *
 * Several distinct client handles onto the SAME backbone race to `claim()` the
 * same target via `Promise.all`. First-write-wins must hold across clients:
 * exactly one `granted`, every loser's `by` points at the single winner, and
 * the channel head advances by exactly one (only the winning claim is appended).
 *
 * This runs both in-process (one `InMemoryBackbone`) AND over HTTP (real
 * `@caucus/backbone-server` on an ephemeral port). The HTTP run was deferred to
 * CAU-7 because the claim route was a 501 stub until then; now the same seam
 * proves first-write-wins survives REAL concurrent HTTP requests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
  claimMsg,
} from "../index.js";

const CH = "incident-concurrent";
const TARGET = "db-shard-3";

const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", inProcessConnector],
  ["http", httpConnector],
];

describe.each(CONNECTORS)("concurrent claim — %s connector", (_name, makeConnector) => {
  const connector = makeConnector();
  let alice: ClientHandle;
  let bob: ClientHandle;
  let carol: ClientHandle;

  beforeAll(async () => {
    await connector.boot();
    alice = await connector.connectClient("alice");
    bob = await connector.connectClient("bob");
    carol = await connector.connectClient("carol");
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "concurrent claim race",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  it("grants exactly one; losers point at the winner; head advances by 1", async () => {
    // Head before the race, observed through one of the shared handles.
    const headBefore = (await alice.backbone.describeChannel(CH)).head;

    // Three clients race for the same target through separate handles. Over the
    // http connector these are three REAL concurrent POST /claim requests.
    const racers: { client: ClientHandle; agentId: string; owner: string }[] = [
      { client: alice, agentId: "alice-agent", owner: "alice" },
      { client: bob, agentId: "bob-agent", owner: "bob" },
      { client: carol, agentId: "carol-agent", owner: "carol" },
    ];

    const results = await Promise.all(
      racers.map((r) =>
        r.client.backbone.claim(CH, claimMsg(r.agentId, r.owner, TARGET)),
      ),
    );

    const granted = results.filter((r) => r.outcome === "granted");
    const losers = results.filter((r) => r.outcome === "already_claimed");

    // AC: exactly one winner across concurrent claims on one target.
    expect(granted).toHaveLength(1);
    expect(losers).toHaveLength(racers.length - 1);

    const winner = granted[0]!;
    if (winner.outcome !== "granted") throw new Error("unreachable");

    // AC: the conflict response identifies who holds the claim — every loser
    // names the single winner (agent_id + owner + ts + msg_id).
    for (const loser of losers) {
      if (loser.outcome !== "already_claimed") throw new Error("unreachable");
      expect(loser.by.msg_id).toBe(winner.message.msg_id);
      expect(loser.by.agent_id).toBe(winner.message.agent_id);
      expect(loser.by.owner).toBe(winner.message.owner);
      expect(loser.by.ts).toBe(winner.message.ts);
    }

    // Only the winning claim was appended: head moved by exactly one.
    const headAfter = (await bob.backbone.describeChannel(CH)).head;
    expect(headAfter).toBe(headBefore + 1);
    expect(winner.cursor).toBe(headAfter);

    // AC: the granted claim appears as a `claim`-type message in the channel
    // log, visible to a THIRD client reading the shared log.
    const read = await carol.backbone.readSince(CH, headBefore);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.msg_id).toBe(winner.message.msg_id);
    expect(read.messages[0]?.type).toBe("claim");
  });
});
