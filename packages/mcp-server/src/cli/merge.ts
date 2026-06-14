/**
 * Idempotent merge + safe-write helpers for `caucus init` (CAU-108).
 *
 * The scaffold is non-destructive (an AC): it merges ONLY the caucus-owned keys
 * into an existing `.mcp.json` / `.claude/settings.local.json`, preserving every
 * other `mcpServers.*`, `permissions`, hook matcher, etc. The merge is pure
 * (takes the parsed existing object + the desired caucus fragment, returns the
 * merged object); the I/O (read/parse/backup/atomic-write) lives in
 * filesystem-touching helpers a caller composes.
 *
 * Stable 2-space serialization (trailing newline) makes re-runs byte-identical,
 * which the "already up to date" no-op detection relies on.
 */
import { type CaucusMcpEntry, type HookMatcher } from "./generate.js";

/** Serialize a value as stable, 2-space JSON with a trailing newline. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Merge the caucus server entry into a (possibly pre-existing, arbitrary)
 * `.mcp.json` object, preserving all other `mcpServers.*` and any other
 * top-level keys. Returns a NEW object (the input is not mutated).
 */
export function mergeMcp(
  existing: Record<string, unknown>,
  entry: CaucusMcpEntry,
): Record<string, unknown> {
  const existingServers =
    existing.mcpServers !== null &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  return {
    ...existing,
    mcpServers: { ...existingServers, caucus: entry },
  };
}

/** True when `m` is the caucus `UserPromptSubmit` matcher (empty matcher, our command shape). */
function isCaucusHookMatcher(m: unknown, command: string): boolean {
  if (m === null || typeof m !== "object") return false;
  const matcher = m as { matcher?: unknown; hooks?: unknown };
  if (matcher.matcher !== "") return false;
  if (!Array.isArray(matcher.hooks)) return false;
  return matcher.hooks.some(
    (h) =>
      h !== null &&
      typeof h === "object" &&
      (h as { command?: unknown }).command === command,
  );
}

/**
 * Merge the caucus `UserPromptSubmit` hook + `caucus` mcp enablement into a
 * (possibly pre-existing) settings object, preserving other hook matchers, other
 * hook events, `permissions`, and any other top-level keys. Idempotent: a
 * re-run replaces the existing caucus matcher in place rather than appending a
 * duplicate. Returns a NEW object.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  matcher: HookMatcher,
): Record<string, unknown> {
  // --- enabledMcpjsonServers: union in "caucus" only if the key is used. ---
  let enabled: string[] | undefined;
  if (Array.isArray(existing.enabledMcpjsonServers)) {
    const cur = existing.enabledMcpjsonServers.filter(
      (v): v is string => typeof v === "string",
    );
    enabled = cur.includes("caucus") ? cur : [...cur, "caucus"];
  } else if (existing.enabledMcpjsonServers === undefined) {
    enabled = ["caucus"];
  }
  // (If the key exists but is some non-array garbage, leave it untouched.)

  // --- hooks.UserPromptSubmit: replace our matcher in place, keep the rest. ---
  const existingHooks =
    existing.hooks !== null &&
    typeof existing.hooks === "object" &&
    !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const ourCommand = matcher.hooks[0].command;
  const existingUps = Array.isArray(existingHooks.UserPromptSubmit)
    ? existingHooks.UserPromptSubmit
    : [];
  const keptOthers = existingUps.filter(
    (m) => !isCaucusHookMatcher(m, ourCommand),
  );
  const mergedUps = [...keptOthers, matcher];

  const result: Record<string, unknown> = {
    ...existing,
    hooks: { ...existingHooks, UserPromptSubmit: mergedUps },
  };
  if (enabled !== undefined) {
    result.enabledMcpjsonServers = enabled;
  }
  return result;
}

/** Outcome class for one artifact's plan, used for legible CLI output. */
export type PlanAction =
  | "create" // file absent → write fresh
  | "noop" // file present and already byte-identical → leave it
  | "merge" // file present, valid JSON → merged in our keys (differs)
  | "recreate" // file present but corrupt JSON → backed up + written fresh
  | "skip"; // file present and differs, but it is the user's secret-bearing
//           env file → leave it untouched, never back it up (ADR-C12)

/** The decided plan for ONE artifact: what to write and why. */
export interface FilePlan {
  /** What we'll do. */
  readonly action: PlanAction;
  /** The exact bytes to write (undefined for `noop`). */
  readonly content?: string;
  /** True when the existing file must be backed up before writing (merge/recreate). */
  readonly backup: boolean;
}

/**
 * Decide the plan for a JSON artifact given its current on-disk content (or
 * `undefined` if absent) and a `build` that produces the desired merged object
 * from the parsed existing object.
 *
 * - absent → `create`.
 * - corrupt JSON → `recreate` (back up + write a fresh object built from `{}`);
 *   never merge into garbage.
 * - valid + already byte-identical to the merge result → `noop` (no backup).
 * - valid + differs → `merge` (back up + write).
 */
export function planJsonFile(
  current: string | undefined,
  build: (existing: Record<string, unknown>) => unknown,
): FilePlan {
  if (current === undefined) {
    return { action: "create", content: serialize(build({})), backup: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    // Corrupt: do NOT merge into garbage — back up and write a clean object.
    return { action: "recreate", content: serialize(build({})), backup: true };
  }
  const existing =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const next = serialize(build(existing));
  if (next === current) {
    return { action: "noop", backup: false };
  }
  return { action: "merge", content: next, backup: true };
}

/**
 * Decide the plan for the sourceable `caucus.env`, which is line-oriented, not
 * JSON. This is the ONE file the user owns and pastes their bearer secret into,
 * so we must never copy it anywhere a backup could be committed (ADR-C12): a
 * `.bak-<ts>` of a populated `caucus.env` would smuggle the secret into a
 * git-trackable file. Therefore:
 *   absent     → `create` (write the empty-token template);
 *   identical  → `noop`   (already up to date);
 *   differs    → `skip`   (leave it EXACTLY as-is — never backed up, never
 *                          rewritten; the caller prints a notice so the user
 *                          can reconcile CAUCUS_URL/CAUCUS_CHANNEL by hand).
 * Note there is deliberately no `--force` path that overwrites it.
 */
export function planEnvFile(
  current: string | undefined,
  content: string,
): FilePlan {
  if (current === undefined) return { action: "create", content, backup: false };
  if (current === content) return { action: "noop", backup: false };
  return { action: "skip", backup: false };
}
