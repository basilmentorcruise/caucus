/**
 * Integration scenario — append-only log + read-since cursors over HTTP (CAU-6,
 * the three issue ACs).
 *
 * Runs against the REAL `@caucus/backbone-server` via the {@link httpConnector}
 * (boots a server on an ephemeral port; each client is an `HttpBackbone`), with
 * ≥2 sessions. It validates the CAU-6 acceptance criteria end-to-end over the
 * wire:
 *
 * - **AC1** — messages return in append order with stable cursors: alice appends
 *   five findings; a read from cursor 0 yields exactly those five msg_ids in
 *   append order and a cursor of 5; a re-read from 5 is empty with cursor 5.
 * - **AC2** — two sessions maintain independent checkpoints: bob subscribes
 *   mid-stream (cursor at head); alice appends more; the two cursor variables
 *   advance independently and bob never sees pre-subscribe messages.
 * - **AC3** — re-read with the same cursor is idempotent (no dupes, no gaps):
 *   paging from cursor 0 with `limit=2` until empty concatenates to the full
 *   ordered list with no msg_id twice, and re-reading one page is identical.
 *
 * Claim is intentionally NOT exercised here — this scenario covers the CAU-6 log/cursor ACs only (claim coverage lives in concurrent-claim.itest.ts).
 * These ACs need only create / subscribe / append / read, all of which the
 * CAU-5 service serves. `ts` is treated as opaque (never `Date.parse`); the only
 * cursor arithmetic used is the contract's `cursor + messages.length`.
 */
import type { Cursor } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { httpConnector, type ClientHandle, finding } from "../index.js";

const connector = httpConnector();
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

