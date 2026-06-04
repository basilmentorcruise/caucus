/**
 * The harness seam (CAU-25, AC3).
 *
 * A {@link Connector} is the only thing a scenario knows about the world: it
 * boots a backbone, hands out client handles onto that *same* backbone, and
 * tears it down. Today the only implementation is `inProcessConnector`
 * (one `InMemoryBackbone`, in this process); a future `httpConnector` will boot
 * the real MCP server and return handles whose `backbone` is a remote client —
 * the scenarios are written against this interface and do not change.
 *
 * The shared-instance contract is what makes the scenarios meaningful: two
 * handles must observe each other's appends/claims, so `connectClient` returns
 * fresh handles wrapping the SAME log/ledger, never a backbone-per-client.
 */
import type { Backbone } from "@caucus/backbone";

/**
 * A bootable backbone + a factory for client handles onto it.
 *
 * Lifecycle: `boot()` once, then `connectClient(id)` any number of times
 * (≥2 for a multi-client scenario), then `teardown()` once. Calling
 * `connectClient` before `boot` (or after `teardown`) is a programming error
 * and throws.
 */
export interface Connector {
  /** Stable label for diagnostics: `"in-process"` now, `"http"` later. */
  readonly name: string;
  /** Stand the backbone up. Idempotent per connector instance is NOT required. */
  boot(): Promise<void>;
  /**
   * Return a fresh handle to the SAME backbone the connector booted. Callable
   * ≥2 times to simulate distinct clients sharing one channel.
   *
   * @throws Error if called before {@link boot} (or after {@link teardown}).
   */
  connectClient(id: string): Promise<ClientHandle>;
  /** Drop the backbone and release resources. */
  teardown(): Promise<void>;
}

/** One simulated client: an id plus its view of the shared backbone. */
export interface ClientHandle {
  /** Caller-chosen client id (used only for test diagnostics). */
  readonly id: string;
  /** The shared backbone. Identical instance across all handles from one boot. */
  readonly backbone: Backbone;
}
