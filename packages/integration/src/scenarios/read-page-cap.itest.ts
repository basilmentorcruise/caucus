/**
 * Integration scenario — CAU-83 readSince max page size, parameterized over
 * BOTH connectors (in-process and HTTP).
 *
 * A low injected `maxReadLimit` proves, over the wire and in-process:
 *
 * 1. **Silent clamp** — a no-limit read and an absurd `limit: 999` both come
 *    back as exactly one max-sized page, never an error (no 400 over HTTP).
 * 2. **Cursor catch-up converges** — paging from cursor 0 (read again from
 *    each returned cursor until a page is empty) yields ALL messages in
 *    append order with no duplicates, and the final cursor equals the
 *    channel's live head.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
  finding,
} from "../index.js";

/** Low read-page cap so a 5-message backlog takes three pages. */
const READ_CAP = 2;

/** Total messages appended — deliberately not a multiple of the cap. */
const TOTAL = 5;

const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", () => inProcessConnector({ maxReadLimit: READ_CAP })],
  ["http", () => httpConnector({ maxReadLimit: READ_CAP })],
];

describe.each(CONNECTORS)(
  "readSince max page size — silent clamp, cursor catch-up converges — %s connector (CAU-83)",
  (_name, makeConnector) => {
    const connector = makeConnector();
    let alice: ClientHandle;

    beforeAll(async () => {
      await connector.boot();
      alice = await connector.connectClient("alice");
      await alice.backbone.createChannel({
        channel: "paged",
        purpose: "read page cap",
        created_by: "alice",
      });
      for (let i = 0; i < TOTAL; i++) {
        await alice.backbone.append(
          "paged",
          finding("alice-agent", "alice", { body: `m${i}` }),
        );
      }
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("clamps a no-limit read to exactly one max-sized page", async () => {
      const page = await alice.backbone.readSince("paged", 0);
      expect(page.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
      expect(page.cursor).toBe(READ_CAP);
    });

    it("clamps an over-cap limit silently — a result, never an error", async () => {
      // Over HTTP this proves the wire answers 200 with a clamped page, not a
      // 400 invalid_cursor.
      const page = await alice.backbone.readSince("paged", 0, 999);
      expect(page.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
      expect(page.cursor).toBe(READ_CAP);
    });

    it("pages from cursor 0 until an empty page: all messages, in order, converging on head", async () => {
      const bodies: string[] = [];
      let cursor = 0;
      for (;;) {
        const page = await alice.backbone.readSince("paged", cursor);
        if (page.messages.length === 0) {
          expect(page.cursor).toBe(cursor); // empty page ⇔ caught up
          break;
        }
        expect(page.messages.length).toBeLessThanOrEqual(READ_CAP);
        bodies.push(...page.messages.map((m) => m.body));
        cursor = page.cursor;
      }
      expect(bodies).toEqual(["m0", "m1", "m2", "m3", "m4"]);
      expect(new Set(bodies).size).toBe(TOTAL); // no duplicates
      const head = (await alice.backbone.describeChannel("paged")).head;
      expect(cursor).toBe(head);
    });
  },
);
