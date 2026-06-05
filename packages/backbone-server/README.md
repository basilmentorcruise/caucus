# @caucus/backbone-server

The standalone **HTTP backbone service** and its **HTTP client** (CAU-5).

`@caucus/backbone` (CAU-4) implements every channel operation in-process behind
the `Backbone` interface. This package exposes that same contract **over the
wire** — one shared server (ADR-C9), HTTP + JSON over localhost, stateless
(CAU-2 substrate verdict) — and ships an `HttpBackbone` client that implements
the identical `Backbone` interface, so the CAU-25 integration harness runs the
same scenarios in-process and over HTTP without change.

Zero runtime dependencies: Node's stdlib `http` server and global `fetch`.

## Security posture (v0)

The server is **unauthenticated** and intended for **localhost only** (it binds
`127.0.0.1` by default). It does not verify `agent_id` / `owner` — identity
anchoring is CAU-9 / CAU-13. Until then, anyone who can reach the port can post
as any principal. **Do not bind it to a public interface.** There is also **no
disk persistence**: the server wraps one in-memory backbone instance, so its
state is lost on restart (durability is deferred).

## Run it

```sh
pnpm backbone:dev          # build the package, then start on PORT (default 4317)
PORT=0 pnpm backbone:dev   # bind an OS-assigned ephemeral port
HOST=127.0.0.1 PORT=4317 pnpm backbone:dev
```

The `caucus-backbone` bin reads `PORT` (default `4317`) and `HOST` (default
`127.0.0.1`) from the environment and logs the bound URL.

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
