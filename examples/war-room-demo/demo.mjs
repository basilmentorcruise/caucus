#!/usr/bin/env node
/**
 * War-room demo — the full CAU-15 walkthrough (the M1 exit demo).
 *
 * This is the scripted realization of the M1 demo definition (`docs/ROADMAP.md`):
 * two engineers' Claude Code sessions sharing one war room avoid duplicated work
 * (claim dedup), a human steer typed into one session reaches the others within a
 * turn (the hook), and the seatbelt blocks a looping post. It COMPOSES the
 * surfaces shipped by earlier tickets — it adds NO new tool, env var, or product
 * surface — and drives the real HTTP backbone exactly as the demo does:
 *
 *   - per-principal `HttpBackbone` clients carry each principal's bearer, so every
 *     write goes through the CAU-13 anchoring path (the server stamps the token's
 *     `{ agent_id, owner }` onto the message — owners can't be forged);
 *   - the REAL turn-start hook bin (`packages/hook/dist/bin.js`) is run as Claude
 *     Code runs it (env + `UserPromptSubmit` JSON on stdin) to prove the steer
 *     propagates within a turn.
 *
 * Everything channel/identity/token-shaped is imported from `seed.config.mjs`,
 * the single source of truth the seed, the docs, and the integration scenario
 * also import — change a value there and the demo, its test, and the README move
 * together.
 *
 * Prerequisites (identical to the seed — see this dir's README):
 *   1. `pnpm build` — this imports the workspace packages from their built `dist`.
 *   2. A backbone booted with the demo tokens, e.g.
 *      `CAUCUS_TOKENS="$(...)" pnpm backbone:dev`.
 *   3. `pnpm demo:seed` — so the channel + alice's opening scene exist. (This demo
 *      also seeds idempotently if you skip step 3, so a bare backbone works too.)
 *
 * Usage:
 *   pnpm demo:run
 *   CAUCUS_URL=http://127.0.0.1:4317 node examples/war-room-demo/demo.mjs
 *
 * Exit code is 0 on the FULL expected path — and the rejections (already_claimed,
 * duplicate_post) ARE the demo, so they count as success. It is non-zero only on
 * an UNexpected failure (backbone unreachable, a token rejected, or a guard that
 * should have fired but didn't).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";

import {
  CHANNEL,
  parseArgs,
  resolveUrl,
  IDENTITIES,
  OPENING_SCENE,
  PURPOSE,
} from "./seed.config.mjs";

const OVERRIDES = parseArgs(process.argv.slice(2));
const URL = resolveUrl(process.env, OVERRIDES);

/** The two work items the dedup beat contends over (CAU-15 demo strings). */
const TARGET_CONTESTED = "auth-timeout repro";
const TARGET_REDIRECT = "db-pool exhaustion";

/** The human steer carol types; the hook must carry it to bob within a turn. */
const STEER_BODY = "check if the 14:02 deploy correlates";

/** bob's Claude Code session id — the key the hook checkpoints against. */
const BOB_SESSION = "sess-bob";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");

/** A bearer-carrying client for a demo principal, looked up by owner. */
function clientFor(owner) {
  const id = IDENTITIES.find((i) => i.owner === owner);
  if (id === undefined) {
    throw new Error(`no demo identity for owner ${JSON.stringify(owner)}`);
  }
  return new HttpBackbone(URL, { token: id.token });
}

/** Print a clear banner so each of the four M1 beats is visually distinct. */
function banner(beat, title) {
  console.log(`\n=== BEAT ${beat}: ${title} ===`);
}

/**
 * Idempotent setup: ensure the channel exists and — iff its log is empty — post
 * alice's opening scene. This reuses the seed's emptiness-gating approach (gate
 * on EMPTINESS, not create-freshness) so the demo runs whether or not
 * `pnpm demo:seed` was run first, and never piles up duplicate scenes on re-run.
 */
