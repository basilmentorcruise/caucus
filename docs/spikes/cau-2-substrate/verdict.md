# CAU-2 — Substrate spike verdict

**Ticket:** [CAU-2 / #2](https://github.com/basilmentorcruise/caucus/issues/2) ·
**ADR under test:** [ADR-C2](../../DECISIONS.md#adr-c2--substrate-lightweight-purpose-built-backbone-not-an-ergo-fork) ·
**Prior-art input:** [CAU-21 / #21](https://github.com/basilmentorcruise/caucus/issues/21) (airc) ·
**Date:** 2026-06-03 · **Node:** v20.20.2 · **Status:** complete.

This is a time-boxed, throwaway spike. Every claim below is backed by an actual
run of the prototype in [`assets/`](assets/) (`node driver.mjs`), not inferred.
The prototype is **not** the real backbone (that is CAU-4+, gated on the demand
probes per ADR-C11).

---

## Verdict: **GO** for the lightweight purpose-built backbone (ADR-C2 confirmed)

All four core properties the spike was meant to de-risk held empirically, with
large margins. **No core property was surprisingly hard; none failed.** The
Ergo-adapter fallback is therefore **not** triggered — but the reversibility
seam (an interface the MCP server depends on, see *Implications for CAU-4*)
stays in place per ADR-C2.

- **Transport:** **HTTP + cursor polling on localhost** (JSON request/response).
  Confirmed as the default; chosen and justified below.
- **Store shape:** **append-only event log + in-memory projections, single
  writer.** Chosen over a naive mutable store; rationale below, informed by
  CAU-21.

---

## What was demonstrated (empirical) vs inferred (honest split)

**Demonstrated by an actual run** (numbers from `node driver.mjs`, this branch):

| # | Property | Result |
|---|----------|--------|
| AC1 | Append + `read(since=cursor)` round-trip between **two** subscribers | PASS — B established a cursor, A appended a finding, B read exactly 1 new msg (cursor 0→1); re-read since the advanced cursor returned **0** duplicates. |
| AC2 | `claim` atomic **first-write-wins** under near-simultaneous callers | PASS — **100 iterations × 8 concurrent claims** on the same target, **shuffled issue-order**: exactly **100 grants over 100 races** (one per target), every loser reported `already_claimed_by` the same winner. Winner spread across all 8 agents (`sess-0..7`: 13/16/11/13/12/8/15/12), so the single winner is **not** a FIFO artifact. |
| AC3 | Subscribe cursor survives across **separate** (stateless, MCP-style) calls | PASS — cursor carried client-side across 3 discrete HTTP request/response calls; strictly monotonic (1 < 2 < 3) with no message overlap between pages. Server holds **no** per-session state. |
| AC4 | Turn-based latency with **3** clients | PASS — 3 concurrent clients × 30 turns (each turn = read-since-cursor → post → read), **90 turns total**: **p50 = 1.16 ms, p95 = 3.35 ms, max = 4.33 ms, avg = 1.38 ms**; 42.7 ms wall for all 90 turns. The "seconds are OK" bar is met with ~1000× headroom. |
| AC6 (support) | Event-log replay / projection rebuild | PASS — full log replays in `seq` order; all 100 claim events present and ordered; the claim ledger is a reconstructable projection of the log. |

Raw output of the run is reproducible with `node driver.mjs`; the driver also
prints a `RESULTS_JSON` block with the same numbers.

**Inferred, NOT demonstrated by this spike (called out honestly):**

- **Latency under real network / real MCP framing.** AC4 measured loopback HTTP
  on one machine with a trivial in-memory store. Real deployments add MCP
  JSON-RPC framing and possibly a non-loopback hop. The headroom (ms vs the
  "seconds OK" bar) makes this a safe inference, but it is an inference.
- **Atomicity under a *multi-process / multi-threaded* writer.** AC2's
  correctness rests on the **single-writer + no-`await`-mid-claim** invariant
  (Node's single-threaded event loop serializes the check-then-append). This is
  demonstrated for a single process. It does **not** generalize to a clustered
  or worker-threaded writer — that would need a real CAS (e.g. a SQLite unique
  constraint / transaction). See *Implications for CAU-4*.
- **Durability / crash recovery.** The prototype log is in-memory only; nothing
  was persisted or recovered. Durability is a CAU-4 concern, not a spike one.
- **Seatbelts, identity anchoring, lease-TTL enforcement.** Out of spike scope;
  not exercised here.

---

## Transport: HTTP + cursor polling on localhost — chosen, justified

**Decision: confirm the ADR-C2 / ticket default — HTTP + cursor polling on
localhost, JSON request/response.**

Why it fits Caucus specifically:
- **Turn-based, not streaming (ADR-C4).** Agents catch up at turn start via the
  hook and before claiming; there is no sub-second autonomous bus. A request/
  response *pull* (read-since-cursor) maps 1:1 onto that loop. We do **not** need
  WebSockets/SSE/long-poll for MVP — they would add a persistent-connection and
  reconnection surface for a real-time-ness we deliberately don't want.
- **Stateless ⇒ cursor-survival is free.** Because the cursor lives client-side
  and is passed back on each call (AC3), the transport needs no sticky sessions.
  This is exactly the MCP request/response shape; the MCP server can be a thin
  client of these endpoints.
- **Trivial, observable, debuggable.** Plain JSON over HTTP is `curl`-able and
  needs no client library. The spike server is < 200 lines of Node stdlib.
- **Localhost / intra-team (ADR-C9).** v1 is single-server, intra-team; no
  federation. Localhost (or a single shared host) is the whole deployment target,
  so HTTP's simplicity wins and TLS/federation concerns are out of scope.

Alternatives weighed and rejected for MVP: WebSocket/SSE push (real-time we
don't need, more connection state); a message broker (operational weight for a
single-process intra-team tool); gist/file substrate (see below — bounded out by
CAU-21).

---

## Store: append-only event log + projections vs a naive store — chosen, justified

**Decision: append-only event log + projections, single writer.** Evaluated
directly against a naive mutable store (e.g. `Map<channel, Message[]>` for the
log plus a separate mutable `claimOwner` map).

The prototype implements the event-log shape: `log` is the single source of
truth (an ordered, append-only array); the **claim ledger and channel list are
projections folded from it**, and the read cursor is just a log offset. The
spike confirmed (AC6) the log replays in order and the claim projection is
reconstructable from the log alone.

Why event-log + projections wins for Caucus:

1. **The cursor *is* the log offset.** `read(since=cursor)` is an ordered slice
   with a naturally monotonic cursor (AC1/AC3). A naive per-channel array can do
   this too, but the event log makes "one global order + per-subscriber offset"
   the native, not bolted-on, model.
2. **Claims and the message feed are the same events.** ADR-C5 requires a granted
   claim to *also* appear as a `claim` message so the hook surfaces it. In the
   event-log shape this is **one append** that simultaneously (a) updates the
   claim projection and (b) becomes a feed message — no dual-write to keep
   consistent. A naive store would write the ledger and *separately* append a
   message, opening a consistency gap.
3. **Auditability / postmortem record.** ADR-C1's defensibility target is the
   structured investigation record. An append-only log *is* that record by
   construction; projections are derived views. A naive mutable store loses
   history on mutation.
4. **First-write-wins is trivial at the projection.** "Is this target already
   claimed?" is a single projection lookup before the append; the append is the
   commit. (AC2.)

**Informed by CAU-21 (airc):** airc's own pivot from a shared-gist file (no CAS,
~80% loss under concurrent bursts before mitigation, ~15 s poll lag, ~240
req/hr/peer cap) to a **single-writer SQLite event store** is direct prior-art
validation of this shape. The gist/file-as-substrate option is therefore
**bounded out**: it is serverless and inspectable but laggy, rate-capped, and
racy — the opposite of the atomic-claim + low-latency properties this spike just
demonstrated. Our spike confirms the *event-log* half of airc's pivot in JS;
their experience confirms the *single-writer + real-CAS-when-persisted* half we
defer to CAU-4.

**Naive store — when it would have been fine:** if claims and the feed were
independent and we never needed replay/audit, a naive `Map` of arrays is less
code. They are *not* independent (point 2), and we *do* want the audit record
(point 3), so the event log is the better fit at the same order of complexity.

---

## Implications for CAU-4 (backbone interface contract)

The spike validates the interface already sketched in
[ARCHITECTURE.md](../../ARCHITECTURE.md). Concretely, CAU-4 should:

1. **Keep the interface seam** (`append` / `readSince` / `claim` / `subscribe` /
   channel ops) so the purpose-built backbone stays swappable for an Ergo-backed
   adapter — the GO does not remove ADR-C2's reversibility requirement.
2. **Cursor = opaque monotonic offset**, carried client-side; the server stays
   stateless across calls (no sticky sessions). `readSince` returns
   `{ messages, cursor }`.
3. **Single-writer + real CAS on persistence.** The spike's atomicity comes from
   a single-threaded, no-`await`-mid-claim writer. When CAU-4 adds **durability**
   (a persisted store — SQLite is the natural choice, per CAU-21), the
   check-then-append must be a single transaction / unique-constraint CAS, **not**
   a read-then-write across an `await`. This is the one place a naive port would
   reintroduce the race the spike avoided — flag it in the CAU-4 design.
4. **Claim grant emits a `claim` message in the same append** (ADR-C5): keep
   claim-ledger update and feed-message creation a single event to avoid a
   dual-write consistency gap.
5. **Transport: HTTP + cursor polling**, JSON request/response, localhost/
   single-host. Do not add WebSocket/SSE for MVP.
6. **Out of spike scope, still required at CAU-4:** durability/recovery, identity
   anchoring (ADR-C7), seatbelts (ADR-C8), and the lease-TTL *schema* (enforcement
   is M2 / CAU-18).

---

## Ergo-adapter fallback

**Not triggered.** No core property failed; the purpose-built lean is confirmed.
Per ADR-C2 the Ergo-backed adapter remains a documented, reversible fallback
behind the same interface (item 1 above) should free IRC-client observability
ever become worth the protocol hop — but nothing in this spike pushes us toward
it.

---

## How to reproduce

```sh
cd docs/spikes/cau-2-substrate/assets
node driver.mjs      # Node >= 20; no install; exit 0 = all properties held
```

See [`assets/README.md`](assets/README.md) for endpoint and check details.
