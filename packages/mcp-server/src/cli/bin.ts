#!/usr/bin/env node
/**
 * `caucus` — the scaffold CLI (CAU-108). A thin process shim: it wires the real
 * filesystem, environment, console, and bin resolver into `runInit` and exits
 * with the returned code. All logic lives in `init.ts` / `generate.ts` /
 * `merge.ts` / `paths.ts` / `prompts.ts`; this file is coverage-excluded by the
 * bin.ts convention (it can only be exercised by a spawned subprocess) and is
 * proven end-to-end by the integration scenario (`init-scaffold.itest.ts`).
 *
 * `caucus init` scaffolds a session; `caucus token` (CAU-129) wraps the loopback
 * issuer admin routes. Any other subcommand prints usage.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runInit } from "./init.js";
import { resolveBins } from "./paths.js";
import { runToken } from "./token.js";

/** Read a file to UTF-8, mapping ENOENT to `undefined`. */
async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Atomic write: mkdir -p the parent, write a tmp sibling, then rename over the target. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.caucus-init-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function main(): Promise<number> {
  const [, , sub, ...rest] = process.argv;
  // Top-level `--help`/`-h` (no subcommand) defers to init's help.
  if (sub === "--help" || sub === "-h") {
    return runInit(["--help"], deps());
  }
  if (sub === "token") {
    return runToken(rest, tokenDeps());
  }
  if (sub !== "init") {
    process.stderr.write(
      sub === undefined
        ? "usage: caucus <init|token> [options]  (run `caucus init --help` or `caucus token --help`)\n"
        : `unknown command: ${sub}\nusage: caucus <init|token> [options]  (run \`caucus init --help\` or \`caucus token --help\`)\n`,
    );
    return 1;
  }
  return runInit(rest, deps());
}

/** The real, side-effecting dependency set for `runToken` (CAU-129). */
function tokenDeps(): Parameters<typeof runToken>[1] {
  return {
    env: process.env,
    log: (line) => process.stdout.write(line + "\n"),
    errlog: (line) => process.stderr.write(line + "\n"),
    // The platform fetch — narrowed to the FetchLike shape runToken consumes.
    fetch: (url, init) => fetch(url, init),
  };
}

/** The real, side-effecting dependency set for `runInit`. */
function deps(): Parameters<typeof runInit>[1] {
  return {
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY),
    log: (line) => process.stdout.write(line + "\n"),
    errlog: (line) => process.stderr.write(line + "\n"),
    readFile: readMaybe,
    writeFile: atomicWrite,
    backup: (from, to) => copyFile(from, to),
    now: () => Date.now(),
    resolveBins: () => resolveBins(),
  };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`caucus failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
