/**
 * Integration scenario — the FULL M1 war-room narrative (CAU-15), driven through
 * REAL MCP server processes + the REAL turn-start hook over ONE shared HTTP
 * backbone.
 *
 * This is the empirical proof of CAU-15's acceptance criteria: it composes the
 * subprocess machinery proven by `shared-backbone.itest.ts` (an out-of-process
 * token-gated backbone, MCP servers driven over stdio JSON-RPC exactly as Claude
 * Code drives them, and the hook run per "turn" with an isolated temp HOME) — but
 * it uses the SEED's demo tokens (`tok-alice` / `tok-bob` / `tok-carol`, the
 * single source of truth in `seed.config.mjs`), NOT the itest's `-secret` set, so
 * the test, the runnable `demo.mjs`, and the README all anchor to the same
 * identities. It then walks the four M1 beats and asserts each observable.
 *
 * Why subprocesses: the whole point is that SEPARATELY-SPAWNED OS processes (two
 * MCP servers + the hook) observe the same store. vitest's source aliases do not
 * apply to a child process, so the spawned bins are built once in the integration
 * `globalSetup` (global-setup.ts already builds the example closure too — no
 * change needed there).
 *
 * Asserted ACs (CAU-15):
 *  - AC2 (claim dedup): alice's `caucus_claim` is granted; carol's
 *    `caucus_read_channel` sees it; carol's same-target claim returns
 *    `already_claimed` naming alice (a normal result — `isError` falsy); carol's
 *    redirect claim on a different target is granted.
 *  - AC3 (human steer): bob's hook checkpoint is pre-minted at head; carol posts
 *    a `note` steer via `caucus_post`; bob's NEXT hook run injects that steer,
 *    attributed to carol (`A·carol`).
 *  - AC4 (seatbelt): an identical `caucus_post` twice — the second surfaces as
 *    `isError` carrying the actionable `duplicate_post` text.
 *  - AC1 (coherent log): a reader's `caucus_read_channel` since 0 shows the whole
 *    M1 story — alice's claim, carol's redirect claim, the steer note, exactly
 *    ONE loop post (the duplicate was rejected), and NO duplicate claim message.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess } from "../harness.js";

// The seed config is the single source of truth (a plain `.mjs` outside the TS
// build); import it so the test uses the SAME channel + tokens the demo does.
// @ts-expect-error — no type declarations for the example's runtime `.mjs`.
import * as seedConfig from "../../../../examples/war-room-demo/seed.config.mjs";

const { CHANNEL, tokensEnv } = seedConfig as {
  CHANNEL: string;
  tokensEnv: () => string;
};

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const MCP_BIN = join(REPO_ROOT, "packages", "mcp-server", "dist", "index.js");
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");

// The demo's bare bearers (tok-alice/bob/carol) and the server's tokens map. The
// server resolves a bearer to `{ agent_id, owner }` and anchors THAT onto every
// write (CAU-13), so the owners asserted below are server-authoritative.
const TOK_ALICE = "tok-alice";
const TOK_BOB = "tok-bob";
const TOK_CAROL = "tok-carol";
const SERVER_TOKENS = tokensEnv();

/** The four M1 demo strings (kept in step with `demo.mjs`). */
const TARGET_CONTESTED = "auth-timeout repro";
const TARGET_REDIRECT = "db-pool exhaustion";
const STEER_BODY = "check if the 14:02 deploy correlates";
const LOOP_BODY = "still seeing elevated p95 — anyone else? (itest loop)";

/** A child env: process.env with undefined stripped, plus overrides. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...overrides };
}

/**
 * Spawn an MCP server as a subprocess and connect a `Client` over stdio — exactly
 * how Claude Code launches it. The transport owns the child; `client.close()`
 * terminates it (see afterAll).
 */
