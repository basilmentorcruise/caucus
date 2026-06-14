# Secrets Operator Runbook (shared backbone)

This runbook is for the **operator running a shared Caucus backbone** that real testers point at
real diagnostics. It covers the operational secret-handling lifecycle: **inventory, rotation &
revocation, alerting, audit, and incident response.**

Read [`SECURITY.md`](../SECURITY.md) first — it defines the trust boundary and the secret-leak
threat model this runbook operates inside. This document does not restate that model; it tells you
how to **run** within it.

> **Accuracy contract.** Every control described here exists in the current code, or is explicitly
> marked **GAP** / **NOT BUILT**. This runbook does not imply a capability Caucus does not ship.
> Where a procedure is "restart with new config" rather than a live API, it says so precisely.

The two load-bearing facts that shape everything below:

1. **The token model is static config.** Write authorization is a bearer-token → identity map
   (`CAUCUS_TOKENS`) parsed **once at process start** into an immutable in-memory map. There is
   **no token store, no issuer service, no live revocation list, and no config reload** — see
   [Rotation & revocation](#rotation--revocation).
2. **The channel is a shared, persisted, append-only log.** A posted secret propagates to every
   joined session and **does not un-leak** ([ADR-C12](DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)).
   Identity anchoring ([ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer))
   tells you *who* posted it; it does not stop the leak.

---

## Secret inventory

What secrets exist in a shared deployment, and where each lives.

| Secret | What it is | Where it lives | Blast radius if leaked |
|---|---|---|---|
| **Participant tokens** (`CAUCUS_TOKENS` entries) | The server-side `tok:agent_id:owner` triples. The `tok` segment is the write-auth bearer secret; the `agent_id`/`owner` segments are the identity it anchors. | **Server only**, in the backbone process's `CAUCUS_TOKENS` env var (and wherever you store that env — systemd unit, `.env`, secrets manager, shell history). Parsed once at startup; **only the SHA-256 digest is retained in memory**, never the raw token. | A stolen `tok` lets the holder **write as that owner** to any channel and read the whole log. Identity anchoring means it impersonates *that specific owner* — it cannot forge a *different* owner. |
| **`CAUCUS_TOKEN`** (client side) | The one client env var. **Dual-role**: it is both the session's display identity *and* the HTTP bearer secret sent verbatim on **every** request (including reads). | On **each tester's machine** — their MCP-server/hook env, shell profile, or `.mcp.json`. One per session. | Same as a stolen participant token: write-as-owner + full-log read. A read-only session still transmits it, so a mistyped `CAUCUS_URL` can ship it off-box. Guard it like a credential even though it "looks like" a display name. |
| **`NPM_TOKEN`** (self-publishing only) | An npm automation/publish token, **if** you self-publish `@caucus/*` packages. | CI secret store / publish runner only. | **GAP / not yet relevant:** per [`RELEASING.md`](RELEASING.md), no publish workflow, npm token, or release is wired up today. Only inventory this secret if *you* add a publish pipeline; until then it does not exist in the deployment. |
| **Proxy / tunnel credentials** | Whatever fronts the loopback backbone for remote testers (SSH tunnel key, Tailscale/WireGuard creds, reverse-proxy basic-auth, Cloudflare Tunnel token, etc.). | The operator's tunnel/proxy config — **outside Caucus**. Caucus has no tunnel of its own. | A leaked tunnel cred can expose the **tokenless read surface** to the network (see below). This is often the *widest* blast radius because reads carry no token at all. |

### Why the tunnel cred matters most

The backbone binds **`127.0.0.1` by default** and **reads are tokenless within the trust boundary**
— the effective read boundary *is* the network bind. The `HOST` env var is the single knob that
widens exposure. So the moment you front the loopback port with a tunnel/proxy for remote testers,
**that tunnel's credential becomes the real read-access control**, because reaching the port = reading
the whole log. Treat the tunnel cred as a Caucus secret of equal weight to the participant tokens.

---

## Rotation & revocation

**This is the section most likely to be misread, so it is stated bluntly: Caucus has no live
revocation. Revocation is "rotate the config and restart the process."**

### How the token model actually works (verified against code)

- `CAUCUS_TOKENS` is parsed **once, at startup**, by `parseTokenMap` into an **immutable** in-memory
  `TokenMap`. Keys are the **SHA-256 digest** of each token; the raw secret is never stored.
- On every write, the server resolves the presented bearer against that map (timing-safe digest
  lookup) and **overwrites** the message's `agent_id`/`owner` with the token's identity before storing
  — this is the [ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)
  anchoring (CAU-13).
- There is **no** `revoke` endpoint, **no** revocation list, **no** per-token expiry, **no** config
  hot-reload, and **no** signal handler that re-reads `CAUCUS_TOKENS`. The map is fixed for the life
  of the process.

**Consequence:** the only way to change who can write is to **change `CAUCUS_TOKENS` and restart the
backbone process.** A running backbone honors exactly the token set it started with.

### Rotate a single participant token (planned, no compromise)

1. Generate a new colon-free token value for that session.
2. Edit `CAUCUS_TOKENS` on the server: replace the old `tok` segment, keep the same `agent_id:owner`
   (so attribution continuity is preserved).
3. **Restart the backbone process.** (Restarting drops all in-flight channels and the log — channels
   are ephemeral and in-memory by design, so plan rotation for a quiet moment or accept the channel
   reset.)
4. Hand the new token to that one tester; have them update their client `CAUCUS_TOKEN`.
5. Every other token keeps working *only because you left it unchanged in the env* — there is no
   per-token rotation primitive; you are editing one line of a shared config and restarting.

### Revoke a *compromised* participant token (urgent)

There is no live revoke. The compromised token stays valid **until the process restarts without
it**. Procedure:

1. **Remove that token's entry from `CAUCUS_TOKENS` on the server** (delete the whole
   `tok:agent_id:owner` line).
