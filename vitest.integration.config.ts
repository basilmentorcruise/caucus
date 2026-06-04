import { defineConfig } from "vitest/config";

// Integration harness config (CAU-25). Runs ONLY the cross-package scenarios
// under packages/integration (the `.itest.ts` suffix keeps them out of the unit
// run in vitest.config.ts). No coverage: the harness is test scaffolding, and
// the coverage gate is owned by the unit run.
//
// Invoked by `pnpm test:integration` and by the CI "Integration harness" step.
export default defineConfig({
  test: {
    include: ["packages/integration/src/**/*.itest.ts"],
    coverage: { enabled: false },
  },
});
