import { describe, expect, it } from "vitest";
import { decode } from "./codec.js";
import {
  MalformedMessageError,
  SchemaError,
  UnsupportedVersionError,
} from "./errors.js";
import {
  MAX_FIELD_CHARS,
  MAX_RECIPIENTS,
  MAX_REPORTED_ISSUES,
} from "./constants.js";
import { validate } from "./validate.js";

/** A minimal valid v1 message (already version-stamped). */
function validNote(): Record<string, unknown> {
  return {
    v: 1,
    type: "note",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    body: "hello",
  };
}

function validClaim(): Record<string, unknown> {
  return {
    v: 1,
    type: "claim",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    body: "Taking the auth-timeout repro.",
    target: "auth-timeout repro",
  };
}

/** Assert validate throws Malformed and that one issue contains `needle`. */
function expectIssue(value: unknown, needle: string): void {
  try {
    validate(value);
    expect.unreachable("validate should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(MalformedMessageError);
    const issues = (err as MalformedMessageError).issues;
    expect(issues.some((i) => i.includes(needle))).toBe(true);
  }
}

describe("validate — happy path", () => {
  it("accepts a minimal valid note", () => {
    expect(() => validate(validNote())).not.toThrow();
  });

  it("accepts a valid claim with target", () => {
    expect(() => validate(validClaim())).not.toThrow();
  });

  it("accepts a valid steer (CAU-99) — incl. status:needs-response", () => {
    expect(() => validate({ ...validNote(), type: "steer" })).not.toThrow();
    expect(() =>
      validate({ ...validNote(), type: "steer", status: "needs-response" }),
    ).not.toThrow();
  });

  it("rejects claim-only fields on a steer (steer is in the non-claim union)", () => {
    expectIssue(
      { ...validNote(), type: "steer", target: "auth-timeout" },
      "target is only valid on claim messages",
    );
  });
});

describe("validate — structural", () => {
  it("rejects a non-object", () => {
    expectIssue(42, "JSON object");
    expectIssue(null, "JSON object");
    expectIssue([], "JSON object");
  });

  it("rejects an unknown top-level key", () => {
    expectIssue({ ...validNote(), bogus: 1 }, 'unknown field "bogus"');
  });

  it("caps unknown-field issues at MAX_REPORTED_ISSUES + 1 summary (CAU-6)", () => {
    const msg = validNote();
    const UNKNOWN = 50;
    for (let i = 0; i < UNKNOWN; i += 1) {
      msg[`extra_${i}`] = i;
    }
    try {
      validate(msg);
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const issues = (err as MalformedMessageError).issues;
      // At most MAX_REPORTED_ISSUES named fields + one summary line. Every other
      // check passes for a valid note, so the only issues are unknown-field ones.
      expect(issues.length).toBeLessThanOrEqual(MAX_REPORTED_ISSUES + 1);
      const named = issues.filter((i) => i.startsWith("unknown field"));
      expect(named).toHaveLength(MAX_REPORTED_ISSUES);
      // The last issue summarizes the remainder rather than naming a field.
      expect(issues[issues.length - 1]).toBe(
        `…and ${UNKNOWN - MAX_REPORTED_ISSUES} more unknown fields`,
      );
    }
  });

  it("rejects a wrong v at the field layer", () => {
    expectIssue({ ...validNote(), v: 5 }, "v must be 1");
  });

  // CAU-88: the unknown-field key is caller-controlled and rides into the
  // thrown error's .message AND the wire-forwarded .issues[]. It is the SOLE
  // caller-content echo in validate.ts — every other push is a server-derived
  // constant/count — so it is sanitized at construction.
  it("strips control bytes from an echoed unknown-field key (DEL + C1)", () => {
    // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
    const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
    const dirtyKey = `pwn\x7f${"\x9b"}[2J`;
    try {
      validate({ ...validNote(), [dirtyKey]: 1 });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const e = err as MalformedMessageError;
      expect(e.message).not.toMatch(CONTROL);
      for (const issue of e.issues) expect(issue).not.toMatch(CONTROL);
      // The clean key text is preserved.
      expect(e.issues).toContain('unknown field "pwn[2J"');
    }
  });

  it("length-caps an overlong unknown-field key in the issue (… marker)", () => {
    const longKey = "k".repeat(300);
    try {
      validate({ ...validNote(), [longKey]: 1 });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      const e = err as MalformedMessageError;
      const issue = e.issues.find((i) => i.startsWith("unknown field"));
      expect(issue).toBeDefined();
      // Capped well below the raw 300-char key, and the truncation marker shows.
      expect(issue!.length).toBeLessThan(longKey.length);
      expect(issue).toContain("…");
      expect(issue).not.toContain("k".repeat(300));
    }
  });

  it("leaves a normal unknown-field key unchanged (no-op)", () => {
    expectIssue({ ...validNote(), bogus_field: 1 }, 'unknown field "bogus_field"');
  });
});

describe("validate — required fields (missing one at a time)", () => {
  it("rejects a bad type", () => {
    expectIssue({ ...validNote(), type: "nope" }, "type must be one of");
  });

  it("rejects missing type", () => {
    const m = validNote();
    delete m.type;
    expectIssue(m, "type must be one of");
  });

  it("rejects missing agent_id", () => {
    const m = validNote();
    delete m.agent_id;
    expectIssue(m, "agent_id");
  });

  it("rejects empty agent_id", () => {
    expectIssue({ ...validNote(), agent_id: "" }, "agent_id");
  });

  it("rejects missing owner", () => {
    const m = validNote();
    delete m.owner;
    expectIssue(m, "owner");
  });

  it("rejects missing msg_id", () => {
    const m = validNote();
    delete m.msg_id;
    expectIssue(m, "msg_id must be a ULID");
  });

  it("rejects an invalid msg_id ULID", () => {
    expectIssue({ ...validNote(), msg_id: "not-a-ulid" }, "msg_id must be a ULID");
  });

  it("rejects missing body", () => {
    const m = validNote();
    delete m.body;
    expectIssue(m, "body must be a non-empty string");
  });

  it("rejects empty body", () => {
    expectIssue({ ...validNote(), body: "" }, "body must be a non-empty string");
  });
});

describe("validate — optional fields", () => {
  it("rejects an invalid thread ULID", () => {
    expectIssue({ ...validNote(), thread: "bad" }, "thread must be a ULID");
  });

  it("accepts a valid thread ULID", () => {
    expect(() =>
      validate({ ...validNote(), thread: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).not.toThrow();
  });

  it("rejects an invalid reply_to ULID", () => {
    expectIssue({ ...validNote(), reply_to: "bad" }, "reply_to must be a ULID");
  });

  it("rejects a non-array to", () => {
    expectIssue({ ...validNote(), to: "sess-B" }, "to must be a non-empty array");
  });

  it("rejects a to array with a non-string entry", () => {
    expectIssue({ ...validNote(), to: ["sess-B", 5] }, "to must be a non-empty array");
  });

  it("rejects an empty to array", () => {
    expectIssue({ ...validNote(), to: [] }, "to must be a non-empty array");
  });

  it("rejects a to array with an empty-string entry", () => {
    expectIssue({ ...validNote(), to: [""] }, "to must be a non-empty array");
  });

  it("accepts a single-element to array", () => {
    expect(() =>
      validate({ ...validNote(), to: ["sess-A"] }),
    ).not.toThrow();
  });

  it("accepts a valid to array", () => {
    expect(() =>
      validate({ ...validNote(), to: ["sess-B", "sess-C"] }),
    ).not.toThrow();
  });

  // CAU-90: `to[]` is a routing fan-out list, not a payload — its entry count
  // is capped at MAX_RECIPIENTS so a poster cannot inflate a read page.
  it(`accepts a to array at exactly MAX_RECIPIENTS (${MAX_RECIPIENTS})`, () => {
    const to = Array.from({ length: MAX_RECIPIENTS }, (_v, i) => `sess-${i}`);
    expect(() => validate({ ...validNote(), to })).not.toThrow();
  });

  it(`rejects a to array over MAX_RECIPIENTS — positional, non-echoing`, () => {
    const to = Array.from(
      { length: MAX_RECIPIENTS + 1 },
      (_v, i) => `sess-${i}`,
    );
    try {
      validate({ ...validNote(), to });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const issues = (err as MalformedMessageError).issues;
      // The issue names the count and the limit — never any recipient value.
      expect(issues).toEqual([
        `to[] has more than ${MAX_RECIPIENTS} recipients (${MAX_RECIPIENTS + 1})`,
      ]);
      for (const recipient of to) {
        expect(issues.join("\n")).not.toContain(recipient);
      }
    }
  });

  it("rejects an over-cap to with control-byte recipients — error stays clean (CAU-88)", () => {
    const ESC = "\x1b";
    const CSI = "\x9b";
    // Over the cap AND every entry dirty: the count check fires first, so the
    // error must carry neither the recipient values nor any control byte.
    const to = Array.from(
      { length: MAX_RECIPIENTS + 5 },
      (_v, i) => `sess-${i}${ESC}${CSI}`,
    );
    try {
      validate({ ...validNote(), to });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const message = (err as MalformedMessageError).message;
      const issues = (err as MalformedMessageError).issues;
      expect(issues).toEqual([
        `to[] has more than ${MAX_RECIPIENTS} recipients (${MAX_RECIPIENTS + 5})`,
      ]);
      expect(message).not.toContain(ESC);
      expect(message).not.toContain(CSI);
      expect(message).not.toContain("sess-0");
    }
  });

  // CAU-90: `agent_id`, `owner`, `artifact` are identity/pointer fields, not
  // payloads — length-capped at MAX_FIELD_CHARS so an embedder (no wire body
  // cap) cannot inflate a read page via a giant identity string. Non-echoing.
  it.each(["agent_id", "owner", "artifact"])(
    "accepts %s at exactly MAX_FIELD_CHARS",
    (field) => {
      const atCap = "x".repeat(MAX_FIELD_CHARS);
      expect(() => validate({ ...validNote(), [field]: atCap })).not.toThrow();
    },
  );

  it.each(["agent_id", "owner", "artifact"])(
    "rejects an over-cap %s — positional, non-echoing (no value in the error)",
    (field) => {
      const over = "z".repeat(MAX_FIELD_CHARS + 1000);
      try {
        validate({ ...validNote(), [field]: over });
        expect.unreachable("validate should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MalformedMessageError);
        const issues = (err as MalformedMessageError).issues;
        expect(
          issues.some((i) =>
            i.includes(`${field} exceeds ${MAX_FIELD_CHARS} characters`),
          ),
        ).toBe(true);
        // The over-long value itself never appears in the error.
        for (const issue of issues) expect(issue).not.toContain(over);
        expect((err as MalformedMessageError).message).not.toContain(over);
      }
    },
  );

  it("rejects an invalid status", () => {
    expectIssue({ ...validNote(), status: "maybe" }, "status must be one of");
  });

  it("accepts a valid status", () => {
    expect(() =>
      validate({ ...validNote(), status: "resolved" }),
    ).not.toThrow();
  });

  it("rejects a non-string artifact", () => {
    expectIssue({ ...validNote(), artifact: 5 }, "artifact");
  });

  it("accepts a valid artifact", () => {
    expect(() =>
      validate({ ...validNote(), artifact: "https://x/y" }),
    ).not.toThrow();
  });

  it("rejects a non-string ts", () => {
    expectIssue({ ...validNote(), ts: 5 }, "ts must be a non-empty string");
  });

  it("accepts a valid ts (server-stamped)", () => {
    expect(() =>
      validate({ ...validNote(), ts: "2026-06-03T00:00:00Z" }),
    ).not.toThrow();
  });
});

describe("validate — claim rules", () => {
  it("rejects a claim with no target", () => {
    const m = validClaim();
    delete m.target;
    expectIssue(m, "claim requires a non-empty target");
  });

  it("rejects a claim with a whitespace-only target", () => {
    expectIssue({ ...validClaim(), target: "   " }, "claim requires a non-empty target");
  });

  it("rejects a claim with a non-string target", () => {
    expectIssue({ ...validClaim(), target: 5 }, "claim requires a non-empty target");
  });

  it("rejects a non-number lease_ttl on a claim", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: "30" },
      "lease_ttl must be a positive integer",
    );
  });

  it("rejects a NaN lease_ttl", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: Number.NaN },
      "lease_ttl must be a positive integer",
    );
  });

  it("rejects a negative lease_ttl", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: -1 },
      "lease_ttl must be a positive integer",
    );
  });

  it("rejects a zero lease_ttl", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: 0 },
      "lease_ttl must be a positive integer",
    );
  });

  it("rejects a fractional lease_ttl", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: 1.5 },
      "lease_ttl must be a positive integer",
    );
  });

  it("rejects an Infinity lease_ttl", () => {
    expectIssue(
      { ...validClaim(), lease_ttl: Number.POSITIVE_INFINITY },
      "lease_ttl must be a positive integer",
    );
  });

  it("accepts lease_ttl of 1", () => {
    expect(() =>
      validate({ ...validClaim(), lease_ttl: 1 }),
    ).not.toThrow();
  });

  it("accepts lease_ttl of 3600", () => {
    expect(() =>
      validate({ ...validClaim(), lease_ttl: 3600 }),
    ).not.toThrow();
  });

  it("accepts a claim with valid lease_ttl and heartbeat", () => {
    expect(() =>
      validate({ ...validClaim(), lease_ttl: 30, heartbeat: true }),
    ).not.toThrow();
  });

  it("rejects a non-boolean heartbeat on a claim", () => {
    expectIssue({ ...validClaim(), heartbeat: "yes" }, "heartbeat must be a boolean");
  });
});

