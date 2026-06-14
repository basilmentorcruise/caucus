/**
 * `caucus init` orchestration (CAU-108).
 *
 * Parses flags, fills gaps interactively (unless `--yes`/non-TTY), resolves the
 * absolute bin paths, plans each artifact's write (create/merge/noop/recreate),
 * and writes them atomically with a backup of anything it replaces. Pure
 * sub-steps (generation, merge, path resolution) live in sibling modules; this
 * is the I/O + control flow, with the filesystem, environment, console, prompter,
 * and bin resolver all injected so the whole flow is unit-testable.
 *
 * Invariants:
 *  - Quiet by default (ADR-C6): success output is short and factual.
 *  - NEVER writes a token literal (ADR-C12): the token is an `${ENV}` reference.
 *  - Non-destructive: existing config is merged, with a `.bak-<ts>` of anything
 *    replaced; a corrupt file is backed up and rewritten (never merged-into).
 *  - `--dry-run` writes NOTHING (no files, no backups, no .gitignore edit).
 */
import { resolve } from "node:path";

import { buildEnvFile, buildMcpEntry, buildHookMatcher } from "./generate.js";
import {
  mergeMcp,
  mergeSettings,
  planEnvFile,
  planJsonFile,
  type FilePlan,
} from "./merge.js";
import { createPrompter, type Prompter } from "./prompts.js";
import { type ResolvedBins } from "./paths.js";

/** Default backbone URL (the local backbone's documented loopback dial). */
export const DEFAULT_URL = "http://127.0.0.1:4747";
/** Default channel under `--yes`/non-TTY when `--channel` is omitted. */
export const DEFAULT_CHANNEL = "dogfood";
/** Default env-var NAME the token is referenced by. */
export const DEFAULT_TOKEN_ENV = "CAUCUS_TOKEN";

/** Parsed CLI options (post arg-parse, pre value-resolution). */
export interface InitOptions {
  url?: string;
  channel?: string;
  agentId?: string;
  owner?: string;
  tokenEnv?: string;
  dir?: string;
  settings?: string;
  force: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
}

/** Result of parsing argv: either options or a usage error. */
export type ParseResult =
  | { readonly ok: true; readonly options: InitOptions }
  | { readonly ok: false; readonly error: string };

/** Injected side-effecting dependencies (all stubbable in tests). */
export interface InitDeps {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** True when interactive prompting is possible (orchestrator passes `process.stdin.isTTY`). */
  readonly isTTY: boolean;
  readonly log: (line: string) => void;
  readonly errlog: (line: string) => void;
  /** Read a file to UTF-8, or `undefined` if it does not exist. */
  readonly readFile: (path: string) => Promise<string | undefined>;
  /** Write a file atomically (tmp + rename). */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** Copy `from`→`to` for a backup. */
  readonly backup: (from: string, to: string) => Promise<void>;
  /** Current time in ms (for the `.bak-<ts>` suffix); injected for determinism. */
  readonly now: () => number;
  readonly resolveBins: () => ResolvedBins;
  readonly makePrompter?: () => Prompter;
}

const USAGE = `caucus init — scaffold the Caucus wiring for a Claude Code session

USAGE
  caucus init [options]

Generates (and safely merges into) the files a tester needs:
  • .mcp.json                      — the Caucus MCP server entry
  • .claude/settings.local.json    — the turn-start (UserPromptSubmit) hook
  • caucus.env                     — a sourceable env file (gitignored)

OPTIONS
  --url <url>          Backbone URL                     (default ${DEFAULT_URL})
  --channel <name>     Channel to join                  (prompted; "${DEFAULT_CHANNEL}" with --yes)
  --agent-id <id>      This session's agent id          (default: derived from --owner)
  --owner <name>       The human this agent acts for     (default: $USER; required)
  --token-env <NAME>   Env var NAME holding the bearer  (default ${DEFAULT_TOKEN_ENV})
  --dir <path>         Project dir to scaffold into     (default: cwd)
  --settings <path>    Override the settings file path  (default: <dir>/.claude/settings.local.json)
  --force              Overwrite/merge without prompting on conflicts
  -y, --yes            Non-interactive; accept defaults
  --dry-run            Print the plan; write nothing
  -h, --help           Show this help

SECRETS
  The bearer token is NEVER written to a committed file. .mcp.json references it
  as \${${DEFAULT_TOKEN_ENV}}; paste the real secret into caucus.env (gitignored)
  and 'source' it. There is no --token flag.`;

