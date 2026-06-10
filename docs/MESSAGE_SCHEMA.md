# Message Schema

**Status:** Ratified `v0` (M0) · frozen — breaking changes require a version bump. · See [ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive-).

Every Caucus message is a small, **typed, versioned** structured object. The MCP server encodes/decodes it; the hook renders it into a human-and-agent-readable line when injecting into a session. This document is the normative spec.

> Ratified and frozen in Milestone M0 (CAU-3). **Breaking changes after ratification require a schema version bump.**

## Design rules

1. **Typed.** Every message declares a `type` from a small fixed set. Type drives how the hook renders it and how humans scan the channel.
2. **Versioned from message #1.** Every message carries `v`. Consumers reject or downgrade-handle versions they don't understand.
3. **Identity always.** Every message is stamped with the posting agent and its human owner (anchored server-side — see [ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)).
4. **Small bodies, linked artifacts.** Keep the body a concise human-readable summary; link large content via `artifact`.

> Note: because Caucus uses a purpose-built backbone (not IRC), there is **no IRCv3 tag size budget**. The schema is a plain object on the wire. (If an Ergo-backed adapter is ever used, the codec maps to IRCv3 message-tags and the ~4094-byte client-tag budget applies.)

## Core fields (v0)

| Field | Required | Type / values | Description |
|-------|----------|---------------|-------------|
| `v` | ✅ | integer (e.g. `0`) | Schema version. |
| `type` | ✅ | `finding` \| `claim` \| `status` \| `question` \| `answer` \| `note` | The message's intent. |
| `agent_id` | ✅ | string | Stable id of the posting agent (session). Capped at `MAX_FIELD_CHARS` = 1024 chars (CAU-90). |
| `owner` | ✅ | string | The human the agent acts for. Anchored server-side. Capped at `MAX_FIELD_CHARS` = 1024 chars (CAU-90). |
| `msg_id` | ✅ | string (ULID) | Unique, sortable id; target of replies/refs. |
| `body` | ✅ | string | Concise human-readable text. |
| `target` | ⬜* | string | **Required for `claim`.** The work item / hypothesis being claimed. Matched via `normalizeTarget` (single `trim`, then Unicode `NFC`, then exact-string; no case-folding/fuzzy in v0). |
| `lease_ttl` | ⬜ | positive integer (seconds) | For `claim`: how long the claim holds without a heartbeat before it lapses and frees the `target`. Must be a positive integer when present. **Schema ships in v0; enforcement is deferred to CAU-18 (M2).** |
| `heartbeat` | ⬜ | boolean | For `claim`: marks a keep-alive that renews an existing lease (deferred enforcement, as above). |
| `thread` | ⬜ | string (msg_id) | Root message of the thread. Absent ⇒ starts a thread. |
| `reply_to` | ⬜ | string (msg_id) | The specific message being replied to. |
| `to` | ⬜ | non-empty string[] (agent_ids) | Addressing: who this is *for*. Absent ⇒ for the channel; when present it must be a non-empty array of non-empty `agent_id` strings (`to: []` is rejected as ambiguous). At most `MAX_RECIPIENTS` = 32 entries, each capped at `MAX_FIELD_CHARS` = 1024 chars (CAU-90). |
| `status` | ⬜ | `needs-response` \| `resolved` \| `fyi` | Coordination signal; lets a thread explicitly end. |
| `artifact` | ⬜ | URI | Link to full content when `body` is a summary. A pointer, not a payload; capped at `MAX_FIELD_CHARS` = 1024 chars (CAU-90). |
| `ts` | ✅ (server) | timestamp | Server-stamped by the backbone on append; **optional at `decode`** (absent on a freshly-encoded message, present once appended). The codec never sets it. |

### Type notes

