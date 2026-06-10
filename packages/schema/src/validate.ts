/**
 * Field validation for a *version-gated* message. The version check is NOT done
 * here — callers (the codec) run the version gate first, then call `validate`.
 *
 * Validation is strict (ADR ratification Q4, CAU-3): unknown top-level keys are
 * rejected, claim-only fields are rejected on non-claim types, and `target` is
 * required on `claim`. All problems are collected and thrown together.
 *
 * Control characters are rejected at this write boundary (CAU-71): the
 * poster-controlled free-text fields must contain no C0/DEL/C1 byte (`body`
 * tolerates `\t`/`\n`). The byte sets come from the shared predicates in
 * `sanitize.ts`, the single authority for both this write layer and the
 * read/render layer (CAU-69/73). Error strings NEVER echo payload bytes —
 * these errors travel over the wire into TTYs (ADR-C12).
 */
import {
  MAX_FIELD_CHARS,
  MAX_RECIPIENTS,
  MAX_REPORTED_ISSUES,
  MESSAGE_TYPES,
  STATUS_VALUES,
} from "./constants.js";
import { MalformedMessageError } from "./errors.js";
import {
  containsControlChars,
  containsControlCharsExceptWhitespace,
  sanitizeErrorFragment,
} from "./sanitize.js";
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
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Assert that `value` is a structurally valid schema message (v1). Assumes the
 * version gate has already accepted `value.v`. Throws
 * {@link MalformedMessageError} listing every problem found.
 */
