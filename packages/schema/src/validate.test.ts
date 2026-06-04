import { describe, expect, it } from "vitest";
import { decode } from "./codec.js";
import {
  MalformedMessageError,
  SchemaError,
  UnsupportedVersionError,
} from "./errors.js";
import { MAX_REPORTED_ISSUES } from "./constants.js";
import { validate } from "./validate.js";

/** A minimal valid v0 message (already version-stamped). */
function validNote(): Record<string, unknown> {
  return {
    v: 0,
    type: "note",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    body: "hello",
  };
}

function validClaim(): Record<string, unknown> {
  return {
    v: 0,
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
    expectIssue({ ...validNote(), v: 5 }, "v must be 0");
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
      decode({ ...validNote(), v: 1 });
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