// CAU-71: write-time rejection of control characters. Bytes are spelled with
// \x escapes so this source file stays plain printable ASCII.
describe("validate — control characters (CAU-71)", () => {
  const ESC = "\x1b"; // ANSI escape introducer
  const BEL = "\x07"; // bell / OSC string terminator
  const DEL = "\x7f"; // delete
  const CSI = "\x9b"; // a C1 control byte

  const BODY_ISSUE =
    "body must not contain control characters (tab and newline are allowed)";

  it.each([
    ["ANSI clear", `a${ESC}[2Jb`],
    ["BEL", `a${BEL}b`],
    ["DEL", `a${DEL}b`],
    ["C1 CSI", `a${CSI}b`],
    ["carriage return", "a\rb"],
  ])("rejects a body carrying %s", (_name, body) => {
    expectIssue({ ...validNote(), body }, BODY_ISSUE);
  });

  it("ACCEPTS a multi-line body (\\n) and tabs (\\t)", () => {
    expect(() =>
      validate({ ...validNote(), body: "step 1\nstep 2" }),
    ).not.toThrow();
    expect(() =>
      validate({ ...validNote(), body: "col1\tcol2" }),
    ).not.toThrow();
  });

  it.each([
    ["ESC", ESC],
    ["newline", "\n"],
    ["C1 CSI", CSI],
  ])("rejects owner and agent_id carrying %s (no whitespace exemption)", (_name, ch) => {
    expectIssue(
      { ...validNote(), owner: `alice${ch}` },
      "owner must not contain control characters",
    );
    expectIssue(
      { ...validNote(), agent_id: `sess${ch}` },
      "agent_id must not contain control characters",
    );
  });

  it("rejects a to array with one dirty entry — a SINGLE aggregate issue", () => {
    try {
      validate({ ...validNote(), to: ["ok", `bad${ESC}`] });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const issues = (err as MalformedMessageError).issues;
      expect(issues).toEqual(["to entries must not contain control characters"]);
    }
  });

  it("rejects a claim target carrying ESC; a clean claim is accepted", () => {
    expectIssue(
      { ...validClaim(), target: `repro${ESC}[2J` },
      "target must not contain control characters",
    );
    expect(() => validate(validClaim())).not.toThrow();
  });

  it("rejects an artifact carrying BEL", () => {
    expectIssue(
      { ...validNote(), artifact: `https://x/y${BEL}` },
      "artifact must not contain control characters",
    );
  });

  it("collects every dirty field's issue in ONE throw", () => {
    try {
      validate({
        ...validClaim(),
        agent_id: `sess${CSI}`,
        owner: `alice${ESC}`,
        body: `b${BEL}`,
        target: `t${DEL}`,
        to: [`x${ESC}`],
      });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const issues = (err as MalformedMessageError).issues;
      expect(issues).toContain("agent_id must not contain control characters");
      expect(issues).toContain("owner must not contain control characters");
      expect(issues).toContain(BODY_ISSUE);
      expect(issues).toContain("target must not contain control characters");
      expect(issues).toContain("to entries must not contain control characters");
    }
  });

  it("never echoes the offending bytes in the error (ADR-C12)", () => {
    try {
      validate({ ...validNote(), body: `secret${ESC}[2J${CSI}` });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(ESC);
      expect(message).not.toContain(CSI);
      expect(message).not.toContain("secret");
    }
  });

  it("accepts a clean kitchen-sink message (every optional field populated)", () => {
    expect(() =>
      validate({
        ...validNote(),
        body: "line 1\nline 2\tend — é ↗",
        thread: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reply_to: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        to: ["sess-B", "sess-C"],
        status: "resolved",
        artifact: "https://example.com/log",
        ts: "2026-06-09T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("a non-string body reports only the base issue (no double-report)", () => {
    try {
      validate({ ...validNote(), body: 42 });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      const issues = (err as MalformedMessageError).issues;
      expect(issues).toEqual(["body must be a non-empty string"]);
    }
  });
});

describe("schema errors share the SchemaError base class", () => {
  it("MalformedMessageError is a SchemaError (consumers branch on the base)", () => {
    try {
      validate({ ...validNote(), body: "" });
      expect.unreachable("validate should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      expect(err).toBeInstanceOf(SchemaError);
    }
  });

  it("UnsupportedVersionError is a SchemaError (consumers branch on the base)", () => {
    try {
      decode({ ...validNote(), v: 99 });
      expect.unreachable("decode should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedVersionError);
      expect(err).toBeInstanceOf(SchemaError);
    }
  });
});

describe("validate — claim-only fields on non-claim", () => {
  it("rejects target on a non-claim type", () => {
    expectIssue(
      { ...validNote(), target: "x" },
      "target is only valid on claim messages",
    );
  });

  it("rejects lease_ttl on a non-claim type", () => {
    expectIssue(
      { ...validNote(), lease_ttl: 30 },
      "lease_ttl is only valid on claim messages",
    );
  });

  it("rejects heartbeat on a non-claim type", () => {
    expectIssue(
      { ...validNote(), heartbeat: true },
      "heartbeat is only valid on claim messages",
    );
  });
});
