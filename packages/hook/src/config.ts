/**
 * Environment → {@link HookConfig} for the `caucus-hook` bin (CAU-14).
 *
 * Kept out of `bin.ts` / `run.ts` so it is unit-testable without a process.
 *
 * The hook runs inside Claude Code's `UserPromptSubmit` event, which blocks the
 * turn (CAU-24 spike: ~30 s budget). So config resolution NEVER throws into the
 * turn: a missing channel is a fail-open *no-op signal* (empty `channel`), not
 * an exception. The caller treats an empty channel as "do nothing this turn".
 */

/** Default backbone URL: the localhost port the CAU-5 server binds (4317). */
export const DEFAULT_CAUCUS_URL = "http://127.0.0.1:4317";

/** Resolved hook configuration. */
export interface HookConfig {
  /** Backbone base URL. Always set (defaulted when `CAUCUS_URL` is absent). */
  readonly url: string;
  /**
   * Channel to inject. Empty string ⇒ no channel configured ⇒ the hook is a
   * no-op this turn (fail open — see module doc). Never throws on absence.
   */
  readonly channel: string;
  /**
   * Bearer token, carried for symmetry with the rest of Caucus. The hook is
   * READ-ONLY and ignores it for now — auth lands in CAU-13. Empty ⇒ unset.
   */
  readonly token: string;
}

/**
 * Read `CAUCUS_URL` (default {@link DEFAULT_CAUCUS_URL}), `CAUCUS_CHANNEL`
 * (required for the hook to do anything; absent ⇒ empty ⇒ no-op), and
 * `CAUCUS_TOKEN` (carried but unused — CAU-13) from an environment-like map.
 *
 * Surrounding whitespace is trimmed; an all-whitespace value is treated as
 * unset. This never throws: the hook must not turn a misconfiguration into a
 * turn-blocking error.
 */
export function loadHookConfig(
  env: Record<string, string | undefined>,
): HookConfig {
  const rawUrl = (env.CAUCUS_URL ?? "").trim();
  const channel = (env.CAUCUS_CHANNEL ?? "").trim();
  const token = (env.CAUCUS_TOKEN ?? "").trim();

  return {
    url: rawUrl === "" ? DEFAULT_CAUCUS_URL : rawUrl,
    channel,
    token,
  };
}
