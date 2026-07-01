# @caucus/hook

## 0.2.1

### Patch Changes

- 0b0554b: CAU-123: four error-ergonomics polish fixes from the launch QA sweep (no functional or security regressions). (1) `@caucus/backbone`: the `invalid_channel_name` / `unknown_channel` / `channel_exists` / `channel_full` error echo now routes the caller-supplied name through `sanitizeErrorFragment`, so a multi-kilobyte channel name yields a bounded error message — the control-char stripping (ADR-C12 / CAU-81) is preserved. (2) `@caucus/mcp-server`: common arg-validation failures (missing required argument, wrong type, out-of-enum value) now surface a clear, leak-free, single-line message naming the offending argument instead of the SDK's raw `-32602` "Input validation error" JSON dump; the rejected value is never echoed, and the advertised tool schemas (`tools/list`) are unchanged. (3) `@caucus/hook`: a LOCAL checkpoint-write failure (read-only home / permission denied) now emits a distinct `caucus-hook: could not persist checkpoint this turn` line instead of misattributing it to "backbone unavailable or slow"; the hook still fails open (exit 0), stdout stays `""`, and the message is value-free (ADR-C12). (4) `@caucus/mcp-server`: the `caucus_catch_me_up` markdown digest no longer backslash-escapes `(`/`)`, so body text renders `auth-timeout repro (qa5)` literally; link/heading/emphasis injection neutralization is unchanged (the `[`/`]` escaping still prevents a `](` link from forming).
- Updated dependencies [7f6538c]
- Updated dependencies [0b0554b]
- Updated dependencies [466ffbc]
  - @caucus/backbone-server@0.2.1
  - @caucus/backbone@0.2.1
  - @caucus/schema@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [7c376c3]
- Updated dependencies [002b1f9]
  - @caucus/backbone@0.2.0
  - @caucus/backbone-server@0.2.0
  - @caucus/schema@0.2.0
