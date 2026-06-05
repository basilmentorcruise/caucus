import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseToken } from "./config.js";

describe("parseToken", () => {
  it("splits a valid token into agent_id and owner", () => {
    expect(parseToken("agent-1:alice")).toEqual({
      agent_id: "agent-1",
      owner: "alice",
    });
  });

  it("splits on the FIRST colon so the owner may contain colons", () => {
    expect(parseToken("a:b:c")).toEqual({ agent_id: "a", owner: "b:c" });
  });

  it("trims whitespace around both halves", () => {
    expect(parseToken("  agent-1  :  alice  ")).toEqual({
      agent_id: "agent-1",
      owner: "alice",
    });
  });

  it("rejects a token with no colon", () => {
    expect(() => parseToken("agent-1")).toThrow(ConfigError);
  });

  it("rejects a blank agent_id half", () => {
    expect(() => parseToken("   :alice")).toThrow(ConfigError);
  });

  it("rejects a blank owner half", () => {
    expect(() => parseToken("agent-1:   ")).toThrow(ConfigError);
  });

  it("attaches the stable config_error code", () => {
    try {
      parseToken("nope");
      expect.unreachable("parseToken should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("config_error");
    }
  });
});

describe("loadConfig", () => {
  it("builds a config from a valid environment", () => {
    expect(
      loadConfig({ CAUCUS_TOKEN: "agent-1:alice", CAUCUS_CHANNEL: "incident-1" }),
    ).toEqual({
      identity: { agent_id: "agent-1", owner: "alice" },
      channel: "incident-1",
    });
  });

  it("trims the channel name", () => {
    expect(
      loadConfig({ CAUCUS_TOKEN: "a:b", CAUCUS_CHANNEL: "  room  " }).channel,
    ).toBe("room");
  });

  it("throws when the token is missing", () => {
    expect(() => loadConfig({ CAUCUS_CHANNEL: "room" })).toThrow(ConfigError);
  });

  it("throws when the token is blank", () => {
    expect(() =>
      loadConfig({ CAUCUS_TOKEN: "   ", CAUCUS_CHANNEL: "room" }),
    ).toThrow(ConfigError);
  });

  it("throws when the channel is missing", () => {
    expect(() => loadConfig({ CAUCUS_TOKEN: "a:b" })).toThrow(ConfigError);
  });

  it("throws when the channel is blank", () => {
    expect(() =>
      loadConfig({ CAUCUS_TOKEN: "a:b", CAUCUS_CHANNEL: "   " }),
    ).toThrow(ConfigError);
  });

  // CAU-50: token handling on the shared HTTP backbone (CAUCUS_URL set).
  it("rejects a colon-free token in OFFLINE mode (CAUCUS_URL unset)", () => {
    // Offline, the local identity is authoritative ⇒ the structured form is
    // still required.
    expect(() =>
      loadConfig({ CAUCUS_TOKEN: "tok-alice", CAUCUS_CHANNEL: "room" }),
    ).toThrow(ConfigError);
  });

  it("accepts an OPAQUE colon-free token when CAUCUS_URL is set, with a cosmetic identity", () => {
    // On the shared backbone the bearer is an opaque secret; the server anchors
    // the real identity, so local display is a token-free placeholder.
    expect(
      loadConfig({
        CAUCUS_TOKEN: "tok-alice-secret",
        CAUCUS_CHANNEL: "room",
        CAUCUS_URL: "http://127.0.0.1:4317",
      }),
    ).toEqual({
      identity: { agent_id: "session", owner: "(anchored server-side)" },
      channel: "room",
    });
  });

  it("the placeholder identity NEVER contains the opaque token (ADR-C12)", () => {
    const secret = "tok-super-secret-value";
    const cfg = loadConfig({
      CAUCUS_TOKEN: secret,
      CAUCUS_CHANNEL: "room",
      CAUCUS_URL: "http://127.0.0.1:4317",
    });
    expect(cfg.identity.agent_id).not.toContain(secret);
    expect(cfg.identity.owner).not.toContain(secret);
  });

  it("still parses a colon-form token for nicer display even on the shared backbone", () => {
    expect(
      loadConfig({
        CAUCUS_TOKEN: "agent-1:alice",
        CAUCUS_CHANNEL: "room",
        CAUCUS_URL: "http://127.0.0.1:4317",
      }).identity,
    ).toEqual({ agent_id: "agent-1", owner: "alice" });
  });

  it("a MISSING token is still fatal when CAUCUS_URL is set", () => {
    expect(() =>
      loadConfig({ CAUCUS_CHANNEL: "room", CAUCUS_URL: "http://127.0.0.1:4317" }),
    ).toThrow(ConfigError);
  });

  it("an all-whitespace CAUCUS_URL is treated as OFFLINE (colon required)", () => {
    expect(() =>
      loadConfig({ CAUCUS_TOKEN: "tok-alice", CAUCUS_CHANNEL: "room", CAUCUS_URL: "   " }),
    ).toThrow(ConfigError);
  });
});
