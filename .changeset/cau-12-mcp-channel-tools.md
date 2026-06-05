---
"@caucus/mcp-server": patch
---

CAU-12: add the channel discovery + create/join MCP tools — `caucus_list_channels`, `caucus_describe_channel`, `caucus_create_channel`, and `caucus_join_channel`.

- Discovery (`list`/`describe`) is read-only and coaches discovery-before-create (an investigation should converge on one room). `describe` defaults to the session channel and lets `unknown_channel` propagate (that IS the answer to "does this room exist?").
- `create` is the one write: it goes through a new `CaucusSession.createChannel`, which anchors `created_by` to the session owner server-side — there is no `created_by` argument to forge (ADR-C7). A duplicate name propagates the backbone's value-free `channel_exists` error.
- `join` mints a read cursor on another room (verifies it exists first, then subscribes-to-now). The session's posting channel stays fixed by `CAUCUS_CHANNEL`; join is read-only.
- Startup bootstrap: the stdio entrypoint now calls `ensureChannel(backbone, config)` before serving, so a freshly-spawned server's `CAUCUS_CHANNEL` exists and posts no longer fail with `unknown_channel` (the CAU-10 validation gap). It is idempotent and propagates non-`unknown_channel` errors.