async function connectMcp(url: string, token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_BIN],
    env: childEnv({ CAUCUS_URL: url, CAUCUS_CHANNEL: CHANNEL, CAUCUS_TOKEN: token }),
    stderr: "inherit",
  });
  const client = new Client({ name: "caucus-war-room-itest", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Parse the single text block of a NON-error tool result as JSON. */
function toolJson<T>(result: CallToolResult): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

/** The text of a tool result's first block (for asserting on an error message). */
function toolText(result: CallToolResult): string {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return (first as { type: "text"; text: string }).text;
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

describe("war-room demo — the full M1 narrative (CAU-15)", () => {
  let url: string;
  let stopServer: () => Promise<void>;
  let alice: Client;
  let bobReader: Client;
  let carol: Client;
  let home: string;
  const bobSession = "sess-bob";

  beforeAll(async () => {
    const started = await startServerProcess({ CAUCUS_TOKENS: SERVER_TOKENS });
    url = started.url;
    stopServer = started.stop;
    home = await mkdtemp(join(tmpdir(), "caucus-war-room-itest-"));

    // Spawn all three sessions concurrently; each ensureChannels the same room at
    // startup, racing the create over HTTP. allSettled (not all) so a survivor is
    // still bound for afterAll to terminate if one connect rejects.
    const settled = await Promise.allSettled([
      connectMcp(url, TOK_ALICE),
      connectMcp(url, TOK_BOB),
      connectMcp(url, TOK_CAROL),
    ]);
    const [a, b, c] = settled;
    if (a.status === "fulfilled") alice = a.value;
    if (b.status === "fulfilled") bobReader = b.value;
    if (c.status === "fulfilled") carol = c.value;
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
  });

  afterAll(async () => {
    await alice?.close();
    await bobReader?.close();
    await carol?.close();
    await stopServer?.();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("AC2: claim dedup — alice wins, carol sees it, loses the dup, redirects, wins", async () => {
    // alice claims the contested target and wins.
    const aliceClaim = toolJson<{ outcome: string }>(
      (await alice.callTool({
        name: "caucus_claim",
        arguments: { target: TARGET_CONTESTED, note: "I'll repro the auth timeout" },
      })) as CallToolResult,
    );
    expect(aliceClaim.outcome).toBe("granted");

    // carol — a SEPARATE process — reads the channel and sees alice's claim.
    const read = toolJson<{
      messages: { type: string; target?: string; owner: string }[];
    }>(
      (await carol.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    const aliceClaimMsg = read.messages.find(
      (m) => m.type === "claim" && m.target === TARGET_CONTESTED,
    );
    expect(aliceClaimMsg).toBeDefined();
    expect(aliceClaimMsg?.owner).toBe("alice");

    // carol claims the SAME target → already_claimed naming alice. This is a
    // NORMAL result (the dedup working), NOT an error.
    const carolDupResult = (await carol.callTool({
      name: "caucus_claim",
      arguments: { target: TARGET_CONTESTED },
    })) as CallToolResult;
    expect(carolDupResult.isError).toBeFalsy();
    const carolDup = toolJson<{
      outcome: string;
      by?: { owner: string };
    }>(carolDupResult);
    expect(carolDup.outcome).toBe("already_claimed");
    expect(carolDup.by?.owner).toBe("alice");

    // carol redirects to different, unclaimed work — and wins.
    const carolRedirect = toolJson<{ outcome: string }>(
      (await carol.callTool({
        name: "caucus_claim",
        arguments: { target: TARGET_REDIRECT, note: "taking the DB pool angle" },
      })) as CallToolResult,
    );
    expect(carolRedirect.outcome).toBe("granted");

    // The redirect claim is anchored to carol (server-stamped, CAU-13).
    const after = toolJson<{
      messages: { type: string; target?: string; owner: string }[];
    }>(
      (await bobReader.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    const redirectMsg = after.messages.find(
      (m) => m.type === "claim" && m.target === TARGET_REDIRECT,
    );
    expect(redirectMsg?.owner).toBe("carol");
  });

  it("AC3: a human steer typed in one session reaches bob's agent next turn", async () => {
    // Pre-mint bob's hook checkpoint at head BEFORE carol posts, so the next run
    // sees a genuine delta (ADR-C6: no backlog replay on first run).
    expect(runHookBin(home, url, bobSession).trim()).toBe("");

    // carol posts the steer (a `note`) via her MCP tool.
    const posted = toolJson<{ msg_id: string }>(
      (await carol.callTool({
        name: "caucus_post",
        arguments: { type: "note", body: STEER_BODY },
      })) as CallToolResult,
    );
    expect(typeof posted.msg_id).toBe("string");

    // bob's NEXT turn: the hook (a separate process) injects the steer,
    // attributed to carol (A·carol — agent acting for human owner, ADR-C7).
    const ctx = additionalContext(runHookBin(home, url, bobSession));
    expect(ctx).toContain(STEER_BODY);
    expect(ctx).toContain("A·carol");
  });

  it("AC4: the seatbelt blocks the looping post (duplicate_post)", async () => {
    // First identical post lands.
    const first = (await carol.callTool({
      name: "caucus_post",
      arguments: { type: "status", body: LOOP_BODY, status: "fyi" },
    })) as CallToolResult;
    expect(first.isError).toBeFalsy();

    // The identical repeat is rejected: the tool surfaces the thrown
    // DuplicatePostError as an `isError` result carrying its actionable text.
    const second = (await carol.callTool({
      name: "caucus_post",
      arguments: { type: "status", body: LOOP_BODY, status: "fyi" },
    })) as CallToolResult;
    expect(second.isError).toBe(true);
    expect(toolText(second)).toContain("Duplicate of your previous post");
  });

  it("AC1: the channel reads as one coherent M1 log", async () => {
    const read = toolJson<{
      messages: {
        type: string;
        target?: string;
        owner: string;
        body: string;
      }[];
    }>(
      (await bobReader.callTool({
        name: "caucus_read_channel",
        arguments: { since: 0 },
      })) as CallToolResult,
    );
    const msgs = read.messages;

    // alice's contested claim is present, owned by alice.
    const aliceClaim = msgs.filter(
      (m) => m.type === "claim" && m.target === TARGET_CONTESTED,
    );
    expect(aliceClaim).toHaveLength(1);
    expect(aliceClaim[0]?.owner).toBe("alice");

    // carol's redirect claim is present, owned by carol; NO duplicate claim of
    // the contested target was ever appended (already_claimed is a no-op write).
    const redirectClaim = msgs.filter(
      (m) => m.type === "claim" && m.target === TARGET_REDIRECT,
    );
    expect(redirectClaim).toHaveLength(1);
    expect(redirectClaim[0]?.owner).toBe("carol");

    // The steer note is present, owned by carol.
    expect(
      msgs.some((m) => m.type === "note" && m.body === STEER_BODY && m.owner === "carol"),
    ).toBe(true);

    // EXACTLY ONE loop post landed — the rejected duplicate is not in the log.
    const loopPosts = msgs.filter((m) => m.body === LOOP_BODY);
    expect(loopPosts).toHaveLength(1);
  });
});
