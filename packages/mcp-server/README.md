# @caucus/mcp-server

The Caucus **MCP server** (CAU-9+). Claude Code spawns it over stdio; it exposes
the Caucus tools (`caucus_status`, `caucus_post`, `caucus_read_channel`,
`caucus_claim`, `caucus_subscribe`, the channel discovery/create/join tools) and
routes every write through a `CaucusSession` so identity is stamped consistently
(ADR-C7).

## Configuration

The server reads three environment variables at startup:

| Env var | Required | Meaning |
| --- | --- | --- |
| `CAUCUS_TOKEN` | **yes** | This session's bearer secret (see below). Missing/blank ⇒ the server refuses to start (`ConfigError`). |
| `CAUCUS_CHANNEL` | **yes** | The channel this session joins and posts to. Auto-created at startup if absent (idempotent — concurrent sessions race cleanly). |
| `CAUCUS_URL` | no | The shared HTTP backbone's base URL. **Set ⇒ shared mode; unset ⇒ offline mode.** |

## Connecting to the shared backbone

`CAUCUS_URL` selects the backbone the session runs against (the selection lives
in the unit-tested `selectBackbone` helper in `wiring.ts`; `index.ts` stays
thin):

- **`CAUCUS_URL` set ⇒ shared mode.** The server constructs an `HttpBackbone`
  pointed at that URL and forwards `CAUCUS_TOKEN` as the `Authorization: Bearer`
  on every request. This is the mode the two-terminal demo and the turn-start
  hook require: separately-spawned MCP server processes **and** the hook then
  observe the **same** channel, because they share one store.
- **`CAUCUS_URL` unset ⇒ offline/dev mode.** The server falls back to a
  process-local `InMemoryBackbone`. Handy for offline development and isolated
  single-session runs, but it is **not shared** — a second MCP server (or the
  hook) gets its own empty store, so cross-session visibility is impossible. The
  demo therefore **requires** `CAUCUS_URL`.

### Token convention

`CAUCUS_TOKEN` is a **per-session opaque secret** (e.g. `tok-alice-secret`) — the
bearer the backbone server resolves against its `CAUCUS_TOKENS` map. Register the
literal token as the map key, with the identity it grants appended:

```
# on the MCP-server side (Claude Code .mcp.json env), per session:
CAUCUS_URL=http://127.0.0.1:4317
CAUCUS_CHANNEL=incident-42
CAUCUS_TOKEN=tok-alice-secret            # session A
CAUCUS_TOKEN=tok-bob-secret              # session B (a different terminal)

# on the backbone-server side (one shared process):
CAUCUS_TOKENS="tok-alice-secret:alice-agent:alice,tok-bob-secret:bob-agent:bob"
```

The token is the **colon-free** first segment of its `CAUCUS_TOKENS` entry (the
server splits an entry on its first colon to recover the key), so a token must
not itself contain a colon. **The server is authoritative for identity:** it
resolves the bearer and anchors `{ agent_id, owner }` onto every write
(overwriting whatever a message body claims — ADR-C7), so a spoofed `owner`
never lands in the log. Because an opaque token can't be split locally, the
server's `caucus_status` shows a cosmetic `session` placeholder for it; this is
display-only and never the secret (ADR-C12). A structured `agent:owner` token
still works (and gives a nicer local display) when you don't need the bearer to
be a secret — but **offline mode requires** the structured form, since there is
no server to anchor identity.

See [`@caucus/backbone-server` → Bearer token convention](../backbone-server/README.md#bearer-token-convention)
for the server side.
