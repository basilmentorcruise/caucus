/**
 * Control-plane audit trail for the issuer (CAU-128) — closes security NOTE-2
 * from the CAU-20 review.
 *
 * The issuer's mint/revoke/rotate control routes mutate the live token store but
 * previously left NO operator-side record, so a compromised `CAUCUS_ADMIN_TOKEN`
 * could mint a rogue identity SILENTLY. This module emits exactly ONE structured
 * line to **stderr** per control-plane op — success OR failure — so the mint of a
 * rogue identity is at least visible to anyone tailing the server's stderr.
 *
 * **Where it goes — stderr ONLY (never stdout, never the channel log).** The hook
 * reads the backbone over HTTP and the bin's stdout is the dial URL; the audit
 * line must NOT pollute either, and it must NOT post to the channel (ADR-C6 — a
 * control-plane op is not a war-room finding/claim). It is an OPERATOR signal,
 * written with {@link AUDIT_WRITE} to `process.stderr` only.
 *
 * **Secret hygiene (ADR-C12).** The record carries ONLY the SHA-256 **digest**
 * (truncated) of the minted/targeted token — exactly what the store already keys
 * on — never the plaintext minted token, never the admin credential, and never
 * any bytes that could reconstruct either. There is intentionally no field that
 * could hold raw secret material: the record's shape ({@link AdminAuditRecord})
 * is closed, and the emitter serializes only that shape.
 *
 * **Fail-closed interaction.** When the control surface is disabled (admin token
 * unset) the ops cannot happen, so no audit line is ever emitted — there is no
 * separate code path to disable here; the auditor is simply never reached.
 */
import { tokenDigest } from "./tokens.js";

/** The control-plane op a {@link AdminAuditRecord} describes. */
export type AdminAuditOp = "mint" | "revoke" | "rotate";

/**
 * The outcome of a control-plane op, recorded in the audit line:
 *  - `ok` — a mint/rotate succeeded (a token was issued).
 *  - `revoked` — a revoke removed ≥1 dynamic token.
 *  - `not_found` — a revoke matched nothing (unknown / seeded / already gone).
 *  - `unauthorized` — the request failed the admin gate (disabled surface, wrong
 *    or missing credential, or a non-loopback bind) and had NO side effect.
 *  - `invalid_request` — the admin gate passed but the body was malformed (no
 *    identity to mint, or no revoke target), so nothing was minted/revoked.
 */
export type AdminAuditResult =
  | "ok"
  | "revoked"
  | "not_found"
  | "unauthorized"
  | "invalid_request";

/** How many leading hex chars of the SHA-256 digest the audit line carries. */
export const AUDIT_DIGEST_PREFIX_LEN = 12;

/**
 * One structured control-plane audit record (CAU-128). Carries ONLY non-secret
 * fields — `op`, the affected identity (`agent_id`/`owner`, when known), the
 * truncated token **digest** (never the token), a wall-clock `ts`, and the
 * `result`. There is deliberately no field that could hold a raw token or the
 * admin credential (ADR-C12). Identity/digest fields are optional because a
 * failed (unauthorized / invalid) op may have no resolved identity or token.
 */
export interface AdminAuditRecord {
  /** The control-plane op. */
  readonly op: AdminAuditOp;
  /** The agent the op concerned, when known (a mint/rotate identity, or a revoke target). */
  readonly agent_id?: string;
  /** The human owner the op concerned, when known. */
  readonly owner?: string;
  /**
   * The truncated SHA-256 digest of the minted/targeted token (the store key),
   * when one exists. NEVER the plaintext token; NEVER the admin credential.
   */
  readonly digest?: string;
  /** ISO-8601 wall-clock timestamp the line was emitted. */
  readonly ts: string;
  /** The op's outcome (see {@link AdminAuditResult}). */
  readonly result: AdminAuditResult;
}

/**
 * What a call site supplies to {@link AdminAuditor}: the full
 * {@link AdminAuditRecord} EXCEPT `ts`, which the auditor stamps so a caller can
 * never forget it (and a test gets a deterministic clock seam).
 */
export type AdminAuditEvent = Omit<AdminAuditRecord, "ts">;

/**
 * Emit one control-plane audit event (the auditor stamps `ts`). Wired into the
 * admin routes (CAU-128); a no-op variant ({@link noopAuditor}) disables
 * auditing without branching the call sites. Total and synchronous — auditing
 * must never throw into or slow the request path.
 */
export type AdminAuditor = (event: AdminAuditEvent) => void;

/** Truncate a full SHA-256 hex digest to its audit-line prefix (non-secret key). */
export function digestPrefix(fullDigest: string): string {
  return fullDigest.slice(0, AUDIT_DIGEST_PREFIX_LEN);
}

/**
 * The truncated audit digest for a RAW token: hash it, then take the prefix.
 * Used for a minted/rotated token (we hold the plaintext exactly once). The
 * plaintext is never retained — only the prefix leaves this function.
 */
export function auditDigestOf(token: string): string {
  return digestPrefix(tokenDigest(token));
}

/** An auditor that drops every record — used when auditing is turned off. */
export const noopAuditor: AdminAuditor = () => {};

/**
 * Serialize a record to a single-line, secret-free JSON string (no trailing
 * newline). A stable `{ kind: "caucus.admin.audit", ... }` envelope marks the
 * line for an operator's log filter. Only the closed {@link AdminAuditRecord}
 * shape is serialized, so no raw secret can ride along. Undefined optional
 * fields are simply omitted by `JSON.stringify`.
 */
export function formatAuditLine(record: AdminAuditRecord): string {
  return JSON.stringify({
    kind: "caucus.admin.audit",
    op: record.op,
    agent_id: record.agent_id,
    owner: record.owner,
    digest: record.digest,
    ts: record.ts,
    result: record.result,
  });
}

/**
 * The sink the default auditor writes to — `process.stderr` (NEVER stdout, never
 * the channel log). Indirected as a constant so a test can capture the exact
 * bytes written and assert the line shape + secret-absence.
 */
export const AUDIT_WRITE = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * The default control-plane auditor: stamp `ts` now and write one JSON line to
 * stderr. `now`/`write` are injectable for tests (a deterministic clock, a
 * captured sink); they default to the real clock and {@link AUDIT_WRITE}.
 */
export function createStderrAuditor(
  write: (line: string) => void = AUDIT_WRITE,
  now: () => Date = () => new Date(),
): AdminAuditor {
  return (event) => {
    write(formatAuditLine({ ...event, ts: now().toISOString() }));
  };
}

/** Truthy env values that DISABLE the audit trail (default is ON). */
const AUDIT_OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Whether the control-plane audit trail is enabled for this `value` of the
 * `CAUCUS_ADMIN_AUDIT` env flag. Default-ON is the safe posture: only an
 * explicit, recognized off-value (`0`/`false`/`off`/`no`, case-insensitive)
 * disables it; anything else (including unset) leaves it ON.
 */
export function auditEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !AUDIT_OFF_VALUES.has(value.trim().toLowerCase());
}
