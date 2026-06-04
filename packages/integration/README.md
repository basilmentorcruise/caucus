# @caucus/integration

Cross-package integration-test harness (CAU-25): boots the backbone and **≥2
simulated clients** against one shared channel, then runs the concurrent-claim,
cursor, and (future) seatbelt scenarios. Private workspace package — it publishes
nothing; it exists so backbone / MCP / hook tickets can satisfy the testing gate
without re-deriving multi-client setup.

Run it:

```sh
pnpm test:integration
```

This runs `vitest run --config vitest.integration.config.ts`, which picks up only
`packages/integration/src/**/*.itest.ts`. The unit run (`pnpm test`) deliberately
does **not** execute `.itest.ts` files, and coverage excludes this package — the
harness is test scaffolding, not gated product code.

## The seam

Everything goes through one small interface so the same scenario can run
in-process today and over HTTP/MCP later.

- `Connector` (`src/connector.ts`) — `boot()`, `connectClient(id)`,
  `teardown()`. `connectClient` returns a `ClientHandle { id, backbone }`; every
  handle from one boot wraps the **same** backbone instance (shared log +
  claim ledger), which is what makes multi-client assertions meaningful.
- `inProcessConnector()` (`src/connectors/in-process.ts`) — the only
  implementation today: one `InMemoryBackbone`.
- `Scenario` (`src/scenario.ts`) + `runScenarios()` (`src/harness.ts`) — a
  programmatic runner that boots a connector, runs scenarios, and **always**
  tears down in a `finally`.
- `finding()` / `claimMsg()` (`src/fixtures.ts`) — message builders that mint a
  fresh ULID `msg_id` via `@caucus/schema`, so scenarios don't hand-roll
  `MessageInput`.

## Adding a scenario

1. Create `src/scenarios/<name>.itest.ts` (the `.itest.ts` suffix keeps it out
   of the unit run).
2. In `beforeAll`, `boot()` an `inProcessConnector()` and `connectClient()` for
   each simulated client (use distinct `agent_id` / `owner`). In `afterAll`,
   `teardown()`.
3. Drive the handles' `backbone` (`createChannel`, `append`, `claim`,
   `subscribe`, `readSince`) and assert with vitest `expect`.

Conventions that keep scenarios correct:

- One backbone per boot, shared across handles — never one backbone per client.
- Cursors are **per-client variables owned by the test**: each client mints its
  own via `subscribe()` and carries it across `readSince()` calls.
- Order and compare by cursor / append order, never by parsing `ts`
  (`ts` is an opaque ordering token, not an ISO instant — `Date.parse(ts)` is
  `NaN`).
- Claims go through `claim()` (`type: "claim"` + non-empty `target`); `append()`
  rejects claim-typed messages.

## Adding a connector

Implement `Connector` (e.g. `src/connectors/http.ts` booting the MCP server and
returning handles whose `backbone` is a remote client). The existing scenarios
are written against the interface, so they run unchanged on the new connector
once you point them at it.
