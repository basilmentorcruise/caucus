import { describe, expect, it } from "vitest";

import { MAX_ERROR_FRAGMENT_CHARS } from "./constants.js";
import {
  containsControlChars,
  containsControlCharsExceptWhitespace,
  sanitizeErrorFragment,
  stripControlChars,
  stripControlCharsKeepWhitespace,
} from "./sanitize.js";

// Control bytes used across the sanitization tests. Spelled with \x escapes so
// this source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const BEL = "\x07"; // bell / OSC string terminator
const DEL = "\x7f"; // delete
const C1 = "\x9b"; // C1 CSI — survives JSON.stringify

describe("stripControlChars", () => {
  it("keeps printable ASCII 0x20–0x7e (space through ~) unchanged", () => {
    let printable = "";
    for (let c = 0x20; c <= 0x7e; c++) printable += String.fromCharCode(c);
    expect(stripControlChars(printable)).toBe(printable);
  });

  it("removes every C0 control byte 0x00–0x1f", () => {
    for (let c = 0x00; c <= 0x1f; c++) {
      const ch = String.fromCharCode(c);
      expect(stripControlChars(`a${ch}b`)).toBe("ab");
    }
  });

  it("removes DEL 0x7f", () => {
    expect(stripControlChars(`a${DEL}b`)).toBe("ab");
  });

  it("removes every C1 control byte 0x80–0x9f", () => {
    for (let c = 0x80; c <= 0x9f; c++) {
      const ch = String.fromCharCode(c);
      expect(stripControlChars(`a${ch}b`)).toBe("ab");
    }
  });

  it("leaves multibyte UTF-8 (↗, é, ·, accented) intact", () => {
    expect(stripControlChars("↗ é · café — naïve")).toBe("↗ é · café — naïve");
  });

  it("strips ESC, BEL and a full OSC sequence from mixed content", () => {
    const dirty = `${ESC}[2Jclear${BEL}bell${ESC}]0;pwned${BEL}osc`;
    const clean = stripControlChars(dirty);
    // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
    expect(clean).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    // The printable remnants survive (only the control bytes are removed).
    expect(clean).toBe("[2Jclearbell]0;pwnedosc");
  });

  it("returns an empty string unchanged", () => {
    expect(stripControlChars("")).toBe("");
  });
});

describe("stripControlCharsKeepWhitespace", () => {
  it("PRESERVES \\n (0x0a) and \\t (0x09) — does NOT glue words", () => {
    expect(stripControlCharsKeepWhitespace("step 1\nstep 2")).toBe(
      "step 1\nstep 2",
    );
    expect(stripControlCharsKeepWhitespace("col1\tcol2")).toBe("col1\tcol2");
  });

  it("still removes every OTHER C0 control byte (incl. \\r 0x0d)", () => {
    for (let c = 0x00; c <= 0x1f; c++) {
      if (c === 0x09 || c === 0x0a) continue; // TAB/LF are kept
      const ch = String.fromCharCode(c);
      expect(stripControlCharsKeepWhitespace(`a${ch}b`)).toBe("ab");
    }
  });

  it("removes DEL 0x7f", () => {
    expect(stripControlCharsKeepWhitespace(`a${DEL}b`)).toBe("ab");
  });

  it("removes every C1 control byte 0x80–0x9f", () => {
    for (let c = 0x80; c <= 0x9f; c++) {
      const ch = String.fromCharCode(c);
      expect(stripControlCharsKeepWhitespace(`a${ch}b`)).toBe("ab");
    }
  });

  it("strips ESC/BEL/OSC but keeps surrounding newlines", () => {
    const dirty = `a\n${ESC}[2J${BEL}\nb`;
    const clean = stripControlCharsKeepWhitespace(dirty);
    // Only \n and \t may remain among controls.
    // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
    expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(clean).toBe("a\n[2J\nb");
  });

  it("leaves multibyte UTF-8 intact", () => {
    expect(stripControlCharsKeepWhitespace("↗ é · café — naïve")).toBe(
      "↗ é · café — naïve",
    );
  });

  it("returns an empty string unchanged", () => {
    expect(stripControlCharsKeepWhitespace("")).toBe("");
  });
});

