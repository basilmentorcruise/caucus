/**
 * Environment → {@link ServerOptions} parsing for the `caucus-backbone` bin
 * (CAU-5). Kept out of `bin.ts` so it is unit-testable without spawning a
 * process: `bin.ts` is a ~3-line shebang shim, all logic lives here and in
 * `startServer`.
 */
import { auditEnabled, noopAuditor } from "./audit.js";
import type { ServerOptions } from "./server.js";
import { DEFAULT_PORT } from "./server.js";
import { parseTokenMap, tokenDigest } from "./tokens.js";

/** The subset of `ServerOptions` derivable from the environment. */
export type EnvConfig = Pick<
  ServerOptions,
  "port" | "host" | "tokens" | "adminTokenDigest" | "audit"
>;

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
 *
 * **Admin control surface (CAU-20).** `CAUCUS_ADMIN_TOKEN` gates the issuer's
 * mint/revoke/rotate routes. It is DIGESTED here (never carried in plaintext
 * past this function) and surfaced as `adminTokenDigest`; an absent/empty value
 * leaves it `undefined`, which fail-closes the control surface (routes 401, see
 * `server.ts`). The admin secret is NEVER echoed in any thrown message (it is a
 * secret like the write tokens, ADR-C12) — this function never includes its
 * value in an error.
 *
 * **Control-plane audit trail (CAU-128).** `CAUCUS_ADMIN_AUDIT` toggles the
 * stderr audit line emitted per mint/revoke/rotate (closes NOTE-2). Default ON:
 * only an explicit `0`/`false`/`off`/`no` (case-insensitive) turns it off — by
 * handing the server the no-op auditor — and even then it is a clean no-op (no
 * crash) when the control surface is disabled. The audit line carries only the
 * token DIGEST (never the token, never the admin credential — ADR-C12) and goes
 * to stderr only, never stdout, never the channel log (ADR-C6).
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.error(m),
): EnvConfig {
  const config: {
    port: number;
    host?: string;
    tokens?: ReturnType<typeof parseTokenMap>;
    adminTokenDigest?: string;
    audit?: EnvConfig["audit"];
  } = {
    port: DEFAULT_PORT,
  };

  // Control-plane audit trail (CAU-128): default ON (one secret-free stderr line
  // per mint/revoke/rotate, closing NOTE-2). `CAUCUS_ADMIN_AUDIT=0|false|off|no`
  // turns it off by handing the server the no-op auditor; anything else (incl.
  // unset) leaves `audit` undefined so the server installs its default stderr
  // auditor. Off is a no-op, never a crash, even when admin routes are disabled.
  if (!auditEnabled(env.CAUCUS_ADMIN_AUDIT)) {
    config.audit = noopAuditor;
  }

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

  // The admin credential gating the issuer control surface (CAU-20). Digest it
  // immediately so the plaintext never travels in the config object; an absent
  // or empty value leaves it undefined ⇒ the control routes are disabled
  // (fail-closed). The secret is never named in any error here (ADR-C12).
  const rawAdmin = env.CAUCUS_ADMIN_TOKEN;
  if (rawAdmin !== undefined && rawAdmin !== "") {
    config.adminTokenDigest = tokenDigest(rawAdmin);
  }

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
