/**
 * Unit tests for {@link parseEnvConfig} (CAU-5): PORT/HOST parsing, defaults,
 * and fail-fast on a malformed PORT.
 */
import { describe, expect, it } from "vitest";

import { noopAuditor } from "./audit.js";
import { parseEnvConfig } from "./config.js";
import { DEFAULT_PORT } from "./server.js";
import { tokenDigest } from "./tokens.js";

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

  // CAU-20: the admin credential gating the issuer control surface.
  it("parses and DIGESTS CAUCUS_ADMIN_TOKEN (never the plaintext)", () => {
    const cfg = parseEnvConfig({ CAUCUS_ADMIN_TOKEN: "super-secret-admin" });
    expect(cfg.adminTokenDigest).toBe(tokenDigest("super-secret-admin"));
    // The plaintext never appears in the parsed config.
    expect(JSON.stringify(cfg)).not.toContain("super-secret-admin");
  });

  it("leaves adminTokenDigest undefined when CAUCUS_ADMIN_TOKEN is absent (control disabled)", () => {
    expect(parseEnvConfig({}).adminTokenDigest).toBeUndefined();
  });

  it("treats an empty-string CAUCUS_ADMIN_TOKEN as unset (control disabled)", () => {
    expect(parseEnvConfig({ CAUCUS_ADMIN_TOKEN: "" }).adminTokenDigest).toBeUndefined();
  });

  it("never names the admin secret in a thrown PORT error (ADR-C12)", () => {
    // A bad PORT throws; the admin secret must not ride along in the message.
    try {
      parseEnvConfig({ PORT: "nope", CAUCUS_ADMIN_TOKEN: "leak-me-admin" });
      throw new Error("expected parseEnvConfig to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("leak-me-admin");
    }
  });

  // CAU-128: the control-plane audit trail flag (default ON).
  it("leaves audit undefined by default (server installs its stderr auditor)", () => {
    expect(parseEnvConfig({}).audit).toBeUndefined();
    expect(parseEnvConfig({ CAUCUS_ADMIN_AUDIT: "1" }).audit).toBeUndefined();
  });

  it("installs the no-op auditor when CAUCUS_ADMIN_AUDIT disables it", () => {
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      expect(parseEnvConfig({ CAUCUS_ADMIN_AUDIT: off }).audit).toBe(noopAuditor);
    }
  });

  it("disabling the audit is a clean no-op even with no admin token configured", () => {
    const cfg = parseEnvConfig({ CAUCUS_ADMIN_AUDIT: "off" });
    expect(cfg.audit).toBe(noopAuditor);
    expect(cfg.adminTokenDigest).toBeUndefined();
  });
});
