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
- `inProcessConnector()` (`src/connectors/in-process.ts`) — one
  `InMemoryBackbone`, in this process (zero network).
- `httpConnector()` (`src/connectors/http.ts`, CAU-5) — boots a real
  `@caucus/backbone-server` on an ephemeral port; each `connectClient` returns a
  handle whose `backbone` is an `HttpBackbone` pointed at that server, so the
  clients share the one server's log/ledger **over the wire**.
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

The `channels-join.itest.ts` scenario (CAU-5) runs over the `httpConnector` and
covers the CAU-5 acceptance criteria end-to-end (create + 3-client join,
descriptor/list correctness, mid-session join). The claim/cursor scenarios run
in-process because they exercise `claim()`, whose server-side route is CAU-7;
they will be parameterized over HTTP once that route lands.

## Adding a connector

Implement `Connector` — see `src/connectors/http.ts` (CAU-5), which boots the
HTTP backbone server and returns handles whose `backbone` is an `HttpBackbone`.
The existing scenarios are written against the interface, so they run unchanged
on a new connector once you point them at it (subject to the connector serving
the operations the scenario uses).
