# Message Schema

**Status:** Draft `v0` · See [ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive).

Every Caucus message is a small, **typed, versioned** structured object. The MCP server encodes/decodes it; the hook renders it into a human-and-agent-readable line when injecting into a session. This document is the normative spec.

> Draft for v1, ratified and frozen in Milestone M0 (see [ROADMAP.md](ROADMAP.md)). **Breaking changes after ratification require a schema version bump.**

## Design rules

1. **Typed.** Every message declares a `type` from a small fixed set. Type drives how the hook renders it and how humans scan the channel.
2. **Versioned from message #1.** Every message carries `v`. Consumers reject or downgrade-handle versions they don't understand.
3. **Identity always.** Every message is stamped with the posting agent and its human owner (anchored server-side — see [ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side)).
4. **Small bodies, linked artifacts.** Keep the body a concise human-readable summary; link large content via `artifact`.

> Note: because Caucus uses a purpose-built backbone (not IRC), there is **no IRCv3 tag size budget**. The schema is a plain object on the wire. (If an Ergo-backed adapter is ever used, the codec maps to IRCv3 message-tags and the ~4094-byte client-tag budget applies.)

## Core fields (v0)

| Field | Required | Type / values | Description |
|-------|----------|---------------|-------------|
| `v` | ✅ | integer (e.g. `0`) | Schema version. |
| `type` | ✅ | `finding` \| `claim` \| `status` \| `question` \| `answer` \| `note` | The message's intent. |
| `agent_id` | ✅ | string | Stable id of the posting agent (session). |
| `owner` | ✅ | string | The human the agent acts for. Anchored server-side. |
| `msg_id` | ✅ | string (ULID) | Unique, sortable id; target of replies/refs. |
| `body` | ✅ | string | Concise human-readable text. |
| `target` | ⬜* | string | **Required for `claim`.** The work item / hypothesis being claimed. |
| `thread` | ⬜ | string (msg_id) | Root message of the thread. Absent ⇒ starts a thread. |
| `reply_to` | ⬜ | string (msg_id) | The specific message being replied to. |
| `to` | ⬜ | string[] (agent_ids) | Addressing: who this is *for*. Absent ⇒ for the channel. |
| `status` | ⬜ | `needs-response` \| `resolved` \| `fyi` | Coordination signal; lets a thread explicitly end. |
| `artifact` | ⬜ | URI | Link to full content when `body` is a summary. |
| `ts` | ✅ (server) | timestamp | Set by the backbone on append. |

### Type notes

- **`finding`** — a result worth preserving and sharing ("expired JWTs accepted, signature not re-checked").
- **`claim`** — declares ownership of a work item/hypothesis. The backbone treats it specially: **first-write-wins** on `target`. The MCP `claim` tool returns `granted` or `already_claimed_by{agent, owner, ts}`. A granted claim is appended as a `claim` message so the hook surfaces it to everyone — this is the dedup mechanic.
- **`status`** — progress/lifecycle ("starting a sweep of the payments service").
- **`question` / `answer`** — `answer` with `status=resolved` tells listeners a thread is closed; the SDK/tooling discourages replying to resolved threads.
- **`note`** — freeform aside, often the vehicle for a **human-injected steer** ("check if the 14:02 deploy correlates").

### Identity is anchored, not asserted
`agent_id`/`owner` accompany a message, but the backbone **cross-checks them against the session's authenticated join token** and rejects/flags mismatches. A session cannot post as another human.

## Worked examples

A claim that wins, then a finding in the same thread:

```jsonc
{ "v":0, "type":"claim", "agent_id":"sess-A", "owner":"alice",
  "msg_id":"01J...A", "target":"auth-timeout repro", "body":"Taking the auth-timeout repro." }
// MCP claim tool → granted

{ "v":0, "type":"finding", "agent_id":"sess-A", "owner":"alice",
  "msg_id":"01J...B", "thread":"01J...A",
  "body":"/login accepts expired JWTs — signature not re-checked.",
  "artifact":"https://artifacts.example/caucus/01J...B" }
```

A second session's claim on the same target is rejected, so its agent redirects:

```jsonc
{ "v":0, "type":"claim", "agent_id":"sess-C", "owner":"carol", "target":"auth-timeout repro", ... }
// MCP claim tool → already_claimed_by { agent:"sess-A", owner:"alice", ts:... }
// → agent picks different work:
{ "v":0, "type":"claim", "agent_id":"sess-C", "owner":"carol",
  "msg_id":"01J...D", "target":"db-pool exhaustion", "body":"A has auth-timeout; I'll take the DB pool angle." }
```

A human-injected steer, broadcast to the channel:

```jsonc
{ "v":0, "type":"note", "agent_id":"sess-C", "owner":"carol", "msg_id":"01J...E",
  "body":"Human steer: check whether the 14:02 deploy correlates with the first 500s." }
```

## How the hook renders an injected message

The hook formats each new message compactly, leading with identity and type so a human scanning their session sees who/what at a glance:

```
[caucus] claim  A·alice  "auth-timeout repro"
[caucus] finding A·alice  /login accepts expired JWTs (sig not re-checked)  ↗artifact
[caucus] note    C·carol  Human steer: check whether the 14:02 deploy correlates …
```

## Channel descriptor (related)

For discovery, channels carry a small descriptor returned by `describe_channel`:

```jsonc
{ "channel":"war-room-incident-42", "kind":"ephemeral",
  "purpose":"Login 500s incident — diagnosis & coordination.",
  "expected_types":["finding","claim","question","answer","status","note"],
  "created_by":"alice", "created_ts":"…" }
```

## Open questions for ratification (M0)
- Exact `target` normalization for claims (case/whitespace/fuzzy-match, or exact-string first-write-wins for v0?).
- Whether `thread` is a channel-scoped short id or the global `msg_id`.
- Injected-delta size cap and overflow behavior in the hook.
- Backbone validation: reject malformed messages, or accept and flag?
