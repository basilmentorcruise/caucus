/**
 * The runtime token issuer (CAU-20) — activates the ADR-C7 issuer deferral.
 *
 * A {@link TokenIssuer} owns the SINGLE live source the write-auth path consults
 * to resolve a presented bearer to its server-anchored {@link TokenIdentity}. It
 * unifies two layers behind ONE digest-keyed lookup:
 *
 *  - the **seed** — the immutable {@link TokenMap} parsed from `CAUCUS_TOKENS` at
 *    boot (ADR-C7's static map). Seed entries are NON-REVOCABLE and reload from
 *    env on restart.
 *  - the **dynamic** layer — entries minted at runtime via the admin control
 *    surface ({@link mint}/{@link rotate}), and removed via {@link revoke}.
 *
 * {@link resolve} consults dynamic-then-seed, so a minted token authorizes a
 * write and is anchored server-side EXACTLY like a static one — the anchoring
 * code in `server.ts` is unchanged; it just calls {@link resolve} instead of the
 * free `resolveToken`.
 *
 * **Ephemeral (ADR-C2).** The store is process memory only. A restart loses all
 * minted tokens; seeded tokens reload from env. No disk, no TTL, no sweep.
 *
 * **Fail-closed (ADR-C7).** An empty store (no seed, nothing minted) authorizes
 * NOBODY — every write 401s. Minting is gated by `CAUCUS_ADMIN_TOKEN` at the
 * transport layer; the issuer itself never decides authorization for the control
 * surface (that is the server's `requireAdmin`).
 *
 * **Secret hygiene (ADR-C12).** A minted token is returned EXACTLY ONCE from
 * {@link mint}/{@link rotate} and never stored, logged, or echoed — the store
 * keeps only its SHA-256 digest. The raw token is unrecoverable after the mint
 * call returns.
 */
import { randomBytes } from "node:crypto";

import { resolveToken, tokenDigest, type TokenIdentity, type TokenMap } from "./tokens.js";

/**
 * The one-time result of a {@link TokenIssuer.mint} / {@link TokenIssuer.rotate}:
 * the freshly generated opaque bearer (returned ONCE — never re-readable) plus
 * the identity it anchors to. The caller (the admin route) returns this verbatim
 * and then forgets the raw `token`.
 */
export interface MintResult {
  /** The opaque bearer secret. Returned ONCE; only its digest is retained. */
  readonly token: string;
  /** The agent session the token belongs to. */
  readonly agent_id: string;
  /** The human (owner) the agent acts for (ADR-C7). */
  readonly owner: string;
}

/**
 * Identify a token to {@link TokenIssuer.revoke} / {@link TokenIssuer.rotate}:
 * by the `agent_id` it anchors to, or directly by its stored `digest`. Exactly
 * one is honored — `digest` takes precedence when both are present.
 */
export interface RevokeTarget {
  /** Revoke the (dynamic) token anchored to this agent_id, if any. */
  readonly agent_id?: string;
  /** Revoke the token with this exact SHA-256 digest, if it is dynamic. */
  readonly digest?: string;
}

/**
 * The outcome of a {@link TokenIssuer.revoke}. `revoked` is `true` only when a
 * DYNAMIC entry was actually removed. Revoking an unknown target, or a SEED
 * entry (non-revocable), both yield `false` with NO mutation and the SAME shape
 * — so the response is not an enumeration oracle distinguishing "unknown" from
 * "seeded" from "not a real token".
 */
export interface RevokeResult {
  readonly revoked: boolean;
}

/** The runtime token issuer (CAU-20). See the module doc. */
export interface TokenIssuer {
  /**
   * Resolve a presented bearer to its identity, or `undefined` if absent, empty,
   * unknown, or revoked. Consults the dynamic layer first, then the seed; the
   * digest-keyed lookup is timing-safe (the presented token is hashed before
   * comparison). This is the unified replacement for the free `resolveToken`.
   */
  resolve(presented: string | undefined): TokenIdentity | undefined;
  /**
   * Mint a fresh dynamic token for `identity`, store only its digest, and return
   * the raw token ONCE. The generated token is high-entropy
   * (`crypto.randomBytes(32)`, base64url) and colon-free, so it never collides
   * with the `tok:agent:owner` seed format.
   */
  mint(identity: TokenIdentity): MintResult;
  /**
   * Remove a DYNAMIC entry by `agent_id` or `digest`. Seed entries are
   * non-revocable; an unknown target is a clean no-op. Idempotent — the same
   * call twice yields `{ revoked: false }` the second time. See
   * {@link RevokeResult} for the no-oracle guarantee.
   */
  revoke(target: RevokeTarget): RevokeResult;
  /**
   * Mint a new token for `identity` and revoke the OLD one in a single call
   * (mint-new + revoke-old). The new token resolves immediately; the old one
   * (named by `target`) no longer does. Returns the new token ONCE.
   */
  rotate(target: RevokeTarget, identity: TokenIdentity): MintResult;
}