export function validate(value: unknown): asserts value is CaucusMessage {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    throw new MalformedMessageError(["message must be a JSON object"]);
  }

  // Unknown top-level keys. The number of unknown fields is attacker-controlled
  // (one issue each is otherwise unbounded), so report at most
  // MAX_REPORTED_ISSUES individually, then a single summary line — the error
  // can never dwarf the body that caused it (CAU-6).
  let unknownReported = 0;
  let unknownTotal = 0;
  for (const key of Object.keys(value)) {
    if (ALLOWED_KEYS.has(key)) continue;
    unknownTotal += 1;
    if (unknownReported < MAX_REPORTED_ISSUES) {
      // `key` is caller-controlled and rides into the thrown error's `.message`
      // / wire-forwarded `.issues[]` (ADR-C12 / CAU-88): strip control bytes and
      // length-cap before echoing it. Every OTHER push in this file interpolates
      // only server-derived constants/counts (SCHEMA_VERSION, the enum joins,
      // unknown-field count, the fixed CLAIM_ONLY_KEYS names) — this is the sole
      // caller-content echo here, so it is the only one sanitized.
      issues.push(`unknown field "${sanitizeErrorFragment(key)}"`);
      unknownReported += 1;
    }
  }
  if (unknownTotal > unknownReported) {
    issues.push(`…and ${unknownTotal - unknownReported} more unknown fields`);
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

  // Required string fields. Each control-char check (CAU-71) runs only when
  // the base shape check passed, so a field never double-reports.
  if (!isNonEmptyString(value.agent_id)) {
    issues.push("agent_id must be a non-empty string");
  } else if (containsControlChars(value.agent_id)) {
    issues.push("agent_id must not contain control characters");
  } else if (value.agent_id.length > MAX_FIELD_CHARS) {
    // Length cap (CAU-90): `agent_id` is a short session label, not a payload —
    // an in-process embedder has no HTTP byte bound, so an unbounded value is a
    // read-amplification lever (a 50MB `agent_id` survives into a clamped read
    // page). Positional + NON-echoing (ADR-C12 / CAU-88): name the field, the
    // limit, and the actual length — never the value. The length is a plain
    // integer (control-byte-free per CAU-88), so it is safe to interpolate.
    issues.push(
      `agent_id exceeds ${MAX_FIELD_CHARS} characters (${value.agent_id.length})`,
    );
  }
  if (!isNonEmptyString(value.owner)) {
    issues.push("owner must be a non-empty string");
  } else if (containsControlChars(value.owner)) {
    issues.push("owner must not contain control characters");
  } else if (value.owner.length > MAX_FIELD_CHARS) {
    // Length cap (CAU-90) — same rationale as `agent_id` above; `owner` is a
    // short human label. Non-echoing: field name + limit + actual length only.
    issues.push(
      `owner exceeds ${MAX_FIELD_CHARS} characters (${value.owner.length})`,
    );
  }
  // msg_id needs no control-char check: the ULID regex already excludes them.
  if (!isUlid(value.msg_id)) {
    issues.push("msg_id must be a ULID");
  }
  if (!isNonEmptyString(value.body)) {
    issues.push("body must be a non-empty string");
  } else if (containsControlCharsExceptWhitespace(value.body)) {
    // `\t`/`\n` are legitimate multi-line body structure; every other
    // C0/DEL/C1 byte (incl. `\r`) is rejected.
    issues.push(
      "body must not contain control characters (tab and newline are allowed)",
    );
  }

  // Optional ULID references — the ULID regex already excludes control bytes,
  // so no control-char check is needed here either.
  if (value.thread !== undefined && !isUlid(value.thread)) {
    issues.push("thread must be a ULID");
  }
  if (value.reply_to !== undefined && !isUlid(value.reply_to)) {
    issues.push("reply_to must be a ULID");
  }

  // Optional `to`: when present, a non-empty array of non-empty strings.
  // An empty array is rejected — "absent" already means "for the channel",
  // so `to: []` would be ambiguous on a frozen contract.
  if (value.to !== undefined) {
    if (
      !Array.isArray(value.to) ||
      value.to.length === 0 ||
      !value.to.every((entry) => isNonEmptyString(entry))
    ) {
      issues.push("to must be a non-empty array of non-empty strings");
    } else if (value.to.length > MAX_RECIPIENTS) {
      // Count cap (CAU-90): `to[]` is a routing fan-out list, not a payload —
      // a poster-controlled count is a read-amplification lever (in-process
      // embedders have no body-byte bound). Positional + NON-echoing (ADR-C12 /
      // CAU-88): the message carries the offending count and the limit, never
      // the recipient values (which are caller-controlled and may contain
      // control bytes — see the per-entry check below). Checked before the
      // control-char scan so an over-cap list is rejected by count without
      // iterating every (possibly dirty) entry.
      issues.push(
        `to[] has more than ${MAX_RECIPIENTS} recipients (${value.to.length})`,
      );
    } else if (
      // ONE aggregate issue for the whole array (CAU-71): the entry count is
      // poster-controlled, so per-entry issues would be unbounded.
      value.to.some((entry) => containsControlChars(entry))
    ) {
      issues.push("to entries must not contain control characters");
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
  if (value.artifact !== undefined) {
    if (!isNonEmptyString(value.artifact)) {
      issues.push("artifact must be a non-empty string");
    } else if (containsControlChars(value.artifact)) {
      issues.push("artifact must not contain control characters");
    } else if (value.artifact.length > MAX_FIELD_CHARS) {
      // Length cap (CAU-90): `artifact` is a *pointer* — a URI/URL to the full
      // content (docs/MESSAGE_SCHEMA.md), never the payload itself — so
      // MAX_FIELD_CHARS (1024) sits comfortably above any legitimate reference.
      // Same read-amplification rationale and non-echoing idiom as `agent_id`.
      issues.push(
        `artifact exceeds ${MAX_FIELD_CHARS} characters (${value.artifact.length})`,
      );
    }
  }

  // Optional server-stamped `ts`. No control-char check: the backbone's
  // `#appendSync` OVERWRITES any client-supplied `ts` with its own stamp, so a
  // client value here never reaches the log — do not "fix" this by rejecting.
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
    } else if (containsControlChars(value.target)) {
      issues.push("target must not contain control characters");
    }
    // `type`/`status`/`v` are enum-checked and `lease_ttl`/`heartbeat` are
    // number/boolean — none can carry a control byte.
    if (
      value.lease_ttl !== undefined &&
      !(Number.isInteger(value.lease_ttl) && (value.lease_ttl as number) > 0)
    ) {
      issues.push("lease_ttl must be a positive integer (seconds)");
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
