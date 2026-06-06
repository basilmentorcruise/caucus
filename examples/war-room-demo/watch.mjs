#!/usr/bin/env node
/**
 * `watch.mjs` — a live, IRC-window-style tail of the war-room channel
 * (CAU-65). Polls `readSince` (reads are open within the trust boundary,
 * ADR-C9) and renders each new message with the hook's own `renderMessage`,
 * so what you watch is exactly what the agents' hooks inject.
 *
 * This is demo-land human observability — to CAU-17 (the M2+ product
 * surface) what seed.mjs is to a real CLI. The AGENTS stay turn-based
 * (ADR-C4); a human polling at 1s is the "humans are the real-time layer"
 * promise made visible.
 *
 *   make watch PORT=4747
 *   pnpm demo:watch PORT=4747          # make-style args (CAU-63)
 *   CAUCUS_URL=http://127.0.0.1:4747 node examples/war-room-demo/watch.mjs
 *
 * Ctrl-C to stop. Survives a backbone restart: on connection loss it keeps
 * retrying quietly; if the backbone comes back EMPTY (in-memory state reset)
 * the cursor resets and the fresh history replays.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { HttpBackbone } from "@caucus/backbone-server";
import { renderMessage } from "@caucus/hook";
import { CHANNEL, parseArgs, resolveUrl } from "./seed.config.mjs";

const OVERRIDES = parseArgs(process.argv.slice(2));
const URL = resolveUrl(process.env, OVERRIDES);
const POLL_MS = 1000;

const backbone = new HttpBackbone(URL);

let cursor = 0;
let down = false;

console.log(`watching ${CHANNEL} on ${URL} — Ctrl-C to stop`);

/** One poll tick: print anything new; tolerate the backbone being away. */
async function tick() {
  try {
    const { messages, cursor: next } = await backbone.readSince(
      CHANNEL,
      cursor,
    );
    if (down) {
      down = false;
      console.log("--- backbone is back ---");
    }
    for (const m of messages) console.log(renderMessage(m));
    cursor = next;
  } catch (err) {
    if (err?.code === "unknown_channel") {
      // Channel not created yet (or the in-memory backbone restarted and the
      // log is gone). Reset so a re-seed replays cleanly from the top.
      if (cursor !== 0) {
        console.log("--- channel reset (backbone restarted?) — rewinding ---");
        cursor = 0;
      }
      return;
    }
    if (err?.code === "invalid_cursor") {
      // Log shorter than our cursor ⇒ state was reset under us. Rewind.
      console.log("--- channel reset (backbone restarted?) — rewinding ---");
      cursor = 0;
      return;
    }
    // Connection-level failure: announce once, retry quietly (no crash loop).
    if (!down) {
      down = true;
      console.log(`--- backbone unreachable (${URL}) — retrying ---`);
    }
  }
}

for (;;) {
  await tick();
  await sleep(POLL_MS);
}
