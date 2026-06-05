#!/usr/bin/env node
/**
 * `caucus-hook` — the Claude Code `UserPromptSubmit` command hook (CAU-14).
 *
 * A thin shim: read the JSON event from stdin, run the hook, print its result
 * (and ONLY its result) to stdout, exit 0 ALWAYS. All logic lives in
 * `run.ts`/`render.ts`/`checkpoint.ts`/`config.ts`; this file is a process
 * entrypoint and is coverage-excluded by the bin.ts coverage rule (CAU-5
 * convention) — its behavior is proven by the integration scenario which spawns
 * it for real.
 *
 * stdout is EXCLUSIVELY the injection payload (or empty). Everything diagnostic
 * goes to stderr — anything on stdout becomes injected context (CAU-24 spike).
 */
import { HttpBackbone } from "@caucus/backbone-server";

import { loadHookConfig } from "./config.js";
import { HOOK_TIMEOUT_MS, parseHookInput, runHook } from "./run.js";

/** Read all of stdin to a string. Empty on a TTY or closed pipe. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A `fetch` that aborts each request after the hook's client-side budget. This
 * is the AbortController half of the fail-fast guard: it doesn't just stop
 * awaiting a hung request (the `run.ts` timeout does that) — it tears down the
 * underlying socket, so a hung backbone can't keep the event loop alive and
 * stall the process after `runHook` has already returned.
 */
function timeoutFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
}

async function main(): Promise<void> {
  const stdin = await readStdin();
  const { sessionId } = parseHookInput(stdin);
  const config = loadHookConfig(process.env);

  const out = await runHook({
    backbone: new HttpBackbone(config.url, { fetch: timeoutFetch }),
    env: process.env,
    sessionId,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
    stderr: (line) => process.stderr.write(line),
  });

  if (out !== "") {
    // Wait for the pipe write to DRAIN before the explicit exit below runs:
    // stdout-to-a-pipe is async, and process.exit() does not flush it. Today's
    // payload (INJECTED_DELTA_CAP_CHARS ≈ 8 KB) fits the typical 64 KB pipe
    // buffer, but that safety is incidental — never couple correctness to the
    // cap staying under an undocumented OS buffer size.
    await new Promise<void>((resolve) => {
      process.stdout.write(out, () => resolve());
    });
  }
}

// Exit 0 no matter what: a `UserPromptSubmit` hook that exits non-zero can block
// the turn. Any unexpected error is logged to stderr and swallowed. We exit
// EXPLICITLY so a lingering keep-alive socket can never hold the process open
// past the work being done (stdout has already drained inside main()).
main()
  .catch((err: unknown) => {
    process.stderr.write(
      `caucus-hook: fatal, skipped this turn (${err instanceof Error ? err.name : "error"})\n`,
    );
  })
  .finally(() => {
    process.exit(0);
  });
