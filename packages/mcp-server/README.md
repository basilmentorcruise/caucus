# @caucus/mcp-server

The Caucus **MCP server** (CAU-9+). Claude Code spawns it over stdio; it exposes
the Caucus tools (`caucus_status`, `caucus_post`, `caucus_read_channel`,
`caucus_claim`, `caucus_subscribe`, the channel discovery/create/join tools) and
routes every write through a `CaucusSession` so identity is stamped consistently
(ADR-C7).

This package ships **two bins**: `caucus-mcp` (the stdio server above) and
`caucus` (the `caucus init` scaffold CLI below).

## `caucus init` — scaffold a session (CAU-108)

Instead of hand-editing JSON, run `caucus init` in your project to generate the
wiring a Claude Code session needs:

```
npx caucus init --channel incident-42 --owner alice
```

It writes (and **safely merges into**) three files, with **absolute** node-bin
paths filled in:

- **`.mcp.json`** — the Caucus MCP server entry Claude Code spawns. The token is
  written as the env reference `${CAUCUS_TOKEN}` (or `${<--token-env>}`), **never
  a literal secret** (ADR-C12).
- **`.claude/settings.local.json`** — the turn-start (`UserPromptSubmit`) hook
  entry. (This is the file Claude Code reads for project-local hooks; pass
  `--settings <path>` to target another.)
- **`caucus.env`** — a sourceable env file (`export CAUCUS_URL/CAUCUS_CHANNEL` +
  an empty `CAUCUS_TOKEN=`) with a *never-commit* notice; `caucus init` also adds
  it to `.gitignore`. Command hooks inherit the **shell** environment (not
  `.mcp.json`'s `env`), so the hook needs these exported — `source ./caucus.env`
  after pasting your bearer.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url <url>` | `http://127.0.0.1:4747` | Backbone URL (literal). |
| `--channel <name>` | *(prompted; `dogfood` under `--yes`)* | Channel to join. |
| `--agent-id <id>` | `<owner>-agent` | This session's agent id. |
| `--owner <name>` | `$USER` | The human this agent acts for (ADR-C7). |
| `--token-env <NAME>` | `CAUCUS_TOKEN` | Env var **NAME** the token is referenced by. |
| `--dir <path>` | cwd | Project dir to scaffold into. |
| `--settings <path>` | `<dir>/.claude/settings.local.json` | Override the settings file. |
| `--force` | off | Merge/overwrite without prompting on conflicts. |
| `-y, --yes` | off | Non-interactive; accept defaults. |
| `--dry-run` | off | Print the plan; write nothing. |

There is **no `--token <value>` flag** — secrets are referenced by env only
(ADR-C12). Re-running is **idempotent**: an unchanged file is left untouched
("already up to date"); a changed **JSON config** file (`.mcp.json` /
`settings.local.json`) is backed up to `<path>.bak-<ts>` before merge; a corrupt
JSON file is backed up and rewritten (never merged into). The scaffold also
ignores `*.bak-*` so no backup can be committed. **`caucus.env` is special:**
because it holds your pasted bearer, a differing existing `caucus.env` is **left
exactly as-is and never backed up** (a `.bak` of it could smuggle the secret into
a committable file, ADR-C12) — reconcile `CAUCUS_URL`/`CAUCUS_CHANNEL` by hand if
they drift.

After `caucus init`, finish the wiring the scaffold can't do for you: **choose a
bearer secret** (any opaque string only you know — prefer a random value),
register it in the backbone's `CAUCUS_TOKENS` as `<secret>:<agent-id>:<owner>`,
paste the **same** secret into `caucus.env` (the empty `CAUCUS_TOKEN=` line),
`source ./caucus.env`, and start Claude Code. **A session with no token posts
nothing — silently — so don't skip the token.** `caucus.env` is gitignored;
never commit it (ADR-C12).

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