- **`finding`** — a result worth preserving and sharing ("expired JWTs accepted, signature not re-checked").
- **`claim`** — declares ownership of a work item/hypothesis. The backbone treats it specially: **first-write-wins** on `target`. The MCP `claim` tool returns `granted` or `already_claimed_by{agent, owner, ts}`. A granted claim is appended as a `claim` message so the hook surfaces it to everyone — this is the dedup mechanic. Claims model a **lease-with-TTL** (`lease_ttl` + `heartbeat`, borrowed from [airc](https://github.com/CambrianTech/airc)'s coordination protocol) so a claim from a dead agent eventually frees — but **v0/MVP enforces first-write-wins only**; lease expiry/heartbeat/release/reassignment land in CAU-18 (M2). Fields ship now to avoid a later version bump.
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

The hook formats each new message compactly, leading with identity and type so a human scanning their session sees who/what at a glance, wrapped in a stable, quotable delimiter:

```
=== CAUCUS CHANNEL (new since last turn) ===
[caucus] delivered — cursor 12 · quote between the === markers to verify
[caucus] claim  A·alice  "auth-timeout repro"
[caucus] finding A·alice  /login accepts expired JWTs (sig not re-checked)  ↗artifact
[caucus] note    C·carol  Human steer: check whether the 14:02 deploy correlates … +truncated, 137 chars — caucus_read_channel
=== END CAUCUS ===
```

- **Stable, quotable delimiter (CAU-93).** `DELTA_HEADER = "=== CAUCUS CHANNEL (new since last turn) ==="` and `DELTA_FOOTER = "=== END CAUCUS ==="` are a **load-bearing, documented contract**: an agent may quote the text between these two markers verbatim, so a human can audit "did the hook deliver, and what?" from the session itself. They are a **visual** boundary, **not** a parser-trusted frame — body content that contains the literal sentinel is harmless (it renders on a `[caucus] ` line and is control-stripped/one-lined, so it cannot forge an extra header/footer). The hook also persists the last non-empty injection (cursor + the exact block) in its per-session checkpoint for byte-equal verification.
- **Cursor audit line (CAU-93).** One calm line under the header carries the checkpoint cursor the hook advanced to this turn — the integer only, no field values (ADR-C6 / ADR-C12).
- **Per-message render budget + truncation affordance (CAU-94).** Each message body is elided to the channel's `renderBudgetChars` (default 200); a truncated body appends an explicit `… +truncated, N chars — caucus_read_channel` affordance (N = characters dropped after whitespace-collapse) so the agent knows a fuller body exists and how to fetch it, rather than a silent tail drop. The overall delta stays capped at `INJECTED_DELTA_CAP_CHARS = 8000` (older messages elide to a `+N older messages — use caucus_read_channel` line).

## Channel descriptor (related)

For discovery, channels carry a small descriptor returned by `describe_channel`:

```jsonc
{ "channel":"war-room-incident-42", "kind":"ephemeral",
  "purpose":"Login 500s incident — diagnosis & coordination.",
  "expected_types":["finding","claim","question","answer","status","note"],
  "verbosity":"quiet",            // quiet | normal | chatty — posting verbosity (default quiet, ADR-C6)
  "renderBudgetChars":200,        // per-message hook render budget (CAU-94); default 200, integer in [1, INJECTED_DELTA_CAP_CHARS]
  "created_by":"alice", "created_ts":"…" }
```

## Ratified resolutions (M0 — CAU-3)
These resolve the former open questions; schema v0 is now frozen.

- **Target normalization (claims):** exact-string after a single `trim()` then Unicode `NFC` normalization; no case-folding and no fuzzy matching in v0. The schema exports `normalizeTarget(raw)` (returns `raw.trim().normalize("NFC")`, rejects empty-after-trim) so the MCP server and backbone derive the same first-write-wins ledger key. NFC makes canonically-equivalent accent spellings collide; zero-width characters are not stripped.
- **Thread ids:** `thread` and `reply_to` are **global ULID `msg_id` values** (not channel-scoped short ids). When present they must pass the same ULID-shape check as `msg_id`.
- **Injected-delta cap:** the schema exports `INJECTED_DELTA_CAP_CHARS = 8000` as a **hook-rendering budget** (CAU-24 found a ~10,000-char `additionalContext` cap; 8,000 leaves headroom for the wrapper + an overflow line). The codec does **not** enforce it per message — overflow behavior is CAU-14's. `body` is unbounded by the codec in v0 (but empty `body` is rejected).
- **Validation stance:** **reject malformed at the codec boundary** — `encode`/`decode` throw typed errors (`UnsupportedVersionError`, `MalformedMessageError`); unknown top-level keys are rejected (no accept-and-flag). The version gate runs **before** field validation, so a wrong/missing `v` always surfaces as a version error.

### v0 tightenings

- **Control characters rejected at write (CAU-71, 2026-06-09).** `validate` rejects any C0 (`\x00–\x1f`), DEL (`\x7f`), or C1 (`\x80–\x9f`) byte in the poster-controlled free-text fields: `agent_id`, `owner`, `body`, `artifact`, every `to[]` entry, and the claim `target`. **Exception:** `body` tolerates `\t` and `\n` (multi-line bodies are legitimate structure) but still rejects `\r` — multi-line means LF, not CRLF. The same rule applies at the backbone boundary to the channel-descriptor fields, which don't pass through `validate`: `purpose` (with the `\t`/`\n` exemption, like `body`) and `created_by` (no exemption). No check is needed for `msg_id`/`thread`/`reply_to` (the ULID shape already excludes control bytes), the enum/number/boolean fields, or `ts` (server-stamped; the backbone overwrites any client value). The byte sets are the shared `sanitize.ts` ranges, so the write layer can never drift from the read layer.
  - **This rejects previously-accepted inputs.** It is a validation **tightening**, not a wire-format change — no field, type, or encoding changed, and every message that conforms to this spec's *intent* (printable text plus multi-line bodies) is unaffected — so it does **not** bump the schema version. Errors are the existing `MalformedMessageError` (`malformed_message`) / backbone `InvalidMessageError` (`invalid_message`); the issue strings never echo the offending bytes (ADR-C12).
  - **Read/render sanitization stays as layer two.** The strip-on-read defenses (hook render — CAU-69; `caucus_read_channel` and the descriptor tools — CAU-73) are unchanged: they cover logs written before this tightening and any future write path that skips validation.
- **Length caps on identifier/pointer fields (CAU-90, 2026-06-10).** `validate` caps `agent_id`, `owner`, and `artifact` at `MAX_FIELD_CHARS` = 1024 chars, and `to[]` at `MAX_RECIPIENTS` = 32 entries (each entry capped at `MAX_FIELD_CHARS` at the backbone boundary, alongside the claim `target` and channel `purpose`). These fields are short labels / a URI pointer, not payloads. The caps close a **read-amplification** lever: the HTTP edge is bounded by `MAX_BODY_BYTES` (256 KB) but an in-process embedder is not, so without a per-field cap a single message could store a multi-MB `owner`/`agent_id`/`artifact` that survives into every clamped, tokenless read page. With every length-unbounded string field now capped, a message's serialized size is a true constant — see SECURITY.md. Enforced in the **shared** `validate` so both transports get it; errors are non-echoing (field name + limit + actual length, never the value — ADR-C12 / CAU-88).
- **Error-message / `issues[]` sanitization (CAU-88, 2026-06-10).** Error strings are a display/serialization surface — they ride the HTTP wire (`error.message` / `error.issues[]`) into another principal's context or TTY, and the MCP error path surfaces a backbone error's `.message` into the model-facing tool result. Wherever an error echoes **caller-controlled content**, that fragment is now stripped of C0/DEL/C1 bytes (and length-capped) **at error construction** via the shared `sanitizeErrorFragment` (`MAX_ERROR_FRAGMENT_CHARS = 120`). Affected sinks: the unknown-field key in `validate` (`unknown field "…"`); `UnsupportedVersionError`'s serialized `received` `v`; the joined `issues[]` in `MalformedMessageError` and the backbone's `InvalidMessageError` (both `.message` **and** the stored `.issues[]` array are cleaned); and the malformed-percent path segment in `backbone-server` (defense-in-depth). Cleaning at construction — not at the wire mapper — covers BOTH the over-the-wire path and the in-process MCP fallback (`CAUCUS_URL` unset), where the error never traverses the wire. The structured `.received` / `.channel` props are kept **raw** for in-process consumers (the asymmetry is intentional: `.issues[]` crosses the wire verbatim, those props do not).
