/**
 * Integration scenario — the war-room demo seed over a REAL tokened backbone and
 * the REAL `seed.mjs` subprocess (CAU-27).
 *
 * This is the empirical proof of CAU-27's acceptance criteria. The seed ships as
 * a runnable `.mjs` that imports the workspace packages from their built `dist`
 * and talks to the backbone over HTTP with each demo principal's bearer token,
 * so we exercise it exactly as the demo does — with TWO real subprocesses:
 *
 *   1. the backbone server runs OUT OF PROCESS
 *      (`node …/backbone-server/dist/bin.js`) on an ephemeral port, booted with
 *      the demo `CAUCUS_TOKENS` so it accepts and anchors the seed's writes;
 *   2. `seed.mjs` is spawned with `CAUCUS_URL` pointing at that server, the same
 *      way `pnpm demo:seed` runs it.
 *
 * vitest's source aliases do NOT apply to a child process, so the bins and the
 * packages the seed imports must be built first. We build the dependency closure
 * once, lazily, via `pnpm --filter @caucus/example-war-room-demo... build` so the
 * scenario works on a CLEAN checkout (the build is `tsc --build` cache-checked,
 * so a warm tree is a near-no-op).
 *
 * Asserted ACs (CAU-27):
 *  - the seed creates `war-room-incident-42` with the configured purpose;
 *  - alice's opening scene is present, anchored to her identity (server-stamped
 *    owner, proving the bearer resolved — the seed never bypasses anchoring);
 *  - a SECOND `seed.mjs` run exits 0 (repeatable / idempotent);
 *  - `--loop` prints the actionable duplicate rejection and exits 0.
 */
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The seed config is the single source of truth (a plain `.mjs` outside the TS
// build); import it so the test asserts on the SAME values the seed posts. The
// example ships no `.d.ts`, so the bare specifier resolves to `any` here.
// @ts-expect-error — no type declarations for the example's runtime `.mjs`.
import * as seedConfig from "../../../../examples/war-room-demo/seed.config.mjs";

const { CHANNEL, OPENING_SCENE, PURPOSE, tokensEnv } = seedConfig as {
  CHANNEL: string;
  OPENING_SCENE: ReadonlyArray<{ type: string; body: string }>;
  PURPOSE: string;
  tokensEnv: () => string;
};

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const SERVER_BIN = join(REPO_ROOT, "packages", "backbone-server", "dist", "bin.js");
const SEED_SCRIPT = join(REPO_ROOT, "examples", "war-room-demo", "seed.mjs");

const channel = CHANNEL;
const purpose = PURPOSE;
const openingScene = OPENING_SCENE;
const serverTokens = tokensEnv();

/**
 * Build the example + its workspace dep closure so the spawned `seed.mjs` can
 * import the packages from `dist` and the server bin exists. `...` includes the
 * dependency closure (schema → backbone → backbone-server).
 */
/** Start the backbone as its own process with the demo tokens; resolve its URL. */
function startServerProcess(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn("node", [SERVER_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      CAUCUS_TOKENS: serverTokens,
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

/** Run `seed.mjs` as `pnpm demo:seed` does: `CAUCUS_URL` + optional `--loop`. */
function runSeed(url: string, args: readonly string[] = []): string {
  return execFileSync("node", [SEED_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CAUCUS_URL: url },
    encoding: "utf8",
  });
}

describe("war-room demo seed (over HTTP, real subprocess)", () => {
  let url: string;
  let stopServer: () => void;
  // A read client needs no token (reads are open); writes go through seed.mjs.
  let reader: HttpBackbone;

  beforeAll(async () => {
    // Builds are hoisted to the integration globalSetup (global-setup.ts).
    const started = await startServerProcess();
    url = started.url;
    stopServer = started.stop;
    reader = new HttpBackbone(url);
  });

  afterAll(() => {
    stopServer?.();
  });

  it("seeds the channel + opening scene, is idempotent, and demos the seatbelt loop", async () => {
    // RUN 1 — create the channel and post alice's opening scene.
    const out1 = runSeed(url);
    expect(out1).toContain(`created channel ${channel}`);
    expect(out1).toContain("seed complete.");

    // AC: the channel exists with the configured purpose.
    const desc = await reader.describeChannel(channel);
    expect(desc.purpose).toBe(purpose);
    expect(desc.created_by).toBe("alice");

    // AC: the opening messages are present, anchored to alice's identity
    // (server-stamped owner/agent_id, proving the bearer token resolved — the
    // seed never bypasses anchoring).
    const cursor = await reader.subscribe(channel);
    // subscribe() returns the head; read from 0 to see the whole log.
    const all = await reader.readSince(channel, 0);
    expect(all.messages.length).toBe(openingScene.length);
    for (const expected of openingScene) {
      const found = all.messages.find((m) => m.body === expected.body);
      expect(found, `message missing: ${expected.body}`).toBeDefined();
      expect(found!.type).toBe(expected.type);
      expect(found!.owner).toBe("alice");
      expect(found!.agent_id).toBe("sess-alice");
    }
    // Sanity: the read consumed the whole log up to the subscribed head.
    expect(Number(cursor)).toBe(openingScene.length);


    // AC: a SECOND run is repeatable — exits 0 (execFileSync throws on non-zero),
    // reuses the existing channel, and adds NO new messages (the opening scene's
    // duplicate posts are skipped).
    const out2 = runSeed(url);
    expect(out2).toContain(`channel ${channel} already exists`);
    expect(out2).toContain("seed complete.");
    const afterRerun = await reader.readSince(channel, 0);
    expect(afterRerun.messages.length).toBe(openingScene.length);

    // AC: `--loop` runs the seatbelt demo — carol posts the same body twice; the
    // second is rejected, the script prints the actionable message and exits 0.
    const outLoop = runSeed(url, ["--loop"]);
    expect(outLoop).toContain("REJECTED by the seatbelt");
    expect(outLoop).toContain("Duplicate of your previous post");
    expect(outLoop).toContain("seed complete.");

    // The loop demo's FIRST carol post lands; the rejected duplicate does not.
    const afterLoop = await reader.readSince(channel, 0);
    expect(afterLoop.messages.length).toBe(openingScene.length + 1);
    const carolMsg = afterLoop.messages.find((m) => m.owner === "carol");
    expect(carolMsg, "carol's first loop post should be present").toBeDefined();
    expect(carolMsg!.agent_id).toBe("sess-carol");

    // PROVE anchoring (not echoing): the seed's client-sent identity happens
    // to equal the token's anchored identity, so the assertions above would
    // also pass on a server that merely echoed the body. Send a post whose
    // body claims a DIFFERENT identity with alice's bearer — the stored
    // message must carry the token's identity, never the forged one.
    const forger = new HttpBackbone(url, { token: "tok-alice" });
    await forger.append(channel, {
      type: "note",
      body: "forge probe",
      msg_id: newMsgId(),
      agent_id: "sess-mallory",
      owner: "mallory",
    });
    const afterForge = await reader.readSince(channel, 0);
    const probe = afterForge.messages.find((m) => m.body === "forge probe");
    expect(probe).toBeDefined();
    expect(probe!.owner).toBe("alice");
    expect(probe!.agent_id).toBe("sess-alice");
    expect(afterForge.messages.some((m) => m.owner === "mallory")).toBe(false);
  });

  it("posts the opening scene into a PRE-CREATED empty channel (emptiness-gating)", async () => {
    // An MCP server's startup bootstrap (ensureChannel) may auto-create the
    // demo channel EMPTY before the seed ever runs. The seed must still post
    // the opening scene — it gates on emptiness, not on create-freshness.
    const started = await startServerProcess();
    try {
      const alice = new HttpBackbone(started.url, { token: "tok-alice" });
      await alice.createChannel({
        channel,
        purpose,
        created_by: "alice",
      });
      const pre = new HttpBackbone(started.url);
      expect((await pre.readSince(channel, 0)).messages.length).toBe(0);

      const out = runSeed(started.url);
      expect(out).toContain("already exists");
      expect(out).not.toContain("skipping opening scene");

      const after = await pre.readSince(channel, 0);
      expect(after.messages.length).toBe(openingScene.length);
      expect(after.messages.every((m) => m.owner === "alice")).toBe(true);
    } finally {
      started.stop();
    }
  });
});
