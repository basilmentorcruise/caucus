import type { AppendedMessage } from "@caucus/backbone";
import { INJECTED_DELTA_CAP_CHARS } from "@caucus/schema";
import { describe, expect, it } from "vitest";

import {
  BODY_TRUNCATE_CHARS,
  DELTA_FOOTER,
  DELTA_HEADER,
  renderDelta,
  renderMessage,
  stripControlChars,
} from "./render.js";

// Control bytes used across the sanitization tests (CAU-69). Spelled with \x
// escapes so this source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const BEL = "\x07"; // bell / OSC string terminator
const DEL = "\x7f"; // delete

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/** Assert no terminal control byte survives in a rendered string. */
function expectInert(s: string): void {
  expect(s).not.toContain(ESC);
  expect(s).not.toContain(BEL);
  expect(s).not.toContain(DEL);
  expect(s).not.toMatch(CONTROL_CHARS);
}

/** Build an appended message with sensible defaults; override per-test. */
function msg(over: Partial<AppendedMessage> & { type?: AppendedMessage["type"] } = {}): AppendedMessage {
  const base = {
    type: "finding",
    agent_id: "alice-agent",
    owner: "alice",
    msg_id: "01J0000000000000000000000A",
    body: "a finding",
    v: 0,
    ts: "t1",
  };
  return { ...base, ...over } as AppendedMessage;
}

describe("renderMessage", () => {
  it("renders a finding with identity and padded type", () => {
    const line = renderMessage(msg({ type: "finding", owner: "alice", body: "boom" }));
    // `finding` (7) is padded to the widest type `question` (8), so two spaces
    // precede the identity column.
    expect(line).toBe("[caucus] finding  A·alice  boom");
  });

  it("pads the type column so columns align across types", () => {
    const finding = renderMessage(msg({ type: "finding" }));
    const note = renderMessage(msg({ type: "note" }));
    // `question` (8 chars) is the widest type; identity starts at the same column.
    const idxFinding = finding.indexOf("A·");
    const idxNote = note.indexOf("A·");
    expect(idxFinding).toBe(idxNote);
  });

  it("quotes the claim target up front", () => {
    const line = renderMessage(
      msg({ type: "claim", target: "auth-timeout repro", body: "claiming it" } as Partial<AppendedMessage>),
    );
    expect(line).toContain('"auth-timeout repro"');
    expect(line.indexOf('"auth-timeout repro"')).toBeLessThan(line.indexOf("claiming it"));
  });

  it("renders a question with a needs-response status tag", () => {
    const line = renderMessage(msg({ type: "question", body: "why 500s?", status: "needs-response" }));
    expect(line).toBe("[caucus] question A·alice  why 500s?  [needs-response]");
  });

  it("renders an answer with a resolved status tag", () => {
    const line = renderMessage(msg({ type: "answer", body: "fixed it", status: "resolved" }));
    expect(line).toContain("[resolved]");
  });

  it("renders an fyi status tag", () => {
    const line = renderMessage(msg({ type: "status", body: "still digging", status: "fyi" }));
    expect(line).toContain("[fyi]");
  });

  it("renders @agent markers when addressed via to[]", () => {
    const line = renderMessage(msg({ body: "look here", to: ["bob-agent", "carol-agent"] }));
    expect(line).toContain("@bob-agent @carol-agent");
  });

  it("renders a ↗artifact marker but NEVER the url (ADR-C12)", () => {
    const line = renderMessage(
      msg({ body: "summary", artifact: "https://secret.example/with?token=abc123" }),
    );
    expect(line).toContain("↗artifact");
    expect(line).not.toContain("secret.example");
    expect(line).not.toContain("token=abc123");
  });

  it("ignores an empty artifact string", () => {
    const line = renderMessage(msg({ body: "summary", artifact: "" }));
    expect(line).not.toContain("↗artifact");
  });

  it("ignores an empty to[] array", () => {
    const line = renderMessage(msg({ body: "summary", to: [] }));
    expect(line).not.toContain("@");
  });

  it("collapses newlines so one message stays one line", () => {
    const line = renderMessage(msg({ body: "line1\nline2\tline3" }));
    expect(line).toBe("[caucus] finding  A·alice  line1 line2 line3");
    expect(line).not.toContain("\n");
  });

  it("truncates a long body to BODY_TRUNCATE_CHARS with an ellipsis", () => {
    const body = "x".repeat(BODY_TRUNCATE_CHARS + 50);
    const line = renderMessage(msg({ body }));
    expect(line).toContain("x".repeat(BODY_TRUNCATE_CHARS) + "…");
    expect(line).not.toContain("x".repeat(BODY_TRUNCATE_CHARS + 1));
  });

  it("does not append an ellipsis for a body exactly at the limit", () => {
    const body = "y".repeat(BODY_TRUNCATE_CHARS);
    const line = renderMessage(msg({ body }));
    expect(line.endsWith("…")).toBe(false);
    expect(line).toContain("y".repeat(BODY_TRUNCATE_CHARS));
  });

  it("renders a claim with target, status, and @to together", () => {
    const line = renderMessage(
      msg({
        type: "claim",
        target: "db-migration",
        body: "on it",
        status: "needs-response",
        to: ["bob-agent"],
      } as Partial<AppendedMessage>),
    );
    expect(line).toContain('"db-migration"');
    expect(line).toContain("on it");
    expect(line).toContain("[needs-response]");
    expect(line).toContain("@bob-agent");
  });
});

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
    expectInert(clean);
    // The printable remnants survive (only the control bytes are removed).
    expect(clean).toBe("[2Jclearbell]0;pwnedosc");
  });

  it("returns an empty string unchanged", () => {
    expect(stripControlChars("")).toBe("");
  });
});