/** Bytes of entropy in a minted token before base64url encoding (256 bits). */
const MINT_TOKEN_BYTES = 32;
/** Mint-token prefix — a human-recognizable, colon-free, non-secret marker. */
const MINT_TOKEN_PREFIX = "tok_";

/**
 * Generate a fresh opaque bearer: `tok_` + 256 bits of CSPRNG entropy as
 * base64url. base64url is colon-free (`-`/`_` alphabet), so a minted token can
 * never be mistaken for a `tok:agent:owner` seed entry, and it is never logged.
 */
function generateToken(): string {
  return `${MINT_TOKEN_PREFIX}${randomBytes(MINT_TOKEN_BYTES).toString("base64url")}`;
}

/**
 * Build a {@link TokenIssuer} over a single in-memory store initialized from the
 * immutable `seed` (boot `CAUCUS_TOKENS`). The seed map is COPIED into a private
 * dynamic store the issuer never mutates for seed keys — seed entries stay
 * non-revocable — while mint/revoke add and remove dynamic keys layered over it.
 *
 * Resolution semantics: a key present in the seed is non-revocable and always
 * resolves to its seeded identity; a dynamic key resolves until revoked.
 */
export function createIssuer(seed: TokenMap): TokenIssuer {
  // The seed stays separate and immutable so seed entries are never revocable
  // and a restart reloads exactly the env-configured identities. Dynamic entries
  // live in their own map, layered OVER the seed by `resolve`.
  const dynamic = new Map<string, TokenIdentity>();

  /** Resolve a target {@link RevokeTarget} to the dynamic digest it names, or undefined. */
  function dynamicDigestFor(target: RevokeTarget): string | undefined {
    // `digest` is authoritative when present — it names the exact entry.
    if (target.digest !== undefined && target.digest !== "") {
      return dynamic.has(target.digest) ? target.digest : undefined;
    }
    if (target.agent_id !== undefined && target.agent_id !== "") {
      for (const [digest, identity] of dynamic) {
        if (identity.agent_id === target.agent_id) return digest;
      }
    }
    return undefined;
  }

  return {
    resolve(presented: string | undefined): TokenIdentity | undefined {
      // Dynamic layer first (a minted token), then the seed (CAUCUS_TOKENS).
      // Both are looked up by digest via the shared timing-safe `resolveToken`,
      // so the issuer adds no new comparison of secret bytes.
      const dyn = resolveToken(dynamic, presented);
      if (dyn !== undefined) return dyn;
      return resolveToken(seed, presented);
    },

    mint(identity: TokenIdentity): MintResult {
      const token = generateToken();
      // Store ONLY the digest — the raw token leaves in the return value and is
      // never retained (ADR-C12). Collisions are cryptographically impossible at
      // 256 bits, so we do not guard against a digest clash.
      dynamic.set(tokenDigest(token), {
        agent_id: identity.agent_id,
        owner: identity.owner,
      });
      return { token, agent_id: identity.agent_id, owner: identity.owner };
    },

    revoke(target: RevokeTarget): RevokeResult {
      const digest = dynamicDigestFor(target);
      if (digest === undefined) {
        // Unknown, seeded (non-revocable), or already-revoked — all the SAME
        // no-mutation response, so revoke is never an enumeration oracle.
        return { revoked: false };
      }
      dynamic.delete(digest);
      return { revoked: true };
    },

    rotate(target: RevokeTarget, identity: TokenIdentity): MintResult {
      // Mint-new + revoke-old. Resolve the OLD target's digest BEFORE minting:
      // when `target` names an agent_id, minting the new token first would add a
      // dynamic entry with the SAME agent_id, and an after-the-fact
      // `dynamicDigestFor(target)` could pick up the JUST-MINTED entry instead of
      // the old one — revoking the new token and leaving the old one live. By
      // capturing the old digest first, we always revoke exactly the old entry.
      const oldDigest = dynamicDigestFor(target);
      const minted = this.mint(identity);
      if (oldDigest !== undefined) this.revoke({ digest: oldDigest });
      return minted;
    },
  };
}
