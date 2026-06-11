/**
 * The logical artifact URI mint/parse seam (ADR-C14, CAU-100).
 *
 * The `artifact` field of a message may carry a host-agnostic
 * `caucus://artifact/<channel>/<sha256>` URI pointing into the backbone's
 * ephemeral evidence store. This module is the single place that MINTS that
 * string (after an upload) and PARSES it (before a fetch). It is deliberately
 * host-free: the URI names only the channel + content address, and the fetcher
 * resolves it against its OWN validated `CAUCUS_URL` (the backbone wiring it
 * already trusts), never a caller-supplied host — that is the SSRF guard by
 * construction (ADR-C14). A parse therefore validates SHAPE only and rejects
 * anything carrying a host/authority.
 */

/** The fixed scheme + authority prefix every artifact URI starts with. */
const ARTIFACT_URI_PREFIX = "caucus://artifact/";

/** Channel slug grammar (must match the backbone's `CHANNEL_NAME_RE`). */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A lowercase-hex SHA-256 content address: exactly 64 hex digits. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** The channel + content address recovered from a valid artifact URI. */
export interface ParsedArtifactUri {
  readonly channel: string;
  readonly sha256: string;
}

/**
 * Mint the logical artifact URI for a `(channel, sha256)` pair. Callers supply
 * an already-valid channel slug and a lowercase-hex digest (the backbone
 * returns exactly these), so this is a pure format.
 */
export function mintArtifactUri(channel: string, sha256: string): string {
  return `${ARTIFACT_URI_PREFIX}${channel}/${sha256}`;
}

/**
 * Parse a `caucus://artifact/<channel>/<sha256>` URI into its channel + content
 * address, or return `undefined` if it is not a structurally valid artifact URI.
 *
 * Validation is strict and host-free: the string must start with the exact
 * `caucus://artifact/` prefix, then a valid channel slug, then a `/`, then a
 * 64-hex-digit SHA-256 — and NOTHING else (no query, no fragment, no extra
 * path). A URI naming any other scheme/host (`http://…`, `caucus://OTHER/…`) is
 * rejected, so a tool can never be steered to dial a foreign target (ADR-C14
 * SSRF guard). The channel is NOT resolved here — the caller's join-gate decides
 * whether this session may reach it.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
  if (typeof uri !== "string" || !uri.startsWith(ARTIFACT_URI_PREFIX)) {
    return undefined;
  }
  const rest = uri.slice(ARTIFACT_URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  const channel = rest.slice(0, slash);
  const sha256 = rest.slice(slash + 1);
  if (!CHANNEL_NAME_RE.test(channel) || !SHA256_HEX_RE.test(sha256)) {
    return undefined;
  }
  return { channel, sha256 };
}