describe("renderMessage — control-character sanitization (CAU-69)", () => {
  it("neutralizes ESC/BEL/DEL and an OSC sequence embedded in the body", () => {
    // \x1b[2J clears the screen; \x1b]0;pwned\x07 is a title/clipboard OSC.
    const body = `before ${ESC}[2J ${BEL} ${DEL} ${ESC}]0;pwned${BEL} after`;
    const line = renderMessage(msg({ body }));
    expectInert(line);
    // Legitimate words are preserved; only the control bytes are gone.
    expect(line).toContain("before");
    expect(line).toContain("after");
  });

  it("sanitizes a malicious owner field", () => {
    const line = renderMessage(msg({ owner: `alice${ESC}[31m`, body: "hi" }));
    expectInert(line);
    expect(line).toContain("A·alice");
    expect(line).toContain("[31m"); // the printable ESC remnant, ESC byte gone
  });

  it("sanitizes a malicious claim target", () => {
    const line = renderMessage(
      msg({ type: "claim", target: `repro${BEL}${ESC}[2J`, body: "on it" } as Partial<AppendedMessage>),
    );
    expectInert(line);
    expect(line).toContain('"repro');
  });

  it("sanitizes a malicious to[] entry", () => {
    const line = renderMessage(msg({ body: "look", to: [`bob${ESC}[1m`] }));
    expectInert(line);
    expect(line).toContain("@bob");
  });

  it("leaves clean input byte-for-byte unchanged (no format regression)", () => {
    // The exact rendering example from the existing suite must be untouched.
    const line = renderMessage(msg({ type: "finding", owner: "alice", body: "boom" }));
    expect(line).toBe("[caucus] finding  A·alice  boom");
  });
});

describe("renderDelta", () => {
  it("returns empty string for no messages (quiet default)", () => {
    expect(renderDelta([])).toBe("");
  });

  it("wraps messages in the header/footer block", () => {
    const out = renderDelta([msg({ body: "one" }), msg({ body: "two" })]);
    expect(out.startsWith(DELTA_HEADER)).toBe(true);
    expect(out.endsWith(DELTA_FOOTER)).toBe(true);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out.split("\n")).toHaveLength(4); // header + 2 lines + footer
  });

  it("keeps the whole block when under the cap (no overflow line)", () => {
    const out = renderDelta([msg({ body: "small" })]);
    expect(out).not.toContain("older messages");
    expect(out.length).toBeLessThanOrEqual(INJECTED_DELTA_CAP_CHARS);
  });

  it("drops OLDEST lines and prepends a +N overflow line when over the cap", () => {
    // 20 messages of ~80 chars each, with a tiny cap that fits only a few.
    const many = Array.from({ length: 20 }, (_, i) =>
      msg({ body: `message-number-${i} ${"z".repeat(60)}`, msg_id: `01J000000000000000000000${i % 10}A` }),
    );
    const cap = 400;
    const out = renderDelta(many, cap);

    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).toMatch(/^\+\d+ older messages — use caucus_read_channel$/m);
    // The NEWEST message survives; the oldest is dropped.
    expect(out).toContain("message-number-19");
    expect(out).not.toContain("message-number-0 ");
    // header + overflow + >=1 kept line + footer
    expect(out.startsWith(DELTA_HEADER)).toBe(true);
    expect(out.endsWith(DELTA_FOOTER)).toBe(true);
  });

  it("reports the correct dropped count in the overflow line", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      msg({ body: `m${i} ${"q".repeat(60)}` }),
    );
    const cap = 300;
    const out = renderDelta(many, cap);
    const match = out.match(/\+(\d+) older messages/);
    expect(match).not.toBeNull();
    const dropped = Number(match![1]);
    // kept = 10 - dropped; every kept newest message must appear.
    const kept = 10 - dropped;
    for (let i = 10 - kept; i < 10; i++) {
      expect(out).toContain(`m${i} `);
    }
  });

  it("cap accounting includes the wrapper: a block at exactly the cap is not truncated", () => {
    // Pick a cap equal to the exact rendered length of a one-message block.
    const m = msg({ body: "exact-fit" });
    const full = `${DELTA_HEADER}\n${renderMessage(m)}\n${DELTA_FOOTER}`;
    const out = renderDelta([m], full.length);
    expect(out).toBe(full);
    expect(out).not.toContain("older messages");
  });

  it("keeps at least the newest message even when one line cannot fit the cap", () => {
    // Append order: oldest first, newest last.
    const out = renderDelta([msg({ body: "older" }), msg({ body: "wont-fit-but-kept" })], 1);
    // Degenerate cap: still emits a non-empty block carrying the newest message.
    expect(out).toContain("wont-fit-but-kept");
    expect(out).toContain("older messages"); // overflow line present
    expect(out.startsWith(DELTA_HEADER)).toBe(true);
  });
});
