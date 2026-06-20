import { describe, expect, it } from "vitest";

import { sanitizeMessageFields } from "./sanitize-message.js";
import { SCHEMA_VERSION } from "./version.js";
import type { CaucusMessage } from "./types.js";

// Control bytes, spelled with \x escapes so this source stays printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer (C0)
const C1 = "\x9b"; // C1 CSI — survives JSON.stringify verbatim
const DEL = "\x7f";

/** Matches any C0/DEL/C1 control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

function note(overrides: Partial<CaucusMessage> = {}): CaucusMessage {
  return {
    v: SCHEMA_VERSION,
    type: "note",
    agent_id: "alice-agent",
    owner: "alice",
    msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    body: "hello",
    ...overrides,
  } as CaucusMessage;
}

describe("sanitizeMessageFields", () => {
  it("strips C0/C1/DEL from body, owner, agent_id", () => {
    const out = sanitizeMessageFields(
      note({
        body: `dan${ESC}[2Jger`,
        owner: `ali${C1}ce`,
        agent_id: `age${DEL}nt`,
      }),
    );
    expect(out.body).toBe("dan[2Jger");
    expect(out.owner).toBe("alice");
    expect(out.agent_id).toBe("agent");
    expect(JSON.stringify(out)).not.toMatch(CONTROL_CHARS);
  });

  it("preserves \\n and \\t in body (whitespace-keeping strip)", () => {
    const out = sanitizeMessageFields(note({ body: "step 1\nstep 2\twrap" }));
    expect(out.body).toBe("step 1\nstep 2\twrap");
  });

  it("strips control bytes from claim target, artifact, and each to[] entry", () => {
    const out = sanitizeMessageFields(
      note({
        type: "claim",
        target: `tar${C1}get`,
        artifact: `caucus://artifact/c/${DEL}abc`,
        to: [`bo${ESC}b`, `car${C1}ol`],
      } as Partial<CaucusMessage>),
    ) as CaucusMessage & { target: string; artifact: string; to: string[] };
    expect(out.target).toBe("target");
    expect(out.artifact).toBe("caucus://artifact/c/abc");
    expect(out.to).toEqual(["bob", "carol"]);
  });

  it("leaves structural fields untouched and does not mutate the input", () => {
    const input = note({ msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", thread: "01ARZ3NDEKTSV4RRFFQ69G5FAW" });
    const snapshot = JSON.stringify(input);
    const out = sanitizeMessageFields(input);
    expect(out.msg_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(out.thread).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    // input untouched
    expect(JSON.stringify(input)).toBe(snapshot);
    // a copy, not the same reference
    expect(out).not.toBe(input);
  });

  it("is a no-op for an already-clean message (idempotent shape)", () => {
    const clean = note({ body: "all good", owner: "alice" });
    expect(sanitizeMessageFields(clean)).toEqual(clean);
  });
});
