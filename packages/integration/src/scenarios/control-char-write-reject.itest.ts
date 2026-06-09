/**
 * Integration scenario — write-time control-character rejection (CAU-71),
 * parameterized over BOTH connectors so the HTTP wire path is exercised.
 *
 * CAU-69/73 sanitize control characters at the READ layer; CAU-71 adds the
 * write-time choke point: the schema validator (run inside the backbone)
 * REJECTS escape-bearing fields so they never enter the append-only log. This
 * scenario proves, end-to-end (in-process AND over a real HTTP server):
 *
 * - a dirty append surfaces as a typed `invalid_message` error, the head does
 *   not move, and a subsequent read carries zero control bytes;
 * - a clean multi-line body is still accepted and reads back with `\n` intact
 *   (the deliberate `\t`/`\n` body exemption);
 * - a dirty claim is rejected without corrupting the ledger — a clean claim on
 *   the same channel still wins.
 */
import { InvalidMessageError } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  httpConnector,
  inProcessConnector,
  type ClientHandle,
  type Connector,
  claimMsg,
  finding,
} from "../index.js";

const CH = "incident-ctrl-reject";

// Control bytes spelled with \x escapes so this source stays plain ASCII.
const ESC = "\x1b"; // ANSI escape introducer

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

const CONNECTORS: ReadonlyArray<readonly [string, () => Connector]> = [
  ["in-process", inProcessConnector],
  ["http", httpConnector],
];

describe.each(CONNECTORS)(
  "CAU-71 write-time control-char rejection — %s connector",
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
        purpose: "control-char write rejection",
        created_by: "alice",
      });
    });

    afterAll(async () => {
      await connector.teardown();
    });

    it("rejects an ESC-bearing append with a typed invalid_message error; head unchanged; reads stay clean", async () => {
      const headBefore = (await alice.backbone.describeChannel(CH)).head;

      let thrown: unknown;
      await alice.backbone
        .append(
          CH,
          finding("alice-agent", "alice", { body: `pwn${ESC}[2J the room` }),
        )
        .catch((e) => {
          thrown = e;
        });
      // The REAL typed error arrives — over HTTP it is reconstructed from the
      // wire body, with the same stable `.code` callers branch on.
      expect(thrown).toBeInstanceOf(InvalidMessageError);
      expect((thrown as InvalidMessageError).code).toBe("invalid_message");
      expect((thrown as InvalidMessageError).issues).toContain(
        "body must not contain control characters (tab and newline are allowed)",
      );
      // The error itself never echoes the offending bytes (ADR-C12).
      expect((thrown as Error).message).not.toMatch(CONTROL_CHARS);

      // Nothing was appended.
      const headAfter = (await bob.backbone.describeChannel(CH)).head;
      expect(headAfter).toBe(headBefore);

      // A subsequent full read (what another agent would receive) contains
      // zero control bytes anywhere.
      const read = await bob.backbone.readSince(CH, 0);
      expect(JSON.stringify(read.messages)).not.toMatch(CONTROL_CHARS);
    });

    it("accepts a clean multi-line body and reads it back with \\n intact", async () => {
      const body = "step 1\nstep 2\tdone";
      const res = await alice.backbone.append(
        CH,
        finding("alice-agent", "alice", { body }),
      );
      expect(res.message.body).toBe(body);

      // Bob reads the exact same multi-line body off the shared log.
      const read = await bob.backbone.readSince(CH, res.cursor - 1);
      expect(read.messages[0]?.body).toBe(body);
    });

    it("rejects a dirty claim target; a clean claim on the same channel still succeeds", async () => {
      let thrown: unknown;
      await alice.backbone
        .claim(CH, claimMsg("alice-agent", "alice", `db-pool${ESC}]0;x`))
        .catch((e) => {
          thrown = e;
        });
      expect(thrown).toBeInstanceOf(InvalidMessageError);
      expect((thrown as InvalidMessageError).code).toBe("invalid_message");
      expect((thrown as InvalidMessageError).issues).toContain(
        "target must not contain control characters",
      );

      // The rejected claim corrupted nothing: bob cleanly wins a claim on the
      // same channel afterwards.
      const clean = await bob.backbone.claim(
        CH,
        claimMsg("bob-agent", "bob", "db-pool"),
      );
      expect(clean.outcome).toBe("granted");
    });
  },
);
