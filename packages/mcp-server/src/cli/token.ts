/**
 * `caucus token` — the issuer admin CLI (CAU-129).
 *
 * A thin **ergonomics wrapper** over the existing CAU-20 loopback admin routes
 * (`POST /admin/tokens`, `/admin/tokens/revoke`, `/admin/tokens/rotate`). It
 * adds NO new server capability and NO new trust boundary: the boundary is still
 * the loopback bind + the `CAUCUS_ADMIN_TOKEN` credential the server already
 * checks. This file just turns a raw `curl` against loopback into typed
 * subcommands with secret-safe ergonomics.
 *
 * Subcommands:
 *  - `caucus token mint   --owner <o> --agent <a>`       → mints a new token
 *  - `caucus token revoke <digest>`                      → revokes one token
 *  - `caucus token rotate <digest> --owner <o> --agent <a>` → revoke-old + mint-new
 *
 * Invariants:
 *  - **Admin token from env ONLY** (`CAUCUS_ADMIN_TOKEN`) — NEVER a flag, never
 *    echoed (ADR-C12). A `--admin-token` flag is explicitly rejected.
 *  - **Backbone URL from env** (`CAUCUS_URL`, default {@link DEFAULT_URL}).
 *  - A minted/rotated token is printed **once** to stdout with a "copy now —
 *    not re-readable" warning, and it is written to NO log/history file (this
 *    CLI writes no files at all).
 *  - Errors are **value-free** (ADR-C12): they name the problem + the fix
 *    WITHOUT echoing any token bytes (admin token, minted token, or digest
 *    secrets). Each maps to a non-zero exit code.
 */
import { DEFAULT_URL } from "./init.js";

/** The env var the admin credential is read from — never a flag (ADR-C12). */
export const ADMIN_TOKEN_ENV = "CAUCUS_ADMIN_TOKEN";
/** The env var the backbone URL is read from (consistent with the rest of the CLI). */
export const URL_ENV = "CAUCUS_URL";

/** A minimal `fetch` shape — injected so the network path is unit-testable. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

/** Injected side-effecting dependencies (all stubbable in tests). */
export interface TokenDeps {
  readonly env: Record<string, string | undefined>;
  readonly log: (line: string) => void;
  readonly errlog: (line: string) => void;
  readonly fetch: FetchLike;
}

/** A parsed `mint` invocation. */
interface MintCommand {
  readonly kind: "mint";
  readonly owner: string;
  readonly agent: string;
}
/** A parsed `revoke` invocation. */
interface RevokeCommand {
  readonly kind: "revoke";
  readonly digest: string;
}
/** A parsed `rotate` invocation. */
interface RotateCommand {
  readonly kind: "rotate";
  readonly digest: string;
  readonly owner: string;
  readonly agent: string;
}
/** `--help` (or no subcommand) prints usage and exits 0. */
interface HelpCommand {
  readonly kind: "help";
}

export type TokenCommand =
  | MintCommand
  | RevokeCommand
  | RotateCommand
  | HelpCommand;

/** Result of parsing argv: a command or a usage error. */
export type TokenParseResult =
  | { readonly ok: true; readonly command: TokenCommand }
  | { readonly ok: false; readonly error: string };

export const USAGE = `caucus token — mint / revoke / rotate issuer bearer tokens (CAU-129)

USAGE
  caucus token mint   --owner <owner> --agent <agent-id>
  caucus token revoke <digest>
  caucus token rotate <digest> --owner <owner> --agent <agent-id>

A thin wrapper over the backbone's loopback admin routes (the same surface you
could hit with curl). No new capability, no new trust boundary.

ARGUMENTS
  <digest>             The token digest to revoke/rotate (printed by the server's
                       audit line). Use 'agent:<id>' to target every dynamic
                       token for an agent id instead of a single digest.

OPTIONS (mint / rotate)
  --owner <owner>      The human the minted token acts for      (required)
  --agent <agent-id>   The agent id the minted token anchors to (required)
  -h, --help           Show this help

ENVIRONMENT
  ${ADMIN_TOKEN_ENV}   REQUIRED. The admin credential gating the control surface.
                       Read from the environment ONLY — there is no --admin-token
                       flag, and the token is never printed.
  ${URL_ENV}           The backbone URL (default ${DEFAULT_URL}).

SECRETS
  A minted/rotated token is printed ONCE to stdout — copy it immediately, it is
  not re-readable. This CLI writes no log or history file. Never paste a token
  into a channel.`;

/** The `agent:` prefix selecting a by-agent_id target instead of a digest. */
const AGENT_PREFIX = "agent:";

