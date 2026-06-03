/**
 * Field validation for a *version-gated* message. The version check is NOT done
 * here — callers (the codec) run the version gate first, then call `validate`.
 *
 * Validation is strict (ADR ratification Q4, CAU-3): unknown top-level keys are
 * rejected, claim-only fields are rejected on non-claim types, and `target` is
 * required on `claim`. All problems are collected and thrown together.
 */
import { MESSAGE_TYPES, STATUS_VALUES } from "./constants.js";
import { MalformedMessageError } from "./errors.js";
import type { CaucusMessage } from "./types.js";
import { isUlid } from "./ulid.js";
import { SCHEMA_VERSION } from "./version.js";

/** Allowed top-level keys: schema fields + the codec-managed `v` and `ts`. */
const ALLOWED_KEYS = new Set<string>([
  "v",
  "ts",
  "type",
  "agent_id",
  "owner",
  "msg_id",
  "body",
  "thread",
  "reply_to",
  "to",
  "status",
  "artifact",
  "target",
  "lease_ttl",
  "heartbeat",
]);

/** Claim-only fields, rejected when present on a non-claim message. */
const CLAIM_ONLY_KEYS = ["target", "lease_ttl", "heartbeat"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True iff `v` is a non-empty string. */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * Assert that `value` is a structurally valid schema-v0 message. Assumes the
 * version gate has already accepted `value.v`. Throws
 * {@link MalformedMessageError} listing every problem found.
 */
export function validate(value: unknown): asserts value is CaucusMessage {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    throw new MalformedMessageError(["message must be a JSON object"]);
  }

  // Unknown top-level keys.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      issues.push(`unknown field "${key}"`);
    }
  }

  // `v` must be exactly the supported version (the gate should guarantee this,
  // but validate defensively for direct callers).
  if (value.v !== SCHEMA_VERSION) {
    issues.push(`v must be ${SCHEMA_VERSION}`);
  }

  // type
  const type = value.type;
  const typeOk =
    typeof type === "string" &&
    (MESSAGE_TYPES as readonly string[]).includes(type);
  if (!typeOk) {
    issues.push(`type must be one of ${MESSAGE_TYPES.join(", ")}`);
  }

  // Required string fields.
  if (!isNonEmptyString(value.agent_id)) {
    issues.push("agent_id must be a non-empty string");
  }
  if (!isNonEmptyString(value.owner)) {
    issues.push("owner must be a non-empty string");
  }
  if (!isUlid(value.msg_id)) {
    issues.push("msg_id must be a ULID");
  }
  if (typeof value.body !== "string" || value.body.length === 0) {
    issues.push("body must be a non-empty string");
  }

  // Optional ULID references.
  if (value.thread !== undefined && !isUlid(value.thread)) {
    issues.push("thread must be a ULID");
  }
  if (value.reply_to !== undefined && !isUlid(value.reply_to)) {
    issues.push("reply_to must be a ULID");
  }

  // Optional `to`: array of non-empty strings.
  if (value.to !== undefined) {
    if (
      !Array.isArray(value.to) ||
      !value.to.every((entry) => isNonEmptyString(entry))
    ) {
      issues.push("to must be an array of non-empty strings");
    }
  }

  // Optional `status`.
  if (
    value.status !== undefined &&
    !(STATUS_VALUES as readonly string[]).includes(value.status as string)
  ) {
    issues.push(`status must be one of ${STATUS_VALUES.join(", ")}`);
  }

  // Optional `artifact`.
  if (value.artifact !== undefined && !isNonEmptyString(value.artifact)) {
    issues.push("artifact must be a non-empty string");
  }

  // Optional server-stamped `ts`.
  if (value.ts !== undefined && !isNonEmptyString(value.ts)) {
    issues.push("ts must be a non-empty string");
  }

  // Claim-specific rules.
  if (type === "claim") {
    if (
      typeof value.target !== "string" ||
      value.target.trim().length === 0
    ) {
      issues.push("claim requires a non-empty target");
    }
    if (value.lease_ttl !== undefined && typeof value.lease_ttl !== "number") {
      issues.push("lease_ttl must be a number");
    }
    if (value.heartbeat !== undefined && typeof value.heartbeat !== "boolean") {
      issues.push("heartbeat must be a boolean");
    }
  } else {
    // Claim-only fields are not allowed on other types.
    for (const key of CLAIM_ONLY_KEYS) {
      if (value[key] !== undefined) {
        issues.push(`${key} is only valid on claim messages`);
      }
    }
  }

  if (issues.length > 0) {
    throw new MalformedMessageError(issues);
  }
}
