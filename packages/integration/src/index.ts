/**
 * @caucus/integration — the cross-package integration-test harness (CAU-25).
 *
 * Private workspace package: it ships no published surface, only the test
 * scaffolding the scenarios run on. The pieces:
 *
 * - the {@link Connector} seam (`connector.ts`) + the {@link inProcessConnector}
 *   (`connectors/in-process.ts`) — one shared backbone, ≥2 client handles;
 * - the {@link Scenario} type + {@link runScenarios} runner (`scenario.ts`,
 *   `harness.ts`), which always tears down in a `finally`;
 * - message {@link finding}/{@link claimMsg} builders (`fixtures.ts`).
 *
 * The actual scenarios live in `src/scenarios/*.itest.ts` and run via
 * `pnpm test:integration`. See README.md to add a connector or scenario.
 */
export type { ClientHandle, Connector } from "./connector.js";
export { inProcessConnector } from "./connectors/in-process.js";
export { runScenarios } from "./harness.js";
export type { Scenario } from "./scenario.js";
export { claimMsg, finding, type MessageOpts } from "./fixtures.js";