/** Parse argv (already sliced past `node script init`). */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: InitOptions = { force: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takeValue = (): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i++;
      return next;
    };
    switch (arg) {
      case "--url": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--url requires a value` };
        options.url = v;
        break;
      }
      case "--channel": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--channel requires a value` };
        options.channel = v;
        break;
      }
      case "--agent-id": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--agent-id requires a value` };
        options.agentId = v;
        break;
      }
      case "--owner": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--owner requires a value` };
        options.owner = v;
        break;
      }
      case "--token-env": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--token-env requires a value` };
        options.tokenEnv = v;
        break;
      }
      case "--dir": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--dir requires a value` };
        options.dir = v;
        break;
      }
      case "--settings": {
        const v = takeValue();
        if (v === undefined) return { ok: false, error: `--settings requires a value` };
        options.settings = v;
        break;
      }
      case "--token":
        // ADR-C12: secrets are referenced by env only — there is no token flag.
        return {
          ok: false,
          error: `--token is not supported: secrets are referenced by env only (ADR-C12). Use --token-env <NAME> and put the value in caucus.env.`,
        };
      case "--force":
        options.force = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, options };
}

/** A channel name must be non-empty and free of control chars / whitespace runs. */
export function validateChannel(channel: string): string | { err: string } {
  const trimmed = channel.trim();
  if (trimmed === "") return { err: "channel must not be empty" };
  // Reject control characters (the backbone rejects them on write — fail early,
  // legibly, here). Covers \x00-\x1f and \x7f.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { err: "channel must not contain control characters" };
  }
  return trimmed;
}

/**
 * Reject control characters in a cosmetic field (`--owner` / `--agent-id`).
 * These fields are display-only — they seed the next-steps `CAUCUS_TOKENS`
 * example and the generated agent id, but they DO NOT establish identity, which
 * is server-anchored from the bearer (ADR-C7). We still scrub control chars for
 * consistency with the CAU-71/81 sanitize discipline (and so the printed
 * next-steps line can't be corrupted by an escape sequence). Returns the trimmed
 * value or `{ err }`. Uses the same `\x00-\x1f\x7f` class as `validateChannel`.
 */
export function validateField(label: string, value: string): string | { err: string } {
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { err: `${label} must not contain control characters` };
  }
  return trimmed;
}

/** A token-env NAME must look like an env var (letters/digits/underscore, not leading digit). */
export function validateTokenEnv(name: string): string | { err: string } {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return { err: `--token-env must be an env var NAME (e.g. CAUCUS_TOKEN), not "${name}"` };
  }
  return trimmed;
}

/** The fully-resolved values, after flags + prompts + defaults. */
interface ResolvedValues {
  readonly url: string;
  readonly channel: string;
  readonly agentId: string;
  readonly owner: string;
  readonly tokenEnv: string;
  readonly dir: string;
  readonly settingsPath: string;
}

/** Apply the `.bak-<ts>` suffix used for backups. */
export function backupName(path: string, ts: number): string {
  return `${path}.bak-${ts}`;
}

/** Print the human-readable next steps after a successful (non-dry-run) scaffold. */
function printNextSteps(deps: InitDeps, v: ResolvedValues, bins: ResolvedBins): void {
  deps.log("");
  deps.log("Next steps (the scaffold can't do these for you):");
  deps.log("");
  deps.log("  1. Choose a bearer secret for this session — any opaque string only you know");
  deps.log("     (call it <YOUR_SECRET>). Prefer a random value, not a guessable one.");
  deps.log("  2. Register it in the backbone's CAUCUS_TOKENS, mapped to this identity:");
  deps.log(`       CAUCUS_TOKENS="<YOUR_SECRET>:${v.agentId}:${v.owner}"`);
  deps.log(`  3. Paste the SAME <YOUR_SECRET> into caucus.env (the empty ${v.tokenEnv}= line).`);
  deps.log("     caucus.env is gitignored — never commit it.");
  deps.log("  4. source ./caucus.env");
  deps.log("  5. Start Claude Code. Without steps 1–4 the session has no token and silently");
  deps.log("     posts nothing — this is the #1 first-run mistake.");
  void bins;
}

/**
 * Run `caucus init`. Returns the process exit code (0 ok, 1 on a usage/validation
 * error or a conflict the user declined). Never throws for an expected failure;
 * unexpected I/O errors propagate.
 */
