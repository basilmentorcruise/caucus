import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Integration harness config (CAU-25). Runs ONLY the cross-package scenarios
// under packages/integration (the `.itest.ts` suffix keeps them out of the unit
// run in vitest.config.ts). No coverage: the harness is test scaffolding, and
// the coverage gate is owned by the unit run.
//
// Invoked by `pnpm test:integration` and by the CI "Integration harness" step.
export default defineConfig({
  // Resolve workspace packages to SOURCE, not dist: the harness must run on a
  // clean checkout (no prior build) and must never test stale build output.
  resolve: {
    alias: {
      "@caucus/backbone": resolve(import.meta.dirname, "packages/backbone/src/index.ts"),
      "@caucus/backbone-server": resolve(import.meta.dirname, "packages/backbone-server/src/index.ts"),
      "@caucus/schema": resolve(import.meta.dirname, "packages/schema/src/index.ts"),
    },
  },
  test: {
    include: ["packages/integration/src/**/*.itest.ts"],
    coverage: { enabled: false },
    // Build every spawned bin ONCE before any scenario runs. Scenarios that
    // spawn real subprocesses (hook / backbone-server / mcp-server) need their
    // `dist/*.js` to exist; building per-file raced under vitest's parallel file
    // execution (two concurrent `tsc --build` invocations), so the build is
    // hoisted here (CAU-50). See packages/integration/src/global-setup.ts.
    globalSetup: ["packages/integration/src/global-setup.ts"],
  },
});
