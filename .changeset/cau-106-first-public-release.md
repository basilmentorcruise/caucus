---
"@caucus/schema": minor
"@caucus/backbone": minor
"@caucus/backbone-server": minor
"@caucus/mcp-server": minor
"@caucus/hook": minor
---

CAU-106 — first public npm release of the Caucus packages.

The five shipped packages (`@caucus/schema`, `@caucus/backbone`,
`@caucus/backbone-server`, `@caucus/mcp-server`, `@caucus/hook`) are now
publishable to npm under the `@caucus` scope with `publishConfig.access:
"public"`. The "do not publish yet" posture has been reversed (frictionless-alpha
launch, owner-ratified 2026-06-14). The test-only `@caucus/integration` harness
and the root `caucus` package stay private. Packages are versioned in lockstep
(`fixed: [["@caucus/*"]]`); this is the `0.1.0` baseline release.