export async function runInit(
  argv: readonly string[],
  deps: InitDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.errlog(parsed.error);
    deps.errlog("");
    deps.errlog("Run `caucus init --help` for usage.");
    return 1;
  }
  const opts = parsed.options;
  if (opts.help) {
    deps.log(USAGE);
    return 0;
  }

  const interactive = !opts.yes && deps.isTTY;
  const prompter = interactive
    ? (deps.makePrompter?.() ?? createPrompter())
    : undefined;

  try {
    // --- Resolve values (flags → prompts → defaults). ---
    const defaultOwner = (deps.env.USER ?? deps.env.USERNAME ?? "").trim();

    const url =
      opts.url?.trim() ||
      (prompter ? await prompter.ask("Backbone URL", DEFAULT_URL) : DEFAULT_URL);

    // An OMITTED --channel is filled by prompt/default; a PRESENT-but-blank
    // --channel is an explicit error (don't silently swap a typo'd value).
    let channelRaw: string;
    if (opts.channel === undefined) {
      if (prompter) {
        channelRaw = await prompter.ask("Channel");
      } else {
        channelRaw = DEFAULT_CHANNEL;
        deps.errlog(
          `note: no --channel given; using "${DEFAULT_CHANNEL}" (override with --channel <name>).`,
        );
      }
    } else {
      channelRaw = opts.channel;
    }
    const channel = validateChannel(channelRaw);
    if (typeof channel !== "string") {
      deps.errlog(`error: ${channel.err}`);
      return 1;
    }

    const ownerRaw =
      opts.owner?.trim() ||
      (prompter ? await prompter.ask("Owner (the human you act for)", defaultOwner) : defaultOwner);
    if (ownerRaw === "") {
      deps.errlog(
        `error: owner is required (set --owner or $USER).`,
      );
      return 1;
    }
    // owner/agent-id are cosmetic/next-steps-only — identity is server-anchored
    // (ADR-C7) — but we still reject control chars for sanitize consistency.
    const owner = validateField("--owner", ownerRaw);
    if (typeof owner !== "string") {
      deps.errlog(`error: ${owner.err}`);
      return 1;
    }
    const agentIdRaw =
      opts.agentId?.trim() ||
      (prompter ? await prompter.ask("Agent id", `${owner}-agent`) : `${owner}-agent`);
    const agentId = validateField("--agent-id", agentIdRaw);
    if (typeof agentId !== "string") {
      deps.errlog(`error: ${agentId.err}`);
      return 1;
    }

    const tokenEnvRaw = opts.tokenEnv?.trim() || DEFAULT_TOKEN_ENV;
    const tokenEnv = validateTokenEnv(tokenEnvRaw);
    if (typeof tokenEnv !== "string") {
      deps.errlog(`error: ${tokenEnv.err}`);
      return 1;
    }

    // Resolve a relative --dir against the injected cwd (like --settings), so the
    // two stay consistent and the flow is fully testable.
    const dir = resolve(deps.cwd, opts.dir?.trim() || ".");
    const settingsPath = opts.settings
      ? resolve(deps.cwd, opts.settings)
      : resolve(dir, ".claude", "settings.local.json");

    const v: ResolvedValues = { url, channel, agentId, owner, tokenEnv, dir, settingsPath };

    // --- Resolve bins (absolute node entrypoints). ---
    let bins: ResolvedBins;
    try {
      bins = deps.resolveBins();
    } catch (err) {
      deps.errlog(
        `error: could not resolve the Caucus bins — is @caucus/hook installed alongside @caucus/mcp-server? (${err instanceof Error ? err.message : String(err)})`,
      );
      return 1;
    }

    const scaffold = {
      url,
      channel,
      mcpServerBin: bins.mcpServer,
      hookBin: bins.hook,
      tokenEnv,
    };

    // --- Plan each artifact. ---
    const mcpPath = resolve(dir, ".mcp.json");
    const envPath = resolve(dir, "caucus.env");
    const gitignorePath = resolve(dir, ".gitignore");

    const mcpEntry = buildMcpEntry(scaffold);
    const hookMatcher = buildHookMatcher(scaffold);

    const mcpPlan = planJsonFile(await deps.readFile(mcpPath), (existing) =>
      mergeMcp(existing, mcpEntry),
    );
    const settingsPlan = planJsonFile(await deps.readFile(settingsPath), (existing) =>
      mergeSettings(existing, hookMatcher),
    );
    const envPlan = planEnvFile(await deps.readFile(envPath), buildEnvFile(scaffold));

    const items: ReadonlyArray<{ label: string; path: string; plan: FilePlan }> = [
      { label: ".mcp.json", path: mcpPath, plan: mcpPlan },
      { label: "settings.local.json", path: settingsPath, plan: settingsPlan },
      { label: "caucus.env", path: envPath, plan: envPlan },
    ];

    // --- Conflict gate: any backup-requiring write needs --force/--yes or a prompt. ---
    const conflicts = items.filter((it) => it.plan.backup);
    if (conflicts.length > 0 && !opts.force && !opts.dryRun) {
      deps.errlog(
        `The following files already exist and differ; caucus will merge in its keys and back up the originals:`,
      );
      for (const c of conflicts) {
        const why = c.plan.action === "recreate" ? " (corrupt JSON — will be replaced)" : "";
        deps.errlog(`  • ${c.path}${why}`);
      }
      const proceed = prompter ? await prompter.confirm("Proceed?") : false;
      if (!proceed) {
        deps.errlog(
          interactive
            ? "Aborted; nothing written."
            : "Refusing to modify existing files without --force (non-interactive). Re-run with --force.",
        );
        return 1;
      }
    }

    // --- Dry run: report the plan, write nothing. ---
    if (opts.dryRun) {
      deps.log(`caucus init (dry run) — would write into ${dir}:`);
      for (const it of items) {
        deps.log(`  ${describePlan(it.plan.action)}  ${it.path}`);
      }
      deps.log(`  mcp server: ${bins.mcpServer}`);
      deps.log(`  hook:       ${bins.hook}`);
      deps.log(`  identity:   ${agentId} → ${owner} · channel "${channel}" · url ${url}`);
      return 0;
    }

    // --- Apply. ---
    const ts = deps.now();
    for (const it of items) {
      if (it.plan.action === "noop") {
        deps.log(`unchanged  ${it.label} (already up to date)`);
        continue;
      }
      if (it.plan.action === "skip") {
        // Only caucus.env reaches `skip`: it differs but holds the user's pasted
        // secret, so we never touch it (and never back it up — that .bak would be
        // committable, ADR-C12). Print a notice so the user can reconcile by hand.
        deps.log(
          `left as-is ${it.label} (already exists and differs; update CAUCUS_URL/CAUCUS_CHANNEL by hand if needed)`,
        );
        continue;
      }
      if (it.plan.backup) {
        const bak = backupName(it.path, ts);
        await deps.backup(it.path, bak);
        deps.errlog(`backed up  ${it.path} → ${bak}`);
      }
      await deps.writeFile(it.path, it.plan.content!);
      deps.log(`${describePlan(it.plan.action).padEnd(9)}  ${it.label}`);
    }

    // --- .gitignore: ensure caucus.env is ignored (it holds the secret). ---
    await ensureGitignore(deps, gitignorePath);

    printNextSteps(deps, v, bins);
    return 0;
  } finally {
    prompter?.close();
  }
}

