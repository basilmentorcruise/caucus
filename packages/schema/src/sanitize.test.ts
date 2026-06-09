import { describe, expect, it } from "vitest";

import {
  stripControlChars,
  stripControlCharsKeepWhitespace,
} from "./sanitize.js";

// Control bytes used across the sanitization tests. Spelled with \x escapes so
// this source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const BEL = "\x07"; // bell / OSC string terminator
const DEL = "\x7f"; // delete

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