/**
 * Parse argv already sliced past `node script token`. Pure — no env, no I/O.
 * Rejects a `--admin-token` flag explicitly (ADR-C12: the credential is env-only).
 */
export function parseArgs(argv: readonly string[]): TokenParseResult {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return { ok: true, command: { kind: "help" } };
  }
  if (sub !== "mint" && sub !== "revoke" && sub !== "rotate") {
    return { ok: false, error: `unknown command: token ${sub}` };
  }

  // A --admin-token flag is NEVER accepted — the credential is env-only.
  for (const arg of rest) {
    if (arg === "--admin-token" || arg.startsWith("--admin-token=")) {
      return {
        ok: false,
        error: `--admin-token is not accepted; set ${ADMIN_TOKEN_ENV} in the environment instead (the admin token is never passed as a flag).`,
      };
    }
  }

  // Collect positionals + --owner/--agent for mint/rotate; -h anywhere is help.
  const positionals: string[] = [];
  let owner: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") {
      return { ok: true, command: { kind: "help" } };
    }
    if (arg === "--owner") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) {
        return { ok: false, error: `--owner requires a value` };
      }
      owner = v;
      continue;
    }
    if (arg === "--agent") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) {
        return { ok: false, error: `--agent requires a value` };
      }
      agent = v;
      continue;
    }
    if (arg.startsWith("--")) {
      return { ok: false, error: `unknown option: ${arg}` };
    }
    positionals.push(arg);
  }

  if (sub === "mint") {
    if (positionals.length > 0) {
      return { ok: false, error: `mint takes no positional arguments (got "${positionals[0]!}")` };
    }
    const o = (owner ?? "").trim();
    const a = (agent ?? "").trim();
    if (o === "" || a === "") {
      return { ok: false, error: `mint requires --owner <owner> and --agent <agent-id>` };
    }
    return { ok: true, command: { kind: "mint", owner: o, agent: a } };
  }

  if (sub === "revoke") {
    if (owner !== undefined || agent !== undefined) {
      return { ok: false, error: `revoke takes no --owner/--agent — only a <digest> (or agent:<id>)` };
    }
    if (positionals.length !== 1) {
      return { ok: false, error: `revoke requires exactly one <digest> (or agent:<id>)` };
    }
    return { ok: true, command: { kind: "revoke", digest: positionals[0]! } };
  }

  // sub === "rotate"
  if (positionals.length !== 1) {
    return { ok: false, error: `rotate requires exactly one <digest> (or agent:<id>)` };
  }
  const o = (owner ?? "").trim();
  const a = (agent ?? "").trim();
  if (o === "" || a === "") {
    return {
      ok: false,
      error: `rotate requires <digest> plus --owner <owner> and --agent <agent-id> (the new token's identity)`,
    };
  }
  return { ok: true, command: { kind: "rotate", digest: positionals[0]!, owner: o, agent: a } };
}

/**
 * Build the revoke/rotate target body from a `<digest>` positional. A bare value
 * is a `{ digest }`; an `agent:<id>` value is a `{ agent_id }` (the by-agent
 * sweep, CAU-122). The value never appears in any error message (ADR-C12).
 */
function targetBody(value: string): { digest?: string; agent_id?: string } | undefined {
  if (value.startsWith(AGENT_PREFIX)) {
    const agentId = value.slice(AGENT_PREFIX.length).trim();
    if (agentId === "") return undefined;
    return { agent_id: agentId };
  }
  const digest = value.trim();
  if (digest === "") return undefined;
  return { digest };
}

/** Strip a trailing slash so `${base}/admin/...` never doubles up. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Classify a network/transport failure into a value-free, actionable message.
 * NEVER includes any token bytes — only the dial URL (which is not a secret) and
 * the underlying error's `code`/`message` (a DNS/refused/etc. string, never a
 * credential). A connection refused / non-loopback unreachable backbone is the
 * common operator mistake, so it gets a pointed hint.
 */
function networkErrorMessage(url: string, err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause: unknown }).cause
      : undefined;
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const effective = code ?? causeCode;
  if (effective === "ECONNREFUSED") {
    return `cannot reach the backbone at ${url}: connection refused. Is the backbone running, and is ${URL_ENV} pointing at its loopback address?`;
  }
  return `cannot reach the backbone at ${url}${
    effective === undefined ? "" : ` (${effective})`
  }. Check that the backbone is running and ${URL_ENV} is correct.`;
}

/**
 * Map a non-2xx admin response to a value-free message. A `401` from this
 * surface is deliberately ambiguous (no oracle): disabled control surface,
 * wrong admin token, or a non-loopback bind all look identical — so the message
 * names every fix without claiming which one applies, and echoes NO token bytes.
 */
