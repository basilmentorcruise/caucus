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

  it("throws MalformedMessageError when empty after trim", () => {
    expect(() => normalizeTarget("   ")).toThrow(MalformedMessageError);
    expect(() => normalizeTarget("")).toThrow(MalformedMessageError);
  });
});
