/**
 * The codec boundary: `encode` (authored input → wire string) and `decode`
 * (wire string / parsed value → typed message). Malformed input is rejected
 * here with typed errors (ADR ratification Q4, CAU-3).
 *
 * The codec is a pure leaf: it stamps `v`, never sets `ts`, and never touches
 * or auth-checks `agent_id`/`owner` (those are server-anchored, ADR-C7).
 */
import { MalformedMessageError, UnsupportedVersionError } from "./errors.js";
import type { CaucusMessage, MessageInput } from "./types.js";
import { validate } from "./validate.js";
import { SCHEMA_VERSION } from "./version.js";

/** Throw {@link UnsupportedVersionError} unless `v` is exactly the supported version. */
function versionGate(v: unknown): asserts v is typeof SCHEMA_VERSION {
  if (v !== SCHEMA_VERSION) {
    throw new UnsupportedVersionError(v);
  }
}

/**
 * Stamp `v`, validate, and serialize an authored message to a wire string.
 * Never sets `ts` and never mutates the caller's object. Throws
 * {@link MalformedMessageError} if the input is invalid.
 */
export function encode(input: MessageInput): string {
  const stamped = { ...input, v: SCHEMA_VERSION };
  validate(stamped);
  return JSON.stringify(stamped);
}

/**
 * Parse (if a string) and validate a message. Runs the version gate FIRST so a
 * wrong/missing `v` always surfaces as {@link UnsupportedVersionError} rather
 * than field issues. Throws {@link MalformedMessageError} for non-JSON input or
 * field problems.
 */
export function decode(raw: string | unknown): CaucusMessage {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MalformedMessageError(["not valid JSON"]);
    }
  } else {
    parsed = raw;
  }

  // Version gate before field validation. A non-object can't carry `v`, so it
  // fails the gate with `received: undefined`.
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).v
      : undefined;
  versionGate(version);

  validate(parsed);
  return parsed;
}
