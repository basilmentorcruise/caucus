/**
 * Unit tests for the centralized error mapping (CAU-5): every BackboneError code
 * maps to the right status with a non-leaking body, `invalid_message` carries
 * its issues, unknown codes / non-BackboneError throws map to a generic 500, and
 * the client-side reconstruction registry round-trips codes back to the REAL
 * subclasses.
 */
import {
  BackboneError,
  ChannelExistsError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  UnknownChannelError,
} from "@caucus/backbone";
import { describe, expect, it } from "vitest";

import { backboneErrorFromWire, mapError } from "./wire-errors.js";

describe("mapError — status mapping", () => {
  it("invalid_channel_name → 400", () => {
    const m = mapError(new InvalidChannelNameError("BAD NAME"));
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe("invalid_channel_name");
  });

  it("invalid_cursor → 400", () => {
    const m = mapError(new InvalidCursorError("cursor out of range", 99));
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe("invalid_cursor");
  });

  it("unknown_channel → 404", () => {
    const m = mapError(new UnknownChannelError("ghost"));
    expect(m.status).toBe(404);
    expect(m.body.error.code).toBe("unknown_channel");
  });

  it("channel_exists → 409", () => {
    const m = mapError(new ChannelExistsError("c1"));
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("channel_exists");
  });

  it("invalid_message → 400 and passes issues through", () => {
    const m = mapError(new InvalidMessageError(["msg_id is not a ULID", "body too long"]));
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe("invalid_message");
    expect(m.body.error.issues).toEqual(["msg_id is not a ULID", "body too long"]);
  });

  it("unknown BackboneError code → 500 generic, no leak", () => {
    const m = mapError(new BackboneError("secret internal detail", "weird_code"));
    expect(m.status).toBe(500);
    expect(m.body.error.code).toBe("internal_error");
    expect(m.body.error.message).not.toContain("secret internal detail");
    expect(m.body.error.issues).toBeUndefined();
  });

  it("non-BackboneError throw → 500 generic, no leak of message/stack", () => {
    const m = mapError(new TypeError("cannot read property foo of undefined"));
    expect(m.status).toBe(500);
    expect(m.body.error.code).toBe("internal_error");
    expect(m.body.error.message).not.toContain("foo");
  });

  it("non-Error throw (string) → 500 generic", () => {
    const m = mapError("boom");
    expect(m.status).toBe(500);
    expect(m.body.error.code).toBe("internal_error");
  });
});

describe("backboneErrorFromWire — reconstruction registry", () => {
  it("reconstructs UnknownChannelError (instanceof + code)", () => {
    const err = backboneErrorFromWire({
      error: { code: "unknown_channel", message: 'Unknown channel: "ghost"' },
    });
    expect(err).toBeInstanceOf(UnknownChannelError);
    expect(err.code).toBe("unknown_channel");
    expect((err as UnknownChannelError).channel).toBe("ghost");
  });

  it("reconstructs InvalidChannelNameError and recovers the channel name", () => {
    const err = backboneErrorFromWire({
      error: {
        code: "invalid_channel_name",
        message: 'Invalid channel name: "BAD NAME" (must match ...)',
      },
    });
    expect(err).toBeInstanceOf(InvalidChannelNameError);
    expect((err as InvalidChannelNameError).channel).toBe("BAD NAME");
  });

  it("reconstructs ChannelExistsError", () => {
    const err = backboneErrorFromWire({
      error: { code: "channel_exists", message: 'Channel already exists: "c1"' },
    });
    expect(err).toBeInstanceOf(ChannelExistsError);
  });

  it("reconstructs InvalidCursorError", () => {
    const err = backboneErrorFromWire({
      error: { code: "invalid_cursor", message: "cursor must be an integer in [0, 3]" },
    });
    expect(err).toBeInstanceOf(InvalidCursorError);
    expect(err.code).toBe("invalid_cursor");
  });

  it("reconstructs InvalidMessageError with its issues", () => {
    const err = backboneErrorFromWire({
      error: { code: "invalid_message", message: "bad", issues: ["i1", "i2"] },
    });
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).issues).toEqual(["i1", "i2"]);
  });

  it("invalid_message without issues falls back to the message", () => {
    const err = backboneErrorFromWire({
      error: { code: "invalid_message", message: "single problem" },
    });
    expect((err as InvalidMessageError).issues).toEqual(["single problem"]);
  });

  it("unrecognized code → generic BackboneError preserving the code", () => {
    const err = backboneErrorFromWire({
      error: { code: "future_code", message: "from a newer server" },
    });
    expect(err).toBeInstanceOf(BackboneError);
    expect(err.code).toBe("future_code");
    expect(err.message).toBe("from a newer server");
  });

  it("channel recovery falls back to the whole message when unquoted", () => {
    const err = backboneErrorFromWire({
      error: { code: "unknown_channel", message: "no quotes here" },
    });
    expect((err as UnknownChannelError).channel).toBe("no quotes here");
  });
});
