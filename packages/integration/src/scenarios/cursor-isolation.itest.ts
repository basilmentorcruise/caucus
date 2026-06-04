/**
 * Integration scenario 2 — per-client cursor isolation (CAU-25).
 *
 * Two clients each subscribe (mint their own cursor). Alice appends two
 * findings and bob claims a target → three messages on the shared log. EACH
 * client, reading from ITS OWN cursor, must see all three messages in append
 * order, exactly once; its cursor advances by exactly three; and a re-read from
 * the advanced cursor returns zero. Cursors are per-client variables owned by
 * the test, against one shared backbone.
 */
import type { Cursor } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inProcessConnector,
  type ClientHandle,
  claimMsg,
  finding,
} from "../index.js";

const CH = "incident-cursor";

const connector = inProcessConnector();
let alice: ClientHandle;
let bob: ClientHandle;

beforeAll(async () => {
  await connector.boot();
  alice = await connector.connectClient("alice");
  bob = await connector.connectClient("bob");
  await alice.backbone.createChannel({
    channel: CH,
    purpose: "cursor isolation",
    created_by: "alice",
  });
});

afterAll(async () => {
  await connector.teardown();
});

describe("cursor isolation (independent per-client cursors)", () => {
  it("both clients see all 3 messages in order, once; re-read returns 0", async () => {
    // Each client mints its own cursor at the (currently empty) head.
    const aliceCursor: Cursor = await alice.backbone.subscribe(CH);
    const bobCursor: Cursor = await bob.backbone.subscribe(CH);

    // Three appends on the shared log: two findings by alice, one claim by bob.
    const f1 = await alice.backbone.append(
      CH,
      finding("alice-agent", "alice", { body: "finding one" }),
    );
    const f2 = await alice.backbone.append(
      CH,
      finding("alice-agent", "alice", { body: "finding two" }),
    );
    const c1 = await bob.backbone.claim(
      CH,
      claimMsg("bob-agent", "bob", "log-pipeline"),
    );
    if (c1.outcome !== "granted") throw new Error("claim should be granted");

    const expectedOrder = [f1.message.msg_id, f2.message.msg_id, c1.message.msg_id];

    // Alice reads from her own cursor: all 3, in append order, exactly once.
    const aliceRead = await alice.backbone.readSince(CH, aliceCursor);
    expect(aliceRead.messages.map((m) => m.msg_id)).toEqual(expectedOrder);
    expect(aliceRead.cursor).toBe(aliceCursor + 3);

    // Bob reads from HIS own (independent) cursor: same 3, same order, once.
    const bobRead = await bob.backbone.readSince(CH, bobCursor);
    expect(bobRead.messages.map((m) => m.msg_id)).toEqual(expectedOrder);
    expect(bobRead.cursor).toBe(bobCursor + 3);

    // Re-reading from each advanced cursor returns nothing (no duplicates).
    const aliceReread = await alice.backbone.readSince(CH, aliceRead.cursor);
    expect(aliceReread.messages).toHaveLength(0);
    expect(aliceReread.cursor).toBe(aliceRead.cursor);

    const bobReread = await bob.backbone.readSince(CH, bobRead.cursor);
    expect(bobReread.messages).toHaveLength(0);
    expect(bobReread.cursor).toBe(bobRead.cursor);
  });
});
