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
