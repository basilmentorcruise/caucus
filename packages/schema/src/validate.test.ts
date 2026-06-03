import { describe, expect, it } from "vitest";
import { MalformedMessageError } from "./errors.js";
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
    expectIssue({ ...validNote(), to: "sess-B" }, "to must be an array");
  });

  it("rejects a to array with a non-string entry", () => {
    expectIssue({ ...validNote(), to: ["sess-B", 5] }, "to must be an array");
  });

  it("rejects a to array with an empty-string entry", () => {
    expectIssue({ ...validNote(), to: [""] }, "to must be an array");
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
    expectIssue({ ...validClaim(), lease_ttl: "30" }, "lease_ttl must be a number");
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
