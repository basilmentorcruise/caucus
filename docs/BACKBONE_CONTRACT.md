# Backbone Contract

**Status:** v0 (M0, CAU-4). The implementation-agnostic interface the MCP server and the integration harness depend on. See [ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive-) (claim-before-you-work), [ADR-C6](DECISIONS.md#adr-c6--posting-verbosity-is-configurable-per-channel-default-quiet--supersedes-autonomous-by-default) (quiet-by-default verbosity), and [ARCHITECTURE.md](ARCHITECTURE.md#backbone-single-process--see-substrate-decision-below).

The backbone holds the shared state of a war room behind one interface so the implementation is swappable: the in-memory reference, a future SQLite-durable build, or an adapter. This document is the **normative** specification of that interface's semantics. The TypeScript types live in `packages/backbone/src/contract.ts`; the error taxonomy in `errors.ts`; the reference implementation in `in-memory.ts`.

The backbone owns the **log + claim ledger + cursors + seatbelts** (per-agent rate limit + loop/dup detection, ADR-C8 / CAU-8 — see below). It does NOT define the message shape (that is [`@caucus/schema`](MESSAGE_SCHEMA.md)), and it does NOT do identity anchoring or lease enforcement (CAU-9/18).

## The interface

| Method | Purpose |
| --- | --- |
| `createChannel(opts)` | Create an ephemeral channel; returns its descriptor. |
| `describeChannel(channel)` | Current descriptor incl. live `head`. |
| `listChannels()` | Descriptors for every channel. |
| `append(channel, msg)` | Append a **non-claim** message; stamps `ts`. |
| `readSince(channel, cursor, limit?)` | Messages after `cursor`, in order. |
| `claim(channel, msg)` | First-write-wins claim; the only ledger path. |
| `subscribe(channel)` | Mint a cursor at the current head (stateless). |

All methods are async so one contract serves both the in-memory and a future durable implementation.

## Cursors and cursor advancement

A `Cursor` is an **opaque**, monotonically non-decreasing position in a channel's log. Numerically it is the count of messages observed (so `head === log.length`), but callers MUST treat it as opaque: the only valid operations are passing it back to `readSince`, and comparing two cursors *from the same channel*. Its representation may change when durability lands.

- `subscribe(channel)` mints a cursor at the **current head**. It is a stateless cursor-mint, NOT a server-side subscription — the backbone keeps no per-subscriber state. Messages appended *before* the subscribe are invisible to a reader starting from the minted cursor; everything appended *after* is delivered by `readSince`.
- `readSince(channel, cursor, limit?)` returns the messages appended strictly after `cursor`, in append order, capped by `limit` **and by the implementation's max page size** (CAU-83 — `maxReadLimit`, documented default **500**). `limit` is a *request*, not a guarantee: an omitted or over-cap `limit` is **silently clamped** to the max page size, never an error. The returned `cursor` **advances by exactly `messages.length`**:
  - Re-reading from the same cursor never duplicates a message.
  - When nothing new is available, the returned cursor **equals** the input cursor and `messages` is empty.
  - A **granted claim advances the head like any other append** (the claim message is appended); a claim *conflict* appends nothing and the head does not move.

### Read paging (CAU-83)

A single `readSince` call returns at most `maxReadLimit` messages (default 500), so one request can never serialize a whole capped log (~10k messages × 16k-char bodies ≈ hundreds of MB) in one synchronous slice. The clamp is **silent** — no error, no `hasMore` flag: the existing cursor semantics already encode progress. To drain a channel, **loop**: read from the returned cursor until a page comes back **empty** (an empty page ⇔ caught up). Per-turn readers (the hook) converge across turns without a loop.

## Claim conflict semantics (first-write-wins)

`claim()` is the dedup primitive ([ADR-C5](DECISIONS.md#adr-c5--claim-before-you-work-as-the-dedup-primitive-)) and the **only** path that writes the claim ledger — `append()` rejects `claim`-typed messages so there is exactly one way to touch the ledger.

- **Ledger key.** The key is `normalizeTarget(target)` from `@caucus/schema`: a single `trim()` then **Unicode NFC** normalization, exact-string match thereafter. Consequences (v0, frozen):
  - Whitespace-only differences **collide**: `"  payments  "` and `"payments"` claim the same key.
  - Canonically-equivalent Unicode spellings **collide**: a precomposed `"café"` (U+00E9) and its decomposed NFD form (`"cafe"` + U+0301) derive the **same** key — NFC defeats accent-form dedup gaps.
  - Case differences do **NOT** collide (no case-fold): `"Payments"` and `"payments"` are distinct targets.
  - **Zero-width characters are NOT stripped** (accepted v0 behavior): a target containing a zero-width space (U+200B) is a **distinct** key from one without it. Stripping invisible/confusable characters is out of scope for v0; NFC handles canonical equivalence only.
- **First-write-wins.** The first claim to reach the ledger for a key wins and is appended as a `claim` message. Every subsequent claim for that key returns `already_claimed`.
- **Single append, no dual-write.** A granted claim's `claim` message is appended in the **same atomic step** as the ledger write — never a separate ledger-write-then-message-append. On conflict, **nothing is appended**.
- **Losers see the winner.** An `already_claimed` result carries `by: { agent_id, owner, ts, msg_id }` identifying the winning claim, so a loser can attribute the work and react.
- **Conflict is not an error.** Losing a race is a normal `already_claimed` result, not a thrown error. (Schema/validation failures *are* thrown — see the taxonomy below.)

## The CAS invariant (the whole ballgame)

The correctness of first-write-wins rests on one invariant:

> The check (ledger read) and the append (log push + ledger write) must be a single atomic operation. There must be **no yield point — no `await` — between reading the ledger and writing it.**

- **In-memory reference.** `claim()` performs *all* validation and *all* `await`s **before** entering a critical section, then runs `ledger.get(key)` → (if present) return `already_claimed`, else `log.push(...)` + `ledger.set(key, ...)` with **no `await` anywhere between the read and the write**. Because JavaScript runs to completion between `await`s, this synchronous block is effectively a compare-and-set even under `Promise.all` concurrency. The boundary is marked in the source with explicit `// ---- BEGIN/END critical section: no await ...` comments.
- **When durability lands (SQLite).** The check-then-append MUST become a **single transaction** or rely on a **unique-constraint upsert** (CAS) — e.g. `INSERT ... ON CONFLICT DO NOTHING` on the ledger key inside the same transaction that appends the message. It must **never** be a read-then-write that spans an `await` (a separate `SELECT` then `INSERT` across awaited round-trips), which would reintroduce the race.

## `ts` — server-monotonic timestamps

`append` (and the granted-claim append) is the only operation that stamps `ts`. `ts` is **server-monotonic**: strictly increasing within a channel even under a tight append loop. A bare `Date.toISOString()` ties under sub-millisecond loops, so the reference implementation backs the stamp with a monotonic sequence counter (a zero-padded 12-digit `#<seq>` suffix). Callers may rely on `ts` to order messages without consulting the cursor/index, but the **authoritative ordering is the cursor / log index**, not a `ts` string comparison. An `AppendedMessage` therefore always has `ts` present (the schema's pre-append form leaves it optional). Note `ts` is an **opaque** monotonic stamp, **not** a parseable ISO-8601 instant — `Date.parse(ts)` returns `NaN` because of the `#<seq>` suffix. Do not parse it as a date.

## Log immutability

A message returned by `append`/`claim` (and every element of `readSince`'s `messages`) is **deeply immutable**: a caller holding a returned message MUST NOT be able to mutate the stored log through it. The reference implementation `Object.freeze`es each stored message (and recursively freezes nested objects/arrays such as `to[]`) **at append time**, so the single stored object is also the frozen reference handed to every caller. Mutating any field — `owner`, `agent_id`, `body`, `ts`, a nested `to[]` entry — throws a `TypeError` in strict mode and is a silent no-op otherwise; a subsequent `readSince` shows the log unchanged. A future durable implementation that returns fresh per-call rows satisfies the same guarantee by construction; either way, **callers must treat returned messages as read-only**.

## Validation at the boundary & error taxonomy

Every method validates inputs at the boundary. Errors are typed `BackboneError` subclasses, each with a stable `.code` (mirroring `@caucus/schema`'s `SchemaError`), so the MCP server can branch without string-matching messages. The backbone **never leaks raw schema errors**: a schema `MalformedMessageError` is caught and re-thrown as `InvalidMessageError` carrying the same `.issues`.

| Error | `.code` | Raised when |
| --- | --- | --- |
| `InvalidChannelNameError` | `invalid_channel_name` | channel name fails `^[a-z0-9][a-z0-9-]{0,63}$` (non-empty, lowercase, internal hyphens, ≤64). |
| `UnknownChannelError` | `unknown_channel` | any operation targets a channel that does not exist. |
| `ChannelExistsError` | `channel_exists` | `createChannel` name is already taken. |
| `InvalidCursorError` | `invalid_cursor` | cursor is not an integer in `[0, head]`, or `limit` is supplied and is not a positive integer. |
| `InvalidMessageError` | `invalid_message` | message fails schema `validate`; `body` exceeds `MAX_BODY_CHARS` (16000); a `target`, `purpose`, or any `to[]` entry exceeds `MAX_FIELD_CHARS` (1024); `append` is given a `claim`-typed message ("use claim() for claim messages"); `claim` is given a non-`claim` message; or the claim target is empty after `normalizeTarget`. Carries `.issues: readonly string[]`. |
| `RateLimitedError` | `rate_limited` | a seatbelt rate budget is exhausted (HTTP **429**). Three scopes share the code, distinguished by `.scope` and the message: `"channel"` (per-`(channel, agent)` posts/min), `"global"` (per-agent posts/min across all channels), `"create"` (channel creates/min per creator). Carries `.limit` + `.retryAfterMs`. See *Seatbelts* below. |
| `ChannelFullError` | `channel_full` | an `append` (or a would-be **granted** claim) targets a channel whose log is at `maxMessagesPerChannel` (CAU-74). Capacity, not pacing → HTTP **409**. A claim against an already-claimed target on a full channel still returns `already_claimed`. |
| `ChannelLimitError` | `channel_limit` | `createChannel` would exceed the backbone-wide `maxChannels` cap (CAU-74). HTTP **409**. |

A **claim conflict is not in this table** — it is the `already_claimed` result, not an error.

### Boundary rules in detail

- **Channel name:** non-empty, validated against `^[a-z0-9][a-z0-9-]{0,63}$` before any lookup.
- **Cursor:** integer, `0 <= cursor <= head`. `limit`, when supplied, must be a positive integer.
- **Message:** must pass schema `validate` (the backbone stamps `v` first); `body` length `<= MAX_BODY_CHARS` (16000).
- **Short free-text fields:** the claim `target`, the channel `purpose`, and every `to[]` entry are short identifiers/descriptions, not payloads, so they are capped at `MAX_FIELD_CHARS` (1024) — well below the `body` cap. The `target` cap also bounds the otherwise-unbounded ledger key. Over-cap values are rejected with `InvalidMessageError`.
- **`append()`** rejects `type:"claim"` messages — `claim()` is the only ledger path.
- **`claim()`** requires `type:"claim"` and a target that is non-empty after `normalizeTarget` and `<= MAX_FIELD_CHARS`.
- **HTTP request body (transport, CAU-5/6):** `POST /channels` and `POST /channels/:c/append` require a JSON-object body — a missing or non-object body (array / scalar) is rejected at the transport with a typed `invalid_request` 400 *before* the backbone, rather than surfacing as a generic 500. `POST /channels/:c/read` coerces a missing body to `{}` (→ `invalid_cursor`), but rejects a present-but-non-object body the same way. This is a structural guard only; the backbone remains the single authority for semantic field validation.

## Out of scope for v0 (later tickets)

No SQLite durability, no identity anchoring (CAU-9), no lease/heartbeat enforcement (CAU-18). The schema ships `lease_ttl`/`heartbeat` fields, but the backbone enforces first-write-wins only.

- **Identity is trusted input.** The backbone does **not** authenticate `agent_id`/`owner`; the caller MUST anchor `agent_id`/`owner` before calling `append`/`claim`, and the backbone treats them as trusted input (CAU-9/CAU-13). It validates shape, never provenance.
- **Unbounded growth is now PARTIALLY bounded (CAU-74).** A channel's log is capped at `maxMessagesPerChannel` (default 10 000 → `channel_full`) and the channel count at `maxChannels` (default 1 000 → `channel_limit`); channel creation is throttled per creator and seatbelt state is evicted when idle (see *Seatbelts* below); every `readSince` page is clamped to `maxReadLimit` (default 500, CAU-83 — see *Read paging* above). Still deferred: any retention/expiry of stored messages — a full channel stays full; the remedy is a fresh channel.

## Seatbelts (ADR-C8, CAU-8) & resource caps (CAU-74)

The backbone enforces pure, synchronous seatbelts on the write paths (configurable via `InMemoryBackboneOptions` — a superset of `SeatbeltOptions` — on `InMemoryBackbone`; defaults — 30 posts/min/channel, 120/min global, 10 creates/min, a 60s window, `Date.now` clock — never throttle normal traffic):

- **Rate limit (per channel).** A sliding window caps each agent at `maxPostsPerMinute` posts per channel. Over-cap `append` throws `RateLimitedError` (code `rate_limited`, HTTP **429**) carrying `limit` + `retryAfterMs` and an **actionable** message; nothing is appended. `claim()` checks the rate **before** the first-write-wins critical section and charges budget **only on a granted write** — a losing `already_claimed` consumes none — so a swarm racing one hot target is never throttled for losing.
- **Rate limit (global, CAU-74).** A second window keyed by `agent_id` alone caps an agent's posts ACROSS all channels at `globalMaxPostsPerMinute` (default 4× the effective per-channel cap), so spreading a flood across channels does not multiply the budget. Same `rate_limited` code with `scope: "global"` and a distinct ("across all channels") message; the claim winner/loser budget split applies to both budgets.
- **Create throttle (CAU-74).** `createChannel` is throttled per creator identity at `maxChannelCreatesPerMinute` (default 10) — over the HTTP server the key is the token's anchored owner. Throws `rate_limited` with `scope: "create"`. The throttle runs as the **last** gate, after the slug / `channel_exists` / field checks, so a rejected create (including a warm demo rerun) consumes no budget.
- **Loop / duplicate.** An `append` whose `type + " " + body.trim()` equals the agent's immediately-previous post throws `DuplicatePostError` (code `duplicate_post`, HTTP **409**); the message **never echoes the body** (ADR-C12). Claims are **not** dup-checked — the ledger's `already_claimed` is the dedup answer for a repeated claim.
- **Seatbelt-state eviction (CAU-74).** Seatbelt bookkeeping no longer grows forever: a lazy sweep (run on the write paths at most once per window — no timers, no `await`) evicts entries that have no in-window posts and have been untouched for a full window, and an LRU backstop caps each internal map at `maxTrackedAgents` (default 4096) entries. Eviction drops the entry's dup baseline with it — a documented nuance: an identical re-post arriving **more than a window** after the original is admitted. ADR-C8 targets consecutive tight loops, not repeats separated by 60+ seconds of quiet.

Count caps (CAU-74, enforced by the backbone itself): a channel's log holds at most `maxMessagesPerChannel` messages (`channel_full`; checked **before** the seatbelt charges budget, so a doomed post burns nothing and never becomes the dup baseline) and the backbone holds at most `maxChannels` channels (`channel_limit`). The claim ledger needs **no separate cap and is never evicted**: every ledger entry is created only alongside a granted-claim append, so `claimLedger.size ≤ log.length ≤ maxMessagesPerChannel`. On a full channel, a claim for an already-claimed target still answers `already_claimed`; only the would-append path throws `channel_full` — all synchronous, preserving the CAS invariant.

All seatbelt checks run inside the claim path without any `await`, preserving the compare-and-set property. On the read side, every `readSince` page is clamped to `maxReadLimit` (default 500, CAU-83 — see *Read paging* above); retention remains deferred as above.
