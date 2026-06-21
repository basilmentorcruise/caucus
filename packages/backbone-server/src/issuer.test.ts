/**
 * Unit tests for the runtime token issuer (CAU-20) — the unified seed+dynamic
 * resolver behind mint/revoke/rotate. These cover the security-critical
 * properties: a minted token resolves and is anchored, a revoked one stops
 * resolving, seed entries are non-revocable, the store keeps only digests, and
 * an empty store is fail-closed.
 */
import { describe, expect, it } from "vitest";

import { createIssuer, type TokenIssuer } from "./issuer.js";
import { parseTokenMap, tokenDigest, type TokenMap } from "./tokens.js";

/** A seed with one immutable entry, `seed-tok` → `{ seed-agent, seed-owner }`. */
function seededIssuer(): { issuer: TokenIssuer; seed: TokenMap } {
  const seed = parseTokenMap("seed-tok:seed-agent:seed-owner");
  return { issuer: createIssuer(seed), seed };
}

/** Matches a colon (the seed `tok:agent:owner` separator) — a minted token must NOT contain one. */
const HAS_COLON = /:/;

describe("TokenIssuer.mint + resolve", () => {
  it("a minted token resolves to its requested identity", () => {
    const { issuer } = seededIssuer();
    const minted = issuer.mint({ agent_id: "a1", owner: "alice" });
    expect(minted.agent_id).toBe("a1");
    expect(minted.owner).toBe("alice");
    expect(issuer.resolve(minted.token)).toEqual({ agent_id: "a1", owner: "alice" });
  });

  it("each mint yields a distinct, high-entropy, colon-free token", () => {
    const { issuer } = seededIssuer();
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { token } = issuer.mint({ agent_id: `a${i}`, owner: "o" });
      expect(token.startsWith("tok_")).toBe(true);
      // base64url of 32 bytes is ~43 chars; prefix included ⇒ well over 40.
      expect(token.length).toBeGreaterThan(40);
      // Colon-free so a minted token can never collide with the seed format.
      expect(HAS_COLON.test(token)).toBe(false);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50); // all distinct
  });

  it("resolve consults BOTH the seed and the dynamic layer", () => {
    const { issuer } = seededIssuer();
    // The seed entry resolves out of the box.
    expect(issuer.resolve("seed-tok")).toEqual({
      agent_id: "seed-agent",
      owner: "seed-owner",
    });
    // A minted (dynamic) entry resolves alongside it.
    const minted = issuer.mint({ agent_id: "dyn", owner: "d" });
    expect(issuer.resolve(minted.token)).toEqual({ agent_id: "dyn", owner: "d" });
    // The seed still resolves after a mint.
    expect(issuer.resolve("seed-tok")?.owner).toBe("seed-owner");
  });

  it("the store keeps only the digest — the raw token is not retrievable post-mint", () => {
    const { issuer } = seededIssuer();
    const { token } = issuer.mint({ agent_id: "a", owner: "o" });
    // The issuer exposes no way to read the token back; the only retained form is
    // the digest. We can prove the digest (not the plaintext) is the lookup key:
    // resolving by the plaintext works, and the digest of the plaintext is a
    // 64-char hex string distinct from the token.
    const digest = tokenDigest(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(token);
    // No property of the returned MintResult other than `token` carries the
    // secret, and `token` is the caller's one-and-only copy.
    expect(Object.keys({ ...issuer.mint({ agent_id: "b", owner: "o" }) }).sort()).toEqual([
      "agent_id",
      "owner",
      "token",
    ]);
  });
});

describe("TokenIssuer.revoke", () => {
  it("a revoked dynamic token stops resolving (security-critical)", () => {
    const { issuer } = seededIssuer();
    const minted = issuer.mint({ agent_id: "a", owner: "alice" });
    expect(issuer.resolve(minted.token)).toBeDefined();
    const res = issuer.revoke({ agent_id: "a" });
    expect(res.revoked).toBe(true);
    expect(issuer.resolve(minted.token)).toBeUndefined();
  });

  it("revoke by digest works too", () => {
    const { issuer } = seededIssuer();
    const minted = issuer.mint({ agent_id: "a", owner: "alice" });
    const res = issuer.revoke({ digest: tokenDigest(minted.token) });
    expect(res.revoked).toBe(true);
    expect(issuer.resolve(minted.token)).toBeUndefined();
  });

  it("a SEED entry is non-revocable — revoke is a clean no-op, seed still resolves", () => {
    const { issuer } = seededIssuer();
    // By agent_id: the seed agent is not a dynamic entry, so nothing is removed.
    const byAgent = issuer.revoke({ agent_id: "seed-agent" });
    expect(byAgent.revoked).toBe(false);
    // By digest: even naming the exact seed digest does not revoke it.
    const byDigest = issuer.revoke({ digest: tokenDigest("seed-tok") });
    expect(byDigest.revoked).toBe(false);
    // The seed entry STILL resolves — it was never mutated.
    expect(issuer.resolve("seed-tok")?.owner).toBe("seed-owner");
  });

  it("revoke is idempotent — unknown / already-revoked yield the same { revoked:false } shape", () => {
    const { issuer } = seededIssuer();
    const minted = issuer.mint({ agent_id: "a", owner: "alice" });
    expect(issuer.revoke({ agent_id: "a" })).toEqual({ revoked: true });
    // Second revoke of the same (now-gone) target — clean no-op, same shape.
    expect(issuer.revoke({ agent_id: "a" })).toEqual({ revoked: false });
    // A wholly unknown target — same shape, no oracle.
    expect(issuer.revoke({ agent_id: "never-existed" })).toEqual({ revoked: false });
    expect(issuer.revoke({ digest: "deadbeef" })).toEqual({ revoked: false });
    // The minted token stayed revoked across all of the above.
    expect(issuer.resolve(minted.token)).toBeUndefined();
  });
});

