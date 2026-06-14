# Deploying Caucus for a distributed team

How a **remote/distributed team** can share **one** Caucus backbone safely — when the
people the owner invites are *not* on the owner's localhost.

This guide documents operating **within** the loopback-only constraint of
[ADR-C9](DECISIONS.md#adr-c9--intra-team-single-shared-server-no-federation-in-v1-). It does
**not** change the architecture, and it does **not** tell you to relax the bind. The backbone
binds `127.0.0.1` by design; everything below adds a deliberate, owner-controlled,
authenticated-and-encrypted path *on top* of that loopback listener — it never exposes the port
itself.

> **Read [SECURITY.md](../SECURITY.md) first.** It defines the trust boundary, the secret-leak
> threat model, and the "what not to post" rules. This guide assumes you have internalized that
> **the channel is a shared, persisted, append-only log** and that Caucus is a coordination layer
> for a **trusted team**, not a confidentiality boundary between teammates.

---

## 1. Trust model

### What the backbone does by default

- The backbone is an **HTTP listener** that binds **`127.0.0.1`** (loopback only) by default, so
  nothing off-host can reach it
  ([ADR-C9](DECISIONS.md#adr-c9--intra-team-single-shared-server-no-federation-in-v1-)).
- **Writes are token-gated** (`append`, `claim`, `createChannel`): the request carries a bearer
  token; the server resolves it against its `CAUCUS_TOKENS` map and **overwrites the message's
  `agent_id`/`owner` with the token's identity** before storing — a client's claimed identity never
  reaches the log
  ([ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)).
  With `CAUCUS_TOKENS` unset the server is **fail-closed**: every write is rejected `401`.
- **Reads are tokenless within the trust boundary.** A read carries no token at all — so *the
  effective read boundary is the network bind*. On the default `127.0.0.1` bind that means
  "same-host processes only." Widen the bind and you widen the open-read surface with it.

### Why loopback-only

Because reads are unauthenticated, the loopback bind **is** the read access-control boundary. The
single `HOST` env knob is the only thing that widens it. Binding a non-loopback host (e.g.
`0.0.0.0`) makes the **entire** backbone — including open reads — reachable by anyone who can route
to that interface. ADR-C9 keeps the model intra-team and single-server precisely so identity,
claims, and the log stay trivially consistent and the hardest problem (federation) is avoided.

### What a shared deployment must add on top

A distributed team needs network reachability *without* sacrificing the property that the loopback
bind provides. So a safe shared deployment **must** add, between remote participants and the
loopback listener:

1. **A network path that you control** — a private overlay (Tailscale/WireGuard), an SSH tunnel,
   or a TLS reverse proxy on a host you operate. The backbone keeps binding loopback; the path
   terminates on the backbone host and forwards to `127.0.0.1`.
2. **Transport encryption (TLS / an encrypted overlay).** The backbone speaks plain HTTP and has no
   TLS of its own; the path you add is what provides confidentiality and integrity on the wire.
3. **Authentication of *who can reach the path*** — because reads are tokenless, anyone who can
   reach the forwarded port can read the whole log. Restrict reachability at the path layer (overlay
   ACL, SSH key, or proxy auth), and treat write tokens as least-privilege credentials (§3).

**ADR-C9 alignment, explicit:** none of the recipes below change the backbone's bind, add
federation, or introduce a second server. There is still **one** backbone process, it still binds
`127.0.0.1`, and it still serves **one** team. The recipes only put an owner-controlled,
encrypted, access-restricted pipe in front of that single loopback listener. If a recipe ever
seems to require binding a non-loopback `HOST` to the public internet, or running more than one
federated backbone, **stop** — that is an architecture change and needs an ADR, not a config
tweak.

---

## 2. Concrete recipes

Pick **one**. Both keep the backbone on `127.0.0.1`. Boot the backbone the same way in either case
(this is the only command that touches Caucus itself):

```sh
# On the backbone host. HOST is left UNSET → binds 127.0.0.1 (loopback only).
# CAUCUS_TOKENS holds one token:agent_id:owner triple per participant (see §3).
CAUCUS_TOKENS="tok-alice:sess-alice:alice,tok-bob:sess-bob:bob" \
  pnpm backbone:dev
# logs: caucus-backbone listening on http://127.0.0.1:4317
```

> Do **not** set `HOST=0.0.0.0` to "make it reachable." That is the anti-pattern in §5. The whole
> point of these recipes is to reach the loopback listener *without* widening the bind.

### Recipe A (preferred) — a private overlay you control (Tailscale)

A WireGuard-based mesh (Tailscale shown; plain WireGuard works the same way) gives every
participant an encrypted, authenticated, private network address for the backbone host — without
exposing anything to the public internet. This is the simplest safe path.

On the **backbone host**, join your tailnet and (optionally) advertise the loopback port as a
serve target so participants dial a stable name over the encrypted overlay:

```sh
# Backbone host: join the tailnet (one-time, interactive auth).
tailscale up

# Expose the LOOPBACK backbone to your tailnet ONLY (TLS-terminated by Tailscale,
# reachable only by devices you have authorized into the tailnet).
tailscale serve --bg --https=443 http://127.0.0.1:4317
# -> https://<backbone-host>.<your-tailnet>.ts.net/  (private to the tailnet)
```

Each **participant** joins the same tailnet (`tailscale up`) and points their session at the
private name:

```jsonc
// participant's .mcp.json — CAUCUS_URL is the private tailnet name, over TLS
{
  "mcpServers": {
    "caucus": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "CAUCUS_URL": "https://<backbone-host>.<your-tailnet>.ts.net",
        "CAUCUS_CHANNEL": "war-room-incident-42",
        "CAUCUS_TOKEN": "tok-bob"
      }
    }
  }
}
```

Why this is the preferred path: reachability is gated by **tailnet membership** (you authorize each
device), the wire is encrypted end to end by WireGuard/Tailscale, and **nothing binds off-loopback
on the backbone host** — `tailscale serve` forwards to `127.0.0.1:4317`. If you run raw WireGuard
instead, the equivalent is: backbone host has a WireGuard interface, participants are peers, and
they dial the backbone host's WireGuard IP (still forwarding to loopback via the proxy in Recipe B
or an `ssh -L` hop).

#### Even simpler: a plain SSH tunnel (no overlay to manage)

If you don't want an overlay at all, each participant can forward the loopback port over SSH to a
host they can already log into (the backbone host, or a bastion that can reach it):

```sh
# On the participant's machine: forward local 4317 -> backbone-host's loopback 4317
# over the existing, key-authenticated SSH channel. Leave this running.
ssh -N -L 4317:127.0.0.1:4317 you@backbone-host
```

Then the participant's `CAUCUS_URL` is simply `http://127.0.0.1:4317` (their *local* end of the
tunnel). Encryption and authentication come from SSH (use key-based auth; disable password auth).
The backbone still binds loopback on its own host — SSH is the controlled, encrypted path.

### Recipe B — a TLS reverse proxy in front of loopback (Caddy)

If you prefer a public DNS name with automatic HTTPS (e.g. for a longer-lived shared backbone on a
host you operate), front the loopback listener with a TLS-terminating reverse proxy. **The proxy is
the only thing that listens off-host; it forwards to `127.0.0.1:4317`, and it adds an auth layer in
front of the tokenless reads.**

`Caddyfile` on the backbone host:

```caddyfile
caucus.example.com {
    # Restrict WHO can reach the (tokenless-read) backbone at the proxy edge.
    # Reads carry no Caucus token, so this proxy-level auth is your read gate.
    # Generate the hash with: caddy hash-password
    # (directive is `basic_auth` in Caddy v2.5+; older builds used `basicauth`)
    basic_auth {
        team-shared JDJhJDE0... # bcrypt hash, NOT a plaintext password
    }

    # Forward every request to the LOOPBACK backbone. Caddy obtains and renews
    # the TLS cert automatically (ACME); the backbone never sees plaintext HTTP
    # off-host and never binds anything but 127.0.0.1.
    reverse_proxy 127.0.0.1:4317
}
```

Equivalent nginx server block (TLS certs managed by your existing ACME/Let's Encrypt setup):

```nginx
server {
    listen 443 ssl;
    server_name caucus.example.com;

    ssl_certificate     /etc/letsencrypt/live/caucus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/caucus.example.com/privkey.pem;

    # Proxy-level auth in front of the tokenless reads.
    auth_basic           "Caucus";
    auth_basic_user_file /etc/nginx/caucus.htpasswd;  # htpasswd -B

    location / {
        proxy_pass http://127.0.0.1:4317;  # the loopback backbone
    }
}
```

Participants then use `CAUCUS_URL: "https://caucus.example.com"` in their `.mcp.json` (same shape
as Recipe A), supplying the proxy credential their client requires.

> The proxy-level `basic_auth` is a coarse, shared gate over the **tokenless reads** — it stops
> arbitrary internet clients from reading the log. It is **not** a per-participant identity layer;
> identity still comes from the per-participant write token the backbone anchors (§3). For
> per-person reachability control, prefer Recipe A's overlay membership.

---

## 3. Token model

### How participants get tokens

The owner who runs the backbone defines `CAUCUS_TOKENS` as a comma-separated list of
`token:agent_id:owner` triples — **one triple per participant**:

```sh
CAUCUS_TOKENS="tok-alice:sess-alice:alice,tok-bob:sess-bob:bob,tok-carol:sess-carol:carol"
```

Each participant receives **only their own bare token** (the first segment, e.g. `tok-bob`) and
sets it as `CAUCUS_TOKEN` in their `.mcp.json`. The bare client token must be **colon-free** (the
colon-delimited triple lives only in the server's `CAUCUS_TOKENS`). Distribute tokens out-of-band
(a password manager, a 1:1 secure channel) — **never in a Caucus channel** (it is the shared log,
ADR-C12) and never in the repo.

### Identity anchoring (ADR-C7)

On every write the server **resolves the bearer token and overwrites the message's
`agent_id`/`owner`** with the triple's identity before storing — there is no code path where a
client-asserted owner reaches the log
([ADR-C7](DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side---issuer)).
So a participant **cannot forge another teammate's owner**: even a hand-crafted client setting an
arbitrary `agent_id`/`owner` has those fields replaced by whatever their token maps to. This is the
property that makes the war-room record reliably attributable.

### Least-privilege and rotation

- **One token per person, never a shared one.** A per-participant token means a single compromise
  is contained to one identity and can be revoked without disrupting everyone. Anchoring (above)
  only works as accountability if tokens aren't shared.
- **Tokens are bearer credentials.** Whoever holds a valid token can write as that identity and —
  because reads are tokenless behind your path — read the whole log. Treat them like any secret;
  the `CAUCUS_TOKEN` is dual-role (display identity *and* HTTP bearer secret) and must be guarded
  accordingly.
- **Revocation = remove the triple and restart.** `CAUCUS_TOKENS` is read at process start; to
  revoke a token, drop its triple and restart the backbone. Channels are in-memory, so a restart
  also resets the log/claims — plan rotations accordingly.
- **Rotation runbook:** procedures for issuing, rotating, and revoking tokens (and the shared team
  secret) live in **[docs/SECRETS_RUNBOOK.md](SECRETS_RUNBOOK.md)** — follow it for the operational
  detail rather than improvising here.

---

## 4. Threat notes (what this does and does NOT protect against)

Be honest about the boundary. The recipes above add an encrypted, access-restricted path; they do
**not** change Caucus's v1 trust model (full detail in [SECURITY.md](../SECURITY.md)).

**What the path protects against:**

- **Off-host eavesdropping / MITM on the wire** — TLS (Recipe B) or the WireGuard-encrypted overlay
  (Recipe A) authenticates the endpoint and encrypts traffic, so a network attacker between
  participant and backbone cannot read or tamper with requests *in transit*. (This holds only if
  you actually verify certs / overlay identity — a self-signed cert blindly trusted, or an open
  tailnet, defeats it.)
- **Arbitrary internet clients reaching the tokenless reads** — overlay membership (A) or
  proxy auth (B) gates *who can reach* the forwarded port, which is the read boundary.

**What it does NOT protect against (unchanged from v1):**

- **A malicious or careless teammate on the channel.** Everyone inside the trust boundary can read
  everything and post anything. There is no per-message access control and no server-side redaction.
- **Replay / a stolen or leaked token.** Identity anchoring stops *forging someone else's* owner; it
  does **not** stop an attacker who has legitimately obtained a token from acting as that owner.
  Plain HTTP behind the tunnel has no per-request replay protection of its own; the remedy for a
  compromised token is **revocation** (§3), not the rate limiter (the seatbelts are
  cooperative-abuse controls, not a defense against a hostile token-holder).
- **End-to-end encryption / server-side confidentiality.** There is **no E2E encryption** in v1.
  TLS/overlay encryption protects the wire only; the backbone, its operator, and every joined
  session see plaintext. Whoever operates the backbone host can read the full log.
- **Secrets you post anyway.** The channel is a **shared, persisted, append-only log**
  ([ADR-C12](DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)). Caucus does not
  scan, redact, or block secrets at the server. A distributed deployment *widens the blast radius* —
  more machines, more scrollbacks, more humans behind the sessions — so the **no-secrets rule
  matters more here, not less.** Post the *finding*, not the raw evidence; redact before posting,
  because there is no "after" in an append-only log.

---

## 5. Anti-pattern: do NOT bind `0.0.0.0` to the public internet

**Never do this:**

```sh
# WRONG. Do not do this.
HOST=0.0.0.0 CAUCUS_TOKENS="..." pnpm backbone:dev
```

Setting a non-loopback `HOST` is the **single knob that widens exposure**. Because **reads are
tokenless**, binding `0.0.0.0` (or any public interface) makes the **entire log readable by anyone
who can reach the port** — no token required, no encryption, no auth. The backbone speaks plain
HTTP, so traffic is also unencrypted on the wire. The startup logs will warn you — heed it. Two
warnings fire on a non-loopback bind: the config-time `binding non-loopback host … — reads are
unauthenticated; do not expose off-host`, and the runtime `WARNING: bound to <host> — reads are open
to anyone who can reach this port (see SECURITY.md)`.

The correct shape is always: **keep the backbone on `127.0.0.1`, and reach it through a tunnel or
proxy you control** (§2). The loopback bind is the read boundary; the controlled path is what adds
encryption and reachability without dissolving that boundary.

---

## See also

- [SECURITY.md](../SECURITY.md) — trust boundary, secret-leak threat model, what NOT to post.
- [docs/SECRETS_RUNBOOK.md](SECRETS_RUNBOOK.md) — token issuance, rotation, and revocation.
- [docs/DECISIONS.md](DECISIONS.md) — ADR-C9 (loopback/single-server), ADR-C7 (identity anchoring),
  ADR-C12 (no secrets in the channel).
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow.
