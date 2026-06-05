---
"@caucus/mcp-server": patch
---

CAU-50: wire the MCP server entrypoint to the shared HTTP backbone via `CAUCUS_URL`.

- `CAUCUS_URL` set ⇒ the entrypoint constructs an `HttpBackbone` (from `@caucus/backbone-server`) carrying `CAUCUS_TOKEN` as its `Authorization: Bearer`; unset ⇒ the historical process-local `InMemoryBackbone` fallback (offline/dev mode). The selection lives in a thin, unit-tested `selectBackbone(env)` helper (`wiring.ts`); `index.ts` stays a thin shim.
- Token convention (security hand-off on #50): `CAUCUS_TOKEN` is a per-session **opaque** bearer secret — the colon-free first segment of a server `CAUCUS_TOKENS` entry (`<secret>:<agent>:<owner>`). Because an opaque token can't be split for local display, on the shared backbone `loadConfig` resolves a cosmetic `session` identity (display-only — the server anchors the real identity, ADR-C7; the secret never appears in it, ADR-C12). Offline mode still requires the structured `agent:owner` form, and a missing/blank token remains fatal in both modes.
- Bootstrap (`ensureChannel`) now runs over HTTP with the bearer; the already-exists race survives the wire (HTTP 409 → `ChannelExistsError` reconstruction), so concurrently-spawned sessions race the create cleanly.
- READMEs document the three env vars, the token convention, and the offline fallback.
