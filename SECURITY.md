# Security Policy

Caucus is an **agent war room for investigations and escalations**: several engineers each
drive their own Claude Code session, and those sessions share one ephemeral channel through an
MCP server and a turn-start hook. That shared channel is exactly where sensitive output tends to
fly around, so secret-leak hygiene is a **first-class concern**, not an afterthought
([ADR-C12](docs/DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)).

This document covers two things:

1. **How to report a vulnerability** in Caucus.
2. **The trust boundary and the secret-leak threat model** — what Caucus protects against in v1,
   what it deliberately does **not**, and the operational guidance that follows from that.

Read the threat model before you put Caucus in front of production diagnostics. The most important
property to internalize is simple: **the channel is a shared, persisted, append-only log. Treat
everything you post as visible to your whole team — forever.**

---

## Reporting a vulnerability

**Please do not file security issues as public GitHub issues, and do not disclose them in a
Caucus channel** (the channel is itself a shared log — see the threat model below).

Report privately through **GitHub's private vulnerability reporting** for this repository:

> **<https://github.com/basilmentorcruise/caucus/security/advisories/new>**

(You can also reach this from the repository's **Security** tab → **Report a vulnerability**.)
Private vulnerability reporting opens a confidential advisory thread visible only to you and the
maintainers, so we can triage, fix, and coordinate disclosure without exposing the issue first.

When you report, please include where practical:

- the affected component (`schema` / `backbone` / `mcp-server` / `hook` / docs / CI),
- the version, branch, or commit,
- reproduction steps or a proof-of-concept,
- the impact you observed and any suggested remediation.

**What to expect.** Caucus is a pre-alpha, open-source project (see the status note in the
[README](README.md)); there is no paid support tier and no formal SLA. We aim to acknowledge a
report within a few business days, keep you updated as we triage, and credit you in the advisory
when a fix ships unless you ask us not to. Please give us a reasonable window to remediate before
any public disclosure.

### What is and isn't in scope

In scope: vulnerabilities in Caucus's own code and configuration — e.g. **identity-spoofing**
(forging another agent's `human owner`, contrary to [ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)),
**claim-ledger integrity** breaks (defeating first-write-wins), **seatbelt** bypasses
([ADR-C8](docs/DECISIONS.md#adr-c8--seatbelts-rate-limit--loopduplicate-detection-)), cursor/log
tampering, or a flaw that lets the server silently re-route a message to an unintended recipient.

Out of scope: the **designed-in** trust properties described in the threat model below (e.g. "a
teammate on the channel can read what I post"). Those are documented limitations of the v1 trust
model, not vulnerabilities. If you think one of them should change, that's an architecture
discussion — open an issue referencing the relevant ADR.

---

## Trust boundary and threat model

### The trust boundary

Caucus's trust boundary is **one team sharing one backbone** ([ADR-C9](docs/DECISIONS.md#adr-c9--intra-team-single-shared-server-no-federation-in-v1-)).
Concretely:

- There is **one shared backbone process per team/org**. No federation, no cross-org channels,
  no multi-server fan-out in v1.
- Everyone who can **join a channel is inside the trust boundary.** Joining is gated by a
  per-session join token (a shared team secret or a simple issued token,
  [ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)).
  Anyone who holds a valid token — and every agent and human they're driving — can read the whole
  channel.
- The channel is a **shared, persisted, append-only log.** A message posted to a channel is
  visible to **every joined session and every human behind those sessions**, and it stays in the
  log. Posting is *quiet by default* ([ADR-C6](docs/DECISIONS.md#adr-c6--posting-verbosity-is-configurable-per-channel-default-quiet--supersedes-autonomous-by-default))
  to keep the feed calm — but "quiet" is about volume, **not** confidentiality. Quiet posts are
  just as visible and just as persisted as chatty ones.

In short: **the unit of trust is the team, not the individual.** Caucus assumes the people on a
channel are colleagues who are already in the same incident bridge / Slack huddle and already
share this class of operational data. It is a coordination layer for a trusted team — not a
confidentiality boundary between the people on it.

### Network exposure

The backbone is an **HTTP listener**. By default it binds **`127.0.0.1`** (loopback only), so
nothing off-host can reach it. **Writes are token-gated (CAU-13)**: `append`, `claim`, and
`createChannel` require a bearer token from the server's `CAUCUS_TOKENS` map, and the server
**resolves the token and overwrites the message's `agent_id`/`owner` server-side** — a client's
claimed identity never reaches the log, which is how
[ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)'s
anti-forgery is enforced (a stolen token still impersonates its owner — guard tokens like any
credential). With `CAUCUS_TOKENS` unset the server is **fail-closed**: every write is rejected 401.
Token resolution is **timing-safe**: the server stores and compares SHA-256 digests of tokens,
never the raw secret, so lookup timing does not leak token contents.
**Reads remain open within the trust boundary** (everyone who can reach the port can read
everything — designed-in for the intra-team model, and what keeps the read-only hook tokenless).
The **`HOST` env var is the single knob that widens exposure**: setting it to a non-loopback
address makes the backbone (incl. open reads) reachable by anyone on that interface. **Do not bind
a non-loopback host off-host** — keep it on `127.0.0.1` and reach remote sessions through a tunnel
you control, not by exposing the port. The startup log always surfaces this: the bin logs the
dialable URL, plus an explicit `WARNING: bound to …` line naming the real bind whenever it is
non-loopback (a wildcard bind's URL substitutes a loopback literal for dialability, so the warning
is what keeps the exposure visible).

### The secret-leak vector (why this document exists)

The core risk is structural, and it comes straight from what makes Caucus useful:

> Agents post **diagnostic output** — log excerpts, stack traces, request/response dumps, env
> dumps, query results — into a shared, persisted log so the rest of the team's agents can see it.
> Diagnostic output during a real incident is **exactly** where credentials, tokens, and customer
> data live. So the same pipe that spreads a useful finding can spread a secret, and once a secret
> is in an append-only log that propagated to every session, **it is leaked and it does not
> un-leak.**

This is amplified by three things specific to Caucus:

1. **It's agent-driven.** A human pasting a log into Slack at least glances at it. An agent
   summarizing "here's the failing request" may include an `Authorization: Bearer …` header
   without a human reviewing that specific post first.
2. **It's persisted and propagated.** The hook injects new messages into *every* session at turn
   start. A leaked secret doesn't sit in one scrollback; it lands in everyone's context and in the
   durable log.
3. **It's the incident path.** The headline use case (and the lower-tempo investigations that are
   the launch beachhead) are precisely the moments when the most sensitive output is in motion.

### What Caucus does NOT protect against in v1 — state this honestly

Do not deploy Caucus believing it gives you guarantees it does not. In v1, Caucus does **not**
defend against any of the following:

- **A malicious or careless teammate on the channel.** Anyone inside the trust boundary can read
  everything posted and can post anything. There is no per-message access control, no need-to-know
  partitioning, and no redaction enforced by the server.
- **A compromised session, token, or machine.** A stolen join token, or a compromised laptop
  running a joined Claude Code session, grants the attacker the same channel-wide read/post access
  as the legitimate owner. Identity is anchored server-side
  ([ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)),
  which stops *forging someone else's* owner — it does **not** stop an attacker who has
  legitimately obtained a token from acting as the real owner.
- **End-to-end encryption.** There is **no E2E encryption** in v1. Messages are not encrypted such
  that only intended recipients can read them; the server and every joined session see plaintext.
- **Server-side confidentiality.** There is a **single shared server** per team
  ([ADR-C9](docs/DECISIONS.md#adr-c9--intra-team-single-shared-server-no-federation-in-v1-)). Whoever
  operates that backbone can read the full log. Caucus does not protect channel contents from the
  server operator or anyone with access to the backbone's storage.
- **Secrets you post anyway.** Caucus does **not** scan, redact, or block secrets at the server in
  v1 (this is about the Caucus backbone itself — distinct from GitHub's repo-level secret scanning,
  which only covers this source repository). If an agent posts a token, the backbone faithfully stores and propagates it. **Not posting
  secrets is an operator/agent responsibility, not a feature the server enforces.**
- **Long-term archival hardening.** Channels are ephemeral by design and persistent archival /
  retention is explicitly out of MVP, but for the lifetime of a channel the log *is* persisted —
  do not treat "ephemeral" as "not recorded."
- **Terminal control characters are rejected at write and neutralized at read.** C0/DEL/C1 control bytes
  are stripped from untrusted poster-controlled fields before content leaves the log for another
  principal. The covered read consumers are:
  - the hook's `renderMessage` and the demo `watch`, which strip `body`/`owner`/claim
    `target`/`to[]` before displaying on a TTY (CAU-69);
  - the `caucus_read_channel` MCP tool, which strips `body`/`owner`/claim `target`/`to[]`/`artifact`
    before serializing a page into another agent's model context (CAU-73);
  - the `caucus_list_channels` / `caucus_describe_channel` descriptor tools, which strip
    `purpose`/`created_by` before serializing a descriptor into another agent's model context
    (CAU-73);
  - the `caucus_claim` tool, which strips the winner's `agent_id`/`owner` in an
    `already_claimed.by` result before serializing it into the losing agent's model context (CAU-73);
  - `caucus_read_channel` additionally strips the `agent_id` it serializes.

  Read-side stripping is defense-in-depth layer two: since CAU-71 the root-cause fix is in place —
  the schema validator (and the backbone's channel-create boundary) **rejects** control characters
  at write time, so new log content never stores them. The read layer stays to cover logs written
  before the tightening and any future write path that skips validation.

  This matters specifically for the serialization consumers because `JSON.stringify` does **not**
  escape C1 bytes (`\x80–\x9f`). All paths share a single `stripControlChars` exported from
  `@caucus/schema` (structured-JSON reads use its whitespace-preserving sibling
  `stripControlCharsKeepWhitespace` for multi-line `body`/`purpose`, since `\n`/`\t` are
  JSON-escaped and terminal-inert), so any **new** consumer that reads the log must likewise run
  untrusted fields through it (or `renderMessage`) rather than printing/forwarding raw. Writes are
  rejected via the same module's `containsControlChars` / `containsControlCharsExceptWhitespace`
  predicates (CAU-71), which are derived from the strip functions so the two layers cannot drift.

  As of CAU-81 this no-payload-echo discipline also covers the backbone's own **error messages**:
  the channel-name-bearing errors strip C0/DEL/C1 from the supplied name before embedding it, so a
  dirty name reachable tokenlessly via a percent-encoded URL path (`GET /channels/%C2%9B…`) cannot
  ride an error response back into the requester's context or TTY.

- **Bidi-override display spoofing (display-layer only, not defended in v1).** Unicode
  bidirectional override/embedding characters (e.g. U+202E RIGHT-TO-LEFT OVERRIDE, and the
  U+202A–U+202E / U+2066–U+2069 families) are **not** C0/DEL/C1 control bytes: they pass write
  validation and survive read-side stripping, and a poster can use them to visually reorder a
  rendered hook or `watch` line so displayed text appears in a misleading order (e.g. content
  seeming to belong to a different part of the line). What it does **not** break: the
  server-anchored `owner` ([ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer))
  and the stored log bytes are untouched — the model reads, and the log holds, the true byte
  order; only the human-rendered glyph order is spoofed. Treat the raw log entry as authoritative
  when a rendered line looks suspicious. Render-layer bidi neutralization is M2-class work.

- **Resource exhaustion by a hostile token-holder — only cooperative caps (CAU-74).** The backbone
  now enforces resource caps: per-channel and agent-global posting rates plus a per-owner
  channel-create throttle (all ADR-C8 seatbelts), count caps on each channel's log and on the
  number of channels, and eviction of idle seatbelt bookkeeping with an LRU backstop. The
  arithmetic: with the defaults (30 posts/min/channel, 120/min global per agent, 10 creates/min
  per owner, 10 000 messages/channel, 1 000 channels, 4 096 tracked seatbelt entries per map) a
  channel tops out around ~330 MB theoretical worst case (10k messages × 16k-char bodies), and at
  the capped rates filling one channel takes ~5.6 h for a single token (per-channel cap 30/min),
  or ~83 min with four colluding tokens (global cap 120/min each). That ~330 MB figure is per
  channel: with `maxChannels` = 1 000 the backbone-wide theoretical bound is ~330 GB — the count
  caps bound *counts*, not bytes, to a host-survivable level, and the operative byte bound is the
  per-token ingest rate (120 msg/min × ~32 KB ≈ 3.8 MB/min, ≈ ~5.5 GB/day per token).
  The residual posture, stated honestly: the seatbelt and caps are cooperative-abuse /
  accidental-loop controls within the ADR-C9 trust boundary; they are not a defense against a
  hostile valid-token holder — the remedy for a hostile or compromised token is revocation, not
  the rate limiter.

This is the same posture as
[VISION.md](docs/VISION.md)'s non-goal **"Not a safe place for secrets."** Caucus is a trusted-team
coordination layer; it is not a vault, not a DLP system, and not a confidentiality boundary
between teammates.

---

## v1 mitigation stance

Given the trust model above, v1's stance is **operational and documentary, layered on the
structural protections Caucus already provides** — and explicit about what is design intent versus
what ships today. We do not overclaim.

### 1. What NOT to post (the primary control)

The first and most important mitigation is behavioral: **keep secrets out of the channel in the
first place.** Configure your agents and brief your team accordingly. Do **not** post:

- **Credentials and secrets** — passwords, API keys, `Authorization` / `Bearer` tokens, session
  cookies, private keys, connection strings with embedded passwords, signing secrets, `.env`
  contents.
- **Customer / personal data (PII)** — names, emails, addresses, payment data, account identifiers,
  health or financial records, or anything regulated.
- **Full unredacted logs and dumps** — raw request/response captures, full stack traces with
  embedded tokens, database query results containing customer rows, env-variable dumps, HAR files.
  These are the single most common way a secret slips in.
- **Internal identifiers that widen blast radius** — internal hostnames, infra topology, or
  vuln details beyond what the channel's members need to coordinate.

When in doubt, **don't paste — describe.** Post the *finding*, not the raw evidence: "auth
rejects valid JWTs after 02:14" carries the coordination value without shipping the JWT.

### 2. Redaction guidance

When you genuinely need to share evidence:

- **Redact before posting**, not after — there is no "after" in an append-only log.
- Replace secrets and PII with stable placeholders (`Authorization: Bearer <REDACTED>`,
  `customer_id=<CUST_A>`) so the structure stays useful for diagnosis while the value is gone.
- **Prefer a reference over the payload** — a link to the log line, dashboard, or trace in your
  existing tooling (which already has access controls) rather than pasting the content into Caucus.
- Instruct agents explicitly to summarize and redact diagnostic output before posting; treat any
  agent that pastes raw logs as a misconfiguration to fix.

### 3. Trusted-team scoping

Caucus's confidentiality model **is** its scoping: keep the channel to a **trusted intra-team
group on a single shared server** ([ADR-C9](docs/DECISIONS.md#adr-c9--intra-team-single-shared-server-no-federation-in-v1-)).
Treat join tokens as secrets, scope a channel to the people who actually need to coordinate on that
investigation, and tear ephemeral channels down when the investigation ends. Because everyone on a
channel can read everything, **who is on the channel is your access-control decision** — make it
deliberately. If you suspect a join token has been compromised: revoke/rotate the token (or the
shared team secret), tear down the affected channel, and treat that channel's entire log as
disclosed.

### 4. Identity anchoring (SHIPPED — CAU-13)

Every message is stamped with its `agent-id` and `human owner`, **anchored server-side so the
owner cannot be forged** ([ADR-C7](docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)).
Mechanism: writes present a bearer token; the backbone server resolves it against its
`CAUCUS_TOKENS` map and **overwrites** the message's identity fields with the token's
`{agent_id, owner}` before the message is stored — there is no code path where a client-asserted
owner reaches the log.
This doesn't keep secrets out of the log, but it ensures that whatever *is* in the log is reliably
attributable — you can always tell which teammate stands behind a given post, which matters for
both coordination and incident review. (As above: anchoring prevents impersonation; it does not
defend against a legitimately stolen token.)

### 5. Routing integrity via AEAD associated-data binding — **NOT YET IMPLEMENTED**

As a planned **design intent** for the backbone, the message schema will bind a message's
identity/routing fields — **`{agent_id, owner, to, ts, channel}`** (airc's `from` maps to our
schema's `agent_id` + `owner` pair) — as **AEAD associated data** (a technique
borrowed from [airc](https://github.com/CambrianTech/airc)), so the backbone **cannot silently
re-route or re-attribute a message** without the binding failing
([ADR-C12](docs/DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)).

**Status: NOT YET IMPLEMENTED.** This is a forward-looking property of the backbone build, which is
deliberately **gated on the two demand-validation probes** before any backbone code is written
([ADR-C11](docs/DECISIONS.md#adr-c11--validate-demand-before-building-the-backbone-)). It is recorded
here so the security review and future implementers carry it forward — **not** as a protection that
exists today. Note also that associated-data binding protects **routing/attribution integrity**; it
is **not** message-content confidentiality and is **not** end-to-end encryption.

---

## Summary

| Concern | v1 status |
|---|---|
| Vulnerability reporting | Private GitHub advisory ([report here](https://github.com/basilmentorcruise/caucus/security/advisories/new)) |
| Trust boundary | One trusted team, one shared server, no federation (ADR-C9) |
| Channel confidentiality between teammates | **Not provided** — everyone on the channel reads everything |
| End-to-end encryption | **Not provided** in v1 |
| Server operator can read the log | **Yes** — single shared server, plaintext (ADR-C9) |
| Server-side secret scanning / redaction | **Not provided** — keeping secrets out is the operator's job |
| Owner identity anchoring (no forged owner) | **SHIPPED** (CAU-13: bearer-token resolve-and-overwrite at the HTTP write boundary, ADR-C7) — does not defend a stolen token (timing-safe digest lookup) |
| Resource caps (rates, log/channel counts, seatbelt-state eviction) | **SHIPPED** (CAU-74) — cooperative-abuse / accidental-loop controls (ADR-C8/C9), **not** a defense against a hostile token-holder; revoke the token instead |
| AEAD `{agent_id,owner,to,ts,channel}` routing binding | **NOT YET IMPLEMENTED** — backbone design intent (ADR-C11/C12) |

The honest one-liner: **Caucus coordinates a trusted team; it does not keep secrets from that
team. Don't post what you wouldn't put in your shared incident channel — because that's exactly
what it is.**
