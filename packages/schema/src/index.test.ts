import { describe, expect, it } from "vitest";
import * as schema from "./index.js";

/**
 * Smoke test for the public API surface: every documented export is present
 * and a minimal encode→decode round-trip works through the package entrypoint.
 */
describe("@caucus/schema public API", () => {
  it("re-exports the documented constants", () => {
    expect(schema.SCHEMA_VERSION).toBe(1);
    expect(schema.MESSAGE_TYPES).toContain("claim");
    expect(schema.STATUS_VALUES).toContain("resolved");
    expect(schema.INJECTED_DELTA_CAP_CHARS).toBe(8000);
  });

  it("re-exports the codec, helpers, and error classes", () => {
    expect(typeof schema.encode).toBe("function");
    expect(typeof schema.decode).toBe("function");
    expect(typeof schema.validate).toBe("function");
    expect(typeof schema.isUlid).toBe("function");
    expect(typeof schema.newMsgId).toBe("function");
    expect(typeof schema.normalizeTarget).toBe("function");
    expect(typeof schema.SchemaError).toBe("function");
    expect(typeof schema.UnsupportedVersionError).toBe("function");
    expect(typeof schema.MalformedMessageError).toBe("function");
  });

  it("round-trips a message through the entrypoint", () => {
    const round = schema.decode(
      schema.encode({
        type: "note",
        agent_id: "sess-A",
        owner: "alice",
        msg_id: schema.newMsgId(),
        body: "hello",
      }),
    );
    expect(round.v).toBe(1);
    expect(round.type).toBe("note");
  });
});
