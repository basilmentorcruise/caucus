/**
 * Bin path resolution for `caucus init` (CAU-108).
 *
 * The scaffold writes ABSOLUTE paths to the MCP server's `dist/index.js` and the
 * hook's `dist/bin.js` so the generated `.mcp.json` / `.claude/settings.local.json`
 * launch the right node entrypoints regardless of cwd. This module is the single
 * place that resolves those two paths, so it can be unit-tested without writing
 * any files.
 *
 * Two layouts must work:
 *  - **monorepo / source build:** this file builds to
 *    `packages/mcp-server/dist/cli/paths.js`, so the server bin is `../index.js`
 *    relative to that. The hook is a sibling workspace package resolved via
 *    Node's resolver.
 *  - **installed from npm:** `@caucus/mcp-server` is under `node_modules`, its bin
 *    is still `../index.js` from `dist/cli/`, and `@caucus/hook` is a peer under
 *    `node_modules` resolved the same way.
 *
 * The hook bin is found by resolving the `@caucus/hook` package root (from its
 * `package.json` location), then reading that package's `bin["caucus-hook"]`
 * entry — so we never hard-code the hook's internal `dist/bin.js` layout.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The resolved, absolute node entrypoints the scaffold wires up. */
export interface ResolvedBins {
  /** Absolute path to the MCP server bin (`@caucus/mcp-server` `dist/index.js`). */
  readonly mcpServer: string;
  /** Absolute path to the hook bin (`@caucus/hook` `dist/bin.js`). */
  readonly hook: string;
}

/**
 * Dependencies injected so the resolver is testable without touching the real
 * module graph: a `resolve` (defaults to a `require.resolve` bound to THIS
 * module), a `readFile` (defaults to `readFileSync`), and the resolving module's
 * URL.
 */
export interface ResolveBinsDeps {
  /** Resolve a module specifier to an absolute file path. */
  readonly resolve: (specifier: string) => string;
  /** Read a file to a UTF-8 string. */
  readonly readFile: (path: string) => string;
  /** Base URL of the resolving module (`dist/cli/paths.js`); the server bin is `../index.js` from here. */
  readonly selfUrl: string;
}

/** The bin name the hook package exposes; we read its `bin[...]` target. */
const HOOK_BIN_NAME = "caucus-hook";

/**
 * Resolve the absolute MCP-server bin path from the resolving module's URL.
 * `dist/cli/paths.js` → `dist/index.js` is always `../index.js`.
 */
export function resolveMcpServerBin(selfUrl: string): string {
  return fileURLToPath(new URL("../index.js", selfUrl));
}

/**
 * Resolve the absolute hook bin path: find `@caucus/hook`'s `package.json`, read
 * its `bin["caucus-hook"]`, and join that against the package root. Works in
 * both the monorepo (workspace symlink) and an npm install (`node_modules`).
 *
 * @throws Error if the hook package can't be resolved or has no `caucus-hook` bin.
 */
export function resolveHookBin(
  deps: Pick<ResolveBinsDeps, "resolve" | "readFile">,
): string {
  // Resolve the package.json directly — robust whether or not the package has a
  // root `exports` map, and it gives us the package root unambiguously.
  const pkgJsonPath = deps.resolve("@caucus/hook/package.json");
  const pkg = JSON.parse(deps.readFile(pkgJsonPath)) as {
    bin?: string | Record<string, string>;
  };
  const binField = pkg.bin;
  let binRel: string | undefined;
  if (typeof binField === "string") {
    binRel = binField;
  } else if (binField !== null && typeof binField === "object") {
    binRel = binField[HOOK_BIN_NAME];
  }
  if (binRel === undefined) {
    throw new Error(
      `@caucus/hook package.json has no "${HOOK_BIN_NAME}" bin entry`,
    );
  }
  return resolve(dirname(pkgJsonPath), binRel);
}

/**
 * Resolve both bins. The default deps bind a `require` to this module so the
 * peer `@caucus/hook` resolves from the installed `@caucus/mcp-server` location.
 */
export function resolveBins(deps?: Partial<ResolveBinsDeps>): ResolvedBins {
  const selfUrl = deps?.selfUrl ?? import.meta.url;
  const req = createRequire(selfUrl);
  const resolveFn = deps?.resolve ?? ((s: string): string => req.resolve(s));
  const readFile =
    deps?.readFile ?? ((p: string): string => readFileSync(p, "utf8"));
  return {
    mcpServer: resolveMcpServerBin(selfUrl),
    hook: resolveHookBin({ resolve: resolveFn, readFile }),
  };
}
