import { defineConfig } from "vitest/config";

// Coverage gate (ADR / docs/GITHUB_PROJECTS.md → "Testing & validation gate").
//
// The coverage thresholds below are ENFORCED: `vitest run --coverage` exits
// non-zero if any metric falls below its bar, which fails CI. This is the
// mechanism that backs the project-wide testing/validation gate.
//
// DO NOT LOWER THESE THRESHOLDS. Per docs/GITHUB_PROJECTS.md, a ticket may not
// lower the coverage bar; new code is expected to be covered. Raising is fine.
const COVERAGE_THRESHOLD = 90;

export default defineConfig({
  test: {
    include: ["packages/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      // packages/integration is the integration-test harness (CAU-25) — test
      // scaffolding, not gated product code, so it is excluded from the unit
      // coverage gate (it runs via vitest.integration.config.ts instead).
      //
      // `**/bin.ts` is a process entrypoint shim (a shebang + a few lines that
      // boot a real listening server). Its logic lives in covered helpers
      // (`parseEnvConfig`, `startServer`); the shim itself can only be exercised
      // by spawning a subprocess, which contributes no in-process coverage, so it
      // is excluded by convention (CAU-5).
      exclude: [
        "**/*.{test,spec}.ts",
        "**/dist/**",
        "**/bin.ts",
        "packages/integration/**",
      ],
      // Enforced bar — the run FAILS if any metric is below these values.
      thresholds: {
        lines: COVERAGE_THRESHOLD,
        statements: COVERAGE_THRESHOLD,
        functions: COVERAGE_THRESHOLD,
        branches: COVERAGE_THRESHOLD,
      },
    },
  },
});
