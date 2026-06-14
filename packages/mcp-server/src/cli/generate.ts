/**
 * Pure generators for the `caucus init` scaffold (CAU-108).
 *
 * Each function returns a plain JS object (or string) for one artifact; nothing
 * here touches the filesystem, so the generation logic — most importantly the
 * ADR-C12 invariant that the token is ALWAYS an `${ENV}` reference and NEVER a
 * literal secret — is unit-testable in isolation.
 *
 * Artifacts:
 *  - `.mcp.json`        — the Caucus MCP server entry Claude Code spawns.
 *  - `.claude/settings.local.json` — the `UserPromptSubmit` (turn-start) hook.
 *  - `caucus.env`       — a sourceable env file (the hook inherits the SHELL
 *    env, not `.mcp.json`'s env block), with the token left empty + a
 *    never-commit notice.
 */

/** The resolved values the generators stamp into the artifacts. */
export interface ScaffoldValues {
  /** Backbone base URL (literal). */
  readonly url: string;
  /** Channel to join (literal, validated upstream). */
  readonly channel: string;
  /** Absolute path to the MCP-server bin. */
  readonly mcpServerBin: string;
  /** Absolute path to the hook bin. */
  readonly hookBin: string;
  /** The env-var NAME the token is referenced by (NOT a value). Default `CAUCUS_TOKEN`. */
  readonly tokenEnv: string;
}

/** Shape of the `.mcp.json` `mcpServers.caucus` entry we own. */
export interface CaucusMcpEntry {
  readonly command: "node";
  readonly args: readonly [string];
  readonly env: {
    readonly CAUCUS_URL: string;
    readonly CAUCUS_CHANNEL: string;
    readonly CAUCUS_TOKEN: string;
  };
}

/** A minimal `.mcp.json` carrying ONLY the caucus server entry. */
export interface McpJson {
  readonly mcpServers: { readonly caucus: CaucusMcpEntry };
}

/** One `hooks.UserPromptSubmit` matcher block. */
export interface HookMatcher {
  readonly matcher: string;
  readonly hooks: readonly [{ readonly type: "command"; readonly command: string }];
}

/** A minimal `.claude/settings.local.json` carrying the caucus hook + mcp enablement. */
export interface SettingsJson {
  readonly enabledMcpjsonServers: readonly string[];
  readonly hooks: { readonly UserPromptSubmit: readonly HookMatcher[] };
}

/**
 * Build the caucus `.mcp.json` server entry. `CAUCUS_TOKEN` is ALWAYS the
 * `${...}` env reference for `tokenEnv` — never a literal token (ADR-C12). URL
 * and channel are literals (they are not secrets and the hook needs the literal
 * channel name to subscribe).
 */
export function buildMcpEntry(values: ScaffoldValues): CaucusMcpEntry {
  return {
    command: "node",
    args: [values.mcpServerBin],
    env: {
      CAUCUS_URL: values.url,
      CAUCUS_CHANNEL: values.channel,
      // The literal `${NAME}` reference — Claude Code expands it from the
      // ambient env at spawn time. NEVER the token value (ADR-C12).
      CAUCUS_TOKEN: `\${${values.tokenEnv}}`,
    },
  };
}

/** Build a fresh `.mcp.json` object carrying only the caucus server entry. */
export function buildMcpJson(values: ScaffoldValues): McpJson {
  return { mcpServers: { caucus: buildMcpEntry(values) } };
}

/** The `caucus` hook matcher block for `UserPromptSubmit`. */
export function buildHookMatcher(values: ScaffoldValues): HookMatcher {
  return {
    matcher: "",
    hooks: [{ type: "command", command: `node ${values.hookBin}` }],
  };
}

/** Build a fresh `.claude/settings.local.json` carrying the caucus hook + enablement. */
export function buildSettings(values: ScaffoldValues): SettingsJson {
  return {
    enabledMcpjsonServers: ["caucus"],
    hooks: { UserPromptSubmit: [buildHookMatcher(values)] },
  };
}

/**
 * Build the sourceable `caucus.env`. Claude Code COMMAND hooks inherit the SHELL
 * env (not `.mcp.json`'s `env`), so the hook needs `CAUCUS_URL` / `CAUCUS_CHANNEL`
 * exported; and the MCP server's `${CAUCUS_TOKEN}` reference needs the token in
 * the env too. We leave the token EMPTY with a loud never-commit notice — the
 * user pastes their own secret and `source`s the file (ADR-C12: secrets never
 * land in a committed file). Uses `\n` line endings; the env var name is the
 * caller's `tokenEnv`.
 */
export function buildEnvFile(values: ScaffoldValues): string {
  return [
    "# caucus.env — source this before launching Claude Code:  source ./caucus.env",
    "#",
    "# NEVER COMMIT THIS FILE. It is the place your per-session bearer token",
    "# lives; the scaffold adds it to .gitignore. The token stays out of every",
    "# committed config — .mcp.json references it as ${" + values.tokenEnv + "} only.",
    "#",
    "# The Claude Code command hook inherits THIS shell environment (not the env",
    "# block in .mcp.json), so CAUCUS_URL / CAUCUS_CHANNEL must be exported here.",
    `export CAUCUS_URL=${values.url}`,
    `export CAUCUS_CHANNEL=${values.channel}`,
    `# Paste your per-session bearer secret (registered in the backbone's CAUCUS_TOKENS):`,
    `export ${values.tokenEnv}=`,
    "",
  ].join("\n");
}
