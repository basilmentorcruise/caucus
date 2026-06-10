/**
 * Error-construction sanitization (CAU-88). Schema errors are a
 * display/serialization surface — `.message` (and, for `MalformedMessageError`,
 * the wire-forwarded `.issues[]`) ride into another principal's context or TTY.
 * These tests pin that control bytes are stripped AT CONSTRUCTION, while the
 * structured `.received` is deliberately kept raw for in-process consumers.
 */
import { describe, expect, it } from "vitest";

import { MalformedMessageError, UnsupportedVersionError } from "./errors.js";
import { stripControlChars } from "./sanitize.js";

// Control bytes spelled with \x escapes so this source stays plain ASCII.
const DEL = "\x7f"; // delete — JSON.stringify does NOT escape it
const C1 = "\x9b"; // C1 CSI — JSON.stringify does NOT escape it

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

describe("MalformedMessageError (CAU-88)", () => {
  it("strips control bytes from BOTH .message and every .issues[] entry", () => {
    const dirty = `unknown field "ev${DEL}il${C1}"`;
    const err = new MalformedMessageError([dirty, "type must be one of x"]);

    expect(err.message).not.toMatch(CONTROL_CHARS);
    for (const issue of err.issues) {
      expect(issue).not.toMatch(CONTROL_CHARS);
      // Idempotence: a second strip is a no-op — the stored value is clean.
      expect(stripControlChars(issue)).toBe(issue);
    }
    // The clean text is preserved (only the bytes were removed).
    expect(err.issues[0]).toBe('unknown field "evil"');
  });

  it("leaves a clean issues array untouched (no-op)", () => {
    const issues = ["agent_id must be a non-empty string"];
    const err = new MalformedMessageError(issues);
    expect(err.issues).toEqual(issues);
    expect(err.message).toBe(
      "Malformed message: agent_id must be a non-empty string",
    );
  });
});

describe("UnsupportedVersionError (CAU-88)", () => {
  it("strips control bytes from .message for a hostile string `v` (DEL/C1)", () => {
    const hostile = `9${DEL}${C1}`;
    const err = new UnsupportedVersionError(hostile);
    expect(err.message).not.toMatch(CONTROL_CHARS);
    // The asymmetry the architect pinned: .received keeps the RAW value for
    // in-process consumers; only the message is sanitized.
    expect(err.received).toBe(hostile);
    expect(CONTROL_CHARS.test(err.received as string)).toBe(true);
  });

  it("strips control bytes from a nested-string non-string `v` (object value)", () => {
    const hostile = { tag: `x${DEL}y${C1}` };
    const err = new UnsupportedVersionError(hostile);
    expect(err.message).not.toMatch(CONTROL_CHARS);
    // .received retains the raw object verbatim (asymmetry pinned).
    expect(err.received).toBe(hostile);
  });

  it("is a no-op for a clean value", () => {
    const err = new UnsupportedVersionError(7);
    expect(err.message).toBe(
      "Unsupported schema version: received 7, supported 0",
    );
    expect(err.received).toBe(7);
  });

  it("handles a missing `v` (JSON.stringify(undefined) === undefined) without throwing", () => {
    // The missing-version gate constructs this with `received: undefined`;
    // JSON.stringify(undefined) is itself `undefined`, which must not blow up
    // the sanitize step. The message falls back to the literal "undefined".
    const err = new UnsupportedVersionError(undefined);
    expect(err.message).toBe(
      "Unsupported schema version: received undefined, supported 0",
    );
    expect(err.received).toBeUndefined();
  });
});
