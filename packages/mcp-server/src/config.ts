/**
 * Session configuration and identity for the MCP server (CAU-9).
 *
 * Identity model (ADR-C7, anchored as of CAU-13): a session's agent→human
 * identity is supplied out-of-band by whoever spawns the server, as a single
 * `CAUCUS_TOKEN` env var of the form `"<agent_id>:<owner>"`. The channel the
 * session joins is `CAUCUS_CHANNEL`.
 *
 * The local {@link parseToken} split is COSMETIC/OFFLINE only: it feeds
 * `caucus_status` display and the in-process backbone path. On the shared HTTP
 * backbone the SERVER is authoritative — it resolves the bearer token against
 * its own `CAUCUS_TOKENS` map and overwrites message identity server-side, so
 * whatever a misconfigured client believes about itself never reaches the log.
 * The rest of the server depends only on the resolved identity, never on the
 * token.
 */

/**
 * The resolved agent→human identity for a session. Every message the server
 * emits is stamped with exactly these two principals (see `identity.ts`); tools
 * can neither read the token nor override the identity.
 */
export interface SessionIdentity {
  /** Stable id of this agent session. */
  readonly agent_id: string;
  /** The human this agent acts for (ADR-C7). */
  readonly owner: string;
}

/** Fully-resolved server configuration. */
export interface ServerConfig {
  /** The agent→human identity stamped on every outgoing message. */
  readonly identity: SessionIdentity;
  /** The channel this session joins. */
  readonly channel: string;
}

/**
 * Raised when the environment does not yield a usable {@link ServerConfig}. The
 * stable `code` lets callers (and CAU-13's anchored loader) branch on the
 * failure class without string-matching the message.
 */
export class ConfigError extends Error {
  /** Stable, machine-readable error class. */
  readonly code = "config_error";

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve a `CAUCUS_TOKEN` value into a {@link SessionIdentity}.
 *
 * v0 format: `"<agent_id>:<owner>"`, split on the FIRST colon only — so an owner
 * may itself contain colons (`"a:b:c"` → `agent_id "a"`, `owner "b:c"`). Both
 * halves are trimmed; an empty half (or a missing colon) is rejected.
 *
 * This is the choke point CAU-13 replaces with an anchored credential lookup; it
 * intentionally returns the same `SessionIdentity` shape so nothing downstream
 * changes.
 *
 * @throws ConfigError if the token has no colon or either trimmed half is empty.
 */
export function parseToken(token: string): SessionIdentity {
  const sep = token.indexOf(":");
  if (sep === -1) {
    throw new ConfigError(
      'CAUCUS_TOKEN must be of the form "<agent_id>:<owner>"',
    );
  }
  const agent_id = token.slice(0, sep).trim();
  const owner = token.slice(sep + 1).trim();
  if (agent_id === "" || owner === "") {
    throw new ConfigError(
      'CAUCUS_TOKEN must have a non-empty agent_id and owner ("<agent_id>:<owner>")',
    );
  }
  return { agent_id, owner };
}

/**
 * The cosmetic identity used for an OPAQUE (colon-free) `CAUCUS_TOKEN` on the
 * shared HTTP backbone. The token is a per-session secret (CAU-13 / security
 * hand-off) and must NEVER be displayed, so the placeholder is token-free: both
 * principals read as `"session"`. This is display-only — the server resolves the
 * bearer against its `CAUCUS_TOKENS` map and anchors the REAL identity onto every
 * message (ADR-C7), so what lands in the log is correct regardless of this value.
 */
const OPAQUE_TOKEN_IDENTITY: SessionIdentity = {
  agent_id: "session",
  owner: "(anchored server-side)",
};

/**
 * Resolve `CAUCUS_TOKEN` into a {@link SessionIdentity}, honoring the shared vs.
 * offline distinction.
 *
 * - **Offline (`shared === false`).** The local identity IS authoritative (no
 *   server to anchor it), so the token MUST be the structured `agent:owner`
 *   form — a colon-free token is rejected via {@link parseToken}.
 * - **Shared (`shared === true`, i.e. `CAUCUS_URL` set).** The token is the HTTP
 *   bearer — a per-session OPAQUE secret (e.g. `tok-alice-1`) that the server's
 *   `CAUCUS_TOKENS` map (entry `tok-alice-1:agent:owner`, where the secret is
 *   the colon-free FIRST segment) resolves and anchors. A colon-free opaque
 *   token therefore can't be split locally; rather than fail (the bearer is
 *   valid; identity is server-authoritative), it maps to a cosmetic
 *   {@link OPAQUE_TOKEN_IDENTITY} for `caucus_status` display ONLY. A token that
 *   DOES contain a colon is still parsed for a nicer local display.
 */
function resolveIdentity(token: string, shared: boolean): SessionIdentity {
  if (shared && !token.includes(":")) {
    // Opaque bearer secret: never displayed, server anchors the real identity.
    return OPAQUE_TOKEN_IDENTITY;
  }
  return parseToken(token);
}

/**
 * Build a {@link ServerConfig} from a process environment.
 *
 * Requires `CAUCUS_TOKEN` and `CAUCUS_CHANNEL` (the default channel, trimmed).
 * Throws {@link ConfigError} when either is missing/blank so the server fails
 * fast rather than ever emitting an unidentified message.
 *
 * Token handling depends on whether `CAUCUS_URL` is set (the shared HTTP
 * backbone — CAU-50): see {@link resolveIdentity}. In BOTH modes a MISSING or
 * blank token is fatal; only the colon requirement is relaxed for an opaque
 * bearer on the shared backbone.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const token = env.CAUCUS_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new ConfigError("CAUCUS_TOKEN is required");
  }
  const channel = env.CAUCUS_CHANNEL;
  if (channel === undefined || channel.trim() === "") {
    throw new ConfigError("CAUCUS_CHANNEL is required");
  }
  const shared = (env.CAUCUS_URL ?? "").trim() !== "";
  return {
    identity: resolveIdentity(token.trim(), shared),
    channel: channel.trim(),
  };
}