describe("CAU-6 append-only log + read-since cursors over HTTP", () => {
  it("AC1: appends return in order with a stable, advancing cursor; re-read at head is empty", async () => {
    const CH = "log-order";
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "append order + stable cursors",
      created_by: "alice",
    });

    // Alice appends five findings; remember the wire-assigned ids in order.
    const expected: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await alice.backbone.append(
        CH,
        finding("alice-agent", "alice", { body: `finding ${i}` }),
      );
      expected.push(r.message.msg_id);
    }

    // Read from cursor 0: exactly those five, in append order; cursor == 5.
    const read = await alice.backbone.readSince(CH, 0);
    expect(read.messages.map((m) => m.msg_id)).toEqual(expected);
    expect(read.cursor).toBe(5);

    // Re-read from the advanced cursor: nothing new, cursor unchanged.
    const tail = await alice.backbone.readSince(CH, read.cursor);
    expect(tail.messages).toHaveLength(0);
    expect(tail.cursor).toBe(read.cursor);
  });

  it("AC2: two sessions keep independent checkpoints; a mid-stream joiner misses prior messages", async () => {
    const CH = "log-isolation";
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "independent per-session checkpoints",
      created_by: "alice",
    });

    // Alice subscribes at the empty head and appends two findings.
    let aliceCursor: Cursor = await alice.backbone.subscribe(CH);
    const early: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await alice.backbone.append(
        CH,
        finding("alice-agent", "alice", { body: `early ${i}` }),
      );
      early.push(r.message.msg_id);
    }

    // Bob subscribes mid-stream: his cursor mints at the current head, so the two
    // earlier findings are invisible to him.
    let bobCursor: Cursor = await bob.backbone.subscribe(CH);
    const bobInitial = await bob.backbone.readSince(CH, bobCursor);
    expect(bobInitial.messages).toHaveLength(0);
    expect(bobInitial.cursor).toBe(bobCursor);

    // Alice appends two more findings AFTER bob joined.
    const late: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await alice.backbone.append(
        CH,
        finding("alice-agent", "alice", { body: `late ${i}` }),
      );
      late.push(r.message.msg_id);
    }

    // Bob, an ACTIVE second reader, advances his OWN checkpoint one message at a
    // time (limit=1). He sees ONLY post-subscribe findings, in order, never the
    // pre-subscribe pair.
    const bobPage1 = await bob.backbone.readSince(CH, bobCursor, 1);
    expect(bobPage1.messages.map((m) => m.msg_id)).toEqual([late[0]]);
    bobCursor = bobPage1.cursor;
    expect(bobCursor).toBe(bobInitial.cursor + 1);

    // Alice, from HER own (independent) checkpoint, drains all four in order.
    // While bob sits at his partial checkpoint, the two cursors hold DIFFERENT
    // positions — proof the checkpoints are independent, not shared.
    const aliceRead = await alice.backbone.readSince(CH, aliceCursor);
    expect(aliceRead.messages.map((m) => m.msg_id)).toEqual([...early, ...late]);
    aliceCursor = aliceRead.cursor;
    expect(aliceCursor).toBe(early.length + late.length);
    expect(aliceCursor).not.toBe(bobCursor); // alice ahead; bob still mid-stream

    // Bob's view never contains the pre-subscribe pair, however he pages.
    expect(bobPage1.messages.map((m) => m.msg_id)).not.toContain(early[0]);
    expect(bobPage1.messages.map((m) => m.msg_id)).not.toContain(early[1]);

    // Bob drains the rest from his own cursor: he gets exactly the remaining
    // post-subscribe finding, with no dupe of the one he already read.
    const bobPage2 = await bob.backbone.readSince(CH, bobCursor);
    expect(bobPage2.messages.map((m) => m.msg_id)).toEqual([late[1]]);
    bobCursor = bobPage2.cursor;

    // Re-reading from each advanced cursor yields nothing (no dupes, no gaps).
    expect((await alice.backbone.readSince(CH, aliceCursor)).messages).toHaveLength(0);
    expect((await bob.backbone.readSince(CH, bobCursor)).messages).toHaveLength(0);
  });

  it("AC3: paging is idempotent — no dupes, no gaps; re-reading a page is identical", async () => {
    const CH = "log-paging";
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "idempotent paging",
      created_by: "alice",
    });

    const N = 7;
    const expected: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const r = await alice.backbone.append(
        CH,
        finding("alice-agent", "alice", { body: `msg ${i}` }),
      );
      expected.push(r.message.msg_id);
    }

    // Walk from cursor 0 with limit=2 until a page comes back empty. The only
    // cursor arithmetic is the contract's `cursor + messages.length` (implicit
    // in the returned cursor); we never assume a numeric stride.
    const seen: string[] = [];
    let cursor: Cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await alice.backbone.readSince(CH, cursor, 2);
      if (page.messages.length === 0) {
        // An empty page must not advance the cursor.
        expect(page.cursor).toBe(cursor);
        break;
      }
      expect(page.messages.length).toBeLessThanOrEqual(2);
      seen.push(...page.messages.map((m) => m.msg_id));
      cursor = page.cursor;
      pages += 1;
      if (pages > N + 2) throw new Error("paging did not terminate");
    }

    // Concatenation equals the full ordered list, exactly once each.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(N);
    // Final cursor sits at the head; a read there is empty.
    expect(cursor).toBe(N);
    const atHead = await alice.backbone.readSince(CH, cursor);
    expect(atHead.messages).toHaveLength(0);
    expect(atHead.cursor).toBe(cursor);

    // Re-reading one earlier page from the SAME cursor twice is identical
    // (idempotent: no dupes, no gaps).
    const pageA = await alice.backbone.readSince(CH, 2, 2);
    const pageB = await alice.backbone.readSince(CH, 2, 2);
    expect(pageA.messages.map((m) => m.msg_id)).toEqual(
      pageB.messages.map((m) => m.msg_id),
    );
    expect(pageA.cursor).toBe(pageB.cursor);
    expect(pageA.messages.map((m) => m.msg_id)).toEqual([expected[2], expected[3]]);
  });
});
