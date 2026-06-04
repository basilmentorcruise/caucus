/**
 * A connector-agnostic integration scenario (CAU-25).
 *
 * A scenario is a named async routine that drives a booted {@link Connector}
 * (connecting ≥2 clients, appending/claiming/reading) and asserts on the
 * outcome. Scenarios never construct a backbone directly — they go through the
 * connector seam so the same scenario can run in-process today and over HTTP
 * later.
 */
import type { Connector } from "./connector.js";

/** One named, connector-agnostic integration scenario. */
export interface Scenario {
  /** Human-readable name for diagnostics and reporting. */
  readonly name: string;
  /**
   * Drive the (already-booted) connector and assert. Reject to fail the
   * scenario; the harness lets the rejection propagate after teardown.
   */
  run(connector: Connector): Promise<void>;
}