/** Map a plan action to a short verb for output. */
function describePlan(action: FilePlan["action"]): string {
  switch (action) {
    case "create":
      return "created";
    case "merge":
      return "merged";
    case "recreate":
      return "rewrote";
    case "noop":
      return "unchanged";
    case "skip":
      return "left as-is";
  }
}

/**
 * Patterns the scaffold ensures `.gitignore` carries (idempotent). `caucus.env`
 * holds the user's pasted bearer; `*.bak-<ts>` is the suffix this scaffold uses
 * when it backs a file up on a conflicting merge. Even though `caucus.env`
 * itself is never backed up (ADR-C12 — see `planEnvFile`), we ignore `*.bak-*`
 * belt-and-suspenders so no scaffold backup can ever be committed.
 */
const GITIGNORE_PATTERNS: readonly string[] = ["caucus.env", "*.bak-*"];

/** Append any missing scaffold ignore patterns to `.gitignore` (idempotent). */
async function ensureGitignore(deps: InitDeps, gitignorePath: string): Promise<void> {
  const current = await deps.readFile(gitignorePath);
  const lines = (current === undefined ? [] : current.split("\n")).map((l) => l.trim());
  const isIgnored = (pat: string): boolean =>
    lines.some((l) => l === pat || l === `/${pat}`);
  const missing = GITIGNORE_PATTERNS.filter((pat) => !isIgnored(pat));
  if (missing.length === 0) return;
  const prefix =
    current === undefined ? "" : current.endsWith("\n") ? current : current + "\n";
  await deps.writeFile(gitignorePath, prefix + missing.map((p) => `${p}\n`).join(""));
  deps.log(
    `${current === undefined ? "created" : "updated"}  .gitignore (ignores ${missing.join(", ")})`,
  );
}
