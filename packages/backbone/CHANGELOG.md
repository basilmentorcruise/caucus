# @caucus/backbone

## 0.2.0

### Minor Changes

- 7c376c3: CAU-18: claim lifecycle — lease expiry, heartbeat, reassignment, and an explicit done-state. The `Backbone` contract gains `reassignClaim` and `markClaimDone`; `claim` now enforces the previously-inert `lease_ttl`/`heartbeat` fields with **lazy wall-clock** expiry (no timer/sweeper) against the injectable clock. A lapsed lease frees its target on the next claim (and is overwritten, never left dangling); a holder's `heartbeat:true` renews in place (a different owner cannot steal); reassignment hands a live target to a named assignee (owner-matched authorization, ADR-C7) with the assignee as poster-asserted ledger data; done posts a `claim` message carrying `status:"resolved"` and frees the target. The MCP server adds `caucus_reassign` / `caucus_mark_done` tools and the HTTP backbone gains `/reassign` + `/done` routes (identity-anchored like `/claim`). No new wire message type, no new `status` value, no schema-version bump — everything is expressed with existing schema fields. `ClaimResult` adds one TS-only `not_held` variant for a no-op done.

### Patch Changes

- @caucus/schema@0.2.0
