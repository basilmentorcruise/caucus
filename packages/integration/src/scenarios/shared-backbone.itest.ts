/**
 * Integration scenario — TWO real MCP server processes + the turn-start hook all
 * sharing ONE HTTP backbone via `CAUCUS_URL` (CAU-50, CAU-25).
 *
 * This is the end-to-end proof that wiring the MCP entrypoint to the shared
 * backbone makes the two-terminal demo (CAU-15) possible. It cannot run
 * in-process: the whole point is that SEPARATELY-SPAWNED OS processes observe
 * the same store, so everything here is a real subprocess driven exactly as
 * Claude Code drives it.
 *
 *   - the backbone server runs OUT OF PROCESS (`node …/backbone-server/dist/bin.js`)
 *     on an ephemeral port, token-gated (CAU-13);
 *   - TWO MCP servers (`node …/mcp-server/dist/index.js`) are spawned with
 *     `CAUCUS_URL=<server>`, the SAME `CAUCUS_CHANNEL`, and DISTINCT
 *     `CAUCUS_TOKEN`s registered in the server's `CAUCUS_TOKENS` map. Each is
 *     driven over a real stdio JSON-RPC connection via the MCP SDK `Client` on a
 *     `StdioClientTransport`;
 *   - the hook (`node …/hook/dist/bin.js`) is spawned per "turn" with the same
 *     `CAUCUS_URL`/`CAUCUS_CHANNEL` and an isolated temp `HOME`, fed the
 *     `UserPromptSubmit` JSON on stdin.
 *
 * vitest's source aliases do NOT apply to a child process, so the spawned bins
 * must be built first. The build is hoisted into the integration config's
 * `globalSetup` (it runs ONCE before any scenario), so this file does not build
 * — see `packages/integration/src/global-setup.ts`.
 *
 * Asserted ACs:
 *  - AC2: session A posts via `caucus_post` ⇒ session B's `caucus_read_channel`
 *    sees it (same store); then the hook (a third, separate process) reads the
 *    same channel and renders a post made by A.
 *  - AC3: both MCP servers are spawned SIMULTANEOUSLY; each `ensureChannel`s the
 *    same room at startup, racing the create over HTTP, and BOTH come up cleanly
 *    (the channel exists exactly once) — proven by both serving `tools/list`.
 *
 * (AC1 — `selectBackbone` switches on `CAUCUS_URL` — is unit-tested in
 * `packages/mcp-server/src/wiring.test.ts`.)
 */
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const SERVER_BIN = join(REPO_ROOT, "packages", "backbone-server", "dist", "bin.js");
const MCP_BIN = join(REPO_ROOT, "packages", "mcp-server", "dist", "index.js");
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");

const CHANNEL = "incident-shared";

/**
 * The MVP token convention (CAU-50, security hand-off on #50): each session's
 * `CAUCUS_TOKEN` is a per-session OPAQUE secret (colon-free), sent verbatim as
 * the HTTP bearer. The server map entry is `<secret>:<agent>:<owner>` — the
 * secret is the colon-free FIRST segment (so it round-trips as the map key),
 * and `<agent>:<owner>` is the identity the server ANCHORS onto every write.
 * Two distinct sessions ⇒ two distinct secrets. (A colon-free token can't be
 * split for local display, so the MCP server shows a cosmetic identity — the
 * server is authoritative for what lands in the log; see config.ts.)
 */
const TOK_A = "tok-alice-secret";
const TOK_B = "tok-bob-secret";
const SERVER_TOKENS = `${TOK_A}:alice-agent:alice,${TOK_B}:bob-agent:bob`;

