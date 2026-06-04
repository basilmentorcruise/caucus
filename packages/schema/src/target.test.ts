import { describe, expect, it } from "vitest";
import { MalformedMessageError } from "./errors.js";
import { normalizeTarget } from "./target.js";

describe("normalizeTarget", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeTarget("  auth-timeout repro  ")).toBe(
      "auth-timeout repro",
    );
  });

  it("trims tabs and newlines", () => {
    expect(normalizeTarget("\t\nfoo\n\t")).toBe("foo");
  });

  it("is idempotent", () => {
    const once = normalizeTarget("  db-pool  ");
    expect(normalizeTarget(once)).toBe(once);
  });

  it("preserves case (no case-folding in v0)", () => {
    expect(normalizeTarget("Auth-Timeout REPRO")).toBe("Auth-Timeout REPRO");
  });

  it("preserves internal whitespace", () => {
    expect(normalizeTarget("  a  b   c  ")).toBe("a  b   c");
  });

  it("NFC-normalizes canonically-equivalent spellings to one key", () => {
    // Precomposed "café" (U+00E9) vs decomposed "café" (e + combining
    // acute). They are distinct code-point sequences but canonically equal;
    // both must derive the same ledger key.
    const precomposed = "café";
    const decomposed = "café";
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeTarget(precomposed)).toBe(normalizeTarget(decomposed));
    expect(normalizeTarget(decomposed)).toBe(precomposed);
  });

  it("does NOT strip zero-width characters (distinct keys — accepted v0)", () => {
    // A zero-width space makes the target distinct; v0 does not strip it.
    const plain = "payments";
    const withZwsp = "pay​ments";
    expect(normalizeTarget(withZwsp)).not.toBe(normalizeTarget(plain));
  });

  it("throws MalformedMessageError when empty after trim", () => {
    expect(() => normalizeTarget("   ")).toThrow(MalformedMessageError);
    expect(() => normalizeTarget("")).toThrow(MalformedMessageError);
  });
});
