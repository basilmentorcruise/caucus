// CAU-2 SPIKE — test driver. Boots the throwaway backbone and empirically
// exercises every acceptance criterion, printing measured numbers. Run:
//
//   node driver.mjs
//
// Exit code 0 = every property held; non-zero = a property failed (which would
// flip the verdict toward the Ergo-adapter fallback).
//
// Stdlib only (node:http via global fetch + child_process). No dependencies.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7459;
const BASE = `http://127.0.0.1:${PORT}`;

// --- tiny HTTP client over the cursor-polling transport -------------------
async function append(channel, msg) {
  const r = await fetch(`${BASE}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, ...msg }),
  });
  return r.json();
}
async function read(channel, cursor, limit) {
  const q = new URLSearchParams({ channel, cursor: String(cursor) });
  if (limit) q.set("limit", String(limit));
  const r = await fetch(`${BASE}/read?${q}`);
  return r.json();
}
async function claim(channel, target, agent_id, owner) {
  const r = await fetch(`${BASE}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, target, agent_id, owner }),
  });
  return r.json();
}

// --- assertion helpers ----------------------------------------------------
const results = [];
let failed = false;
function check(name, ok, detail) {
  if (!ok) failed = true;
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function pct(n) {
  return Math.round(n * 1000) / 1000;
}

async function waitHealthy(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("backbone did not become healthy");
}

async function main() {
  const child = spawn("node", [path.join(__dirname, "backbone.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (e) => {
    console.error("failed to spawn backbone", e);
    process.exit(2);
  });

  try {
    await waitHealthy();

    // =====================================================================
    // AC1 — append + read_channel(since=cursor) round-trip between TWO
    // subscribers. Subscriber B reads A's post since its own cursor.
    // =====================================================================
    const chan = "war-room-incident-42";
    // Subscriber B establishes a cursor BEFORE A posts.
    const b0 = await read(chan, 0);
    const bCursor = b0.cursor;
    // Subscriber A appends a finding.
    await append(chan, {
      type: "finding",
      agent_id: "sess-A",
      owner: "alice",
      body: "/login accepts expired JWTs — sig not re-checked.",
    });
    // Subscriber B reads since its cursor and should see exactly A's post.
    const b1 = await read(chan, bCursor);
    check(
      "AC1 append→read round-trip between two subscribers",
      b1.messages.length === 1 &&
        b1.messages[0].body.includes("expired JWTs") &&
        b1.messages[0].agent_id === "sess-A",
      `B saw ${b1.messages.length} new msg, cursor ${bCursor}→${b1.cursor}`,
    );
    // A second read by B since the advanced cursor returns nothing new.
    const b2 = await read(chan, b1.cursor);
    check(
      "AC1 re-read since advanced cursor returns no duplicates",
      b2.messages.length === 0,
      `${b2.messages.length} msgs on re-read`,
    );

    // =====================================================================
    // AC2 — claim is ATOMIC first-write-wins under N near-simultaneous
    // callers. Fire N concurrent claims at the SAME target, repeat ~100x;
    // exactly one must win each time.
    // =====================================================================
    const ITER = 100;
    const N = 8; // concurrent callers per iteration
    let exactlyOneWinnerEverywhere = true;
    let totalGranted = 0;
    const winnerHistogram = {};
    // Shuffle which agent fires in which slot each iteration so the winner is
    // not a deterministic artifact of FIFO issue-order — a genuinely
    // adversarial race where any of the N agents can win.
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    for (let i = 0; i < ITER; i++) {
      const target = `hypothesis-${i}`;
      const order = shuffle(Array.from({ length: N }, (_, k) => k));
      const callers = [];
      for (const k of order) {
        callers.push(claim(chan, target, `sess-${k}`, `human-${k}`));
      }
      const outcomes = await Promise.all(callers);
      const winners = outcomes.filter((o) => o.result === "granted");
      totalGranted += winners.length;
      if (winners.length !== 1) exactlyOneWinnerEverywhere = false;
      if (winners.length === 1) {
        const w = winners[0].claim.agent;
        winnerHistogram[w] = (winnerHistogram[w] ?? 0) + 1;
      }
      // Every loser must report already_claimed_by the SAME winning agent.
      const winnerAgent = winners[0]?.claim.agent;
      for (const o of outcomes) {
        if (o.result === "already_claimed_by" && o.by.agent !== winnerAgent) {
          exactlyOneWinnerEverywhere = false;
        }
      }
    }
    check(
      `AC2 atomic first-write-wins (${ITER} iterations × ${N} concurrent)`,
      exactlyOneWinnerEverywhere && totalGranted === ITER,
      `${totalGranted} grants over ${ITER} races (expected ${ITER}); ` +
        `winner spread ${JSON.stringify(winnerHistogram)}`,
    );

    // =====================================================================
    // AC3 — a subscribe cursor survives across SEPARATE request/response
    // (stateless, MCP-style) calls. We hold NO server-side session: the
    // client carries the cursor between discrete HTTP calls.
    // =====================================================================
    const c0 = await read(chan, 0, 1); // page 1
    const c1 = await read(chan, c0.cursor, 1); // page 2, new HTTP call, carried cursor
    const c2 = await read(chan, c1.cursor, 1); // page 3
    const monotonic = c0.cursor < c1.cursor && c1.cursor < c2.cursor;
    const noOverlap =
      c0.messages[0] &&
      c1.messages[0] &&
      c0.messages[0].seq < c1.messages[0].seq &&
      c1.messages[0].seq < (c2.messages[0]?.seq ?? Infinity);
    check(
      "AC3 cursor survives across separate stateless calls",
      monotonic && noOverlap,
      `cursors ${c0.cursor} < ${c1.cursor} < ${c2.cursor}, no overlap=${noOverlap}`,
    );

    // =====================================================================
    // AC4 — turn-based latency with 3 clients. Simulate 3 clients each doing
    // a realistic turn: read-since-cursor, post one message, read again.
    // Measure per-op latency. Seconds are acceptable; we report actuals.
    // =====================================================================
    const TURNS = 30; // turns per client
    const CLIENTS = 3;
    const latencies = [];
    async function clientTurns(idx) {
      let cur = (await read(chan, 0)).cursor;
      for (let t = 0; t < TURNS; t++) {
        const t0 = performance.now();
        await read(chan, cur); // hook-style read-since
        await append(chan, {
          type: "status",
          agent_id: `client-${idx}`,
          owner: `human-${idx}`,
          body: `turn ${t}`,
        });
        const r = await read(chan, cur);
        cur = r.cursor;
        latencies.push(performance.now() - t0);
      }
    }
    const tStart = performance.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, (_, i) => clientTurns(i)),
    );
    const wall = performance.now() - tStart;
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((s, x) => s + x, 0) / latencies.length;
    check(
      `AC4 turn latency w/ ${CLIENTS} clients (${latencies.length} turns)`,
      max < 1000, // each full turn (3 ops) well under a second — far below the "seconds OK" bar
      `p50=${pct(p50)}ms p95=${pct(p95)}ms max=${pct(max)}ms avg=${pct(avg)}ms; ` +
        `wall=${pct(wall)}ms for ${CLIENTS}×${TURNS} turns`,
    );

    // =====================================================================
    // AC1/AC6 supporting — projection rebuild sanity: the full log replays
    // and the claim ledger is reconstructable (event-log property).
    // =====================================================================
    const all = await read(chan, 0);
    const claimMsgs = all.messages.filter((m) => m.type === "claim");
    check(
      "event-log replay: claim events present & ordered by seq",
      claimMsgs.length === ITER &&
        claimMsgs.every((m, i) => (i === 0 ? true : m.seq > claimMsgs[i - 1].seq)),
      `${claimMsgs.length} claim events replayed in seq order`,
    );

    // --- emit machine-readable summary -----------------------------------
    const summary = {
      generated: new Date().toISOString(),
      node: process.version,
      transport: "HTTP + cursor polling on 127.0.0.1",
      store: "append-only event log + in-memory projections (single writer)",
      ac2: {
        iterations: ITER,
        concurrent_per_iter: N,
        total_grants: totalGranted,
        expected_grants: ITER,
        winner_spread: winnerHistogram,
      },
      ac4: {
        clients: CLIENTS,
        turns_per_client: TURNS,
        total_turns: latencies.length,
        p50_ms: pct(p50),
        p95_ms: pct(p95),
        max_ms: pct(max),
        avg_ms: pct(avg),
        wall_ms: pct(wall),
      },
      checks: results,
      all_passed: !failed,
    };
    // eslint-disable-next-line no-console
    console.log("\n===RESULTS_JSON===");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    child.kill("SIGTERM");
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