// CAU-71: the write-layer predicates, derived from the strip functions.
describe("containsControlChars", () => {
  it.each(["\x00", "\x08", "\x1f", "\x7f", "\x80", "\x9f", "\x1b"])(
    "is true for control byte %j",
    (ch) => {
      expect(containsControlChars(`a${ch}b`)).toBe(true);
    },
  );

  it("is true for \\t and \\n (NO whitespace exemption)", () => {
    expect(containsControlChars("a\tb")).toBe(true);
    expect(containsControlChars("a\nb")).toBe(true);
  });

  it("is false for printable ASCII boundaries 0x20 and 0x7e", () => {
    expect(containsControlChars("\x20")).toBe(false);
    expect(containsControlChars("\x7e")).toBe(false);
  });

  it("is false for 0xa0 (NBSP — just past the C1 range)", () => {
    expect(containsControlChars("\xa0")).toBe(false);
  });

  it("is false for multibyte UTF-8 (é, ↗)", () => {
    expect(containsControlChars("é")).toBe(false);
    expect(containsControlChars("↗")).toBe(false);
    expect(containsControlChars("↗ é café — naïve")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(containsControlChars("")).toBe(false);
  });
});

describe("containsControlCharsExceptWhitespace", () => {
  it("is false for \\t and \\n (the body-safe whitespace)", () => {
    expect(containsControlCharsExceptWhitespace("step 1\nstep 2")).toBe(false);
    expect(containsControlCharsExceptWhitespace("col1\tcol2")).toBe(false);
  });

  it.each(["\r", "\x0b", "\x1b", "\x7f", "\x9b"])(
    "is true for control byte %j",
    (ch) => {
      expect(containsControlCharsExceptWhitespace(`a${ch}b`)).toBe(true);
    },
  );

  it("is true for the other sampled controls (\\x00, \\x08, \\x1f, \\x80, \\x9f)", () => {
    for (const ch of ["\x00", "\x08", "\x1f", "\x80", "\x9f"]) {
      expect(containsControlCharsExceptWhitespace(`a${ch}b`)).toBe(true);
    }
  });

  it("is false for printables, NBSP, multibyte, and the empty string", () => {
    expect(containsControlCharsExceptWhitespace("\x20")).toBe(false);
    expect(containsControlCharsExceptWhitespace("\x7e")).toBe(false);
    expect(containsControlCharsExceptWhitespace("\xa0")).toBe(false);
    expect(containsControlCharsExceptWhitespace("é ↗")).toBe(false);
    expect(containsControlCharsExceptWhitespace("")).toBe(false);
  });
});

describe("predicate/strip drift lock (CAU-71)", () => {
  it("0x00–0xFF sweep: each predicate agrees byte-for-byte with its strip function", () => {
    for (let c = 0x00; c <= 0xff; c++) {
      const s = `a${String.fromCharCode(c)}b`;
      expect(containsControlChars(s)).toBe(stripControlChars(s) !== s);
      expect(containsControlCharsExceptWhitespace(s)).toBe(
        stripControlCharsKeepWhitespace(s) !== s,
      );
    }
  });

  it("the two predicates differ EXACTLY on \\x09 (TAB) and \\x0a (LF)", () => {
    const differing: number[] = [];
    for (let c = 0x00; c <= 0xff; c++) {
      const s = String.fromCharCode(c);
      if (containsControlChars(s) !== containsControlCharsExceptWhitespace(s)) {
        differing.push(c);
      }
    }
    expect(differing).toEqual([0x09, 0x0a]);
  });
});

describe("sanitizeErrorFragment (CAU-88)", () => {
  it("strips C0/DEL/C1 control bytes (delegates to stripControlChars)", () => {
    // Only the control BYTES are removed (ESC, DEL, C1) — the printable `[2J`
    // tail of the escape sequence is left intact (this is byte neutralization,
    // not an ANSI-aware parser).
    const dirty = `unknown${ESC}[2J${DEL}field${C1}`;
    const out = sanitizeErrorFragment(dirty);
    expect(out).toBe("unknown[2Jfield");
    expect(containsControlChars(out)).toBe(false);
  });

  it("is a no-op for a short, clean fragment", () => {
    expect(sanitizeErrorFragment("evil-key")).toBe("evil-key");
  });

  it("truncates an overlong fragment to maxLen and appends a … marker", () => {
    const long = "x".repeat(MAX_ERROR_FRAGMENT_CHARS + 50);
    const out = sanitizeErrorFragment(long);
    expect(out).toBe(`${"x".repeat(MAX_ERROR_FRAGMENT_CHARS)}…`);
    // The … marker is one printable char; the visible body is exactly capped.
    expect(out.length).toBe(MAX_ERROR_FRAGMENT_CHARS + 1);
  });

  it("does NOT truncate a fragment exactly at maxLen (boundary, no marker)", () => {
    const exact = "y".repeat(MAX_ERROR_FRAGMENT_CHARS);
    const out = sanitizeErrorFragment(exact);
    expect(out).toBe(exact);
    expect(out.endsWith("…")).toBe(false);
  });

  it("counts visible chars AFTER the strip: an all-control fragment collapses to empty (never truncated)", () => {
    const allControl = DEL.repeat(MAX_ERROR_FRAGMENT_CHARS + 100);
    expect(sanitizeErrorFragment(allControl)).toBe("");
  });

  it("honors an explicit maxLen override", () => {
    expect(sanitizeErrorFragment("abcdef", 3)).toBe("abc…");
  });
});
