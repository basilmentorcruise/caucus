/**
 * Integration scenario — the Claude Code turn-start hook over a REAL backbone
 * and a REAL subprocess (CAU-14, CAU-25).
 *
 * This is the end-to-end proof of the hook's acceptance criteria. Unlike the
 * other scenarios it cannot run in-process: the hook ships as a `UserPromptSubmit`
 * COMMAND hook — Claude Code spawns it as a child process and reads its stdout.
 * So we exercise it the same way Claude Code does, with TWO real subprocesses:
 *
 *   1. the backbone server runs OUT OF PROCESS (`node …/backbone-server/dist/bin.js`)
 *      on an ephemeral port. It must be its own process: the test drives the hook
 *      via the SYNCHRONOUS `execFileSync` (mirroring Claude Code's blocking
 *      command-hook contract), which would otherwise block an in-process server's
 *      event loop and deadlock the very request the hook makes;
 *   2. the hook (`node …/hook/dist/bin.js`) is spawned per "turn" with
 *      `CAUCUS_URL` / `CAUCUS_CHANNEL` + an isolated temp `HOME`, fed the
 *      `UserPromptSubmit` JSON on stdin — exactly Claude Code's contract.
 *
 * vitest's source aliases do NOT apply to a child process, so both bins must be
 * built first. We build `@caucus/hook` (and its workspace deps, which include
 * `@caucus/backbone-server`) once, lazily, via `pnpm --filter @caucus/hook...
 * build` so the scenario works on a CLEAN checkout with no prior `dist`. The
 * build is cache-checked by `tsc --build`, so a warm tree is a near-no-op.
 *
 * Asserted ACs:
 *  - AC1/AC3: a run with a genuine delta injects the rendered lines WITH identity
 *    (`A·owner`), the claim target, and status tags.
 *  - AC2/AC4: a second run with nothing new injects NOTHING (empty stdout).
 *  - AC2: appending one more message and running again injects ONLY that one.
 *
 * (First-run mint-at-head is unit-tested in `run.test.ts`; here we pre-mint the
 * checkpoint by running the hook once before any messages, so the next run sees
 * a genuine delta — the same code path, end to end.)
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId, type MessageInput } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");
const SERVER_BIN = join(REPO_ROOT, "packages", "backbone-server", "dist", "bin.js");
const CHANNEL = "incident-hook";

/** Build the hook + its workspace deps so the spawned `dist/bin.js` files exist. */
function buildHook(): void {
  // `tsc --build` is incremental: a warm tree is a near-no-op; a clean checkout
  // builds schema → backbone → backbone-server → hook in order. `@caucus/hook...`
  // (with the trailing `...`) includes the dependency closure, so the
  // backbone-server bin is built too.
  execFileSync("pnpm", ["--filter", "@caucus/hook...", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/** Start the backbone server as its own process; resolve with its base URL. */
function startServerProcess(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn(
    "node",
    [SERVER_BIN],
    { cwd: REPO_ROOT, env: { ...process.env, PORT: "0", HOST: "127.0.0.1" } },
  ) as ChildProcessWithoutNullStreams;

  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("backbone server did not start within 10s"));
    }, 10_000);

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      // bin.ts logs: `caucus-backbone listening on http://127.0.0.1:<port>`
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

/** Run the hook bin as Claude Code would: env + `UserPromptSubmit` JSON stdin. */
function runHookBin(home: string, url: string, sessionId: string): string {
  return execFileSync("node", [HOOK_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // Windows parity for the checkpoint home
      CAUCUS_URL: url,
      CAUCUS_CHANNEL: CHANNEL,
    },
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

function finding(agent: string, owner: string, body: string): MessageInput {
  return { type: "finding", agent_id: agent, owner, msg_id: newMsgId(), body };
}
function claim(agent: string, owner: string, target: string): MessageInput {
  return { type: "claim", agent_id: agent, owner, msg_id: newMsgId(), body: `claiming ${target}`, target };
}
function question(agent: string, owner: string, body: string): MessageInput {
  return { type: "question", agent_id: agent, owner, msg_id: newMsgId(), body, status: "needs-response" };
}
function answer(agent: string, owner: string, body: string): MessageInput {
  return { type: "answer", agent_id: agent, owner, msg_id: newMsgId(), body, status: "resolved" };
}
function status(agent: string, owner: string, body: string): MessageInput {
  return { type: "status", agent_id: agent, owner, msg_id: newMsgId(), body, status: "fyi" };
}

describe("turn-start hook injection (over HTTP, real subprocess)", () => {
  let url: string;
  let stopServer: () => void;
  let backbone: HttpBackbone;
  let home: string;
  const sessionId = "sess-hook-itest";

  beforeAll(async () => {
    buildHook();
    const started = await startServerProcess();
    url = started.url;
    stopServer = started.stop;
    backbone = new HttpBackbone(url);
    home = await mkdtemp(join(tmpdir(), "caucus-hook-itest-"));
    await backbone.createChannel({
      channel: CHANNEL,
      purpose: "hook injection scenario",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    stopServer?.();
    await rm(home, { recursive: true, force: true });
  });

  it("injects new messages with identity, advances, then quiets, then shows only the newest (AC1–AC4)", async () => {
    // Pre-mint: a first run BEFORE any messages mints the checkpoint at head and
    // injects nothing (ADR-C6 — no backlog replay). This is the genuine
    // first-run path; the assertions below then exercise a real delta.
    expect(runHookBin(home, url, sessionId).trim()).toBe("");

    // Five messages arrive from two principals (alice, bob).
    await backbone.append(CHANNEL, finding("alice-agent", "alice", "login accepts expired JWTs"));
    await backbone.claim(CHANNEL, claim("bob-agent", "bob", "auth-timeout repro"));
    await backbone.append(CHANNEL, question("alice-agent", "alice", "did the 14:02 deploy cause this?"));
    await backbone.append(CHANNEL, answer("bob-agent", "bob", "yes — rollback in progress"));
    await backbone.append(CHANNEL, status("alice-agent", "alice", "watching error rate"));

    // RUN 1 — injects the delta WITH identity, claim target, and status tags
    // (AC1: appears without a manual tool call; AC3: claims/answers/status with
    // identity render legibly).
    const ctx1 = additionalContext(runHookBin(home, url, sessionId));
    expect(ctx1).toContain("login accepts expired JWTs");
    expect(ctx1).toContain('"auth-timeout repro"'); // claim target quoted
    expect(ctx1).toContain("did the 14:02 deploy cause this?");
    expect(ctx1).toContain("yes — rollback in progress");
    expect(ctx1).toContain("watching error rate");
    // Identity (agent → human) is present for both principals.
    expect(ctx1).toContain("A·alice");
    expect(ctx1).toContain("A·bob");
    // Status tags render.
    expect(ctx1).toContain("[needs-response]");
    expect(ctx1).toContain("[resolved]");
    expect(ctx1).toContain("[fyi]");

    // RUN 2 — nothing new since run 1: inject NOTHING (AC2 checkpoint advanced;
    // AC4 empty delta is quiet). Empty stdout, not an empty JSON envelope.
    expect(runHookBin(home, url, sessionId).trim()).toBe("");

    // One more message arrives.
    await backbone.append(CHANNEL, finding("bob-agent", "bob", "found the regressor commit"));

    // RUN 3 — shows ONLY the new message, not the already-seen five (AC2: no
    // re-injection).
    const ctx3 = additionalContext(runHookBin(home, url, sessionId));
    expect(ctx3).toContain("found the regressor commit");
    expect(ctx3).not.toContain("login accepts expired JWTs");
    expect(ctx3).not.toContain("auth-timeout repro");
  });
});