/** A child env: process.env with undefined stripped, plus overrides. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...overrides };
}

/** Start the backbone server as its own process; resolve with its base URL + stop. */
function startServerProcess(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn("node", [SERVER_BIN], {
    cwd: REPO_ROOT,
    env: childEnv({ PORT: "0", HOST: "127.0.0.1", CAUCUS_TOKENS: SERVER_TOKENS }),
  }) as ChildProcessWithoutNullStreams;

  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("backbone server did not start within 10s"));
    }, 10_000);

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const m = buf.match(/listening on (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolveUrl({ url: m[1]!, stop: () => child.kill() });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn an MCP server as a subprocess and connect a `Client` to it over stdio —
 * exactly how Claude Code launches it. The `StdioClientTransport` owns the
 * child process; `client.close()` terminates it (see afterAll).
 */
async function connectMcp(url: string, token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_BIN],
    env: childEnv({
      CAUCUS_URL: url,
      CAUCUS_CHANNEL: CHANNEL,
      CAUCUS_TOKEN: token,
    }),
    // Surface a child's startup failure (e.g. a 401 on ensureChannel) instead of
    // silently hanging the connect.
    stderr: "inherit",
  });
  const client = new Client({ name: "caucus-itest-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Parse the single text block of a tool result as JSON. */
function toolJson<T>(result: CallToolResult): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

/** Run the hook bin as Claude Code would: env + `UserPromptSubmit` JSON stdin. */
function runHookBin(home: string, url: string, sessionId: string): string {
  return execFileSync("node", [HOOK_BIN], {
    cwd: REPO_ROOT,
    env: childEnv({
      HOME: home,
      USERPROFILE: home,
      CAUCUS_URL: url,
      CAUCUS_CHANNEL: CHANNEL,
    }),
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
  });
}

/** Extract `additionalContext` from the hook's stdout JSON (throws if absent). */
function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("shared HTTP backbone — two MCP processes + the hook (CAU-50)", () => {
  let url: string;
  let stopServer: () => void;
  let clientA: Client;
  let clientB: Client;
  let home: string;
  const hookSession = "sess-shared-hook";

  beforeAll(async () => {
    const started = await startServerProcess();
    url = started.url;
    stopServer = started.stop;
    home = await mkdtemp(join(tmpdir(), "caucus-shared-itest-"));

    // AC3 — spawn BOTH MCP servers SIMULTANEOUSLY. Each runs ensureChannel at
    // startup against the SAME shared backbone, racing the create over HTTP; the
    // describe→create→(409 ⇒ ChannelExistsError ⇒ describe) reconstruction must
    // survive the wire so BOTH come up. If either loses the race uncleanly,
    // connect() rejects and this beforeAll fails.
    [clientA, clientB] = await Promise.all([
      connectMcp(url, TOK_A),
      connectMcp(url, TOK_B),
    ]);
  });

  afterAll(async () => {
    // Clean shutdown: closing each client terminates its spawned MCP child
    // (StdioClientTransport owns it), so no MCP processes leak past the suite.
    await clientA?.close();
    await clientB?.close();
    stopServer?.();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("AC3: both concurrently-spawned MCP servers come up and serve tools/list", async () => {
    const [a, b] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    // Both servers are alive and the channel exists exactly once (a clean race):
    // each exposes the standard tool set, proving ensureChannel did not throw.
    expect(a.tools.find((t) => t.name === "caucus_post")).toBeDefined();
    expect(a.tools.find((t) => t.name === "caucus_read_channel")).toBeDefined();
    expect(b.tools.find((t) => t.name === "caucus_post")).toBeDefined();
    expect(b.tools.find((t) => t.name === "caucus_read_channel")).toBeDefined();

    // The channel exists, attributed once. Read it from A (an empty page at
    // cursor 0 is a valid, non-error result; the point is the read succeeds over
    // the shared store).
    const read = toolJson<{ cursor: number; count: number }>(
      (await clientA.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    expect(typeof read.cursor).toBe("number");
  });

  it("AC2: A posts ⇒ B reads it (same store) ⇒ the hook reads it too", async () => {
    // Pre-mint the hook checkpoint at head BEFORE A posts, so the later hook run
    // sees a genuine delta (ADR-C6: no backlog replay on first run).
    expect(runHookBin(home, url, hookSession).trim()).toBe("");

    // Session A posts a finding via its MCP tool. The server anchors identity to
    // A's bearer (alice), regardless of what the tool stamps locally.
    const body = "login accepts expired JWTs (shared-store proof)";
    const posted = toolJson<{ msg_id: string; cursor: number }>(
      (await clientA.callTool({
        name: "caucus_post",
        arguments: { type: "finding", body },
      })) as CallToolResult,
    );
    expect(typeof posted.msg_id).toBe("string");

    // Session B — a SEPARATE process with a DIFFERENT token — reads the channel
    // and sees A's message. This only works because both point at one store.
    const read = toolJson<{
      count: number;
      messages: { body: string; owner: string; agent_id: string }[];
    }>(
      (await clientB.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    const seen = read.messages.find((m) => m.body === body);
    expect(seen).toBeDefined();
    // Identity is server-anchored to A's bearer (CAU-13), not B's: B reads A's
    // message attributed to alice.
    expect(seen?.owner).toBe("alice");
    expect(seen?.agent_id).toBe("alice-agent");

    // The hook — a THIRD, independent process — reads the same shared channel
    // and renders A's post (proving the hook and the MCP servers share a store).
    const ctx = additionalContext(runHookBin(home, url, hookSession));
    expect(ctx).toContain(body);
    expect(ctx).toContain("A·alice");
  });
});
