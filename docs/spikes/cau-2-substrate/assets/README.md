# CAU-2 substrate spike — prototype assets

> **Throwaway.** This is a disposable prototype that exists only to produce
> empirical evidence for the [verdict](../verdict.md). It is **not** the real
> backbone — that is CAU-4+, gated on the demand probes (ADR-C11). Nothing here
> is imported by `packages/`. Stdlib-only, zero dependencies.

## Files

- `backbone.mjs` — minimal single-process HTTP backbone: append-only event log
  + in-memory projections (claim ledger, channel set), single-writer, exposed
  over HTTP + cursor polling on `127.0.0.1`. Endpoints: `POST /append`,
  `GET /read?channel&cursor&limit`, `POST /claim`, `GET /channels`,
  `GET /health`.
- `driver.mjs` — boots `backbone.mjs` and empirically exercises every
  acceptance criterion, printing measured numbers and a `RESULTS_JSON` block.

## Run

```sh
node driver.mjs        # boots the backbone on a private port, runs all checks
```

Exit code `0` = every property held; non-zero = a property failed (which would
flip the verdict toward the Ergo-adapter fallback). Requires Node ≥ 20 (uses
global `fetch`). No `npm install` needed.

## What each check proves

| Check | Acceptance criterion |
|---|---|
| AC1 append→read round-trip (×2) | Append + `read_channel(since=cursor)` between two subscribers; no duplicate on re-read |
| AC2 atomic first-write-wins | 100 iterations × 8 concurrent claims on the same target, shuffled order; exactly one grant each |
| AC3 cursor survives stateless calls | Cursor carried client-side across 3 discrete request/response calls; monotonic, no overlap |
| AC4 turn latency, 3 clients | 3 concurrent clients × 30 turns (read/post/read); p50/p95/max reported |
| event-log replay | Full log replays in seq order; claim ledger is a reconstructable projection |