2. **Restart the backbone process immediately.** This is the revocation. Until the restart, the
   stolen token can still write-as-owner and read the log.
3. Treat **every channel's entire log as disclosed** for the window the token was live (the holder
   could read everything — reads are tokenless and unbounded in count). Tear down the affected
   channels.
4. If you cannot isolate *which* token is compromised, or the shared **team secret** itself leaked,
   **rotate the whole `CAUCUS_TOKENS` set** (new `tok` for every session) and restart — see below.

### Rotate the whole shared secret / all tokens

When the join secret is shared-team-wide, or you can't scope the compromise:

1. Regenerate **every** `tok` value (keep `agent_id:owner` pairs for attribution continuity).
2. Replace `CAUCUS_TOKENS` wholesale and **restart**.
3. Re-distribute new client `CAUCUS_TOKEN`s to **all** testers out-of-band (never in a channel —
   ADR-C12).

### Blast radius, and how identity anchoring limits damage

- **What anchoring DOES limit:** a stolen token can only act as **its own** `agent_id:owner`. The
  thief cannot forge a *different* teammate's owner — the server overwrites identity from the token
  map, and the client-asserted owner never reaches the log. So a compromise is **attributable and
  scoped to one identity**, which makes audit and incident scoping tractable.
- **What anchoring does NOT limit:** anchoring does **not** stop a *legitimately stolen* token from
  acting as the real owner. A thief holding `tok` *is* that owner as far as the server is concerned.
  Anchoring is anti-**forgery**, not anti-**theft**. The remedy for a stolen token is **revocation
  (config edit + restart)**, never the seatbelt/rate-limiter.
- **Reads have no token at all**, so the read blast radius of any compromise (token *or* tunnel) is
  the **entire log of every channel reachable on that bind**.

---

## Alerting

**Be honest with yourself: Caucus ships almost no operator-facing telemetry today.** This section
separates what you *can* see from what you *cannot*, so you don't build a runbook on a signal that
isn't emitted.

### What surfaces TODAY

| Signal | Where it surfaces | Notes |
|---|---|---|
| **Backbone is bound off-loopback** | **Startup stderr.** The bin logs `caucus-backbone listening on <url>` and, for a non-loopback bind, an explicit `WARNING: bound to <host> — reads are open to anyone who can reach this port`. `parseEnvConfig` also warns at config time, sharpened when no tokens are set. | The one strong, reliable operator signal. **Capture stderr** and alert on the `WARNING: bound to` line — an unexpected non-loopback bind is your highest-value alert. |
| **Malformed token config** | **Startup failure.** A malformed `CAUCUS_TOKENS` throws a *positional* parse error (names the entry index, never the token text) and the process fails to start. | Fail-fast at boot — your process supervisor will see a non-zero exit. |
| **Write rejected (401)** | **HTTP response only.** An unknown/absent bearer gets an identical `401` (no oracle). | **GAP:** the server does **not log** auth failures. There is no auth-failure counter, no audit line, nothing on stderr. You can only observe 401s from a proxy/tunnel access log if you put one in front. |

