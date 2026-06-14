/**
 * Vitest globalSetup for the integration harness (CAU-25; build race fixed in
 * CAU-50).
 *
 * Several scenarios spawn REAL subprocesses (`…/dist/bin.js`, `…/dist/index.js`):
 * the turn-start hook, the backbone server, the MCP server. vitest's source
 * aliases (see `vitest.integration.config.ts`) do NOT apply to a child process,
 * so those bins must be built from source first.
 *
 * Building inside each scenario's `beforeAll` raced once a SECOND build-using
 * scenario existed: vitest runs test FILES in parallel, so two concurrent
 * `tsc --build` invocations contended on the shared incremental `.tsbuildinfo`
 * and on the half-written `dist` outputs, intermittently producing a missing/
 * partial bin (a server that "did not start"). Running the build EXACTLY ONCE,
 * here, before any scenario, removes the race entirely.
 *
 * `tsc --build` is incremental, so a warm tree is a near-no-op; a clean checkout
 * builds the dependency graph (schema → backbone → backbone-server →
 * mcp-server / hook) in order, so every spawned bin exists.
 *
 * We build the two bin CLOSURES (`@caucus/mcp-server...` and `@caucus/hook...`,
 * the trailing `...` pulling in each one's workspace deps), NOT the whole
 * workspace — building `@caucus/integration` itself is unnecessary (it runs from
 * source via the config's aliases) and flaky on a fully-clean tree, so it is
 * deliberately excluded.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Bins the spawned-subprocess scenarios need; asserted to exist post-build. */
const REQUIRED_BINS = [
  "packages/mcp-server/dist/index.js",
  "packages/mcp-server/dist/cli/bin.js",
  "packages/hook/dist/bin.js",
  "packages/backbone-server/dist/bin.js",
];

export default function setup(): void {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@caucus/mcp-server...",
      "--filter",
      "@caucus/hook...",
      "--filter",
      "@caucus/example-war-room-demo...",
      "build",
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  // `tsc --build` trusts .tsbuildinfo: if dist/ was deleted but the buildinfo
  // survived (a partial clean), the build silently emits NOTHING and every
  // spawned-bin scenario dies with an opaque startup timeout. Fail loudly here
  // instead, with the actionable fix.
  const missing = REQUIRED_BINS.filter((p) => !existsSync(resolve(REPO_ROOT, p)));
  if (missing.length > 0) {
    throw new Error(
      `integration globalSetup: built bins missing after pnpm build: ` +
        `${missing.join(", ")} — stale *.tsbuildinfo with deleted dist? ` +
        `Run \`pnpm clean && pnpm build\` (or delete packages/*/tsconfig.tsbuildinfo).`,
    );
  }
}