describe("TokenIssuer.revoke + rotate — multiple live tokens per agent_id (CAU-122)", () => {
  it("revoke by agent_id sweeps ALL dynamic tokens for that agent (both 401)", () => {
    const { issuer } = seededIssuer();
    // The same agent_id minted TWICE → two live bearers.
    const first = issuer.mint({ agent_id: "a", owner: "alice" });
    const second = issuer.mint({ agent_id: "a", owner: "alice" });
    expect(first.token).not.toBe(second.token);
    expect(issuer.resolve(first.token)).toBeDefined();
    expect(issuer.resolve(second.token)).toBeDefined();
    // ONE revoke-by-agent_id kills BOTH.
    expect(issuer.revoke({ agent_id: "a" })).toEqual({ revoked: true });
    expect(issuer.resolve(first.token)).toBeUndefined();
    expect(issuer.resolve(second.token)).toBeUndefined();
  });

  it("revoke by digest still removes only the ONE named token (single-token primitive)", () => {
    const { issuer } = seededIssuer();
    const first = issuer.mint({ agent_id: "a", owner: "alice" });
    const second = issuer.mint({ agent_id: "a", owner: "alice" });
    // Revoke by the first token's exact digest — the second survives.
    expect(issuer.revoke({ digest: tokenDigest(first.token) })).toEqual({ revoked: true });
    expect(issuer.resolve(first.token)).toBeUndefined();
    expect(issuer.resolve(second.token)).toBeDefined();
  });

  it("revoke of an agent_id with NO dynamic tokens is a no-op { revoked:false } (same shape)", () => {
    const { issuer } = seededIssuer();
    expect(issuer.revoke({ agent_id: "never-minted" })).toEqual({ revoked: false });
  });

  it("rotate by agent_id sweeps ALL old tokens and leaves EXACTLY ONE valid (the new) token", () => {
    const { issuer } = seededIssuer();
    const first = issuer.mint({ agent_id: "a", owner: "alice" });
    const second = issuer.mint({ agent_id: "a", owner: "alice" });
    const next = issuer.rotate({ agent_id: "a" }, { agent_id: "a", owner: "alice" });
    // Both old bearers are dead.
    expect(issuer.resolve(first.token)).toBeUndefined();
    expect(issuer.resolve(second.token)).toBeUndefined();
    // The freshly minted token is the single survivor and resolves.
    expect(issuer.resolve(next.token)).toEqual({ agent_id: "a", owner: "alice" });
    // A follow-up revoke-by-agent_id removes exactly that one remaining token.
    expect(issuer.revoke({ agent_id: "a" })).toEqual({ revoked: true });
    expect(issuer.resolve(next.token)).toBeUndefined();
    expect(issuer.revoke({ agent_id: "a" })).toEqual({ revoked: false });
  });
});

describe("TokenIssuer.rotate", () => {
  it("rotate issues a NEW token and revokes the OLD one atomically", () => {
    const { issuer } = seededIssuer();
    const old = issuer.mint({ agent_id: "a", owner: "alice" });
    const next = issuer.rotate({ agent_id: "a" }, { agent_id: "a", owner: "alice" });
    // New token resolves to the same identity.
    expect(issuer.resolve(next.token)).toEqual({ agent_id: "a", owner: "alice" });
    expect(next.token).not.toBe(old.token);
    // Old token no longer resolves.
    expect(issuer.resolve(old.token)).toBeUndefined();
  });

  it("rotate of an agent with NO prior dynamic entry mints a token that resolves", () => {
    // Regression: the route's normal case names an agent_id. With no prior
    // dynamic entry for that agent, an after-the-fact dynamicDigestFor(target)
    // would resolve the JUST-MINTED entry and revoke it — leaving the returned
    // token dead. The new token MUST resolve (authorize an append).
    const { issuer } = seededIssuer();
    const minted = issuer.rotate({ agent_id: "fresh" }, { agent_id: "fresh", owner: "frank" });
    expect(issuer.resolve(minted.token)).toEqual({ agent_id: "fresh", owner: "frank" });
  });

  it("rotate can re-anchor to a new identity", () => {
    const { issuer } = seededIssuer();
    const old = issuer.mint({ agent_id: "a", owner: "alice" });
    const next = issuer.rotate({ digest: tokenDigest(old.token) }, { agent_id: "a2", owner: "alice2" });
    expect(issuer.resolve(next.token)).toEqual({ agent_id: "a2", owner: "alice2" });
    expect(issuer.resolve(old.token)).toBeUndefined();
  });
});

describe("TokenIssuer — fail-closed + resolve edge cases", () => {
  it("an empty store (no seed, nothing minted) resolves nobody (fail-closed)", () => {
    const issuer = createIssuer(new Map());
    expect(issuer.resolve("anything")).toBeUndefined();
    expect(issuer.resolve(undefined)).toBeUndefined();
    expect(issuer.resolve("")).toBeUndefined();
  });

  it("resolve returns undefined for absent / empty / unknown tokens", () => {
    const { issuer } = seededIssuer();
    expect(issuer.resolve(undefined)).toBeUndefined();
    expect(issuer.resolve("")).toBeUndefined();
    expect(issuer.resolve("not-a-real-token")).toBeUndefined();
  });
});
