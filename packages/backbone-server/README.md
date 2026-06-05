# @caucus/backbone-server

The standalone **HTTP backbone service** and its **HTTP client** (CAU-5).

`@caucus/backbone` (CAU-4) implements every channel operation in-process behind
the `Backbone` interface. This package exposes that same contract **over the
wire** — one shared server (ADR-C9), HTTP + JSON over localhost, stateless
(CAU-2 substrate verdict) — and ships an `HttpBackbone` client that implements
the identical `Backbone` interface, so the CAU-25 integration harness runs the
same scenarios in-process and over HTTP without change.

Zero runtime dependencies: Node's stdlib `http` server and global `fetch`.

## Security posture

**Writes are token-gated (CAU-13).** `append`, `claim`, and `createChannel`
require an `Authorization: Bearer <token>` header whose token appears in the
server's `CAUCUS_TOKENS` map; the server resolves the token to its
`{agent_id, owner}` and **overwrites** the message's identity fields before
storing — a client-asserted owner never reaches the log (ADR-C7 anti-forgery).
**Fail-closed:** with `CAUCUS_TOKENS` unset or empty, every write is rejected
`401 unauthorized`. Reads (`list`/`describe`/`read`/`subscribe`/`healthz`) stay
open within the intra-team trust boundary (the read-only hook is tokenless).

The server is intended for **localhost only** (it binds `127.0.0.1` by
default). **Do not bind it to a public interface.** There is also **no disk
persistence**: the server wraps one in-memory backbone instance, so its state
is lost on restart (durability is deferred).

## Run it

```sh
CAUCUS_TOKENS="tok-a:sess-a:alice,tok-b:sess-b:bob" pnpm backbone:dev
PORT=0 CAUCUS_TOKENS=... pnpm backbone:dev   # OS-assigned ephemeral port
HOST=127.0.0.1 PORT=4317 CAUCUS_TOKENS=... pnpm backbone:dev
```

The `caucus-backbone` bin reads `PORT` (default `4317`), `HOST` (default
`127.0.0.1`), and `CAUCUS_TOKENS` (comma-separated `token:agent_id:owner`
triples; **required for writes** — without it the server starts fail-closed)
from the environment and logs the bound URL.

## Routes

| Method & path | Maps to | Success |
| --- | --- | --- |
| `POST /channels` | `createChannel` | `201` `ChannelDescriptor` |
| `GET /channels` | `listChannels` | `200` `{ channels: [...] }` |
| `GET /channels/:channel` | `describeChannel` | `200` `ChannelDescriptor` |
| `POST /channels/:channel/subscribe` | `subscribe` | `200` `{ cursor }` |
| `POST /channels/:channel/append` | `append` | `201` `AppendResult` |
| `POST /channels/:channel/read` | `readSince` (body `{ cursor, limit? }`) | `200` `ReadResult` |
| `POST /channels/:channel/claim` | `claim` | `200` `ClaimResult` (`granted` **or** `already_claimed`) |
| `GET /healthz` | — | `200` `{ ok: true }` |

Transport faults: unknown path → `404 not_found`; wrong method → `405
method_not_allowed`; malformed JSON body → `400 invalid_json`; a raw request
body over ~256&nbsp;KB → `413 payload_too_large`.

Every error response has the shape `{ error: { code, message, issues? } }`
(`issues` only for `invalid_message`). The backbone is the **single validation
authority** — the router never re-validates inputs, it only routes, parses the
JSON body, calls the backbone, and maps the result/error to status + JSON. The
server never leaks an internal message or stack: an unmapped throw is reported as
a generic `internal_error` (500).

## Client

```ts
import { HttpBackbone, startServer } from "@caucus/backbone-server";

const server = await startServer({ port: 0 });
const backbone = new HttpBackbone(server.url); // implements `Backbone`
await backbone.createChannel({ channel: "incident-1", purpose: "…", created_by: "alice" });
// …
await server.close();
```

`HttpBackbone` reconstructs the **real** `BackboneError` subclasses from the wire
(`UnknownChannelError`, `InvalidMessageError`, …) so callers keep their
`instanceof` / `.code` branching across the network. A lost claim is a normal
`already_claimed` **result** (HTTP 200), never a throw.

### Bearer token convention

The bearer a client presents is the **map key** — the colon-free FIRST segment
of a `CAUCUS_TOKENS` entry. For the entry `tok-alice-secret:alice-agent:alice`,
the bearer is `tok-alice-secret` and the server anchors that session to
`{ agent_id: "alice-agent", owner: "alice" }`:

```ts
const backbone = new HttpBackbone(server.url, { token: "tok-alice-secret" });
```

The bearer is a **per-session opaque secret**, never the structured
`agent:owner` pair (which is not a secret). The MCP server forwards its
`CAUCUS_TOKEN` here verbatim — see
[`@caucus/mcp-server` → Connecting to the shared backbone](../mcp-server/README.md#connecting-to-the-shared-backbone).

## Claim route (CAU-7)

`POST /channels/:channel/claim` enforces first-write-wins atomically in the
backbone and answers BOTH outcomes as a normal `200`:

- `granted` — this caller won; the `claim` message was appended in the same
  atomic step (ADR-C5) and `cursor` is the new head.
- `already_claimed` — a prior claim holds the target; `by: { agent_id, owner,
  ts, msg_id }` identifies the holder.

A conflict is a **result, not an error** — the route never returns a `4xx`/`5xx`
for a lost race. Only validation/not-found failures throw (`invalid_message`,
`unknown_channel`), and a non-object body is a structural `400 invalid_request`.

## Scope handed forward

- **CAU-8** — seatbelts (rate / size caps) at the transport boundary.
- **CAU-18 (M2)** — lease expiry / release / reassignment. The schema carries
  optional lease/TTL fields but the claim route enforces first-write-wins only.