async function ensureSetup() {
  banner(1, "idempotent setup");
  const alice = clientFor("alice");
  try {
    await alice.createChannel({
      channel: CHANNEL,
      purpose: PURPOSE,
      created_by: "alice",
    });
    console.log(`created channel ${CHANNEL}`);
  } catch (err) {
    if (err?.code === "channel_exists") {
      console.log(`channel ${CHANNEL} already exists — reusing it`);
    } else {
      throw err;
    }
  }

  const { messages } = await alice.readSince(CHANNEL, 0, 1);
  if (messages.length === 0) {
    for (const msg of OPENING_SCENE) {
      await alice.append(CHANNEL, {
        type: msg.type,
        agent_id: "sess-alice",
        owner: "alice",
        msg_id: newMsgId(),
        body: msg.body,
      });
      console.log(`alice posted ${msg.type}: ${msg.body}`);
    }
  } else {
    console.log("channel already has the opening scene — skipping (idempotent)");
  }
}

/**
 * Beat 2 (AC2) — claim dedup. alice claims the contested target and wins; carol
 * reads the channel, claims the SAME target and loses (`already_claimed`, naming
 * alice as the holder); carol redirects to different work and wins. The lost
 * claim is the dedup working — it is a RESULT, not a throw — so we discriminate
 * on `outcome`, never a try/catch.
 */
async function claimDedup() {
  banner(2, "claim dedup — no duplicate work");
  const alice = clientFor("alice");
  const carol = clientFor("carol");

  // First-write-wins claims persist for the backbone's lifetime, so on a WARM
  // backbone (a re-run without a restart) alice already holds the contested
  // target — `already_claimed` by alice herself is the same end state as a fresh
  // `granted`, and the dedup beat below (carol losing to alice) is what matters.
  const aliceClaim = await alice.claim(CHANNEL, {
    type: "claim",
    agent_id: "sess-alice",
    owner: "alice",
    msg_id: newMsgId(),
    target: TARGET_CONTESTED,
    body: `claiming ${TARGET_CONTESTED}`,
  });
  const aliceHolds =
    aliceClaim.outcome === "granted" ||
    (aliceClaim.outcome === "already_claimed" && aliceClaim.by.owner === "alice");
  if (!aliceHolds) {
    throw new Error(
      `expected alice to hold "${TARGET_CONTESTED}", got ${aliceClaim.outcome}`,
    );
  }
  console.log(
    `alice claimed "${TARGET_CONTESTED}" → ${aliceClaim.outcome === "granted" ? "granted" : "already hers (warm backbone)"}`,
  );

  // carol reads the channel FIRST (as a teammate's agent does before claiming),
  // sees alice's claim, then tries the same target anyway to prove the guard.
  const { messages } = await carol.readSince(CHANNEL, 0);
  const sawAliceClaim = messages.some(
    (m) => m.type === "claim" && m.target === TARGET_CONTESTED && m.owner === "alice",
  );
  console.log(
    `carol read the channel — alice's claim visible: ${sawAliceClaim ? "yes" : "no"}`,
  );

  const carolDup = await carol.claim(CHANNEL, {
    type: "claim",
    agent_id: "sess-carol",
    owner: "carol",
    msg_id: newMsgId(),
    target: TARGET_CONTESTED,
    body: `claiming ${TARGET_CONTESTED}`,
  });
  if (carolDup.outcome !== "already_claimed") {
    throw new Error(
      `expected carol's duplicate claim to lose, got ${carolDup.outcome}`,
    );
  }
  console.log(
    `carol claimed "${TARGET_CONTESTED}" → already_claimed (held by owner=${carolDup.by.owner})`,
  );

  // carol redirects to work nobody owns — and wins. THIS is the product: a second
  // agent avoiding redundant work because it saw the first agent's claim.
  const carolRedirect = await carol.claim(CHANNEL, {
    type: "claim",
    agent_id: "sess-carol",
    owner: "carol",
    msg_id: newMsgId(),
    target: TARGET_REDIRECT,
    body: `claiming ${TARGET_REDIRECT}`,
  });
  const carolHolds =
    carolRedirect.outcome === "granted" ||
    (carolRedirect.outcome === "already_claimed" &&
      carolRedirect.by.owner === "carol");
  if (!carolHolds) {
    throw new Error(
      `expected carol to hold "${TARGET_REDIRECT}", got ${carolRedirect.outcome}`,
    );
  }
  console.log(
    `carol redirected → claimed "${TARGET_REDIRECT}" → ${carolRedirect.outcome === "granted" ? "granted" : "already hers (warm backbone)"}`,
  );
  console.log("→ no duplicate work: carol built on what she saw instead of re-digging.");
}

