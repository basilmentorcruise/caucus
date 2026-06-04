/**
 * Session configuration and identity for the MCP server (CAU-9).
 *
 * v0 identity model (ADR-C7; the *anchored* form lands in CAU-13): a session's
 * agent→human identity is supplied out-of-band by whoever spawns the server, as
 * a single `CAUCUS_TOKEN` env var of the form `"<agent_id>:<owner>"`. The
 * channel the session joins is `CAUCUS_CHANNEL`.
 *
 * {@link parseToken} is the seam CAU-13 hardens: today it splits a plaintext
 * token; tomorrow it resolves an opaque, server-anchored credential into the
 * same {@link SessionIdentity} — without changing that type or any caller. The
 * rest of the server depends only on the resolved identity, never on the token.
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
 * Build a {@link ServerConfig} from a process environment.
 *
 * Requires `CAUCUS_TOKEN` (resolved via {@link parseToken}) and `CAUCUS_CHANNEL`
 * (the default channel, trimmed and required). Throws {@link ConfigError} when
 * either is missing or invalid so the server fails fast at startup rather than
 * ever emitting an unidentified message.
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
  return {
    identity: parseToken(token),
    channel: channel.trim(),
  };
}
