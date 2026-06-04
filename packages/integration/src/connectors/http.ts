/**
 * The HTTP connector (CAU-5). `boot()` starts ONE `@caucus/backbone-server` on
 * an ephemeral port (over a single in-memory backbone instance); every
 * `connectClient` returns a handle whose `backbone` is a fresh
 * {@link HttpBackbone} pointed at that server. The handles therefore share the
 * SAME server-side log and claim ledger — over the wire — so the same
 * multi-client scenarios that run in-process also run over HTTP.
 *
 * `teardown()` closes the server and frees the port.
 */
import { HttpBackbone, startServer, type RunningServer } from "@caucus/backbone-server";

import type { ClientHandle, Connector } from "../connector.js";

/**
 * A {@link Connector} backed by a real HTTP backbone server on `127.0.0.1` with
 * an OS-assigned ephemeral port. Each client connects via its own
 * {@link HttpBackbone}; all share the one server's state.
 */
export function httpConnector(): Connector {
  let server: RunningServer | undefined;

  return {
    name: "http",

    async boot(): Promise<void> {
      // Port 0 → OS-assigned ephemeral port, so concurrent suites never collide.
      server = await startServer({ port: 0 });
    },

    connectClient(id: string): Promise<ClientHandle> {
      if (server === undefined) {
        throw new Error("http connector: connectClient() called before boot()");
      }
      // A fresh client per handle, all pointed at the one shared server.
      return Promise.resolve({ id, backbone: new HttpBackbone(server.url) });
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
