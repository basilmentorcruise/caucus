/**
 * The harness runner (CAU-25, AC1).
 *
 * `runScenarios` boots one connector, runs each scenario against it in order,
 * and tears the connector down in a `finally` so the backbone is always
 * released — even if a scenario rejects. This is the programmatic counterpart
 * to the vitest-native scenarios under `src/scenarios/`; both share the same
 * connector seam.
 */
import type { Connector } from "./connector.js";
import type { Scenario } from "./scenario.js";

/**
 * Boot `makeConnector()`, run every scenario against it, then tear down.
 *
 * Teardown runs in a `finally`, so it happens whether the scenarios pass, a
 * scenario rejects, or boot itself throws after partially starting. The first
 * rejection propagates to the caller after teardown completes.
 */
export async function runScenarios(
  makeConnector: () => Connector,
  scenarios: readonly Scenario[],
): Promise<void> {
  const connector = makeConnector();
  await connector.boot();
  try {
    for (const scenario of scenarios) {
      await scenario.run(connector);
    }
  } finally {
    await connector.teardown();
  }
}
