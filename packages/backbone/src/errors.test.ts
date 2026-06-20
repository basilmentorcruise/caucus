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

import {
  ArtifactIntegrityError,
  ArtifactTooLargeError,
  ChannelExistsError,
  ChannelFullError,
  InvalidChannelNameError,
  InvalidMessageError,
  UnknownChannelError,
} from "./errors.js";
import { MAX_ERROR_FRAGMENT_CHARS, stripControlChars } from "@caucus/schema";

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

describe("channel-name error echo is bounded + control-stripped (CAU-123 / CAU-81)", () => {
  it("InvalidChannelNameError caps a very long name and still strips control bytes", () => {
    // A hostile name: thousands of printable chars carrying smuggled control
    // bytes. Pre-CAU-123 the printable run rode the message in full.
    const huge = `${"a".repeat(8000)}${DEL}${C1}`;
    const err = new InvalidChannelNameError(huge);

    // Bounded: the echoed run never reaches the full 8000+ chars. The cap counts
    // visible characters; quoting + the fixed suffix add a small constant.
    expect(err.message.length).toBeLessThan(MAX_ERROR_FRAGMENT_CHARS + 80);
    expect(err.message).toContain("…"); // truncation marker present
    // Control bytes are STILL stripped (ADR-C12 / CAU-81 protection intact).
    expect(err.message).not.toMatch(CONTROL_CHARS);
    // The structured field keeps the name verbatim, as documented.
    expect(err.channel).toBe(huge);
    expect(err.code).toBe("invalid_channel_name");
  });

  it("is a no-op for a normal valid slug", () => {
    const err = new InvalidChannelNameError("war-room-1");
    expect(err.message).toContain('"war-room-1"');
    expect(err.message).not.toContain("…");
  });

  it("caps and strips across the other channel-name error surfaces too", () => {
    const huge = `${"z".repeat(5000)}${C1}`;
    for (const err of [
      new UnknownChannelError(huge),
      new ChannelExistsError(huge),
      new ChannelFullError(huge, 10),
    ]) {
      expect(err.message.length).toBeLessThan(MAX_ERROR_FRAGMENT_CHARS + 120);
      expect(err.message).not.toMatch(CONTROL_CHARS);
    }
  });
});

describe("artifact errors (ADR-C14 / CAU-100)", () => {
  it("ArtifactTooLargeError carries scope + limit and a value-free message per scope", () => {
    for (const scope of ["blob", "channel", "global"] as const) {
      const err = new ArtifactTooLargeError(scope, 1234);
      expect(err.code).toBe("artifact_too_large");
      expect(err.scope).toBe(scope);
      expect(err.limit).toBe(1234);
      expect(err.message).toContain("1234 bytes");
      // No control bytes, no caller content.
      expect(err.message).not.toMatch(CONTROL_CHARS);
    }
    // The three scopes phrase the "where" distinctly so the client can recover
    // the scope from the message.
    expect(new ArtifactTooLargeError("channel", 1).message).toContain(
      "channel's artifact store",
    );
    expect(new ArtifactTooLargeError("global", 1).message).toContain(
      "backbone's artifact store",
    );
    expect(new ArtifactTooLargeError("blob", 1).message).toContain(
      "a single artifact",
    );
  });

  it("ArtifactIntegrityError is a fixed, value-free 400-class error", () => {
    const err = new ArtifactIntegrityError();
    expect(err.code).toBe("artifact_integrity");
    expect(err.message).toContain("integrity check failed");
    expect(err.message).not.toMatch(CONTROL_CHARS);
  });
});
