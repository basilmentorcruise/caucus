/**
 * Environment → {@link ServerOptions} parsing for the `caucus-backbone` bin
 * (CAU-5). Kept out of `bin.ts` so it is unit-testable without spawning a
 * process: `bin.ts` is a ~3-line shebang shim, all logic lives here and in
 * `startServer`.
 */
import type { ServerOptions } from "./server.js";
import { DEFAULT_PORT } from "./server.js";
import { parseTokenMap } from "./tokens.js";

/** The subset of `ServerOptions` derivable from the environment. */
export type EnvConfig = Pick<ServerOptions, "port" | "host" | "tokens">;

/** Hosts that keep the (unauthenticated) backbone reachable only on-host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether `host` binds the server to loopback only (on-host reachable). */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Read `PORT` (default {@link DEFAULT_PORT}), `HOST` (default unset → the
 * server's `127.0.0.1`), and `CAUCUS_TOKENS` (the write-auth token map, CAU-13)
 * from an environment-like map. A `PORT` that is not a non-negative integer
 * throws, so a typo fails fast rather than silently binding the default. A
 * malformed `CAUCUS_TOKENS` throws a POSITIONAL parse error (it never names the
 * token text — ADR-C12).
 *
 * **Fail-closed token gate.** Writes require a bearer that resolves in the
 * token map (CAU-13). An absent/empty `CAUCUS_TOKENS` yields an EMPTY map, so
 * ALL writes return `401` until at least one token is configured — there is no
 * "auth off" mode. Reads stay open within the trust boundary (ADR-C9).
 *
 * If `HOST` resolves to a non-loopback address, emit a one-line warning: binding
 * off-loopback exposes the listener (reads are open) to anyone who can reach the
 * interface. The warning is sharpened when NO tokens are configured, since then
 * the box is reachable AND every write would 401 (a likely misconfiguration).
 * `warn` is injectable for tests; it defaults to `console.error` (stderr).
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.error(m),
): EnvConfig {
  const config: { port: number; host?: string; tokens?: ReturnType<typeof parseTokenMap> } = {
    port: DEFAULT_PORT,
  };

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

  // Always build the token map (empty when CAUCUS_TOKENS is unset) so the server
  // is fail-closed by construction: no tokens ⇒ every write 401.
  const tokens = parseTokenMap(env.CAUCUS_TOKENS);
  config.tokens = tokens;

  const rawHost = env.HOST;
  if (rawHost !== undefined && rawHost !== "") {
    config.host = rawHost;
    if (!isLoopbackHost(rawHost)) {
      const noTokens = tokens.size === 0
        ? " and no CAUCUS_TOKENS are configured (all writes will 401)"
        : "";
      warn(
        `binding non-loopback host ${rawHost} — reads are unauthenticated${noTokens}; do not expose off-host`,
      );
    }
  }

  return config;
}
