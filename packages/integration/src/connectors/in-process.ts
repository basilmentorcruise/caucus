/**
 * The in-process connector (CAU-25). `boot()` creates ONE `InMemoryBackbone`;
 * every `connectClient` returns a handle wrapping that same instance, so the
 * handles share a log and claim ledger. `teardown()` drops it.
 */
import { InMemoryBackbone, type SeatbeltOptions } from "@caucus/backbone";

import type { ClientHandle, Connector } from "../connector.js";

/**
 * A {@link Connector} backed by a single in-process `InMemoryBackbone`.
 *
 * This is the default substrate for the integration scenarios: zero network,
 * one shared backbone, so multi-client tests exercise real cross-client
 * visibility (claims one client wins are seen by the other, cursors mint at the
 * shared head, …).
 *
 * @param opts optional seatbelt tunables (ADR-C8) for the shared backbone — a
 * low `maxPostsPerMinute` lets a scenario trip the cap deterministically.
 * Omitted ⇒ production defaults, so existing scenarios are unchanged.
 */
export function inProcessConnector(opts: SeatbeltOptions = {}): Connector {
  let backbone: InMemoryBackbone | undefined;

  return {
    name: "in-process",

    boot(): Promise<void> {
      backbone = new InMemoryBackbone(opts);
      return Promise.resolve();
    },

    connectClient(id: string): Promise<ClientHandle> {
      if (backbone === undefined) {
        throw new Error(
          "in-process connector: connectClient() called before boot()",
        );
      }
      // Same instance for every handle — this is the load-bearing invariant.
      return Promise.resolve({ id, backbone });
    },

    teardown(): Promise<void> {
      backbone = undefined;
      return Promise.resolve();
    },
  };
}