### What is NOT observable today (GAPS — do not alert on these, you'll get nothing)

- **Auth-failure rate / brute-force attempts** — **NOT BUILT.** The request dispatch path emits no
  per-request log. A flood of 401s leaves no trace on the backbone itself. *Mitigation:* run the
  backbone behind a proxy/tunnel whose access log you *do* collect, and alert there.
- **Anomalous read amplification** — **NOT BUILT.** Reads are tokenless and **not rate-limited**; the
  server does not count, log, or expose who read what or how much. A token-holder (or anyone past the
  bind) can issue clamped reads back-to-back invisibly. The schema-level read-amplification *caps*
  exist (bounded page size, bounded field lengths — CAU-83/90), but they are **size guards, not
  telemetry**: they cap the damage, they do not alert you to the behavior.
- **Unexpected channels / who-joined** — **NOT BUILT** as an alert. You can *list* channels via the
  MCP descriptor tools (`caucus_list_channels` / `caucus_describe_channel`) as a manual poll, but
  there is no event, no notification, and no "a new channel appeared" signal. There is also no
  server-side notion of "join" to observe (the join-gate is client-side only — see ADR-C6 addendum /
  ADR-C12 in SECURITY.md).
- **Secret-posted detection** — **NOT BUILT.** The server does **not** scan, redact, or flag secrets.
  Nothing alerts you that a token landed in a channel. Detection is human ([Audit](#audit) below).

> **All of the above are the domain of [CAU-17 — Human observability surface](https://github.com/basilmentorcruise/caucus/issues/17)**
> (OPEN, backlog). Until CAU-17 lands, treat alerting as: **(a)** the startup bind warning, and
> **(b)** whatever your fronting proxy/tunnel logs. The backbone itself is effectively silent at
> runtime. Do not promise testers an alerting capability that isn't built.

---

## Audit

### What the append-only log DOES record

- Every message carries a **server-anchored `agent_id` + `owner`** (ADR-C7). Attribution is reliable:
  you can always tell **which teammate's session** posted, claimed, created a channel, or steered —
  the owner cannot be forged, only stolen.
- The log is **append-only and ordered** (ULID `msg_id`, monotonic cursor), so "who did what, in
  what order" within a channel's life is reconstructable by reading the channel.
- Claims are first-write-wins and posted as `claim` messages, so the **work-coordination record** is
  in the log too.

### What it DOES NOT record

- **No durability.** The log and the evidence-store blobs are **in-memory, process-lifetime only**
  (ADR-C2 / ADR-C14). On process exit — including the restart you do to revoke a token — **the entire
  audit trail is gone.** If you need a post-incident record, **export/read the channel before you
  restart.** There is no archival, no on-disk log, no retention.
- **No read audit.** Reads are tokenless and unlogged — the log records *posts*, never *who read it*.
  You cannot reconstruct who saw a leaked secret; assume **everyone on the channel** did.
- **No server-side access log** of HTTP requests (see [Alerting](#alerting)).

### Reviewing who-did-what

While the process is alive: read the channel (`caucus_read_channel`, or a direct `readSince`) and use
the anchored `owner`/`agent_id` on each message. There is no separate audit API — the log *is* the
audit record, and it dies with the process.

### The no-secrets guarantee (ADR-C12) and what it actually is

The "no secrets in channel" guarantee is **behavioral, not enforced.** The server faithfully stores
and propagates whatever is posted — it does **not** scan or redact (SECURITY.md states this plainly).
The guarantee is: *the operator and agents keep secrets out*; the tooling helps only by (a) the
"never post secrets" tool copy, and (b) never echoing the bytes of an uploaded artifact into a hook
line. **If a secret is posted, it is leaked** — proceed to incident response.

---

## Incident quick-reference

### A tester leaked a participant token (`tok` / `CAUCUS_TOKEN`)

1. **Remove that token's entry from `CAUCUS_TOKENS` and restart the backbone.** This is the only
   revocation. Until restart, the token is live.
2. Treat **every channel reachable by that token as fully disclosed** for the live window (reads are
   tokenless and unbounded). Tear down affected channels.
3. Re-issue a fresh `tok` for that `agent_id:owner`; deliver the new client `CAUCUS_TOKEN`
   **out-of-band**.
4. If you can't scope which token leaked → rotate the **whole** `CAUCUS_TOKENS` set and restart.
5. **Before restarting**, if you need a record, read the affected channels first — the restart wipes
   the log.

### A secret was posted into a channel

1. **It does not un-leak.** There is no delete; the log is append-only and already propagated to every
   joined session's context.
2. **Rotate the leaked secret at its source** (the database password, API key, cloud cred — whatever
   was posted), out-of-band. The Caucus log entry is not the asset to protect; the underlying secret
   is.
3. Tear down the channel and treat its whole log as disclosed.
4. If the *posted* secret was itself a Caucus participant token, also do the token-leak procedure
   above (remove from `CAUCUS_TOKENS`, restart).
5. Tighten agent behavior: the offending session was posting raw diagnostic output — re-brief it to
   **describe, not paste**, and redact before posting (SECURITY.md mitigation stance).

### The backbone became reachable too widely

1. **Check the bind.** Confirm `HOST` is unset/loopback. The startup `WARNING: bound to <host>` line
   tells you if it isn't — if you see it unexpectedly, you are exposed.
2. **Restart bound to `127.0.0.1`** (clear/fix `HOST`). Never expose the port directly; reach remote
   testers through a tunnel/proxy you control — see [Distributed-team deploy guide](DEPLOY_DISTRIBUTED.md)
   for safe recipes.
3. Because **reads are tokenless**, assume **anyone who could reach the port read the entire log.**
   Treat all live channels as disclosed; rotate any secrets that were posted; rotate the tunnel
   credential if the tunnel was the exposure path.
4. There is no auth-failure log to tell you whether anyone *did* read — assume they did, scope
   accordingly.

---

## Operator checklist (steady state)

- [ ] Backbone bound to `127.0.0.1`; remote access only via a tunnel/proxy you control.
- [ ] `CAUCUS_TOKENS` set (fail-closed: unset ⇒ all writes 401), one token per session, each with a
      distinct `agent_id` (shared `agent_id` shares rate budgets).
- [ ] Token values are colon-free; the whole env value stored as a secret, not in shell history.
- [ ] Startup stderr captured; alert on any `WARNING: bound to` line.
- [ ] A fronting proxy/tunnel access log is collected (the only place 401s / read volume can be
      seen — the backbone itself is silent).
- [ ] Team briefed: **describe, don't paste**; redact before posting; never post a token/secret/PII
      (ADR-C12, SECURITY.md). Tear channels down when an investigation ends.
- [ ] Revocation plan understood: **edit `CAUCUS_TOKENS` + restart**; restart wipes the log, so read
      what you need to keep first.

---

## Known gaps (cross-reference)

These are honest limitations, **not** implied capabilities. They are tracked for future work; do not
operate as if they exist.

- **No live token revocation / issuer / expiry.** Revocation is config-edit + restart. A token-issuer
  service and cross-org identity are deferred to M2 (ADR-C7).
- **No runtime observability** (auth failures, read amplification, channel/join events,
  secret-posting detection) → **[CAU-17](https://github.com/basilmentorcruise/caucus/issues/17)**.
- **No server-side secret scanning/redaction** — operator/agent responsibility (SECURITY.md).
- **No durable audit log** — in-memory, dies on process exit; export before restart.
- **AEAD routing/identity binding** (`{agent_id, owner, to, ts, channel}`) is **NOT YET IMPLEMENTED**
  (SECURITY.md §5 / ADR-C12) — a design intent, not a current protection.

## See also

- [Distributed-team deploy guide](DEPLOY_DISTRIBUTED.md) — safe recipes for fronting the loopback
  backbone for a remote team (the operational counterpart to this runbook).
- [SECURITY.md](../SECURITY.md) — the threat model and trust boundary this runbook operationalizes.
