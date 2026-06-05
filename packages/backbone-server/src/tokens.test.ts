/**
 * Unit tests for the token map (CAU-13): parse, resolve, owner-with-colons, and
 * — critically — that a parse error is POSITIONAL and never leaks the token text
 * (ADR-C12).
 */
import { describe, expect, it } from "vitest";

import { parseTokenMap, resolveToken, TokenMapParseError } from "./tokens.js";

describe("parseTokenMap", () => {
  it("parses a single tok:agent:owner entry", () => {
    const map = parseTokenMap("tok-a:alice-agent:alice");
    expect(map.get("tok-a")).toEqual({ agent_id: "alice-agent", owner: "alice" });
    expect(map.size).toBe(1);
  });

  it("parses multiple comma-separated entries", () => {
    const map = parseTokenMap("t1:a1:alice,t2:a2:bob");
    expect(map.get("t1")).toEqual({ agent_id: "a1", owner: "alice" });
    expect(map.get("t2")).toEqual({ agent_id: "a2", owner: "bob" });
  });

  it("lets the owner contain further colons", () => {
    const map = parseTokenMap("tok:agent:a:b:c");
    expect(map.get("tok")).toEqual({ agent_id: "agent", owner: "a:b:c" });
  });

  it("trims surrounding whitespace on token, agent_id, and owner", () => {
    const map = parseTokenMap("  tok  :  agent  :  owner  ");
    expect(map.get("tok")).toEqual({ agent_id: "agent", owner: "owner" });
  });

  it("returns an empty map for undefined, empty, or all-whitespace input", () => {
    expect(parseTokenMap(undefined).size).toBe(0);
    expect(parseTokenMap("").size).toBe(0);
    expect(parseTokenMap("   ").size).toBe(0);
  });

  it("throws a POSITIONAL error on a missing second colon", () => {
    expect(() => parseTokenMap("tok:onlyagent")).toThrow(TokenMapParseError);
    expect(() => parseTokenMap("tok:onlyagent")).toThrow(
      "CAUCUS_TOKENS entry 1 is malformed",
    );
  });

  it("throws a POSITIONAL error on a missing colon entirely", () => {
    expect(() => parseTokenMap("nocolons")).toThrow("CAUCUS_TOKENS entry 1 is malformed");
  });

  it("reports the offending entry's 1-based position", () => {
    expect(() => parseTokenMap("t1:a:owner,bad")).toThrow(
      "CAUCUS_TOKENS entry 2 is malformed",
    );
    expect(() => parseTokenMap("t1:a:owner,t2:b:owner,,t4:d:owner")).toThrow(
      "CAUCUS_TOKENS entry 3 is malformed",
    );
  });

  it("rejects an empty token, agent_id, or owner half", () => {
    expect(() => parseTokenMap(":agent:owner")).toThrow("entry 1 is malformed");
    expect(() => parseTokenMap("tok::owner")).toThrow("entry 1 is malformed");
    expect(() => parseTokenMap("tok:agent:")).toThrow("entry 1 is malformed");
    expect(() => parseTokenMap("tok:agent:   ")).toThrow("entry 1 is malformed");
  });

  it("rejects a duplicate token", () => {
    expect(() => parseTokenMap("dup:a:alice,dup:b:bob")).toThrow(
      "CAUCUS_TOKENS entry 2 is malformed",
    );
  });

  it("NEVER leaks the token text in a parse error (ADR-C12)", () => {
    // A secret-looking token in a malformed entry. The thrown message must name
    // only the position, never the token bytes.
    const secret = "sk-live-SUPERSECRET-DEADBEEF";
    const tryParse = (input: string): TokenMapParseError => {
      try {
        parseTokenMap(input);
      } catch (e) {
        return e as TokenMapParseError;
      }
      throw new Error("expected a parse error");
    };

    // Malformed: token present but no second colon.
    const e1 = tryParse(`${secret}:onlyagent`);
    expect(e1.message).not.toContain(secret);
    expect(e1.message).not.toContain("SUPERSECRET");

    // Malformed second entry whose token is the secret.
    const e2 = tryParse(`t1:a:owner,${secret}`);
    expect(e2.message).not.toContain(secret);

    // Duplicate token (the secret), rejected at the 2nd occurrence.
    const e3 = tryParse(`${secret}:a:alice,${secret}:b:bob`);
    expect(e3.message).not.toContain(secret);
  });
});

describe("resolveToken", () => {
  const map = parseTokenMap("tok-a:alice-agent:alice,tok-b:bob-agent:bob");

  it("resolves a known token to its identity", () => {
    expect(resolveToken(map, "tok-a")).toEqual({ agent_id: "alice-agent", owner: "alice" });
    expect(resolveToken(map, "tok-b")).toEqual({ agent_id: "bob-agent", owner: "bob" });
  });

  it("returns undefined for an unknown token", () => {
    expect(resolveToken(map, "tok-unknown")).toBeUndefined();
  });

  it("returns undefined for an absent or empty presented token", () => {
    expect(resolveToken(map, undefined)).toBeUndefined();
    expect(resolveToken(map, "")).toBeUndefined();
  });

  it("returns undefined against an empty (fail-closed) map", () => {
    const empty = parseTokenMap(undefined);
    expect(resolveToken(empty, "tok-a")).toBeUndefined();
  });
});
