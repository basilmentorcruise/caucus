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
  ChannelFullError,
  ChannelLimitError,
  DuplicatePostError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  RateLimitedError,
  UnknownChannelError,
} from "@caucus/backbone";
import { describe, expect, it } from "vitest";

import { backboneErrorFromWire, mapError, UnauthorizedError } from "./wire-errors.js";

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

  it("rate_limited → 429 with its actionable message (no body leak)", () => {
    const m = mapError(new RateLimitedError(30, 12_000));
    expect(m.status).toBe(429);
    expect(m.body.error.code).toBe("rate_limited");
    expect(m.body.error.message).toContain("at most 30 posts/min");
    expect(m.body.error.message).toContain("Wait ~12s");
  });

  it("channel_full → 409 (capacity is a state conflict, not pacing) (CAU-74)", () => {
    const m = mapError(new ChannelFullError("incident-1", 10_000));
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("channel_full");
    expect(m.body.error.message).toContain('"incident-1"');
    expect(m.body.error.message).toContain("at most 10000 messages");
  });

  it("channel_limit → 409 (CAU-74)", () => {
    const m = mapError(new ChannelLimitError(1_000));
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("channel_limit");
    expect(m.body.error.message).toContain("at most 1000 channels");
  });

  it("rate_limited (global + create scopes) → 429 (CAU-74)", () => {
    const global = mapError(new RateLimitedError(120, 5_000, "global"));
    expect(global.status).toBe(429);
    expect(global.body.error.message).toContain("across all channels");
    const create = mapError(new RateLimitedError(10, 5_000, "create"));
    expect(create.status).toBe(429);
    expect(create.body.error.message).toContain("channel creates/min per owner");
  });

  it("duplicate_post → 409 with its value-free message", () => {
    const m = mapError(new DuplicatePostError());
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("duplicate_post");
    expect(m.body.error.message).toContain("Duplicate of your previous post");
  });

  it("unauthorized → 401 with the fixed, value-free message (CAU-13)", () => {
    const m = mapError(new UnauthorizedError());
    expect(m.status).toBe(401);
    expect(m.body.error.code).toBe("unauthorized");
    expect(m.body.error.message).toBe("missing or invalid token");
    expect(m.body.error.issues).toBeUndefined();
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

  it("round-trips RateLimitedError (instanceof + code + message-faithful)", () => {
    const original = new RateLimitedError(30, 12_000);
    const wire = mapError(original).body;
    const err = backboneErrorFromWire(wire);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.code).toBe("rate_limited");
    // The message rounds retryAfterMs to whole seconds, so it round-trips exactly.
    expect(err.message).toBe(original.message);
    expect((err as RateLimitedError).limit).toBe(30);
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000);
  });

  it("round-trips RateLimitedError for ALL THREE scopes (regex regression, CAU-74)", () => {
    // The create-scope message says "channel creates/min", not "posts/min" — a
    // posts-only limit regex would silently reconstruct (limit 0, 0ms).
    for (const scope of ["channel", "global", "create"] as const) {
      const original = new RateLimitedError(7, 13_000, scope);
      const wire = mapError(original).body;
      const err = backboneErrorFromWire(wire) as RateLimitedError;
      expect(err).toBeInstanceOf(RateLimitedError);
      expect(err.limit).toBe(7);
      expect(err.retryAfterMs).toBe(13_000);
      expect(err.scope).toBe(scope);
      expect(err.message).toBe(original.message);
    }
  });

  it("round-trips ChannelFullError (instanceof + code + channel + limit) (CAU-74)", () => {
    const original = new ChannelFullError("incident-1", 3);
    const wire = mapError(original).body;
    const err = backboneErrorFromWire(wire) as ChannelFullError;
    expect(err).toBeInstanceOf(ChannelFullError);
    expect(err.code).toBe("channel_full");
    expect(err.channel).toBe("incident-1");
    expect(err.limit).toBe(3);
    expect(err.message).toBe(original.message);
  });

  it("round-trips ChannelLimitError (instanceof + code + limit) (CAU-74)", () => {
    const original = new ChannelLimitError(2);
    const wire = mapError(original).body;
    const err = backboneErrorFromWire(wire) as ChannelLimitError;
    expect(err).toBeInstanceOf(ChannelLimitError);
    expect(err.code).toBe("channel_limit");
    expect(err.limit).toBe(2);
    expect(err.message).toBe(original.message);
  });

  it("capacity errors fall back to limit 0 on an unparseable message (best-effort)", () => {
    const full = backboneErrorFromWire({
      error: { code: "channel_full", message: "mystery" },
    }) as ChannelFullError;
    expect(full).toBeInstanceOf(ChannelFullError);
    expect(full.limit).toBe(0);
    const limit = backboneErrorFromWire({
      error: { code: "channel_limit", message: "mystery" },
    }) as ChannelLimitError;
    expect(limit).toBeInstanceOf(ChannelLimitError);
    expect(limit.limit).toBe(0);
  });

  it("round-trips DuplicatePostError (instanceof + code + exact message)", () => {
    const original = new DuplicatePostError();
    const wire = mapError(original).body;
    const err = backboneErrorFromWire(wire);
    expect(err).toBeInstanceOf(DuplicatePostError);
    expect(err.code).toBe("duplicate_post");
    expect(err.message).toBe(original.message);
  });

  it("round-trips UnauthorizedError (instanceof + code + fixed message) (CAU-13)", () => {
    const original = new UnauthorizedError();
    const wire = mapError(original).body;
    const err = backboneErrorFromWire(wire);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("missing or invalid token");
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
