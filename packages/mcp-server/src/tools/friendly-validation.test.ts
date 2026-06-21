/**
 * Unit tests for the friendly arg-validation mapper (CAU-123).
 *
 * Asserts the three common Zod issues map to clear, leak-free sentences and that
 * a valid parse returns the defaults-applied value. The end-to-end surfacing
 * (through the SDK client over a transport) is covered in server.test.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseToolArgs } from "./friendly-validation.js";

describe("parseToolArgs (CAU-123)", () => {
  it("returns the parsed, defaults-applied value on success", () => {
    const shape = {
      format: z.enum(["structured", "markdown"]).default("structured"),
      since: z.number().int().optional(),
    };
    const r = parseToolArgs(shape, { since: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The enum default was applied.
      expect(r.value).toEqual({ format: "structured", since: 3 });
    }
  });

  it("names a MISSING required argument", () => {
    const r = parseToolArgs({ target: z.string().min(1) }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("Invalid arguments: `target` is required.");
    }
  });

  it("names a WRONG-TYPE argument with the expected type", () => {
    const r = parseToolArgs({ n: z.number().int() }, { n: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("`n` must be a");
  });

  it("lists the allowed ENUM options and never echoes the rejected value", () => {
    const secret = "tok_should_not_leak";
    const r = parseToolArgs(
      { format: z.enum(["structured", "markdown"]) },
      { format: secret },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("`format` must be one of");
      expect(r.message).toContain("`structured`");
      expect(r.message).toContain("`markdown`");
      // Leak-free (ADR-C12): the bad value is never in the message.
      expect(r.message).not.toContain(secret);
    }
  });

  it("de-duplicates and combines multiple issues into one single-line message", () => {
    const r = parseToolArgs(
      { a: z.string(), b: z.number() },
      {}, // both missing
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "Invalid arguments: `a` is required; `b` is required.",
      );
      // Single line — no control bytes, no newlines.
      expect(r.message).not.toContain("\n");
    }
  });

  it("falls back to Zod's own (leak-free) message for an uncommon constraint, prefixed by the field", () => {
    const r = parseToolArgs({ body: z.string().min(5) }, { body: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("`body`");
      // The rejected value ("hi") is not echoed; only the constraint phrasing.
      expect(r.message).not.toContain('"hi"');
    }
  });
});
