# Architecture

Caucus's target architecture for the MVP. The reasoning behind each choice is recorded as Architecture Decision Records in [DECISIONS.md](DECISIONS.md).

## Overview

Each engineer runs their own Claude Code session. Every session reaches Caucus through an **MCP server** and stays aware via a **Claude Code hook**. All sessions share one **backbone** process.

```
 Engineer A's Claude Code     Engineer B's Claude Code     Engineer C's Claude Code
    │  ▲ (hook injects            │  ▲                         │  ▲
    ▼  │  new msgs each turn)     ▼  │                         ▼  │
  MCP server                   MCP server                   MCP server
    │  tools: post / read_channel / claim / subscribe / create / join / list / describe
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
The agent's only interface. Connects to the backbone, registers tools, and stamps identity on every outgoing message. Tools:
- `post(type, body, thread?, reply_to?, to?, artifact?)` and `post_finding(...)` convenience wrapper
- `read_channel(since?, limit?)`
- `claim(target, note?)` → `granted` | `already_claimed_by{agent, owner, ts}`
- `subscribe(channel)` → establishes the cursor the hook reads from
- `create` / `join` / `list_channels` / `describe_channel`

Tool descriptions teach the typed schema and the **claim-before-you-work** norm.

### Claude Code hook
A turn-start hook that calls `read_channel(since = checkpoint)`, formats the delta into injected context, and advances the checkpoint. This is the **passive-awareness primitive** — agents need not remember to read. It injects only new messages, capped to a size budget with a "+N older, call `read_channel`" overflow line so context never floods.

### Backbone (single process — see substrate decision below)
Holds the shared state behind one implementation-agnostic interface:
- **Append-only message log** per channel, with `readSince(cursor)` returning ordered new messages.
- **Claim ledger** — keyed, **first-write-wins**, atomic. The dedup mechanic. A granted claim is also emitted as a `claim`-type message so the hook surfaces it to everyone. The schema models a **lease-with-TTL** (so a dead agent's claim eventually frees), but MVP enforces first-write-wins only; lease expiry/release is M2 ([ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive-)).
- **Subscribe cursors** — per-session checkpoints that survive discrete MCP request/response calls.
- **Seatbelts** — per-agent rate limit; loop/duplicate detection (drop near-identical consecutive posts).
- **Identity** — a per-session join token maps to `agent-id` + `human owner`, anchored server-side so the owner can't be forged.

Internal interface the MCP server depends on (the `Backbone` contract — full signatures + normative semantics in [BACKBONE_CONTRACT.md](BACKBONE_CONTRACT.md), types in `packages/backbone/src/contract.ts`):

```
createChannel(opts)               -> ChannelDescriptor
describeChannel(channel)          -> ChannelDescriptor   (live head)
listChannels()                    -> ChannelDescriptor[]
append(channel, msg)              -> { message, cursor } (non-claim only)
readSince(channel, cursor, limit?) -> { messages, cursor }
claim(channel, msg)               -> granted{message,cursor} | already_claimed{by}
subscribe(channel)                -> cursor               (stateless head-mint)
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
│   ├── mcp-server/        # MCP server over the backbone interface
│   └── hook/              # Claude Code turn-start awareness hook
├── examples/              # the war-room demo + quickstart
└── .github/               # issue/PR templates, workflows
```
