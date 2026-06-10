/**
 * Integration scenario — first-class `steer` round-trips over a REAL HTTP
 * backbone (CAU-99). Proves the live write/read path is consistent after the
 * schema v0→v1 bump:
 *
 *  - A session appends a `steer` (human directive) through the token-gated HTTP
 *    backbone; the server stamps `v` on write and replays the stored object on
 *    read WITHOUT re-decoding.
 *  - `readSince` returns it with `type: "steer"`, `v: 1`, the anchored owner
 *    (ADR-C7), and the body intact — including an optional `status:
 *    needs-response`.
 *
 * This is the load-bearing safety check behind the hard cutover (ADR-C13): the
 * production read path never calls `decode`, so a v1 message round-trips even
 * though `decode` now rejects v0. If the live path ever started re-validating on
 * read, this scenario would surface it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  steer,
  type ClientHandle,
  type Connector,
} from "../index.js";

const CH = "incident-steer";

describe("steer round-trips over HTTP (CAU-99, schema v1)", () => {
  const connector: Connector = httpConnector();
  let carol: ClientHandle;

  beforeAll(async () => {
    await connector.boot();
    carol = await connector.connectClient("carol");
    await carol.backbone.createChannel({
      channel: CH,
      purpose: "human steer",
      created_by: "carol",
    });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  it("appends a steer and reads it back as type:steer + v:1, owner anchored", async () => {
    const before = (await carol.backbone.describeChannel(CH)).head;

    await carol.backbone.append(
      CH,
      steer("carol-agent", "carol", {
        body: "focus on the 14:02 deploy correlation",
      }),
    );

    const read = await carol.backbone.readSince(CH, before);
    expect(read.messages).toHaveLength(1);
    const m = read.messages[0]!;
    expect(m.type).toBe("steer");
    expect(m.v).toBe(1);
    expect(m.body).toBe("focus on the 14:02 deploy correlation");
    // Identity is anchored to the relaying session (ADR-C7) — "whose human
    // steered".
    expect(m.owner).toBe("carol");
    expect(m.agent_id).toBe("carol-agent");
    expect(typeof m.ts).toBe("string");
  });

  it("carries an optional status:needs-response through the round-trip", async () => {
    const before = (await carol.backbone.describeChannel(CH)).head;

    await carol.backbone.append(CH, {
      ...steer("carol-agent", "carol", { body: "hold for my call" }),
      status: "needs-response",
    });

    const read = await carol.backbone.readSince(CH, before);
    expect(read.messages).toHaveLength(1);
    const m = read.messages[0]!;
    expect(m.type).toBe("steer");
    expect(m.status).toBe("needs-response");
  });
});
