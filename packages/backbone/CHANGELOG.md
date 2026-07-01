# @caucus/backbone

## 0.2.1

### Patch Changes

- 0b0554b: CAU-123: four error-ergonomics polish fixes from the launch QA sweep (no functional or security regressions). (1) `@caucus/backbone`: the `invalid_channel_name` / `unknown_channel` / `channel_exists` / `channel_full` error echo now routes the caller-supplied name through `sanitizeErrorFragment`, so a multi-kilobyte channel name yields a bounded error message — the control-char stripping (ADR-C12 / CAU-81) is preserved. (2) `@caucus/mcp-server`: common arg-validation failures (missing required argument, wrong type, out-of-enum value) now surface a clear, leak-free, single-line message naming the offending argument instead of the SDK's raw `-32602` "Input validation error" JSON dump; the rejected value is never echoed, and the advertised tool schemas (`tools/list`) are unchanged. (3) `@caucus/hook`: a LOCAL checkpoint-write failure (read-only home / permission denied) now emits a distinct `caucus-hook: could not persist checkpoint this turn` line instead of misattributing it to "backbone unavailable or slow"; the hook still fails open (exit 0), stdout stays `""`, and the message is value-free (ADR-C12). (4) `@caucus/mcp-server`: the `caucus_catch_me_up` markdown digest no longer backslash-escapes `(`/`)`, so body text renders `auth-timeout repro (qa5)` literally; link/heading/emphasis injection neutralization is unchanged (the `[`/`]` escaping still prevents a `](` link from forming).
  - @caucus/schema@0.2.1

## 0.2.0

### Minor Changes

- 7c376c3: CAU-18: claim lifecycle — lease expiry, heartbeat, reassignment, and an explicit done-state. The `Backbone` contract gains `reassignClaim` and `markClaimDone`; `claim` now enforces the previously-inert `lease_ttl`/`heartbeat` fields with **lazy wall-clock** expiry (no timer/sweeper) against the injectable clock. A lapsed lease frees its target on the next claim (and is overwritten, never left dangling); a holder's `heartbeat:true` renews in place (a different owner cannot steal); reassignment hands a live target to a named assignee (owner-matched authorization, ADR-C7) with the assignee as poster-asserted ledger data; done posts a `claim` message carrying `status:"resolved"` and frees the target. The MCP server adds `caucus_reassign` / `caucus_mark_done` tools and the HTTP backbone gains `/reassign` + `/done` routes (identity-anchored like `/claim`). No new wire message type, no new `status` value, no schema-version bump — everything is expressed with existing schema fields. `ClaimResult` adds one TS-only `not_held` variant for a no-op done.

### Patch Changes

- @caucus/schema@0.2.0
