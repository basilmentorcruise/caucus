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
 *
 * Self-heal (CAU-72): the backbone is in-memory/ephemeral, so a restart is
 * normal — head resets to 0 while the on-disk checkpoint still holds a higher
 * cursor. `readSince` then rejects with `invalid_cursor` (or `unknown_channel`
 * if the channel was never recreated). Rather than fail open every turn forever
 * (silently blind until the checkpoint is deleted by hand), we DISTINGUISH that
 * stale-checkpoint signal from a transient outage and RE-MINT at the fresh head
 * (inject nothing this turn, recover next). A transient fault keeps the pure
 * no-op fail-open and never clobbers a still-valid checkpoint.
 */
import {
  type Backbone,
  type Cursor,
  InvalidCursorError,
  UnknownChannelError,
} from "@caucus/backbone";

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
 * The backbone `.code` strings that signal a STALE checkpoint rather than a
 * transient outage: the cursor points past a head the (ephemeral) backbone no
 * longer has. On an in-memory backbone a restart resets head to 0 while the
 * on-disk checkpoint still holds a higher cursor, so `readSince` rejects with
 * `invalid_cursor` (cursor > head); a fresh backbone that never recreated the
 * channel rejects with `unknown_channel`. Either means "re-mint", not "wait".
 */
const REMINT_CODES: ReadonlySet<string> = new Set([
  new InvalidCursorError("", undefined).code,
  new UnknownChannelError("").code,
]);

/**
 * Does `err` indicate a stale checkpoint we should self-heal by re-minting,
 * versus a transient fault we must ride out without touching the checkpoint?
 *
 * Matches on the backbone's stable `.code` (works for both the in-process
 * {@link InvalidCursorError}/{@link UnknownChannelError} and the `HttpBackbone`
 * client, which reconstructs the same codes from the wire). A timeout, a
 * connection refusal, or any non-`BackboneError` throw has no matching code and
 * is treated as transient — the existing pure no-op fail-open.
 */
function isStaleCheckpointError(err: unknown): boolean {
  if (err instanceof InvalidCursorError || err instanceof UnknownChannelError) {
    return true;
  }
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" && REMINT_CODES.has(code);
  }
  return false;
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
 * Every backbone call is wrapped in the fail-fast timeout. A STALE-checkpoint
 * error (`invalid_cursor` / `unknown_channel` — an ephemeral-backbone restart)
 * re-mints at the new head and injects nothing this turn (self-heal, CAU-72);
 * any OTHER thrown error ⇒ one value-free stderr line and `""` (pure fail open,
 * checkpoint untouched).
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
  } catch (err) {
    // A STALE checkpoint (cursor past a restarted ephemeral backbone's head, or
    // a channel the fresh backbone never recreated) would otherwise wedge the
    // session blind FOREVER: every turn re-throws the same `invalid_cursor` /
    // `unknown_channel`. Self-heal — re-mint at the new head, inject nothing
    // THIS turn (ADR-C6 — no backlog replay), and recover on the next.
    if (isStaleCheckpointError(err)) {
      try {
        const head: Cursor = await withTimeout(
          backbone.subscribe(channel),
          timeoutMs,
        );
        await writeCheckpoint(path, head, channel);
        // Quiet: the checkpoint is healed; next turn injects the fresh delta.
        stderr("caucus-hook: re-synced checkpoint after backbone restart\n");
        return "";
      } catch {
        // The re-mint itself failed (backbone now down, slow, etc.). Stay
        // fail-open and value-free; we'll try to heal again next turn.
        stderr("caucus-hook: skipped this turn (backbone unavailable or slow)\n");
        return "";
      }
    }
    // Transient fault (network refused, timeout, non-Error): pure no-op fail
    // open. Inject nothing and DO NOT touch a valid checkpoint just because the
    // server was briefly down. Value-free line (never the channel/url/error —
    // ADR-C12) so a backbone hiccup can't break or pollute the turn.
    stderr("caucus-hook: skipped this turn (backbone unavailable or slow)\n");
    return "";
  }
}
