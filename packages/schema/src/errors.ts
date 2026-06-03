/**
 * Typed errors thrown at the codec boundary. Every schema error carries a
 * stable string `code` so callers can branch without string-matching messages.
 */
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
      `Unsupported schema version: received ${JSON.stringify(received)}, supported ${SCHEMA_VERSION}`,
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
    super(`Malformed message: ${issues.join("; ")}`, "malformed_message");
    this.name = "MalformedMessageError";
    this.issues = issues;
  }
}
