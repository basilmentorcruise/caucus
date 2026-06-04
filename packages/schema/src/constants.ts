/**
 * Closed value sets for the schema. Kept dependency-free and as `const`
 * tuples so the corresponding union types derive directly from them.
 */

/** The fixed set of message intents (ADR-C5; see docs/MESSAGE_SCHEMA.md). */
export const MESSAGE_TYPES = [
  "finding",
  "claim",
  "status",
  "question",
  "answer",
  "note",
] as const;

/** Coordination signals an optional `status` field may carry. */
export const STATUS_VALUES = ["needs-response", "resolved", "fyi"] as const;

/**
 * Hook-rendering budget for the injected channel delta, in characters.
 *
 * CAU-24 found Claude Code caps a `UserPromptSubmit` `additionalContext`
 * payload at ~10,000 chars; 8,000 leaves headroom for the wrapper block and an
 * overflow line. The codec does NOT enforce this per-message — overflow
 * behavior is CAU-14's. Exported here so the hook and schema agree on one
 * number.
 */
export const INJECTED_DELTA_CAP_CHARS = 8000 as const;

/**
 * Cap on the number of *unknown-field* issues `validate` reports for a single
 * message (CAU-6).
 *
 * The unknown-key scan pushes one issue per unrecognized top-level field, which
 * is otherwise unbounded: a near-max body packed with thousands of unknown keys
 * would inflate the validation error far beyond the offending body itself. After
 * this many unknown-field issues, `validate` stops collecting individual names
 * and appends a single "…and N more unknown fields" summary. Only the
 * unknown-key loop is capped — every other check targets a fixed field set and
 * is inherently bounded.
 */
export const MAX_REPORTED_ISSUES = 10 as const;
