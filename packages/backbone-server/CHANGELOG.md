# @caucus/backbone-server

## 0.2.0

### Minor Changes

- 7c376c3: CAU-18: claim lifecycle — lease expiry, heartbeat, reassignment, and an explicit done-state. The `Backbone` contract gains `reassignClaim` and `markClaimDone`; `claim` now enforces the previously-inert `lease_ttl`/`heartbeat` fields with **lazy wall-clock** expiry (no timer/sweeper) against the injectable clock. A lapsed lease frees its target on the next claim (and is overwritten, never left dangling); a holder's `heartbeat:true` renews in place (a different owner cannot steal); reassignment hands a live target to a named assignee (owner-matched authorization, ADR-C7) with the assignee as poster-asserted ledger data; done posts a `claim` message carrying `status:"resolved"` and frees the target. The MCP server adds `caucus_reassign` / `caucus_mark_done` tools and the HTTP backbone gains `/reassign` + `/done` routes (identity-anchored like `/claim`). No new wire message type, no new `status` value, no schema-version bump — everything is expressed with existing schema fields. `ClaimResult` adds one TS-only `not_held` variant for a no-op done.
- 002b1f9: CAU-20: runtime token issuer — activates the ADR-C7 issuer deferral. The shared backbone server gains an in-process `TokenIssuer` (`createIssuer`) that unifies the static `CAUCUS_TOKENS` boot seed and a dynamic, runtime-minted layer behind one digest-keyed `resolve`. A new **admin-gated, loopback-only** control surface — `POST /admin/tokens` (mint), `/admin/tokens/revoke`, `/admin/tokens/rotate` — mints, revokes, and rotates per-agent bearer tokens **at runtime**, so a leaked token can be rotated or a teammate onboarded without a server restart or env edit. Gated by a new `CAUCUS_ADMIN_TOKEN` env var (digested at boot); **unset ⇒ the control surface is disabled** (fail-closed, no open mint endpoint), and a regular write token can never mint. Identity anchoring is preserved verbatim: a minted token resolves to a server-held `{agent_id, owner}` and the write routes still overwrite client-claimed identity — `tokens.ts` and all of `packages/mcp-server/*` are unchanged. Tokens stay **ephemeral** (process-memory only; a restart loses minted tokens, the seed reloads from env) and a minted token is returned **exactly once** — only its SHA-256 digest is retained (ADR-C12). Control ops never post to the channel log (ADR-C6). New public exports: `createIssuer`, `TokenIssuer`, `MintResult`, `RevokeTarget`, `RevokeResult`; `AuthContext` now carries the `issuer` (plus `adminTokenDigest`/`boundHost`) instead of the raw `tokens` map; `EnvConfig`/`ServerOptions` gain `adminTokenDigest`.

### Patch Changes

- Updated dependencies [7c376c3]
  - @caucus/backbone@0.2.0
  - @caucus/schema@0.2.0
