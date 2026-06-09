import { describe, expect, it } from "vitest";

import { stripControlChars } from "./sanitize.js";

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