/** Run the real hook bin as Claude Code runs it: env + UserPromptSubmit stdin. */
function runHookBin(home, sessionId) {
  return execFileSync("node", [HOOK_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CAUCUS_URL: URL,
      CAUCUS_CHANNEL: CHANNEL,
    },
    input: JSON.stringify({
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
    }),
    encoding: "utf8",
  });
}

/** Extract `additionalContext` from the hook's stdout JSON (throws if absent). */
function additionalContext(stdout) {
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof ctx !== "string") {
    throw new Error("hook produced no additionalContext");
  }
  return ctx;
}

/**
 * Beat 3 (AC3) — human steer propagates within a turn. We pre-mint bob's hook
 * checkpoint at head (first run injects nothing — ADR-C6, no backlog replay),
 * carol posts the steer, then bob's NEXT turn injects exactly that steer. The
 * hook runs against an ISOLATED temp HOME (never the real `$HOME`) so a stale
 * checkpoint from a prior run can't change the outcome.
 */
async function steerPropagation() {
  banner(3, "human steer reaches the other agent within a turn");
  const carol = clientFor("carol");
  const home = await mkdtemp(join(tmpdir(), "caucus-demo-hook-"));
  try {
    // bob's first turn: mint a checkpoint at head, inject nothing.
    const first = runHookBin(home, BOB_SESSION).trim();
    console.log(
      `bob's hook (first run) injected nothing: ${first === "" ? "ok" : "UNEXPECTED"}`,
    );
    if (first !== "") {
      throw new Error("expected bob's first hook run to inject nothing");
    }

    // carol (a human, via her agent) types the steer into the channel.
    await carol.append(CHANNEL, {
      type: "note",
      agent_id: "sess-carol",
      owner: "carol",
      msg_id: newMsgId(),
      body: STEER_BODY,
    });
    console.log(`carol posted note: ${STEER_BODY}`);

    // bob's NEXT turn: the hook injects the steer, attributed to carol.
    const ctx = additionalContext(runHookBin(home, BOB_SESSION));
    if (!ctx.includes(STEER_BODY) || !ctx.includes("A·carol")) {
      throw new Error("bob's hook did not inject carol's steer");
    }
    console.log("bob's hook (next turn) injected:");
    for (const line of ctx.split("\n")) console.log(`  ${line}`);
    console.log("→ the steer reached bob's agent without any manual tool call.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Beat 4 (AC4) — the seatbelt blocks a loop. carol posts an identical body twice
 * back to back; the second trips the loop/duplicate guard (ADR-C8), which THROWS
 * a `DuplicatePostError`. Unlike a lost claim, this IS a throw — we discriminate
 * on `err.code === "duplicate_post"` and print the actionable rejection. The
 * rejection is the success of this beat.
 */
async function seatbelt() {
  banner(4, "seatbelt blocks the looping post");
  const carol = clientFor("carol");
  // A unique body so re-running the demo against a warm backbone still trips the
  // guard on the SECOND of these two posts (not on the first, against history).
  const loopBody = `still seeing elevated p95 — anyone else? (${newMsgId()})`;
  const post = () =>
    carol.append(CHANNEL, {
      type: "status",
      agent_id: "sess-carol",
      owner: "carol",
      msg_id: newMsgId(),
      body: loopBody,
      status: "fyi",
    });

  await post();
  console.log(`carol posted: ${loopBody}`);

  try {
    await post();
    throw new Error(
      "expected the seatbelt to reject carol's duplicate post, but it was accepted",
    );
  } catch (err) {
    if (err?.code === "duplicate_post") {
      console.log("carol's identical re-post was REJECTED by the seatbelt:");
      console.log(`  ${err.message}`);
      console.log("→ the loop is broken before it floods the room.");
      return;
    }
    throw err;
  }
}

async function main() {
  console.log(`war-room demo on ${URL} (channel ${CHANNEL})`);
  await ensureSetup();
  await claimDedup();
  await steerPropagation();
  await seatbelt();
  console.log("\ndemo complete — all four M1 beats ran as expected.");
}

main().catch((err) => {
  console.error(`demo failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
