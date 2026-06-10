/**
 * Typed errors thrown at the codec boundary. Every schema error carries a
 * stable string `code` so callers can branch without string-matching messages.
 */
import { sanitizeErrorFragment, stripControlChars } from "./sanitize.js";
import { SCHEMA_VERSION } from "./version.js";

/** Base class for all schema errors. */
export class SchemaError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
  }
}

/**
 * Thrown when a message's `v` is missing or not the supported version. The
 * version gate runs before any field validation.
 */
export class UnsupportedVersionError extends SchemaError {
  /** The `v` value that was received (may be any type, or undefined). */
  readonly received: unknown;
  /** The single version this build supports. */
  readonly supported: number;

  constructor(received: unknown) {
    super(
      // `received` is caller-controlled: a hostile `v` (e.g. a string carrying
      // DEL/C1 bytes) survives `JSON.stringify` and would ride the message over
      // the wire (ADR-C12 / CAU-88). Sanitize the serialized fragment for the
      // message; `.received` below is kept RAW for in-process consumers (the
      // message is the only display surface). `JSON.stringify(undefined)` is
      // itself `undefined` (the missing-`v` gate), so fall back to the string
      // "undefined" — matching the pre-CAU-88 template-literal coercion.
      `Unsupported schema version: received ${sanitizeErrorFragment(JSON.stringify(received) ?? "undefined")}, supported ${SCHEMA_VERSION}`,
      "unsupported_version",
    );
    this.name = "UnsupportedVersionError";
    this.received = received;
    this.supported = SCHEMA_VERSION;
  }
}

/** Thrown when a versioned message fails field validation or fails to parse. */
export class MalformedMessageError extends SchemaError {
  /** Human-readable list of every problem found. */
  readonly issues: string[];

  constructor(issues: string[]) {
    // Strip control bytes from EVERY issue before they reach a display surface
    // (ADR-C12 / CAU-88). Most issues are server-derived constants, but some
    // echo caller content (the unknown-field key from `validate`), and this
    // array is forwarded verbatim into the wire `.issues[]` AND joined into
    // `.message`. Cleaning once here means BOTH stored `.issues` and `.message`
    // are control-byte-free, so no consumer (wire, MCP, TTY) re-strips.
    const clean = issues.map(stripControlChars);
    super(`Malformed message: ${clean.join("; ")}`, "malformed_message");
    this.name = "MalformedMessageError";
    this.issues = clean;
  }
}
