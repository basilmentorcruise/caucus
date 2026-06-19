import { describe, expect, it } from "vitest";
import type { AppendedMessage } from "@caucus/backbone";
import { sanitizeMessageFields, SCHEMA_VERSION } from "@caucus/schema";

import {
  formatMessageFrame,
  HEARTBEAT_FRAME,
  matchStreamRoute,
  MAX_CONCURRENT_STREAMS,
  parseSince,
  SINCE_INVALID,
  sinceParam,
  STREAM_HEARTBEAT_INTERVAL_MS,
  STREAM_POLL_INTERVAL_MS,
} from "./stream.js";

const C1 = "\x9b"; // C1 CSI — survives JSON.stringify verbatim
const ESC = "\x1b";
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

function appended(overrides: Partial<AppendedMessage> = {}): AppendedMessage {
  return {
    v: SCHEMA_VERSION,
    type: "note",
    agent_id: "alice-agent",
    owner: "alice",
    msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    body: "hello",
    ts: "0000000000000",
    ...overrides,
  } as AppendedMessage;
}

describe("matchStreamRoute", () => {
  it("matches /channels/:channel/stream", () => {
    expect(matchStreamRoute(["channels", "incident-1", "stream"])).toEqual({
      channel: "incident-1",
    });
  });

  it("returns undefined for other shapes", () => {
    expect(matchStreamRoute(["channels", "incident-1"])).toBeUndefined();
    expect(matchStreamRoute(["channels", "incident-1", "append"])).toBeUndefined();
    expect(matchStreamRoute(["channels"])).toBeUndefined();
    expect(
      matchStreamRoute(["channels", "incident-1", "stream", "extra"]),
    ).toBeUndefined();
  });
});

describe("parseSince", () => {
  it("returns undefined when absent", () => {
    expect(parseSince(null)).toBeUndefined();
  });

  it("parses a non-negative integer", () => {
    expect(parseSince("0")).toBe(0);
    expect(parseSince("42")).toBe(42);
  });

  it("rejects malformed/out-of-shape values as SINCE_INVALID", () => {
    expect(parseSince("")).toBe(SINCE_INVALID);
    expect(parseSince("-1")).toBe(SINCE_INVALID);
    expect(parseSince("1.5")).toBe(SINCE_INVALID);
    expect(parseSince("abc")).toBe(SINCE_INVALID);
    expect(parseSince("0x10")).toBe(SINCE_INVALID);
    expect(parseSince(" 3 ")).toBe(SINCE_INVALID);
    expect(parseSince("99999999999999999999")).toBe(SINCE_INVALID); // > MAX_SAFE_INTEGER
  });
});

describe("sinceParam", () => {
  it("extracts the since query value", () => {
    expect(sinceParam("/channels/x/stream?since=3")).toBe("3");
    expect(sinceParam("/channels/x/stream?foo=1&since=7")).toBe("7");
  });

  it("returns null when there is no since", () => {
    expect(sinceParam("/channels/x/stream")).toBeNull();
    expect(sinceParam("/channels/x/stream?foo=1")).toBeNull();
  });
});

describe("formatMessageFrame", () => {
  it("wraps the sanitized JSON as a single SSE data: frame", () => {
    const msg = appended();
    const frame = formatMessageFrame(msg);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const payload = frame.slice("data: ".length, -2);
    expect(JSON.parse(payload)).toEqual(msg);
  });

  it("payload is byte-identical to the shared read-path sanitizer output (ADR-C15)", () => {
    const dirty = appended({
      body: `dan${ESC}[2Jger`,
      owner: `ali${C1}ce`,
    });
    const frame = formatMessageFrame(dirty);
    const payload = frame.slice("data: ".length, -2);
    // The read path (caucus_read_channel) serializes sanitizeMessageFields(m);
    // the stream frame MUST match it byte-for-byte.
    expect(payload).toBe(JSON.stringify(sanitizeMessageFields(dirty)));
  });

  it("strips C0/C1/DEL out of the delivered frame", () => {
    const frame = formatMessageFrame(
      appended({ body: `x${ESC}y${C1}z`, owner: `a${C1}b` }),
    );
    // The framing newlines are the only control bytes; the payload is clean.
    const payload = frame.slice("data: ".length, -2);
    expect(payload).not.toMatch(CONTROL_CHARS);
  });
});

describe("bounds constants", () => {
  it("exposes the tunable cap and cadences (ADR-C15)", () => {
    expect(MAX_CONCURRENT_STREAMS).toBe(32);
    expect(STREAM_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(STREAM_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(HEARTBEAT_FRAME).toBe(": keep-alive\n\n");
  });
});
