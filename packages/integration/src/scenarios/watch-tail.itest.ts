/**
 * CAU-65 — the live room tail (`watch.mjs`), driven as a real subprocess.
 *
 * The watcher is the demo-land human-observability view: it polls
 * `readSince` and renders new messages with the hook's `renderMessage`.
 * This scenario proves the three behaviors the ticket names:
 *  - history replays once at startup,
 *  - a message posted WHILE WATCHING appears (within the poll interval),
 *    rendered with the ANCHORED identity,
 *  - the process is read-only (no token) and tears down cleanly.
 *
 * Builds are hoisted to the integration globalSetup (global-setup.ts).
 */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const SERVER_BIN = join(
  REPO_ROOT,
  "packages",
  "backbone-server",
  "dist",
  "bin.js",
);
const WATCH_SCRIPT = join(REPO_ROOT, "examples", "war-room-demo", "watch.mjs");

function startServerProcess(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn("node", [SERVER_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      CAUCUS_TOKENS: tokensEnv(),
    },
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

/** Spawn watch.mjs (read-only — deliberately NO token in its env). */
function startWatcher(url: string): {
  output: () => string;
  stop: () => void;
} {
  const child: ChildProcessWithoutNullStreams = spawn(
    "node",
    [WATCH_SCRIPT],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, CAUCUS_URL: url, CAUCUS_TOKEN: "" },
    },
  ) as ChildProcessWithoutNullStreams;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
  });
  return { output: () => buf, stop: () => child.kill() };
}

/** Poll the watcher's captured stdout until `needle` appears (or time out). */
async function waitFor(
  output: () => string,
  needle: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `watcher never printed ${JSON.stringify(needle)}; got:\n${output()}`,
  );
}

describe("war-room live tail (watch.mjs, real subprocess)", () => {
  let url: string;
  let stopServer: () => void;
  let watcher: { output: () => string; stop: () => void } | undefined;

  beforeAll(async () => {
    const started = await startServerProcess();
    url = started.url;
    stopServer = started.stop;
    const alice = new HttpBackbone(url, { token: "tok-alice" });
    await alice.createChannel({
      channel: CHANNEL,
      purpose: "watch test",
      created_by: "alice",
    });
    await alice.append(CHANNEL, {
      type: "note",
      body: "pre-watch history line",
      agent_id: "sess-alice",
      owner: "alice",
      msg_id: newMsgId(),
    });
  });

  afterAll(() => {
    watcher?.stop();
    stopServer?.();
  });

  it("replays history, then shows live posts with the anchored identity", async () => {
    watcher = startWatcher(url);

    // History replays once at startup.
    await waitFor(watcher.output, "pre-watch history line");
    expect(watcher.output()).toContain("A·alice");

    // A post made WHILE WATCHING appears within the poll interval — and is
    // rendered with the identity the SERVER anchored from bob's token, not
    // the forged one in the body.
    const bob = new HttpBackbone(url, { token: "tok-bob" });
    await bob.append(CHANNEL, {
      type: "status",
      body: "live-while-watching line",
      agent_id: "sess-mallory",
      owner: "mallory",
      msg_id: newMsgId(),
      status: "fyi",
    });
    await waitFor(watcher.output, "live-while-watching line");
    expect(watcher.output()).toContain("A·bob  live-while-watching line");
    expect(watcher.output()).not.toContain("mallory");

    // No duplicate replay: the history line appears exactly once.
    const occurrences = watcher.output().split("pre-watch history line").length - 1;
    expect(occurrences).toBe(1);
  });
});
