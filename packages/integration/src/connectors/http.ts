/**
 * The HTTP connector (CAU-5; token-gated since CAU-13). `boot()` starts ONE
 * `@caucus/backbone-server` on an ephemeral port (over a single in-memory
 * backbone instance), configured with a {@link TokenMap}; every `connectClient`
 * returns a handle whose `backbone` is a fresh {@link HttpBackbone} carrying the
 * bearer token for that id. The handles therefore share the SAME server-side log
 * and claim ledger — over the wire, with anchored identity — so the same
 * multi-client scenarios that run in-process also run over HTTP.
 *
 * **Tokens (CAU-13).** The server is fail-closed: with no tokens every write is
 * `401`. So the connector configures a deterministic token per client id and
 * hands each `HttpBackbone` its matching bearer. The anchored identity is
 * `{ agent_id: "<id>-agent", owner: "<id>" }` — chosen to match the identities
 * the existing scenarios already author (`"alice-agent"`/`"alice"`, …), so they
 * pass unchanged now that the server OVERWRITES client-supplied identity fields.
 *
 * `teardown()` closes the server and frees the port.
 */
import { InMemoryBackbone, type SeatbeltOptions } from "@caucus/backbone";
import {
  HttpBackbone,
  startServer,
  type RunningServer,
  type TokenIdentity,
  type TokenMap,
} from "@caucus/backbone-server";

import type { ClientHandle, Connector } from "../connector.js";

/** The client ids the connector provisions tokens for by default. */
const DEFAULT_IDS = ["alice", "bob", "carol"] as const;

/**
 * The opaque bearer a client id presents. Deterministic so a scenario can also
 * forge with a known bearer (CAU-13 identity-anchoring AC3). NOT secret in the
 * harness — these are test fixtures, not production credentials.
 */
export function tokenFor(id: string): string {
  return `tok-${id}`;
}

/**
 * The identity a client id is anchored to. Matches the `agent_id`/`owner` the
 * existing scenarios already author, so server-side overwrite is a no-op for
 * them while still being the authoritative anchor.
 */
export function identityForId(id: string): TokenIdentity {
  return { agent_id: `${id}-agent`, owner: id };
}

/** Build the bearer → identity map for a set of client ids (CAU-13). */
function buildTokenMap(ids: readonly string[]): TokenMap {
  const map = new Map<string, TokenIdentity>();
  for (const id of ids) {
    map.set(tokenFor(id), identityForId(id));
  }
  return map;
}

/**
 * A {@link Connector} backed by a real HTTP backbone server on `127.0.0.1` with
 * an OS-assigned ephemeral port. Each client connects via its own
 * {@link HttpBackbone} carrying its bearer token; all share the one server's
 * state and the server anchors each write to the token's identity (CAU-13).
 *
 * @param opts optional seatbelt tunables (ADR-C8). The server runs over an
 * {@link InMemoryBackbone} built from them, so a low `maxPostsPerMinute` trips
 * the cap over the wire too. Omitted ⇒ production defaults (existing scenarios
 * unchanged).
 * @param ids the client ids to provision tokens for; defaults to
 * `["alice", "bob", "carol"]` (the ids every existing scenario uses).
 */
export function httpConnector(
  opts: SeatbeltOptions = {},
  ids: readonly string[] = DEFAULT_IDS,
): Connector {
  let server: RunningServer | undefined;
  const tokens = buildTokenMap(ids);

  return {
    name: "http",

    async boot(): Promise<void> {
      // Port 0 → OS-assigned ephemeral port, so concurrent suites never collide.
      // The server serves an in-memory backbone carrying the seatbelt options,
      // and the token map gating writes (CAU-13 fail-closed).
      server = await startServer({
        port: 0,
        backbone: new InMemoryBackbone(opts),
        tokens,
      });
    },

    connectClient(id: string): Promise<ClientHandle> {
      if (server === undefined) {
        throw new Error("http connector: connectClient() called before boot()");
      }
      // A fresh client per handle, all pointed at the one shared server, each
      // carrying its own bearer so its writes anchor to its identity.
      return Promise.resolve({
        id,
        backbone: new HttpBackbone(server.url, { token: tokenFor(id) }),
      });
    },

    async teardown(): Promise<void> {
      const running = server;
      server = undefined;
      if (running !== undefined) {
        await running.close();
      }
    },
  };
}
