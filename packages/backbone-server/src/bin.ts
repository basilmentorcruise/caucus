#!/usr/bin/env node
/**
 * `caucus-backbone` — boot the standalone HTTP backbone server (CAU-5). Reads
 * `PORT` / `HOST` from the environment (see {@link parseEnvConfig}) and logs the
 * bound URL. All logic lives in `config.ts` / `server.ts`; this stays a thin
 * shim. UNAUTHENTICATED localhost-only server — see `server.ts`.
 */
import { parseEnvConfig } from "./config.js";
import { startServer } from "./server.js";

const server = await startServer(parseEnvConfig());
console.log(`caucus-backbone listening on ${server.url}`);
