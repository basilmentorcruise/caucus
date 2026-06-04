/**
 * Environment → {@link ServerOptions} parsing for the `caucus-backbone` bin
 * (CAU-5). Kept out of `bin.ts` so it is unit-testable without spawning a
 * process: `bin.ts` is a ~3-line shebang shim, all logic lives here and in
 * `startServer`.
 */
import type { ServerOptions } from "./server.js";
import { DEFAULT_PORT } from "./server.js";

/** The subset of `ServerOptions` derivable from the environment. */
export type EnvConfig = Pick<ServerOptions, "port" | "host">;

/** Hosts that keep the (unauthenticated) backbone reachable only on-host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether `host` binds the server to loopback only (on-host reachable). */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Read `PORT` (default {@link DEFAULT_PORT}) and `HOST` (default unset → the
 * server's `127.0.0.1`) from an environment-like map. A `PORT` that is not a
 * non-negative integer throws, so a typo fails fast rather than silently
 * binding the default.
 *
 * If `HOST` resolves to a non-loopback address, emit a one-line warning: the
 * backbone is unauthenticated (identity anchoring is CAU-9/CAU-13), so binding
 * off-loopback exposes it to anyone who can reach the interface. `warn` is
 * injectable for tests; it defaults to `console.error` (stderr).
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.error(m),
): EnvConfig {
  const config: { port: number; host?: string } = { port: DEFAULT_PORT };

  const rawPort = env.PORT;
  if (rawPort !== undefined && rawPort !== "") {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(
        `invalid PORT ${JSON.stringify(rawPort)}: must be an integer in [0, 65535]`,
      );
    }
    config.port = port;
  }

  const rawHost = env.HOST;
  if (rawHost !== undefined && rawHost !== "") {
    config.host = rawHost;
    if (!isLoopbackHost(rawHost)) {
      warn(
        `binding non-loopback host ${rawHost} — the backbone is unauthenticated; do not expose off-host`,
      );
    }
  }

  return config;
}
