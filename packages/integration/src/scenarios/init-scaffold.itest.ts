/**
 * Integration scenario — `caucus init` scaffolds a working session end-to-end
 * (CAU-108), proven against a REAL backbone with REAL subprocesses.
 *
 * This is the empirical proof of CAU-108's headline AC: "running the CLI in a
 * clean dir produces a valid `.mcp.json` + `.claude/settings.local.json` that
 * ACTUALLY launch the MCP server and fire the hook." Like `shared-backbone.itest.ts`
 * it cannot run in-process: the scaffold writes config that a separately-spawned
 * MCP server and a separately-spawned hook consume. So we:
 *
 *   1. boot the real backbone on PORT=4747 with a `CAUCUS_TOKENS` map;
 *   2. run the `caucus` bin (`dist/cli/bin.js`) `init --yes` into a `mkdtemp` dir;
 *   3. assert both config files exist, carry ABSOLUTE existing bin paths and the
 *      `${CAUCUS_TOKEN}` reference, and that NEITHER file (nor caucus.env)
 *      contains the literal bearer secret (ADR-C12);
 *   4. launch the MCP server FROM THE GENERATED `.mcp.json` (command + args + env,
 *      substituting the real bearer for `${CAUCUS_TOKEN}` as Claude Code's env
 *      expansion would), post a finding via the MCP SDK client, and assert it
 *      lands on the live backbone;
 *   5. fire the hook FROM THE GENERATED `settings.local.json` with the env the
 *      scaffold documents, and assert the posted finding appears in the hook's
 *      injected `additionalContext`;
 *   6. re-run the scaffold and assert it is a byte-identical no-op (no .bak);
 *   7. pre-seed an unrelated `permissions` block and assert the merge preserves it.
 *
 * The bins are built once in the integration `globalSetup`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpBackbone } from "@caucus/backbone-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess } from "../harness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CAUCUS_BIN = join(REPO_ROOT, "packages", "mcp-server", "dist", "cli", "bin.js");
const MCP_BIN = join(REPO_ROOT, "packages", "mcp-server", "dist", "index.js");
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");

const CHANNEL = "init-scaffold";
const TOK = "tok-alice-INIT-SECRET";
const SERVER_TOKENS = `${TOK}:alice-agent:alice`;

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}
interface McpConfig {
  mcpServers: { caucus: McpServerEntry };
}
interface SettingsConfig {
  hooks: { UserPromptSubmit: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  enabledMcpjsonServers?: string[];
  permissions?: unknown;
}

/** process.env with undefined stripped, plus overrides — a plain child env. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...overrides };
}

/** Run `caucus init --yes` into `dir`, returning stdout. */
function runInit(dir: string, extra: string[] = []): string {
  return execFileSync(
    "node",
    [
      CAUCUS_BIN, "init", "--yes",
      "--dir", dir,
      "--url", "http://127.0.0.1:4747",
      "--channel", CHANNEL,
      "--agent-id", "alice-agent",
      "--owner", "alice",
      ...extra,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

/**
 * Connect an MCP SDK client to a server spawned EXACTLY as the generated
 * `.mcp.json` prescribes — its `command` + `args` + `env` — but with the
 * `${CAUCUS_TOKEN}` reference replaced by the real bearer and `CAUCUS_URL`
 * pointed at the live ephemeral backbone (what Claude Code's env expansion +
 * the running backbone provide). The transport owns the child; `client.close()`
 * terminates it.
 */
async function connectFromGenerated(entry: McpServerEntry, url: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.env)) {
    env[k] = v === "${CAUCUS_TOKEN}" ? TOK : v;
  }
  env.CAUCUS_URL = url; // the live backbone's actual (ephemeral) URL
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: childEnv(env),
    stderr: "inherit",
  });
  const client = new Client({ name: "init-scaffold-itest", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Fire the hook bin from the generated settings, with the env the scaffold documents. */
function runHookFromSettings(settings: SettingsConfig, home: string, url: string): string {
  const command = settings.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
  const binPath = command.replace(/^node\s+/, ""); // generated as `node <abs bin>`
  return execFileSync("node", [binPath], {
    cwd: REPO_ROOT,
    env: childEnv({ HOME: home, USERPROFILE: home, CAUCUS_URL: url, CAUCUS_CHANNEL: CHANNEL }),
    input: JSON.stringify({ session_id: "sess-init-scaffold", hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
  });
}

/** Extract `additionalContext` from the hook's stdout JSON. */
function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("caucus init scaffold launches the server + fires the hook end-to-end (CAU-108)", () => {
  let url: string;
  let stopServer: () => Promise<void>;
  let backbone: HttpBackbone;
  let client: Client | undefined;
  let dir: string;
  let home: string;

  beforeAll(async () => {
    const started = await startServerProcess({ CAUCUS_TOKENS: SERVER_TOKENS, PORT: "4747" });
    url = started.url;
    stopServer = started.stop;
    backbone = new HttpBackbone(url, { token: TOK });
    await backbone.createChannel({ channel: CHANNEL, purpose: "init scaffold", created_by: "alice" });
    dir = await mkdtemp(join(tmpdir(), "caucus-init-"));
    home = await mkdtemp(join(tmpdir(), "caucus-init-home-"));
  });

  afterAll(async () => {
    await client?.close();
    await stopServer?.();
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("scaffolds valid config, launches the server, lands a finding, and the hook injects it", async () => {
    // --- (2) scaffold into the clean dir. ---
    const out = runInit(dir);
    expect(out).toContain("created");

    const mcpPath = join(dir, ".mcp.json");
    const settingsPath = join(dir, ".claude", "settings.local.json");
    const envPath = join(dir, "caucus.env");
    expect(existsSync(mcpPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(envPath)).toBe(true);

    const mcpRaw = await readFile(mcpPath, "utf8");
    const settingsRaw = await readFile(settingsPath, "utf8");
    const envRaw = await readFile(envPath, "utf8");
    const mcp = JSON.parse(mcpRaw) as McpConfig;
    const settings = JSON.parse(settingsRaw) as SettingsConfig;

    // --- (3) absolute, EXISTING bin paths + the ${CAUCUS_TOKEN} reference. ---
    const entry = mcp.mcpServers.caucus;
    expect(entry.args[0]).toBe(MCP_BIN);
    expect(existsSync(entry.args[0]!)).toBe(true);
    expect(entry.env.CAUCUS_TOKEN).toBe("${CAUCUS_TOKEN}");

    const hookCommand = settings.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
    expect(hookCommand).toBe(`node ${HOOK_BIN}`);
    expect(existsSync(HOOK_BIN)).toBe(true);

    // ADR-C12: the bearer secret appears in NONE of the generated files.
    for (const raw of [mcpRaw, settingsRaw, envRaw]) {
      expect(raw).not.toContain(TOK);
    }

    // --- (4) launch the server FROM the generated config; the finding lands. ---
    client = await connectFromGenerated(entry, url);
    const finding = "scaffolded server posted this finding";
    const result = (await client.callTool({
      name: "caucus_post_finding",
      arguments: { body: finding },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();

    const onBackbone = await backbone.readSince(CHANNEL, 0);
    expect(onBackbone.messages.some((m) => m.body === finding)).toBe(true);

    // --- (5) fire the hook FROM the generated settings; it injects a finding. ---
    // Fresh checkpoint home ⇒ first run mints at head (ADR-C6: no backlog replay)
    // and injects nothing; then a NEW finding is the genuine delta the hook shows.
    expect(runHookFromSettings(settings, home, url).trim()).toBe("");

    const second = "second scaffolded finding for the hook";
    const r2 = (await client.callTool({
      name: "caucus_post_finding",
      arguments: { body: second },
    })) as CallToolResult;
    expect(r2.isError).toBeFalsy();

    const injectedStdout = runHookFromSettings(settings, home, url);
    expect(additionalContext(injectedStdout)).toContain(second);
    // The hook injection never leaks the bearer.
    expect(injectedStdout).not.toContain(TOK);
  });

  it("is idempotent: a second run is a byte-identical no-op with no backup file", async () => {
    const before = await readFile(join(dir, ".mcp.json"), "utf8");
    const out = runInit(dir);
    expect(out).toContain("already up to date");
    expect(await readFile(join(dir, ".mcp.json"), "utf8")).toBe(before);
    // No .bak-* anywhere in the scaffold dir.
    const entries = await readdir(dir);
    expect(entries.some((e) => e.includes(".bak-"))).toBe(false);
  });

  it("never writes a pasted caucus.env token into any file (incl. *.bak-*) on a differing --force re-run (S1, ADR-C12)", async () => {
    const dir3 = await mkdtemp(join(tmpdir(), "caucus-init-env-"));
    try {
      const PASTED = "tok-alice-PASTED-SECRET-S1";
      const seeded = [
        "export CAUCUS_URL=http://old-host:9999",
        "export CAUCUS_CHANNEL=old-channel",
        `export CAUCUS_TOKEN=${PASTED}`,
        "",
      ].join("\n");
      await writeFile(join(dir3, "caucus.env"), seeded, "utf8");

      // Re-run with a CHANGED url + channel and --force, exactly the scenario
      // where the old code would have copied caucus.env to a committable .bak.
      runInit(dir3, ["--url", "http://127.0.0.1:4747", "--force"]);

      // caucus.env is byte-identical to what the user pasted (left untouched).
      expect(await readFile(join(dir3, "caucus.env"), "utf8")).toBe(seeded);

      // The token literal lands in NO file in the dir EXCEPT the user's own
      // caucus.env — and in particular in no *.bak-* file.
      const entries = await readdir(dir3);
      for (const name of entries) {
        // No scaffold backup of caucus.env may exist at all.
        expect(name).not.toMatch(/caucus\.env\.bak-/);
        if (name === "caucus.env") continue; // the user's own file holds it
        const content = await readFile(join(dir3, name), "utf8").catch(() => "");
        expect(content, `token leaked into ${name}`).not.toContain(PASTED);
      }
      // The nested settings file (in .claude/) is also clean.
      const settingsNested = join(dir3, ".claude", "settings.local.json");
      if (existsSync(settingsNested)) {
        expect(await readFile(settingsNested, "utf8")).not.toContain(PASTED);
      }

      // .gitignore keeps caucus.env AND *.bak-* ignored.
      const gitignore = await readFile(join(dir3, ".gitignore"), "utf8");
      const lines = gitignore.split("\n").map((l) => l.trim());
      expect(lines).toContain("caucus.env");
      expect(lines).toContain("*.bak-*");
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }
  });

  it("merges into an existing settings file, preserving an unrelated permissions block", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "caucus-init-merge-"));
    try {
      await mkdir(join(dir2, ".claude"), { recursive: true });
      await writeFile(
        join(dir2, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n",
        "utf8",
      );
      // --force to merge over the pre-existing (differing) file non-interactively.
      runInit(dir2, ["--force"]);
      const merged = JSON.parse(
        await readFile(join(dir2, ".claude", "settings.local.json"), "utf8"),
      ) as SettingsConfig;
      expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] });
      expect(merged.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(`node ${HOOK_BIN}`);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
