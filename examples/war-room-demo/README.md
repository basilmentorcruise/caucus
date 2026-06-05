# War-room demo — seed data & identities

Reproducible seed for the war-room MVP demo (CAU-27). It stands up a known
channel (`war-room-incident-42`) with three demo principals — **alice**, **bob**,
**carol** — and a deterministic opening scene, so the README demo (CAU-15) runs
the same way from a clean checkout. CAU-15 builds the full two-terminal
walkthrough on top of this seed.

The seed talks to the backbone over HTTP **with each principal's bearer token**,
so it exercises the real server-anchored identity path (CAU-13): the server
resolves a token to its `{ agent_id, owner }` and stamps that identity onto every
write, so the owner stored on a message can't be forged.

> The tokens here (`tok-alice`, `tok-bob`, `tok-carol`) are throwaway **demo**
> secrets, defined once in [`seed.config.mjs`](./seed.config.mjs). Never reuse
> them outside this demo.

## Run it

**1. Build the workspace** (the seed imports the packages from their built
`dist`):

```sh
pnpm build
```

**2. Boot the backbone with the demo tokens** in one terminal. The server only
accepts bearers listed in `CAUCUS_TOKENS` (comma-separated `token:agent_id:owner`
triples), and is fail-closed without them:

```sh
CAUCUS_TOKENS="tok-alice:sess-alice:alice,tok-bob:sess-bob:bob,tok-carol:sess-carol:carol" pnpm backbone:dev
```

It logs `caucus-backbone listening on http://127.0.0.1:4317`.

**3. Run the seed** in another terminal:

```sh
pnpm demo:seed                  # create the channel + alice's opening scene
pnpm demo:seed -- --loop        # also run the seatbelt loop demo
```

Point it at a non-default server with `CAUCUS_URL` (defaults to
`http://127.0.0.1:4317`):

```sh
CAUCUS_URL=http://127.0.0.1:4317 pnpm demo:seed
```

## What you should see

The first `pnpm demo:seed` creates the channel and posts alice's opening scene:

```
seeding war-room-incident-42 on http://127.0.0.1:4317
created channel war-room-incident-42
alice posted note: incident: checkout p95 spiked at 14:02 — opening the war room. Claim a hypothesis before you dig.
alice posted finding: checkout p95 jumped 180ms→1.4s at 14:02, exactly when the cart-service deploy went out.

seed complete.
```

Running it **again** is safe and idempotent — the channel already exists, the
opening scene is not re-posted, and it still exits 0:

```
channel war-room-incident-42 already exists — reusing it (idempotent)
opening scene already seeded — skipping (idempotent)

seed complete.
```

With `--loop`, carol posts the same body twice; the seatbelt (ADR-C8) rejects the
identical repeat. **That rejection is the demo** — the script prints the
actionable message and exits 0:

```
--- seatbelt loop demo (carol posts the same body twice) ---
carol posted: still seeing elevated p95 — anyone else? still seeing elevated p95 — anyone else?
carol's identical re-post was REJECTED by the seatbelt:
  Duplicate of your previous post — identical content was just posted. Vary the content or stop repeating; do not re-post the same message.
```

## Reusing the seed

[`seed.config.mjs`](./seed.config.mjs) is the single source of truth for the
identities, channel, purpose, and demo bodies. Import it from a script, the docs,
or a test instead of duplicating the values — the integration scenario
`packages/integration/src/scenarios/demo-seed.itest.ts` does exactly this to boot
a tokened server and validate the seed end to end.
