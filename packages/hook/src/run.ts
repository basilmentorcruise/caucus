/**
 * The hook's turn-start orchestration (CAU-14).
 *
 * Mechanism (CAU-24 spike verdict): a Claude Code `UserPromptSubmit` command
 * hook. On every turn it reads the channel delta since the last checkpoint,
 * renders it, advances the checkpoint, and returns the `additionalContext`
 * payload Claude Code injects into the model's context.
 *
 * Two contracts the spike makes load-bearing:
 *
 * 1. **stdout is sacred.** `runHook` returns EITHER `""` (inject nothing) OR the
 *    exact JSON string Claude Code expects. Every diagnostic goes to the
 *    injected `stderr` — anything on stdout becomes injected context (the
 *    classic hook bug).
 * 2. **Fail open, fast.** A `UserPromptSubmit` hook blocks the turn under a ~30 s
 *    budget. ANY error (backbone down, unknown channel, timeout) ⇒ one
 *    value-free stderr line and `""`. A client-side timeout (~4 s) guards
 *    against a hung backbone eating the whole budget.
 *
 * First-run semantics (ADR-C6, no history replay): when there's no usable
 * checkpoint we MINT at the channel head and inject NOTHING this turn — the hook
 * surfaces only what arrives *after* the session started paying attention, never
 * a backlog dump.
 */
import type { Backbone, Cursor } from "@caucus/backbone";

import { loadHookConfig } from "./config.js";
import { checkpointPath, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { renderDelta } from "./render.js";

/** The Claude Code `UserPromptSubmit` event name (its hookSpecificOutput key). */
const HOOK_EVENT_NAME = "UserPromptSubmit";

/** Client-side fetch budget. Well under the ~30 s `UserPromptSubmit` ceiling. */
export const HOOK_TIMEOUT_MS = 4000;

/** Session id fallback when stdin is empty/garbled — a stable per-host bucket. */
const FALLBACK_SESSION_ID = "default";

/** Injected dependencies for {@link runHook} (everything non-pure is here). */
export interface RunHookDeps {
  /** The backbone client (read-only use: `describeChannel`, `subscribe`, `readSince`). */
  readonly backbone: Backbone;
  /** Process environment (parsed by {@link loadHookConfig}). */
  readonly env: Record<string, string | undefined>;
  /** The Claude Code session id (from {@link parseHookInput}). */
  readonly sessionId: string;
  /** Home dir that anchors the checkpoint path. Injected for tests. */
  readonly home: string;
  /** Diagnostics sink. Defaults to `process.stderr.write` in the bin. */
  readonly stderr: (line: string) => void;
  /** Overridable timeout (ms) for the fail-fast guard; defaults to {@link HOOK_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Shape of the parsed `UserPromptSubmit` stdin payload we care about. */
export interface HookInput {
  /** Claude Code session id; falls back to `"default"` when absent/garbled. */
  readonly sessionId: string;
}

/**
 * Parse the JSON Claude Code pipes to a `UserPromptSubmit` command hook on
 * stdin, extracting the `session_id`. Garbled or empty stdin (or a missing /
 * non-string `session_id`) falls back to `"default"` so the hook still works —
 * it just shares one checkpoint bucket on that host.
 */
export function parseHookInput(stdin: string): HookInput {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed !== null && typeof parsed === "object") {
      const sid = (parsed as { session_id?: unknown }).session_id;
      if (typeof sid === "string" && sid.trim() !== "") {
        return { sessionId: sid };
      }
    }
  } catch {
    // Fall through to the default below.
  }
  return { sessionId: FALLBACK_SESSION_ID };
}

/**
 * Build the exact stdout payload Claude Code injects. The text becomes
 * `hookSpecificOutput.additionalContext` for the `UserPromptSubmit` event.
 */
function injectionEnvelope(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      additionalContext,
    },
  });
}

/**
 * Run a promise with a fail-fast timeout. On timeout the underlying request is
 * abandoned (we don't await it) and the timeout rejection wins, so a hung
 * backbone can never consume more than `ms` of the turn budget.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hook timed out after ${ms}ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * The turn-start hook body. Returns the stdout string to print: either `""`
 * (inject nothing) or the `UserPromptSubmit` injection JSON.
 *
 * Flow:
 * 1. Resolve config. No channel ⇒ no-op (`""`) — the hook isn't wired up.
 * 2. Resolve the checkpoint. None (first run / corrupt) ⇒ mint at head, persist,
 *    inject NOTHING this turn (ADR-C6 — no backlog replay).
 * 3. Otherwise `readSince(channel, checkpoint)`, render the delta, persist the
 *    RETURNED cursor (never a computed one), and inject — or `""` for an empty
 *    delta.
 *
 * Every backbone call is wrapped in the fail-fast timeout; ANY thrown error ⇒
 * one value-free stderr line and `""` (fail open).
 */
export async function runHook(deps: RunHookDeps): Promise<string> {
  const { backbone, env, sessionId, home, stderr } = deps;
  const timeoutMs = deps.timeoutMs ?? HOOK_TIMEOUT_MS;

  const config = loadHookConfig(env);
  if (config.channel === "") {
    // No channel configured: the hook is present but not wired to a war room.
    // Silently do nothing — this is the expected state outside a session.
    return "";
  }
  const channel = config.channel;
  const path = checkpointPath(sessionId, channel, home);

  try {
    const checkpoint = await readCheckpoint(path, channel);

    if (checkpoint === undefined) {
      // First run for this session+channel: mint at head and inject nothing.
      const head: Cursor = await withTimeout(
        backbone.subscribe(channel),
        timeoutMs,
      );
      await writeCheckpoint(path, head, channel);
      return "";
    }

    const result = await withTimeout(
      backbone.readSince(channel, checkpoint),
      timeoutMs,
    );
    // Persist the cursor the backbone RETURNED — never compute it ourselves.
    await writeCheckpoint(path, result.cursor, channel);

    const block = renderDelta(result.messages);
    if (block === "") return "";
    return injectionEnvelope(block);
  } catch {
    // Fail open: a value-free line (never the channel/url/error — ADR-C12) and
    // inject nothing so a backbone hiccup can't break or pollute the turn.
    stderr("caucus-hook: skipped this turn (backbone unavailable or slow)\n");
    return "";
  }
}
