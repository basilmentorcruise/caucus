/**
 * The harness runner (CAU-25, AC1) + the shared subprocess spawn helper
 * (CAU-76).
 *
 * `runScenarios` boots one connector, runs each scenario against it in order,
 * and tears the connector down in a `finally` so the backbone is always
 * released — even if a scenario rejects. This is the programmatic counterpart
 * to the vitest-native scenarios under `src/scenarios/`; both share the same
 * connector seam.
 *
 * `startServerProcess` spawns the real backbone-server bin on an ephemeral
 * port — the helper every subprocess scenario previously hand-rolled. The
 * CAU-76 hardening over the old copies:
 *  - the child's stderr is BUFFERED and surfaced (in the startup-timeout /
 *    early-exit error, and via `stderrOutput()` for a failing scenario to
 *    include) — before, stderr went nowhere and failures timed out opaquely;
 *  - `stop()` actually AWAITS the child's exit (SIGTERM, then SIGKILL after a
 *    grace period) instead of a fire-and-forget `kill()`, so teardown cannot
 *    leak a listening process past the suite.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Connector } from "./connector.js";
import type { Scenario } from "./scenario.js";

/** The monorepo root (this file lives at packages/integration/src/). */
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** The backbone-server bin every subprocess scenario spawns (built in globalSetup). */
const SERVER_BIN = join(
  REPO_ROOT,
  "packages",
  "backbone-server",
  "dist",
  "bin.js",
);

/** How long to wait for the spawned server to print its listening URL. */
const STARTUP_TIMEOUT_MS = 10_000;

/** SIGTERM grace before escalating to SIGKILL on `stop()`. */
const EXIT_GRACE_MS = 5_000;

/** A running backbone-server subprocess (see {@link startServerProcess}). */
export interface ServerProcess {
  /** The base URL the server printed (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /**
   * Terminate the child and RESOLVE ONLY AFTER it has actually exited:
   * SIGTERM first, escalating to SIGKILL after {@link EXIT_GRACE_MS}. Safe to
   * call more than once (subsequent calls await the same exit).
   */
  readonly stop: () => Promise<void>;
  /**
   * Everything the child has written to stderr so far — include it in a
   * failing scenario's error so subprocess failures are not opaque.
   */
  readonly stderrOutput: () => string;
}

/**
 * Spawn the backbone-server bin as its own OS process on an ephemeral port and
 * resolve once it prints its listening URL.
 *
 * @param env extra child environment (typically `CAUCUS_TOKENS`); merged over
 * the parent env with `PORT=0` / `HOST=127.0.0.1` defaults a caller can
 * override.
 */
export function startServerProcess(
  env: Record<string, string> = {},
): Promise<ServerProcess> {
  // Strip undefined values so the child env is a plain string map.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  const child: ChildProcessWithoutNullStreams = spawn("node", [SERVER_BIN], {
    cwd: REPO_ROOT,
    env: { ...base, PORT: "0", HOST: "127.0.0.1", ...env },
  }) as ChildProcessWithoutNullStreams;

  // Buffer stderr from the very first byte so a startup crash (bad tokens,
  // port in use, missing build) is SURFACED in the rejection instead of the
  // old opaque "did not start within 10s".
  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
  });

  /** Resolves when the child process has fully exited. */
  const exited = new Promise<void>((res) => {
    child.on("exit", () => res());
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      child.kill(); // SIGTERM
      const grace = await Promise.race([
        exited.then(() => true),
        new Promise<false>((res) => {
          const t = setTimeout(() => res(false), EXIT_GRACE_MS);
          t.unref();
        }),
      ]);
      if (!grace) {
        child.kill("SIGKILL");
        await exited;
      }
    })();
    return stopping;
  };

  return new Promise<ServerProcess>((resolveServer, reject) => {
    const fail = (reason: string): void => {
      void stop();
      const stderr = stderrBuf.trim();
      reject(
        new Error(
          `backbone server ${reason}${stderr === "" ? "" : `; stderr:\n${stderr}`}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      fail(`did not start within ${STARTUP_TIMEOUT_MS / 1_000}s`);
    }, STARTUP_TIMEOUT_MS);

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      // bin.ts logs: `caucus-backbone listening on http://127.0.0.1:<port>`
      const m = buf.match(/listening on (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolveServer({ url: m[1]!, stop, stderrOutput: () => stderrBuf });
      }
    });
    child.on("exit", (code) => {
      // Exit before the URL ⇒ startup failure (after it, this is teardown).
      clearTimeout(timer);
      fail(`exited with code ${code} before printing its URL`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Boot `makeConnector()`, run every scenario against it, then tear down.
 *
 * Teardown runs in a `finally`, so it happens whether the scenarios pass, a
 * scenario rejects, or boot itself throws after partially starting. The first
 * rejection propagates to the caller after teardown completes.
 */
export async function runScenarios(
  makeConnector: () => Connector,
  scenarios: readonly Scenario[],
): Promise<void> {
  const connector = makeConnector();
  await connector.boot();
  try {
    for (const scenario of scenarios) {
      await scenario.run(connector);
    }
  } finally {
    await connector.teardown();
  }
}
