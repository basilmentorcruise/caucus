#!/usr/bin/env node
/**
 * War-room demo seed (CAU-27).
 *
 * Reproducibly seeds a running backbone so the CAU-15 README demo runs from a
 * clean checkout: it creates the `war-room-incident-42` channel (idempotently),
 * posts alice's deterministic opening scene so the channel isn't empty, and —
 * with `--loop` — demonstrates the seatbelt by posting the same body twice as
 * carol and printing the actionable duplicate rejection.
 *
 * It talks to the backbone over HTTP via the built `HttpBackbone` client WITH
 * each principal's bearer token, so the seed exercises the real CAU-13 anchoring
 * path: the server stamps the token's `{ agent_id, owner }` onto every write and
 * the stored owners prove the tokens resolve. The seed NEVER bypasses anchoring.
 *
 * Prerequisites:
 *   1. `pnpm build` — this imports the workspace packages from their built
 *      `dist`, so the build must have run.
 *   2. A backbone booted with the demo tokens, e.g.
 *      `CAUCUS_TOKENS="$(...)" pnpm backbone:dev` (see this dir's README).
 *
 * Usage:
 *   node examples/war-room-demo/seed.mjs          # create channel + opening scene
 *   node examples/war-room-demo/seed.mjs --loop    # also run the seatbelt demo
 *   CAUCUS_URL=http://127.0.0.1:4317 node ... seed.mjs
 *
 * Exit code is 0 on success INCLUDING the `--loop` duplicate rejection (the
 * rejection is the expected, demonstrated outcome). It is non-zero only on an
 * unexpected failure (e.g. the backbone is unreachable or a token was rejected).
 */
import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";

import {
  CHANNEL,
  DEFAULT_URL,
  IDENTITIES,
  LOOP_BODY,
  OPENING_SCENE,
  PURPOSE,
} from "./seed.config.mjs";

const URL = process.env.CAUCUS_URL ?? DEFAULT_URL;
const LOOP = process.argv.slice(2).includes("--loop");

/** A bearer-carrying client for a demo principal, looked up by owner. */
function clientFor(owner) {
  const id = IDENTITIES.find((i) => i.owner === owner);
  if (id === undefined) {
    throw new Error(`no demo identity for owner ${JSON.stringify(owner)}`);
  }
  return new HttpBackbone(URL, { token: id.token });
}

/**
 * Create the channel, tolerating a prior run: a second `seed.mjs` must succeed
 * cleanly ("repeatable"), so an already-existing channel is a no-op, not a
 * failure. Returns `true` when this run freshly created the channel, `false`
 * when it already existed — the caller posts the opening scene only on a fresh
 * create. The opening scene is gated separately on channel EMPTINESS (see
 * main). Any other error propagates.
 */
async function ensureChannel(backbone) {
  try {
    await backbone.createChannel({
      channel: CHANNEL,
      purpose: PURPOSE,
      created_by: "alice",
    });
    console.log(`created channel ${CHANNEL}`);
    return true;
  } catch (err) {
    if (err?.code === "channel_exists") {
      console.log(`channel ${CHANNEL} already exists — reusing it (idempotent)`);
      return false;
    }
    throw err;
  }
}

/** Post alice's deterministic opening scene so the channel isn't empty. */
async function postOpeningScene(alice) {
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
}

/**
 * The seatbelt demo: carol posts the identical body twice. The first append
 * succeeds; the second trips the loop/duplicate guard (ADR-C8), which throws a
 * `DuplicatePostError`. We print the actionable message and exit 0 — the
 * rejection is the success of this demo.
 */
async function loopDemo(carol) {
  console.log("\n--- seatbelt loop demo (carol posts the same body twice) ---");
  const post = () =>
    carol.append(CHANNEL, {
      type: "status",
      agent_id: "sess-carol",
      owner: "carol",
      msg_id: newMsgId(),
      body: LOOP_BODY,
      status: "fyi",
    });

  await post();
  console.log(`carol posted: ${LOOP_BODY}`);

  try {
    await post();
    // The seatbelt MUST reject the identical repeat; reaching here is a bug.
    throw new Error(
      "expected the seatbelt to reject carol's duplicate post, but it was accepted",
    );
  } catch (err) {
    if (err?.code === "duplicate_post") {
      console.log("carol's identical re-post was REJECTED by the seatbelt:");
      console.log(`  ${err.message}`);
      return;
    }
    throw err;
  }
}

async function main() {
  console.log(`seeding ${CHANNEL} on ${URL}`);
  const alice = clientFor("alice");
  await ensureChannel(alice);
  // Gate the opening scene on EMPTINESS, not create-freshness: an MCP server's
  // startup bootstrap may have auto-created the channel empty before the seed
  // ran (CAU-12 ensureChannel). Seeding iff the log is empty is the genuine
  // idempotency — re-runs never pile up scenes, and a pre-created-but-empty
  // room still gets its opening scene.
  const { messages } = await alice.readSince(CHANNEL, 0, 1);
  if (messages.length === 0) {
    await postOpeningScene(alice);
  } else {
    console.log("channel already has messages — skipping opening scene (idempotent)");
  }

  if (LOOP) {
    await loopDemo(clientFor("carol"));
  }

  console.log("\nseed complete.");
}

main().catch((err) => {
  console.error(`seed failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
