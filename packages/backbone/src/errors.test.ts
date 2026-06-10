/**
 * Backbone error-construction sanitization (CAU-88).
 *
 * `InvalidMessageError` carries the schema validation problems into BOTH its
 * `.message` (joined) and its `.issues[]` (forwarded verbatim onto the HTTP
 * wire). `in-memory.ts` also constructs it DIRECTLY (not only by re-wrapping a
 * schema error), and when CAUCUS_URL is unset the MCP server runs the backbone
 * in-process so that error never traverses the wire. The strip therefore lives
 * in this constructor, covering both paths from one place.
 */
import { describe, expect, it } from "vitest";

import { InvalidMessageError } from "./errors.js";
import { stripControlChars } from "@caucus/schema";

// Control bytes spelled with \x escapes so this source stays plain ASCII.
const DEL = "\x7f";
const C1 = "\x9b";

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

describe("InvalidMessageError (CAU-88)", () => {
  it("strips control bytes from BOTH .message and every .issues[] entry when constructed directly", () => {
    const dirty = `unknown field "ev${DEL}il${C1}"`;
    const err = new InvalidMessageError([dirty, "claim requires a non-empty target"]);

    expect(err.message).not.toMatch(CONTROL_CHARS);
    for (const issue of err.issues) {
      expect(issue).not.toMatch(CONTROL_CHARS);
      expect(stripControlChars(issue)).toBe(issue); // idempotent — already clean
    }
    expect(err.issues[0]).toBe('unknown field "evil"');
    expect(err.code).toBe("invalid_message");
  });

  it("is a no-op for a clean issues array", () => {
    const issues = ["body must be a non-empty string"];
    const err = new InvalidMessageError(issues);
    expect([...err.issues]).toEqual(issues);
    expect(err.message).toBe("Invalid message: body must be a non-empty string");
  });
});
