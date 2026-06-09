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
 * built first. The build is hoisted into the integration config's `globalSetup`
 * (it runs ONCE before any scenario, avoiding a `tsc --build` race between
 * parallel scenario files), so this file does not build — see
 * `packages/integration/src/global-setup.ts`.
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

/**
 * Bearer tokens the subprocess server accepts (CAU-13). The hook scenario posts
 * as TWO principals, so two tokens are configured; each `HttpBackbone` carries
 * the matching bearer and the server anchors writes to that token's identity
 * (`{ agent_id: "<who>-agent", owner: "<who>" }`).
 */
const TOK_ALICE = "tok-alice";
const TOK_BOB = "tok-bob";
const SERVER_TOKENS = `${TOK_ALICE}:alice-agent:alice,${TOK_BOB}:bob-agent:bob`;

/** Start the backbone server as its own process; resolve with its base URL. */
function startServerProcess(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn(
    "node",
    [SERVER_BIN],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", CAUCUS_TOKENS: SERVER_TOKENS },
    },
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
  // Two clients: writes are token-gated and anchored, and the scenario posts as
  // two principals, so each carries its own bearer (CAU-13).
  let backbone: HttpBackbone;
  let backboneBob: HttpBackbone;
  let home: string;
  const sessionId = "sess-hook-itest";

  beforeAll(async () => {
    const started = await startServerProcess();
    url = started.url;
    stopServer = started.stop;
    backbone = new HttpBackbone(url, { token: TOK_ALICE });
    backboneBob = new HttpBackbone(url, { token: TOK_BOB });
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
    await backboneBob.claim(CHANNEL, claim("bob-agent", "bob", "auth-timeout repro"));
    await backbone.append(CHANNEL, question("alice-agent", "alice", "did the 14:02 deploy cause this?"));
    await backboneBob.append(CHANNEL, answer("bob-agent", "bob", "yes — rollback in progress"));
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
    await backboneBob.append(CHANNEL, finding("bob-agent", "bob", "found the regressor commit"));

    // RUN 3 — shows ONLY the new message, not the already-seen five (AC2: no
    // re-injection).
    const ctx3 = additionalContext(runHookBin(home, url, sessionId));
    expect(ctx3).toContain("found the regressor commit");
    expect(ctx3).not.toContain("login accepts expired JWTs");
    expect(ctx3).not.toContain("auth-timeout repro");
  });
});

/**
 * Restart-recovery (CAU-72) — the ephemeral backbone is killed and restarted
 * with head reset to 0 while the hook's on-disk checkpoint still holds a higher
 * cursor. The pre-fix hook called `readSince(channel, stale)` ⇒ `invalid_cursor`
 * EVERY turn and stayed blind forever. The fix self-heals: it re-mints at the
 * fresh head (injecting nothing that turn) and recovers on the next.
 *
 * This is the highest-value missing test per the CAU-14 audit. It uses its own
 * server lifecycle (the original server is killed mid-scenario) and a stable
 * temp HOME so the checkpoint survives the restart, exactly mirroring the field
 * failure.
 */
describe("turn-start hook self-heals after an ephemeral-backbone restart (CAU-72)", () => {
  const CHANNEL_R = CHANNEL; // same channel name pre/post restart
  let home: string;
  const sessionId = "sess-hook-restart";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "caucus-hook-restart-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Spawn a server, create the channel, append `bodies`, return its lifecycle. */
  async function bootWithMessages(
    bodies: string[],
  ): Promise<{ url: string; stop: () => void }> {
    const started = await startServerProcess();
    const client = new HttpBackbone(started.url, { token: TOK_ALICE });
    await client.createChannel({
      channel: CHANNEL_R,
      purpose: "restart-recovery scenario",
      created_by: "alice",
    });
    for (const body of bodies) {
      await client.append(CHANNEL_R, finding("alice-agent", "alice", body));
    }
    return started;
  }

  /** Wait until the server process has actually exited (port freed). */
  function waitExit(stop: () => void): Promise<void> {
    return new Promise((res) => {
      stop();
      setTimeout(res, 300);
    });
  }

  it("re-syncs the stale checkpoint and resumes injecting fresh messages", async () => {
    // --- Incarnation 1: build a real, advanced checkpoint. ---
    const gen1 = await bootWithMessages([
      "pre-restart finding A",
      "pre-restart finding B",
      "pre-restart finding C",
    ]);

    // Pre-mint at head, then run again to advance the checkpoint PAST 0 — this
    // is the cursor that will be stale after the restart.
    expect(runHookBin(home, gen1.url, sessionId).trim()).toBe("");
    // Nothing new since the mint (mint was at head=3) ⇒ quiet, checkpoint=3.
    expect(runHookBin(home, gen1.url, sessionId).trim()).toBe("");

    // --- KILL the ephemeral backbone. The checkpoint (3) survives on disk. ---
    await waitExit(gen1.stop);

    // --- Incarnation 2: a FRESH backbone, head reset to 0, channel recreated
    // with brand-new messages. The on-disk checkpoint (3) now points past the
    // new head — the exact stale-cursor defect. ---
    const gen2 = await bootWithMessages([
      "post-restart finding X",
      "post-restart finding Y",
    ]);

    try {
      // TURN 1 after restart: the stale read throws `invalid_cursor`; the hook
      // self-heals (re-mint at the fresh head) and injects NOTHING this turn.
      // Pre-fix this turn ALSO injected nothing — but never re-minted, so every
      // later turn stayed blind. We prove recovery on the next turn.
      expect(runHookBin(home, gen2.url, sessionId).trim()).toBe("");

      // A new message arrives after the heal.
      const client2 = new HttpBackbone(gen2.url, { token: TOK_BOB });
      await client2.append(CHANNEL_R, finding("bob-agent", "bob", "post-heal finding Z"));

      // TURN 2: the session is no longer blind — it injects the fresh delta
      // (the messages appended after the re-mint), proving self-heal/recovery.
      const ctx = additionalContext(runHookBin(home, gen2.url, sessionId));
      expect(ctx).toContain("post-heal finding Z");
      // It must NOT replay the pre-restart messages (re-minted at head, no
      // backlog dump — ADR-C6).
      expect(ctx).not.toContain("pre-restart finding");
      expect(ctx).not.toContain("post-restart finding X");
    } finally {
      await waitExit(gen2.stop);
    }
  });
});
