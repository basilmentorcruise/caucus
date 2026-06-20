/**
 * Friendly, model-facing arg-validation messages (CAU-123).
 *
 * The MCP SDK validates a tool call's arguments against the tool's Zod input
 * schema BEFORE the handler runs, and on failure surfaces a raw protocol error —
 * `Input validation error: Invalid arguments for tool X: [ … a JSON dump of the
 * Zod issue array … ]`. That dump is leak-free and correct, but it is terse and
 * model-UNfriendly compared to the hand-written tool-layer errors elsewhere
 * (e.g. upload-artifact's "Provide exactly one of `path`/`content`").
 *
 * This module is a tiny mapper that turns the COMMON Zod issues — a missing
 * required argument, a wrong-type argument, and an out-of-enum value — into a
 * single clear sentence naming the offending argument and what it expects. It
 * deliberately does NOT rebuild the validation stack: {@link registry} re-uses
 * each tool's OWN Zod shape to parse, and this function only re-phrases the
 * resulting issues. Anything it doesn't specially handle falls back to the
 * issue's own (already leak-free) message.
 *
 * Leak-free (ADR-C12): the message names the ARGUMENT (a schema-author-chosen
 * field name, never caller content) and, for an enum, the schema's OWN allowed
 * options (also author-chosen) — it NEVER echoes the rejected value or any other
 * caller-supplied payload. The output is single-line and control-byte-free by
 * construction (it is built from fixed phrasing + field/enum names).
 */
import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/** The leading phrase, mirroring the value-free tool-layer error voice. */
const PREFIX = "Invalid arguments";

/** Render a dotted argument path (`a.b`) for nested fields; top-level is just the name. */
function fieldName(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "(root)";
}

/** Read the value at a (possibly nested) issue path in the original args. */
function valueAtPath(
  args: Record<string, unknown>,
  path: readonly PropertyKey[],
): unknown {
  let cur: unknown = args;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * Turn ONE Zod issue into a clear, leak-free clause. Handles the three common
 * shapes; everything else reuses the issue's own message (already leak-free —
 * Zod's default messages name types/constraints, not values).
 */
function describeIssue(
  issue: z.core.$ZodIssue,
  args: Record<string, unknown>,
): string {
  const field = fieldName(issue.path);
  switch (issue.code) {
    case "invalid_type": {
      // Zod reports a MISSING required arg as an invalid_type. The issue object
      // (zod v4) carries no `received`, so distinguish "missing" from "wrong
      // type" by looking at the actual input at the path — both are common and
      // the fix differs.
      if (valueAtPath(args, issue.path) === undefined) {
        return `\`${field}\` is required`;
      }
      const expected = (issue as { expected?: unknown }).expected;
      return typeof expected === "string"
        ? `\`${field}\` must be a ${expected}`
        : `\`${field}\` is the wrong type`;
    }
    case "invalid_value": {
      // An out-of-enum value. Echo the schema's OWN allowed options (author-
      // chosen), never the rejected value.
      const values = (issue as { values?: readonly unknown[] }).values;
      if (Array.isArray(values) && values.length > 0) {
        const opts = values.map((v) => `\`${String(v)}\``).join(", ");
        return `\`${field}\` must be one of: ${opts}`;
      }
      return `\`${field}\` is not an allowed value`;
    }
    default:
      // Fall back to Zod's own message but PREFIX the field so the model knows
      // which argument to fix. Zod default messages are leak-free (they name the
      // constraint/type, not the value).
      return `\`${field}\`: ${issue.message}`;
  }
}

/**
 * Parse `args` against a tool's Zod raw `shape`. On success returns the parsed,
 * defaults-applied args; on failure returns a friendly, leak-free, single-line
 * message (see module doc). The reported issues are de-duplicated by field so a
 * single bad call doesn't repeat the same argument.
 */
export function parseToolArgs(
  shape: ZodRawShapeCompat,
  args: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  // Re-use the tool's OWN shape (not a re-spelled copy) so this can never drift
  // from what the SDK advertises and what the handler expects.
  const result = z.object(shape).safeParse(args);
  if (result.success) {
    return { ok: true, value: result.data as Record<string, unknown> };
  }

  const seen = new Set<string>();
  const clauses: string[] = [];
  for (const issue of result.error.issues) {
    const clause = describeIssue(issue, args);
    if (seen.has(clause)) continue;
    seen.add(clause);
    clauses.push(clause);
  }
  return { ok: false, message: `${PREFIX}: ${clauses.join("; ")}.` };
}
