/**
 * Integration scenario — ephemeral channel create / join / describe over HTTP
 * (CAU-5, the three issue ACs).
 *
 * Runs against the REAL `@caucus/backbone-server` via the {@link httpConnector}
 * (boots a server on an ephemeral port, each client is an `HttpBackbone`). It
 * validates the CAU-5 acceptance criteria end-to-end over the wire:
 *
 * - **AC1** — create an ephemeral channel and have 3 clients join it: alice
 *   creates, alice/bob/carol each `subscribe`, yielding 3 working cursors.
 * - **AC2** — `listChannels` / `describeChannel` return correct descriptors:
 *   every client sees the same descriptor; the wire descriptor is byte-identical
 *   to an in-process control; listing reflects creates.
 * - **AC3** — joining mid-session yields a working read cursor: a client that
 *   subscribes AFTER earlier appends sees only messages appended later.
 *
 * Claim is intentionally NOT exercised here — its server route is CAU-7. These
 * ACs need only create/subscribe/describe/list/append/read, all of which CAU-5
 * serves.
 */
import type { ChannelDescriptor, Cursor } from "@caucus/backbone";
import { InMemoryBackbone } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { httpConnector, type ClientHandle, finding } from "../index.js";

const CH = "incident-join";
const CH2 = "incident-join-2";

const connector = httpConnector();
let alice: ClientHandle;
let bob: ClientHandle;
let carol: ClientHandle;

beforeAll(async () => {
  await connector.boot();
  alice = await connector.connectClient("alice");
  bob = await connector.connectClient("bob");
  carol = await connector.connectClient("carol");
});

afterAll(async () => {
  await connector.teardown();
});

describe("CAU-5 channels: create / join / describe over HTTP", () => {
  it("AC1: alice creates an ephemeral channel; 3 clients join with working cursors", async () => {
    const created = await alice.backbone.createChannel({
      channel: CH,
      purpose: "war room: incident join",
      created_by: "alice",
    });
    expect(created.channel).toBe(CH);
    expect(created.kind).toBe("ephemeral");

    // All three clients join (== subscribe → mint a cursor at head).
    const aliceCursor: Cursor = await alice.backbone.subscribe(CH);
    const bobCursor: Cursor = await bob.backbone.subscribe(CH);
    const carolCursor: Cursor = await carol.backbone.subscribe(CH);

    // Three working cursors: each reads back cleanly (empty channel → no msgs).
    for (const [client, cursor] of [
      [alice, aliceCursor],
      [bob, bobCursor],
      [carol, carolCursor],
    ] as const) {
      const read = await client.backbone.readSince(CH, cursor);
      expect(read.messages).toHaveLength(0);
      expect(read.cursor).toBe(cursor);
    }
  });

  it("AC2: every client sees identical descriptors; list reflects creates; wire == in-process control", async () => {
    // Every client's describeChannel is byte-identical.
    const fromAlice = await alice.backbone.describeChannel(CH);
    const fromBob = await bob.backbone.describeChannel(CH);
    const fromCarol = await carol.backbone.describeChannel(CH);
    expect(JSON.stringify(fromBob)).toBe(JSON.stringify(fromAlice));
    expect(JSON.stringify(fromCarol)).toBe(JSON.stringify(fromAlice));

    // Descriptor contents: ephemeral kind, verbatim purpose, creator, quiet
    // default verbosity (ADR-C6), and a live head.
    expect(fromAlice.kind).toBe("ephemeral");
    expect(fromAlice.purpose).toBe("war room: incident join");
    expect(fromAlice.created_by).toBe("alice");
    expect(fromAlice.verbosity).toBe("quiet");
    expect(typeof fromAlice.created_ts).toBe("string");
    expect(fromAlice.head).toBe(0);

    // listChannels reflects the one create so far.
    const listed1 = await bob.backbone.listChannels();
    expect(listed1.map((c) => c.channel)).toEqual([CH]);

    // Create a 2nd channel; both are then listed.
    await alice.backbone.createChannel({
      channel: CH2,
      purpose: "second war room",
      created_by: "carol",
    });
    const listed2 = await carol.backbone.listChannels();
    expect(listed2.map((c) => c.channel).sort()).toEqual([CH, CH2].sort());

    // Byte-compare the wire descriptor against an in-process control: the HTTP
    // transport must not alter the descriptor shape. We can't compare the
    // server-stamped `created_ts`/`head` literally, so build a control with the
    // same inputs and compare every field except the server-stamped time.
    const control = new InMemoryBackbone();
    const controlDescriptor = await control.createChannel({
      channel: CH,
      purpose: "war room: incident join",
      created_by: "alice",
    });
    const stripTs = (d: ChannelDescriptor): Omit<ChannelDescriptor, "created_ts"> => {
      const rest: Record<string, unknown> = { ...d };
      delete rest.created_ts;
      return rest as Omit<ChannelDescriptor, "created_ts">;
    };
    expect(stripTs(fromAlice)).toEqual(stripTs(controlDescriptor));
  });

  it("AC3: a mid-session join yields a working cursor that sees only later messages", async () => {
    const CH3 = "incident-join-3";
    await alice.backbone.createChannel({
      channel: CH3,
      purpose: "mid-session join",
      created_by: "alice",
    });

    // Alice appends two findings BEFORE carol joins.
    await alice.backbone.append(CH3, finding("alice-agent", "alice", { body: "early one" }));
    await alice.backbone.append(CH3, finding("alice-agent", "alice", { body: "early two" }));

    // Carol joins mid-session: cursor mints at head (== 2), so the two earlier
    // findings are invisible to her.
    const carolCursor: Cursor = await carol.backbone.subscribe(CH3);
    expect(carolCursor).toBe(2);
    const beforeNew = await carol.backbone.readSince(CH3, carolCursor);
    expect(beforeNew.messages).toHaveLength(0);

    // Alice appends one more; carol reads EXACTLY that message from her cursor.
    const later = await alice.backbone.append(
      CH3,
      finding("alice-agent", "alice", { body: "later one" }),
    );
    const carolRead = await carol.backbone.readSince(CH3, carolCursor);
    expect(carolRead.messages).toHaveLength(1);
    expect(carolRead.messages[0]?.msg_id).toBe(later.message.msg_id);
    expect(carolRead.messages[0]?.body).toBe("later one");
    expect(carolRead.cursor).toBe(carolCursor + 1);
  });
});
