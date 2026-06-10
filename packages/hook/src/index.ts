/**
 * @caucus/hook — the Claude Code turn-start awareness hook (CAU-14).
 *
 * A `UserPromptSubmit` command hook (CAU-24 spike verdict): every turn it reads
 * the channel delta since a per-session checkpoint, renders it compactly with
 * identity (ADR-C3/C7), advances the checkpoint, and emits the payload Claude
 * Code injects into context. Quiet by default (ADR-C6 — empty delta injects
 * nothing); fail-open and fast (a hung backbone can never block the turn); and
 * artifact URLs are never surfaced (ADR-C12). See README.md for wiring.
 *
 * The entrypoint shim is `bin.ts` (`caucus-hook`); the modules below are
 * exported so the integration scenario and unit tests can drive them directly.
 */
export {
  loadHookConfig,
  DEFAULT_CAUCUS_URL,
  type HookConfig,
} from "./config.js";
export {
  checkpointDir,
  checkpointPath,
  readCheckpoint,
  readLastInjection,
  writeCheckpoint,
  type LastInjection,
} from "./checkpoint.js";
export {
  renderMessage,
  renderDelta,
  DELTA_HEADER,
  DELTA_FOOTER,
} from "./render.js";
export {
  parseHookInput,
  runHook,
  HOOK_TIMEOUT_MS,
  type HookInput,
  type RunHookDeps,
} from "./run.js";
