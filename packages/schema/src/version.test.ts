import { describe, expect, it } from "vitest";
import { UnsupportedVersionError } from "./errors.js";
import { decode } from "./codec.js";
import { SCHEMA_VERSION } from "./version.js";

const baseFields = {
  type: "note" as const,
  agent_id: "sess-A",
  owner: "alice",
  msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  body: "hello",
};

describe("SCHEMA_VERSION", () => {
  it("is 0", () => {
    expect(SCHEMA_VERSION).toBe(0);
  });
});

describe("version gate (via decode)", () => {
  it("accepts v:0", () => {
    expect(() => decode({ ...baseFields, v: 0 })).not.toThrow();
  });

  it("rejects a future version v:1", () => {
    expect(() => decode({ ...baseFields, v: 1 })).toThrow(
      UnsupportedVersionError,
    );
  });

  it("rejects a negative version v:-1", () => {
    expect(() => decode({ ...baseFields, v: -1 })).toThrow(
      UnsupportedVersionError,
    );
  });

  it("rejects a string version v:'0' (wrong type)", () => {
    expect(() => decode({ ...baseFields, v: "0" })).toThrow(
      UnsupportedVersionError,
    );
  });

  it("rejects a non-integer version v:0.5", () => {
    expect(() => decode({ ...baseFields, v: 0.5 })).toThrow(
      UnsupportedVersionError,
    );
  });

  it("rejects a missing version", () => {
    expect(() => decode({ ...baseFields })).toThrow(UnsupportedVersionError);
  });

  it("rejects a non-object (no v carried)", () => {
    expect(() => decode(42)).toThrow(UnsupportedVersionError);
    expect(() => decode(null)).toThrow(UnsupportedVersionError);
  });

  it("carries received and supported on the error", () => {
    try {
      decode({ ...baseFields, v: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedVersionError);
      const e = err as UnsupportedVersionError;
      expect(e.code).toBe("unsupported_version");
      expect(e.received).toBe(1);
      expect(e.supported).toBe(0);
    }
  });

  it("runs the version gate BEFORE field validation", () => {
    // Wrong version AND a missing body: must report the version error, not
    // field issues.
    expect(() => decode({ type: "note", v: 1 })).toThrow(
      UnsupportedVersionError,
    );
  });
});