function httpErrorMessage(status: number): string {
  if (status === 401) {
    return `the backbone rejected the admin credential (401). Either the control surface is disabled (the backbone was started without ${ADMIN_TOKEN_ENV}), the ${ADMIN_TOKEN_ENV} you exported does not match the backbone's, or the backbone is not bound to loopback. Fix one of those and retry.`;
  }
  if (status === 400) {
    return `the backbone rejected the request as invalid (400). Check the --owner/--agent (mint/rotate) or the <digest> (revoke/rotate) you passed.`;
  }
  if (status === 404) {
    return `the backbone returned 404 for the admin route. This build may not expose the issuer control surface (CAU-20).`;
  }
  return `the backbone returned an unexpected status ${status} for the admin request.`;
}

/** Parse a JSON response body, tolerating an empty body. */
function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Print a freshly-minted/rotated token ONCE with the not-re-readable warning. */
function printMintedToken(deps: TokenDeps, body: Record<string, unknown>): void {
  const token = body.token;
  const agentId = body.agent_id;
  const owner = body.owner;
  // The token is the ONLY secret here — print it to stdout exactly once.
  deps.log(String(token));
  deps.log("");
  deps.errlog(
    `Minted a token for agent_id="${String(agentId)}" owner="${String(owner)}".`,
  );
  deps.errlog(
    "Copy it now — it is shown ONCE and is NOT re-readable (the backbone keeps only its digest).",
  );
}

/**
 * Run `caucus token <sub> ...`. Returns the process exit code (0 ok, non-zero on
 * any failure). Never throws for an expected failure; only truly unexpected
 * conditions propagate to the bin shim's catch.
 */
export async function runToken(
  argv: readonly string[],
  deps: TokenDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.errlog(`error: ${parsed.error}`);
    deps.errlog("");
    deps.errlog("Run `caucus token --help` for usage.");
    return 1;
  }
  const command = parsed.command;
  if (command.kind === "help") {
    deps.log(USAGE);
    return 0;
  }

  // The admin credential is env-only (ADR-C12). Absent ⇒ a clean, value-free error.
  const adminToken = (deps.env[ADMIN_TOKEN_ENV] ?? "").trim();
  if (adminToken === "") {
    deps.errlog(
      `error: ${ADMIN_TOKEN_ENV} is not set. Export the backbone's admin credential into the environment, e.g. \`export ${ADMIN_TOKEN_ENV}=...\` (it is read from the environment only — never a flag).`,
    );
    return 1;
  }

  const base = normalizeBase((deps.env[URL_ENV] ?? "").trim() || DEFAULT_URL);

  // Build the route + body per subcommand.
  let route: string;
  let payload: Record<string, unknown>;
  if (command.kind === "mint") {
    route = `${base}/admin/tokens`;
    payload = { agent_id: command.agent, owner: command.owner };
  } else if (command.kind === "revoke") {
    const target = targetBody(command.digest);
    if (target === undefined) {
      deps.errlog(`error: revoke requires a non-empty <digest> (or agent:<id>).`);
      return 1;
    }
    route = `${base}/admin/tokens/revoke`;
    payload = target;
  } else {
    const target = targetBody(command.digest);
    if (target === undefined) {
      deps.errlog(`error: rotate requires a non-empty <digest> (or agent:<id>).`);
      return 1;
    }
    route = `${base}/admin/tokens/rotate`;
    payload = { ...target, agent_id: command.agent, owner: command.owner };
  }

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await deps.fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The admin token rides ONLY in the Authorization header — never logged,
        // never echoed into stdout/stderr (ADR-C12).
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    deps.errlog(`error: ${networkErrorMessage(base, err)}`);
    return 1;
  }

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    deps.errlog(`error: ${httpErrorMessage(res.status)}`);
    return 1;
  }

  const body = parseJson(text);
  if (command.kind === "mint" || command.kind === "rotate") {
    if (typeof body.token !== "string" || body.token === "") {
      deps.errlog(
        `error: the backbone returned ${res.status} but no token. The control surface may be misconfigured.`,
      );
      return 1;
    }
    printMintedToken(deps, body);
    return 0;
  }

  // revoke → bare { revoked: bool }. Report either outcome (a false is a clean
  // no-op miss, not an error — same shape as the server, no enumeration oracle).
  const revoked = body.revoked === true;
  deps.errlog(
    revoked
      ? "Revoked. A subsequent write with that token will be rejected."
      : "No matching dynamic token to revoke (it may have been a seed token, already revoked, or never minted).",
  );
  return 0;
}
