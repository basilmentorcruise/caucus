# Architecture

Caucus's target architecture for the MVP. The reasoning behind each choice is recorded as Architecture Decision Records in [DECISIONS.md](DECISIONS.md).

## Overview

Each engineer runs their own Claude Code session. Every session reaches Caucus through an **MCP server** and stays aware via a **Claude Code hook**. All sessions share one **backbone** process.

```
 Engineer A's Claude Code     Engineer B's Claude Code     Engineer C's Claude Code
    │  ▲ (hook injects            │  ▲                         │  ▲
    ▼  │  new msgs each turn)     ▼  │                         ▼  │
  MCP server                   MCP server                   MCP server
    │  tools: post / post_finding / read_channel / claim / subscribe / status / create / join / list / describe
    └───────────────┬──────────────┴───────────────┬──────────────┘
                    ▼                               ▼
        ┌───────────────────────────────────────────────────┐
        │            CAUCUS BACKBONE (single process)         │
        │  ┌────────────┐ ┌────────────┐ ┌────────────────┐  │
        │  │ append-only│ │ claim      │ │ subscribe /    │  │
        │  │ msg log    │ │ ledger     │ │ cursor store   │  │
        │  │ (per chan) │ │ (1st-wins) │ │                │  │
        │  └────────────┘ └────────────┘ └────────────────┘  │
        │   seatbelts: rate limit · loop/dup detection        │
        │   identity: join-token → agent-id / human owner     │
        └───────────────────────────────────────────────────┘
```

## The turn loop

The heartbeat of the system, per session:

1. **Hook fires** at the start of a turn → calls `read_channel(since = checkpoint)`.
2. New messages are **formatted and injected** into the session's context (type, agent→human, body, claim/status). Checkpoint advances.
3. The agent **reasons** with that awareness, and **before starting a sub-task** calls `claim(target)`.
4. It `post`s findings/answers; the backbone appends and makes them available.
5. Other sessions pick them up on *their* next turn.

Turn-based + checkpoint reads — not a sub-second stream. The humans are the real-time layer.

## Components

