/**
 * Integration scenario — concurrent claim across multiple clients (CAU-25),
 * parameterized over BOTH connectors (CAU-7); contention hardened in CAU-76.
 *
 * Several distinct client handles onto the SAME backbone race to `claim()` the
 * same target via `Promise.all`. First-write-wins must hold across clients:
 * exactly one `granted`, every loser's `by` points at the single winner, and
 * the channel head advances by exactly one (only the winning claim is appended).
 *
 * CAU-76 hardening: the original test was a light 3-racer × 1-iteration race
 * whose launch order was fixed, so it always granted the first-scheduled
 * caller and could never catch an "always the same winner" bug. Now:
 *  - EIGHT racers contend per race;
 *  - a second test runs MANY iterations (a fresh target each), SHUFFLING the
 *    launch order per iteration, asserting exactly-one-winner EVERY iteration
 *    AND a winner-spread across iterations (≥2 distinct winners). The spread
 *    assertion is non-flaky by construction: even against a fully
 *    deterministic first-launched-wins backbone, a uniform shuffle makes
 *    "one distinct winner across all 12 iterations" as likely as every
 *    shuffle picking the same of 8 racers first — 8 × (1/8)^12 ≈ 1.5e-10.
 *
 * This runs both in-process (one `InMemoryBackbone`) AND over HTTP (real
 * `@caucus/backbone-server` on an ephemeral port), so first-write-wins is
 * proven to survive REAL concurrent HTTP requests under contention.
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

/** Eight racing principals (≥8 per the CAU-76 AC). */
const RACER_IDS = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "grace",
  "heidi",
] as const;

/** Iterations for the winner-spread race (see the flakiness math above). */
const ITERATIONS = 12;

const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector()],
  // The http connector provisions one bearer token per client id (CAU-13).
  ["http", () => httpConnector({}, RACER_IDS)],
];

/** Fisher–Yates shuffle (a fresh array; the input is left untouched). */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Racer {
  readonly client: ClientHandle;
  readonly agentId: string;
  readonly owner: string;
}

describe.each(CONNECTORS)("concurrent claim — %s connector", (_name, makeConnector) => {
  const connector = makeConnector();
  let racers: Racer[];

  beforeAll(async () => {
    await connector.boot();
    racers = await Promise.all(
      RACER_IDS.map(async (id) => ({
        client: await connector.connectClient(id),
        agentId: `${id}-agent`,
        owner: id,
      })),
    );
    await racers[0]!.client.backbone.createChannel({
      channel: CH,
      purpose: "concurrent claim race",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  /** Race every racer (in the given order) for `target`; return the results. */
  function race(order: readonly Racer[], target: string) {
    return Promise.all(
      order.map((r) =>
        r.client.backbone.claim(CH, claimMsg(r.agentId, r.owner, target)),
      ),
    );
  }

  it("grants exactly one of 8; losers point at the winner; head advances by 1", async () => {
    // Head before the race, observed through one of the shared handles.
    const headBefore = (await racers[0]!.client.backbone.describeChannel(CH)).head;

    // Eight clients race for the same target through separate handles. Over the
    // http connector these are eight REAL concurrent POST /claim requests.
    const results = await race(racers, TARGET);

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
    const headAfter = (await racers[1]!.client.backbone.describeChannel(CH)).head;
    expect(headAfter).toBe(headBefore + 1);
    expect(winner.cursor).toBe(headAfter);

    // AC: the granted claim appears as a `claim`-type message in the channel
    // log, visible to a THIRD client reading the shared log.
    const read = await racers[2]!.client.backbone.readSince(CH, headBefore);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.msg_id).toBe(winner.message.msg_id);
    expect(read.messages[0]?.type).toBe("claim");
  });

  it(`holds exactly-one-winner over ${ITERATIONS} shuffled races and spreads the winners`, async () => {
    const headBefore = (await racers[0]!.client.backbone.describeChannel(CH)).head;
    const winners: string[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // A fresh target per iteration (one ledger key each) and a SHUFFLED
      // launch order, so the winner is not pinned to a fixed first-scheduled
      // caller across iterations.
      const target = `spread-target-${i}`;
      const results = await race(shuffled(racers), target);

      const granted = results.filter((r) => r.outcome === "granted");
      const losers = results.filter((r) => r.outcome === "already_claimed");
      // Exactly one winner under contention, EVERY iteration.
      expect(granted).toHaveLength(1);
      expect(losers).toHaveLength(racers.length - 1);

      const winner = granted[0]!;
      if (winner.outcome !== "granted") throw new Error("unreachable");
      for (const loser of losers) {
        if (loser.outcome !== "already_claimed") throw new Error("unreachable");
        expect(loser.by.msg_id).toBe(winner.message.msg_id);
      }
      winners.push(winner.message.owner);
    }

    // Winner spread: not always the same caller. With shuffled launch orders
    // this can only fail if every one of the 12 independent shuffles put the
    // same racer first (probability ≈ 1.5e-10) — i.e. effectively only if the
    // backbone stopped honoring arrival order entirely in favor of some fixed
    // identity, which is exactly the bug this guards against.
    expect(new Set(winners).size).toBeGreaterThanOrEqual(2);

    // One append per iteration — losers never append.
    const headAfter = (await racers[0]!.client.backbone.describeChannel(CH)).head;
    expect(headAfter).toBe(headBefore + ITERATIONS);
  });
});
