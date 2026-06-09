#!/usr/bin/env node
/**
 * `watch.mjs` — a live, IRC-window-style tail of a war-room channel
 * (CAU-65; made generic in CAU-67). Polls `readSince` (reads are open within
 * the trust boundary, ADR-C9) and renders each new message with the hook's own
 * `renderMessage`, so what you watch is exactly what the agents' hooks inject.
 *
 * This is demo-land human observability — to CAU-17 (the M2+ product
 * surface) what seed.mjs is to a real CLI. The AGENTS stay turn-based
 * (ADR-C4); a human polling at 1s is the "humans are the real-time layer"
 * promise made visible.
 *
 *   make watch PORT=4747                       # the demo channel (default)
 *   make watch CHANNEL=dogfood PORT=4747       # any named channel
 *   make watch CHANNEL='*' PORT=4747           # ALL channels, multiplexed
 *   pnpm demo:watch --all PORT=4747            # `--all` is the CLI form of CHANNEL='*'
 *   CAUCUS_CHANNEL=dogfood node examples/war-room-demo/watch.mjs
 *
 * Channel selection mirrors URL selection: `CHANNEL=` arg wins, then
 * `CAUCUS_CHANNEL` env, then the demo channel. Ctrl-C to stop. Survives a
 * backbone restart: on connection loss it keeps retrying quietly; if the
 * backbone comes back EMPTY (in-memory state reset) cursors reset and the
 * fresh history replays. In `--all` mode, channels created after launch are
 * picked up on the next poll.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { HttpBackbone } from "@caucus/backbone-server";
import { renderMessage } from "@caucus/hook";
import {
  isWatchAll,
  parseArgs,
  resolveChannel,
  resolveUrl,
  WATCH_ALL_FLAG,
} from "./seed.config.mjs";

const ARGV = process.argv.slice(2);
// `--all` is a recognized flag, not an unknown arg (keeps CAU-61 loud rejection).
const OVERRIDES = parseArgs(ARGV, [WATCH_ALL_FLAG]);
const URL = resolveUrl(process.env, OVERRIDES);
const ALL = isWatchAll(ARGV, process.env, OVERRIDES);
const SINGLE_CHANNEL = ALL ? null : resolveChannel(process.env, OVERRIDES);
const POLL_MS = 1000;

const backbone = new HttpBackbone(URL);

// Per-channel cursor (one entry in single-channel mode, many under `--all`).
const cursors = new Map();
let down = false;

function announceDown(detail) {
  if (!down) {
    down = true;
    console.log(
      `--- backbone unreachable (${URL})${detail ? ` — ${detail}` : ""} — retrying ---`,
    );
  }
}
function announceUp() {
  if (down) {
    down = false;
    console.log("--- backbone is back ---");
  }
}

/**
 * Print a channel's new messages and advance its cursor. Under `--all`,
 * `label` swaps the fixed `[caucus]` tag for `[<channel>]` so rooms are
 * distinguishable in one stream.
 */
async function tickChannel(channel, label) {
  const since = cursors.get(channel) ?? 0;
  try {
    const { messages, cursor: next } = await backbone.readSince(channel, since);
    announceUp();
    for (const m of messages) {
      const line = renderMessage(m);
      console.log(label ? line.replace("[caucus]", `[${channel}]`) : line);
    }
    cursors.set(channel, next);
  } catch (err) {
    if (err?.code === "unknown_channel") {
      // Not created yet, or the in-memory backbone restarted and the log is
      // gone. Reset so a re-seed replays cleanly from the top.
      if (since !== 0) {
        console.log(`--- ${channel}: reset (backbone restarted?) — rewinding ---`);
        cursors.set(channel, 0);
      }
      return;
    }
    if (err?.code === "invalid_cursor") {
      // Log shorter than our cursor ⇒ state was reset under us. Rewind.
      console.log(`--- ${channel}: reset (backbone restarted?) — rewinding ---`);
      cursors.set(channel, 0);
      return;
    }
    announceDown(); // connection-level failure: retry quietly, no crash loop.
  }
}

/** One poll tick: a single channel, or every channel under `--all`. */
async function tick() {
  if (!ALL) {
    await tickChannel(SINGLE_CHANNEL, false);
    return;
  }
  let channels;
  try {
    channels = await backbone.listChannels(); // discover new rooms each tick
    announceUp();
  } catch {
    announceDown("listing channels");
    return;
  }
  for (const c of channels) await tickChannel(c.channel, true);
}

console.log(
  ALL
    ? `watching ALL channels on ${URL} — Ctrl-C to stop`
    : `watching ${SINGLE_CHANNEL} on ${URL} — Ctrl-C to stop`,
);

for (;;) {
  await tick();
  await sleep(POLL_MS);
}