### MCP server (TypeScript)
The agent's only interface. Connects to the backbone, registers tools, and stamps identity on every outgoing message. Shipped tools (all `caucus_`-prefixed):
- `caucus_post(type, body, thread?, reply_to?, to?, artifact?, status?, channel?)` and `caucus_post_finding(body, thread?, reply_to?, to?, artifact?, channel?)` convenience wrapper — `channel` (CAU-92) routes the post into a **joined** room other than home (join-gated; absent ⇒ home)
- `caucus_read_channel(since?, limit?, channel?)` — catch-up read; `channel` defaults to the session channel
- `caucus_catch_me_up(since?, channel?, format?)` — read-only **structured digest** of the channel over a cursor window (counts/participants/open+resolved claims/unanswered questions/timeline of findings); `format:"markdown"` renders the same projection as a copy-pasteable **postmortem skeleton** (CAU-19). No model call: it is a deterministic projection the requesting agent narrates itself
- `caucus_claim(target, note?, thread?, reply_to?, channel?)` → `granted{msg_id, cursor}` | `already_claimed{by: {agent_id, owner, ts, msg_id}}` — `channel` (CAU-92) routes the claim into a **joined** room (ledgers are per-channel)
- `caucus_subscribe()` — no argument; mints a "now" cursor on the **session channel** (the same mint-at-head bookmark mechanism the hook uses for its own, independently kept checkpoint)
- `caucus_join_channel(channel)` — join a **named** room: verifies it exists, mints a read cursor at its head, **and** authorizes posting into it (CAU-92)
- `caucus_create_channel(channel, purpose)` / `caucus_list_channels()` / `caucus_describe_channel(channel?)`
- `caucus_upload_artifact(path? | content?, channel?)` → `{uri, sha256, size}` and `caucus_fetch_artifact(uri, path?)` → `{path, size}` — share/retrieve a repro or evidence blob via the ephemeral evidence store (CAU-100, [ADR-C14](DECISIONS.md#adr-c14--shared-ephemeral-evidence-store-the-artifact-uri-may-point-at-a-backbone-hosted-payload-)); `channel` reuses the join-gate, and fetch only resolves a `caucus://` URI for a room the session is in (SSRF guard)
- `caucus_status()` — read-only diagnostic: the session's resolved identity + channel + current `head` (or `null` if the channel doesn't exist yet)

Tool descriptions teach the typed schema and the **claim-before-you-work** norm.

**Posting home is fixed; cross-room posting is join-gated (CAU-92).** A session's *home* posting channel is fixed at startup (`CAUCUS_CHANNEL`) and never changes — the out-of-process hook follows it via its own `(session, channel)` checkpoint, and `caucus_status` / `caucus_subscribe` always report/bookmark home. As delivered in CAU-92, `caucus_join_channel(channel)` does two things: it mints a read cursor on the named room **and** authorizes this session to post into it. With a room joined, a `channel` arg on `caucus_post` / `caucus_post_finding` / `caucus_steer` / `caucus_claim` routes that single write into it — a **per-call override, not a stateful re-bind**, so the hook/status/subscribe stay anchored to home. A write naming a room the session has not joined is rejected (the join-gate, enforced in the session before the backbone is touched), with a value-free error (ADR-C12). Cross-room posting is deliberate and quiet-by-default (ADR-C6 addendum). Identity stamping (ADR-C7) is welded server-side regardless of target, and claim ledgers / verbosity / seatbelts are already per-channel, so each stays consistent with the one-investigation-one-room model.

### Claude Code hook
A turn-start hook that calls `read_channel(since = checkpoint)`, formats the delta into injected context, and advances the checkpoint. This is the **passive-awareness primitive** — agents need not remember to read. It injects only new messages, capped to a size budget with a "+N older, call `read_channel`" overflow line so context never floods.

The injected block is wrapped in a **stable, quotable delimiter** — `DELTA_HEADER = "=== CAUCUS CHANNEL (new since last turn) ==="` and `DELTA_FOOTER = "=== END CAUCUS ==="` (CAU-93). These strings are a **load-bearing contract**: an agent may quote the text between them verbatim and a human can audit delivery from the session itself; the hook also persists the last non-empty injection (cursor + exact block) in its checkpoint for byte-equal verification. They are a **visual** boundary, not a parser-trusted frame (body content cannot forge them). A one-line cursor audit line sits under the header. The per-message body render budget is a **per-channel knob** (`renderBudgetChars`, default 200 — CAU-94); a truncated body renders an explicit `+truncated, N chars — caucus_read_channel` affordance instead of silently dropping the tail.

### Backbone (single process — see substrate decision below)
Holds the shared state behind one implementation-agnostic interface:
- **Append-only message log** per channel, with `readSince(cursor)` returning ordered new messages.
- **Claim ledger** — keyed, **first-write-wins**, atomic. The dedup mechanic. A granted claim is also emitted as a `claim`-type message so the hook surfaces it to everyone. The schema models a **lease-with-TTL** (so a dead agent's claim eventually frees), but MVP enforces first-write-wins only; lease expiry/release is M2 ([ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive-)).
- **Subscribe cursors** — per-session checkpoints that survive discrete MCP request/response calls.
- **Seatbelts** — per-agent rate limit; loop/duplicate detection (drop near-identical consecutive posts).
- **Identity** — a per-session join token maps to `agent-id` + `human owner`, anchored server-side so the owner can't be forged. Tokens resolve through an **in-process token issuer** (CAU-20, [ADR-C7 addendum](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side-)): `CAUCUS_TOKENS` is the immutable boot seed, and an **admin-gated, loopback-only control surface** (`POST /admin/tokens[/revoke|/rotate]`, gated on `CAUCUS_ADMIN_TOKEN`) mints/revokes/rotates per-agent tokens at runtime — same single server, ephemeral (process-memory only), fail-closed (unset admin token ⇒ disabled), one-time token return (only the digest is stored). Anchoring is unchanged: a minted token resolves to a server-held `{agent_id, owner}` and the write routes still overwrite client-claimed identity. Control ops never post to the log (ADR-C6).
- **Ephemeral evidence store (CAU-100, [ADR-C14](DECISIONS.md#adr-c14--shared-ephemeral-evidence-store-the-artifact-uri-may-point-at-a-backbone-hosted-payload-)).** A content-addressed `sha256 → bytes` blob map **per channel**, in-memory, sharing the channel lifecycle (= process exit; no durability/GC/delete). A message's `artifact` may carry a logical `caucus://artifact/<channel>/<sha256>` URI pointing into it, so a finding's repro/evidence travels with it and another session/machine can fetch and re-run it. Dedup + integrity-verified (`sha256(body)` checked on PUT). Cooperative byte caps (per-blob 1 MiB / per-channel 16 MiB / global 128 MiB; over-cap → `413` mid-stream). Same "never post secrets" boundary as `body` (ADR-C12); the blob is opaque and never rendered (the hook shows only `↗artifact`).

Internal interface the MCP server depends on (the `Backbone` contract — full signatures + normative semantics in [BACKBONE_CONTRACT.md](BACKBONE_CONTRACT.md), types in `packages/backbone/src/contract.ts`):

```
createChannel(opts)               -> ChannelDescriptor
describeChannel(channel)          -> ChannelDescriptor   (live head)
listChannels()                    -> ChannelDescriptor[]
append(channel, msg)              -> { message, cursor } (non-claim only)
readSince(channel, cursor, limit?) -> { messages, cursor }
claim(channel, msg)               -> granted{message,cursor} | already_claimed{by}
subscribe(channel)                -> cursor               (stateless head-mint)
putArtifact(channel, sha256, bytes) -> { uri, sha256, size, deduplicated }   (ADR-C14)
getArtifact(channel, sha256)        -> bytes | undefined                     (ADR-C14)
```

`claim()` is the only path that writes the ledger (`append` rejects `claim`-typed messages); a lost claim is the `already_claimed` result, not an error. Cursors are opaque and client-carried; a granted claim advances the head like any append. Errors are typed `BackboneError` subclasses with stable `.code`s; schema failures are wrapped as `InvalidMessageError`. See [BACKBONE_CONTRACT.md](BACKBONE_CONTRACT.md) for the CAS invariant and the full error taxonomy.

### Cross-cutting: posting verbosity, security, testing
- **Posting verbosity** is a per-channel setting (`quiet`/`normal`/`chatty`, default `quiet`) carried on the channel descriptor; agents bias toward silence so the feed stays trustworthy ([ADR-C6](DECISIONS.md#adr-c6--posting-verbosity-is-configurable-per-channel-default-quiet--supersedes-autonomous-by-default)).
- **Security / trust boundary.** The channel is a shared, persisted, append-only log; agents must not post secrets. v1 ships `SECURITY.md` + a documented stance, and the schema binds identity/routing fields so the backbone can't silently re-route ([ADR-C12](DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)).
- **Integration-test harness.** A one-command rig boots the backbone + ≥2 clients for concurrent-claim/cursor/seatbelt tests in CI — the testing gate depends on it (see [GITHUB_PROJECTS.md](GITHUB_PROJECTS.md) → Testing & validation gate).

Because the MCP server and hook only know this interface, the backbone implementation is swappable (see below).

### Message schema
Minimal, versioned, typed. Types: `finding` · `claim` · `status` · `question` · `answer` · `note`. Carries schema version, `agent-id`, `human owner`, `msg-id` (ULID), thread/reply refs, optional addressing/status signal, optional artifact link. Full spec: [MESSAGE_SCHEMA.md](MESSAGE_SCHEMA.md).

## Substrate decision: purpose-built backbone, not an Ergo fork

The original plan (under the old "Agora" concept) was to fork the Ergo IRC server. **That premise no longer holds.** Ergo's value was "agents are IRC clients, so get channels/history/accounts/clients for free." But Caucus's clients are **Claude Code sessions speaking MCP** — not IRC clients. The only remaining Ergo upside is free human observability via off-the-shelf IRC clients, which is a nice-to-have, not core.

| | Ergo fork (IRC) | Lightweight purpose-built |
|---|---|---|
| Fit to MCP clients | Extra protocol hop (MCP server ↔ IRC) for no client benefit | MCP server talks a thin RPC to a backbone we own |
| Claim ledger (1st-wins) | Not native; bolt-on or Go fork | First-class keyed table |
| Cursor reads | Bend IRC CHATHISTORY | Native log offsets |
| Loop/dup seatbelt | Needs a Go fork | Write exactly what we need |
| Schema size | IRCv3 ~4094-byte tag budget | No artificial limit |
| Human observability | Free via IRC clients | Build a viewer later (out of MVP) |

**Decision:** build a lightweight purpose-built backbone, **pending the M0 spike** confirming no surprises. It's kept reversible — an Ergo-backed adapter could implement the same interface later if free IRC observability becomes worth it. See [DECISIONS.md ADR-C2](DECISIONS.md) and the spike in the [Roadmap](ROADMAP.md).

## Explicitly out of MVP
Native real-time SDK · web dashboard / digests · federation / multi-server · token-issuer identity service · persistent archival/retention · Python SDK · threaded UI · sub-second streaming. Each is a clean post-MVP increment — see [ROADMAP.md](ROADMAP.md).

## Repository shape (proposed)

TypeScript monorepo (pnpm workspaces):

```
caucus/
├── docs/                  # this documentation set
├── packages/
│   ├── schema/            # versioned typed-message schema + codec (shared)
│   ├── backbone/          # the channel service: log, claim ledger, cursors, seatbelts
│   ├── backbone-server/   # standalone HTTP transport over the backbone + HTTP client
│   ├── mcp-server/        # MCP server over the backbone interface
│   └── hook/              # Claude Code turn-start awareness hook
├── examples/              # the war-room demo + quickstart
└── .github/               # issue/PR templates, workflows
```
