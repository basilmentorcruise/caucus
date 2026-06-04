/**
 * Unit tests for {@link parseEnvConfig} (CAU-5): PORT/HOST parsing, defaults,
 * and fail-fast on a malformed PORT.
 */
import { describe, expect, it } from "vitest";

import { parseEnvConfig } from "./config.js";
import { DEFAULT_PORT } from "./server.js";

describe("parseEnvConfig", () => {
  it("defaults to DEFAULT_PORT and no host when env is empty", () => {
    const cfg = parseEnvConfig({});
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.host).toBeUndefined();
  });

  it("reads a valid PORT", () => {
    expect(parseEnvConfig({ PORT: "8080" }).port).toBe(8080);
  });

  it("allows PORT 0 (ephemeral)", () => {
    expect(parseEnvConfig({ PORT: "0" }).port).toBe(0);
  });

  it("reads HOST", () => {
    expect(parseEnvConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("treats empty-string PORT/HOST as unset", () => {
    const cfg = parseEnvConfig({ PORT: "", HOST: "" });
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.host).toBeUndefined();
  });

  it("throws on a non-integer PORT", () => {
    expect(() => parseEnvConfig({ PORT: "abc" })).toThrow(/invalid PORT/);
  });

  it("throws on a fractional PORT", () => {
    expect(() => parseEnvConfig({ PORT: "12.5" })).toThrow(/invalid PORT/);
  });

  it("throws on an out-of-range PORT", () => {
    expect(() => parseEnvConfig({ PORT: "70000" })).toThrow(/invalid PORT/);
  });

  it("throws on a negative PORT", () => {
    expect(() => parseEnvConfig({ PORT: "-1" })).toThrow(/invalid PORT/);
  });

  it("warns when HOST is a non-loopback address", () => {
    const warnings: string[] = [];
    const cfg = parseEnvConfig({ HOST: "0.0.0.0" }, (m) => warnings.push(m));
    expect(cfg.host).toBe("0.0.0.0");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/non-loopback host 0\.0\.0\.0/);
    expect(warnings[0]).toMatch(/unauthenticated/);
  });

  it("does NOT warn for loopback hosts (127.0.0.1 / localhost / ::1, any case)", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "LOCALHOST"]) {
      const warnings: string[] = [];
      parseEnvConfig({ HOST: host }, (m) => warnings.push(m));
      expect(warnings, `host ${host} should not warn`).toHaveLength(0);
    }
  });

  it("does NOT warn when HOST is unset", () => {
    const warnings: string[] = [];
    parseEnvConfig({}, (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});
