/**
 * Unit tests for the control-plane audit module (CAU-128) — the pure record
 * formatter, the digest truncation, the env on/off flag, and the stderr auditor
 * shape. The dispatch-level "one line per op, secret-free" behavior is covered in
 * `server.test.ts`; here we pin the building blocks in isolation.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIT_DIGEST_PREFIX_LEN,
  auditDigestOf,
  auditEnabled,
  createStderrAuditor,
  digestPrefix,
  formatAuditLine,
  noopAuditor,
  type AdminAuditRecord,
} from "./audit.js";
import { tokenDigest } from "./tokens.js";

describe("digest truncation (ADR-C12 — never the token)", () => {
  it("auditDigestOf is a strict, short prefix of the full SHA-256 digest", () => {
    const token = "tok_secret-bytes-abc";
    const prefix = auditDigestOf(token);
    expect(prefix).toBe(tokenDigest(token).slice(0, AUDIT_DIGEST_PREFIX_LEN));
    expect(prefix.length).toBe(AUDIT_DIGEST_PREFIX_LEN);
    // The prefix is hex only — it can never contain raw token bytes.
    expect(/^[0-9a-f]+$/.test(prefix)).toBe(true);
    // The token bytes themselves are absent from the prefix.
    expect(prefix.includes("secret-bytes")).toBe(false);
  });

  it("digestPrefix truncates an already-computed digest", () => {
    const full = tokenDigest("anything");
    expect(digestPrefix(full)).toBe(full.slice(0, AUDIT_DIGEST_PREFIX_LEN));
  });
});

describe("formatAuditLine — single-line, secret-free JSON", () => {
  const record: AdminAuditRecord = {
    op: "mint",
    agent_id: "x",
    owner: "xavier",
    digest: "0123456789ab",
    ts: "2026-06-20T00:00:00.000Z",
    result: "ok",
  };

  it("serializes exactly the closed record shape, on one line", () => {
    const line = formatAuditLine(record);
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      kind: "caucus.admin.audit",
      op: "mint",
      agent_id: "x",
      owner: "xavier",
      digest: "0123456789ab",
      ts: "2026-06-20T00:00:00.000Z",
      result: "ok",
    });
  });

  it("omits undefined optional fields (no agent_id/owner/digest keys)", () => {
    const line = formatAuditLine({ op: "revoke", ts: "t", result: "not_found" });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      kind: "caucus.admin.audit",
      op: "revoke",
      ts: "t",
      result: "not_found",
    });
    expect("agent_id" in parsed).toBe(false);
    expect("digest" in parsed).toBe(false);
  });
});

describe("createStderrAuditor", () => {
  it("stamps ts from the injected clock and writes ONE line to the sink", () => {
    const lines: string[] = [];
    const auditor = createStderrAuditor(
      (line) => lines.push(line),
      () => new Date("2026-01-02T03:04:05.000Z"),
    );
    auditor({ op: "mint", agent_id: "a", owner: "o", digest: "abc", result: "ok" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.ts).toBe("2026-01-02T03:04:05.000Z");
    expect(parsed.op).toBe("mint");
    expect(parsed.result).toBe("ok");
  });

  it("produces an ISO-8601 ts with the default (real) clock", () => {
    const lines: string[] = [];
    const auditor = createStderrAuditor((line) => lines.push(line));
    auditor({ op: "revoke", agent_id: "a", result: "revoked" });
    const parsed = JSON.parse(lines[0]!) as { ts: string };
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });
});

describe("noopAuditor", () => {
  it("drops the event (no throw, no output)", () => {
    expect(() => noopAuditor({ op: "mint", result: "ok" })).not.toThrow();
  });
});

describe("auditEnabled — default ON, explicit off-values only", () => {
  it("is ON when unset (default-on safe posture)", () => {
    expect(auditEnabled(undefined)).toBe(true);
  });

  it.each(["0", "false", "off", "no", "OFF", " False ", "No"])(
    "is OFF for the explicit off-value %j (case/space-insensitive)",
    (value) => {
      expect(auditEnabled(value)).toBe(false);
    },
  );

  it.each(["1", "true", "on", "yes", "", "anything"])(
    "stays ON for the non-off value %j",
    (value) => {
      expect(auditEnabled(value)).toBe(true);
    },
  );
});
