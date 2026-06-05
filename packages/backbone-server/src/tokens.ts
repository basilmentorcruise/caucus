/**
 * Server-anchored identity tokens (CAU-13) — the map from an opaque bearer
 * token to the agent→human identity it grants.
 *
 * This is the anchoring substrate for ADR-C7: a session presents a bearer
 * token; the server resolves it to a {@link TokenIdentity} and stamps THAT
 * identity onto every write (overwriting whatever the client claimed), so the
 * `owner` on a stored message cannot be forged. The token text is a secret —
 * it is NEVER echoed in an error, a log, or a response (ADR-C12). Parse errors
 * are POSITIONAL ONLY: they name the entry's position, never its contents.
 *
 * **Fail-closed (loud).** The token map is the ONLY source of write
 * authorization. An EMPTY or UNSET `CAUCUS_TOKENS` yields an EMPTY map, and an
 * empty map authorizes nobody — so EVERY write (createChannel / append / claim)
 * is rejected `401`. There is no implicit "auth disabled" mode: to allow writes
 * you MUST configure at least one token. Reads stay open within the trust
 * boundary (ADR-C9); this gate is for writes only.
 */

/** The agent→human identity a single bearer token grants. */
export interface TokenIdentity {
  /** Stable id of the agent session the token belongs to. */
  readonly agent_id: string;
  /** The human (owner) the agent acts for (ADR-C7). */
  readonly owner: string;
}

/** An immutable bearer-token → {@link TokenIdentity} lookup. */
export type TokenMap = ReadonlyMap<string, TokenIdentity>;

/**
 * Thrown by {@link parseTokenMap} when an entry is malformed. The message is
 * POSITIONAL ONLY — it names the 1-based entry index and NEVER the token text
 * (ADR-C12: the token is a secret; a parse error must not become an oracle that
 * leaks it). Tests assert the offending token string is absent from `.message`.
 */
export class TokenMapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenMapParseError";
  }
}

/**
 * Parse `CAUCUS_TOKENS` — a comma-separated list of `tok:agent_id:owner`
 * entries — into a {@link TokenMap}.
 *
 * Per entry: the FIRST colon splits the token from the rest; the SECOND colon
 * splits the agent_id from the owner. The owner may itself contain further
 * colons (`tok:agent:a:b:c` → owner `"a:b:c"`). Every field is trimmed; an
 * empty token, agent_id, or owner rejects the whole parse with a positional
 * {@link TokenMapParseError}. A duplicate token (same value twice) also rejects.
 *
 * An absent / empty / all-whitespace value yields an EMPTY map (fail-closed:
 * see the module doc — an empty map authorizes nobody, so all writes 401).
 *
 * @throws TokenMapParseError positional only — the message names the entry
 *   index, never the token text.
 */
export function parseTokenMap(env: string | undefined): TokenMap {
  const map = new Map<string, TokenIdentity>();
  if (env === undefined || env.trim() === "") {
    return map;
  }

  const entries = env.split(",");
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i] ?? "";
    // 1-based position for human-facing diagnostics; never the token text.
    const pos = i + 1;
    if (raw.trim() === "") {
      throw new TokenMapParseError(`CAUCUS_TOKENS entry ${pos} is malformed`);
    }

    const firstColon = raw.indexOf(":");
    if (firstColon === -1) {
      throw new TokenMapParseError(`CAUCUS_TOKENS entry ${pos} is malformed`);
    }
    const token = raw.slice(0, firstColon).trim();
    const rest = raw.slice(firstColon + 1);

    const secondColon = rest.indexOf(":");
    if (secondColon === -1) {
      throw new TokenMapParseError(`CAUCUS_TOKENS entry ${pos} is malformed`);
    }
    const agent_id = rest.slice(0, secondColon).trim();
    // The owner keeps any further colons verbatim (after trimming the ends).
    const owner = rest.slice(secondColon + 1).trim();

    if (token === "" || agent_id === "" || owner === "") {
      throw new TokenMapParseError(`CAUCUS_TOKENS entry ${pos} is malformed`);
    }
    if (map.has(token)) {
      throw new TokenMapParseError(`CAUCUS_TOKENS entry ${pos} is malformed`);
    }

    map.set(token, { agent_id, owner });
  }

  return map;
}

/**
 * Resolve a presented bearer token to its {@link TokenIdentity}, or `undefined`
 * if the token is absent, empty, or unknown. The caller maps `undefined` to an
 * IDENTICAL `401` for both "no token" and "unknown token" so the response is
 * not an oracle distinguishing a valid-but-unknown token from no token at all.
 */
export function resolveToken(
  map: TokenMap,
  presented: string | undefined,
): TokenIdentity | undefined {
  if (presented === undefined || presented === "") {
    return undefined;
  }
  return map.get(presented);
}
