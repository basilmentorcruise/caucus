/**
 * Backbone selection for the MCP server entrypoint (CAU-50).
 *
 * The server can run in one of two modes, chosen purely by whether `CAUCUS_URL`
 * is set in the environment:
 *
 * 1. **Shared mode (`CAUCUS_URL` set).** Construct an {@link HttpBackbone}
 *    pointed at the shared `caucus-backbone` HTTP server (ADR-C9, one shared
 *    server). This is the mode the two-terminal demo (CAU-15) and the turn-start
 *    hook (CAU-14) require: every separately-spawned MCP server process AND the
 *    hook then observe the SAME channel, because they all read and write the one
 *    shared store. The session's `CAUCUS_TOKEN` is passed through as the HTTP
 *    bearer (CAU-13): writes are token-gated and the server anchors the resolved
 *    identity onto every message, so a spoofed `owner` in a message body never
 *    lands in the log.
 *
 * 2. **Offline mode (`CAUCUS_URL` unset).** Fall back to a process-local
 *    {@link InMemoryBackbone}. This is the historical behavior — useful for
 *    offline development and for running a single session in isolation — but it
 *    is NOT shared: a second MCP server (or the hook) gets its own empty store,
 *    so cross-session visibility is impossible. The two-terminal demo therefore
 *    REQUIRES `CAUCUS_URL`.
 *
 * **Token convention (MVP).** The same token STRING serves two roles, and the
 * server is authoritative for identity:
 *   - locally, `CAUCUS_TOKEN` is split by `parseToken` into a cosmetic
 *     `agent:owner` identity for `caucus_status` display (see `config.ts`);
 *   - over HTTP, the SAME string is sent verbatim as the bearer and resolved by
 *     the server against its `CAUCUS_TOKENS` map (entry form
 *     `<token>:<agent>:<owner>`).
 * The simplest working convention — and the one the READMEs document — is for
 * the server operator to register the literal `CAUCUS_TOKEN` value as the map
 * key, e.g. client `CAUCUS_TOKEN=tok-alice-secret` and server map entry
 * `tok-alice-secret:alice-agent:alice`. The token is the colon-free FIRST
 * segment of that entry (the server splits on its first colon to recover the
 * key), so a bearer secret must not itself contain a colon. The server's mapping
 * is authoritative for what lands in the log. The local parse is still required
 * for identity DISPLAY, so a missing `CAUCUS_TOKEN` remains fatal (a
 * `ConfigError` from `loadConfig`) regardless of mode — unchanged behavior.
 */
import { InMemoryBackbone } from "@caucus/backbone";
import type { Backbone } from "@caucus/backbone";
import { HttpBackbone } from "@caucus/backbone-server";

import { ConfigError } from "./config.js";

/**
 * Select the backbone the entrypoint should serve, from the process
 * environment.
 *
 * `CAUCUS_URL` (trimmed; an all-whitespace value counts as unset) decides:
 * set ⇒ an {@link HttpBackbone} against that URL carrying `CAUCUS_TOKEN` as its
 * bearer (CAU-13); unset ⇒ a process-local {@link InMemoryBackbone} (offline
 * fallback). A set `CAUCUS_URL` is validated up front (CAU-75): it must parse
 * as a URL with an `http:` or `https:` scheme, so a bad value fails fast at
 * config time with a {@link ConfigError} instead of surfacing as a confusing
 * fetch failure later. The error message NEVER echoes the URL value — a URL can
 * carry userinfo credentials, and `String(err)` goes to stderr (ADR-C12). The
 * token is read here only to forward it as the bearer — it is never logged or
 * echoed (ADR-C12); identity parsing for display lives in `loadConfig`.
 *
 * @returns the selected {@link Backbone}. Pure w.r.t. its `env` argument so it
 *   is unit-testable without a process or a live server.
 * @throws ConfigError if `CAUCUS_URL` is set but unparsable or non-http(s).
 */
export function selectBackbone(
  env: Record<string, string | undefined>,
): Backbone {
  const url = (env.CAUCUS_URL ?? "").trim();
  if (url === "") {
    // Offline/dev fallback: a process-local store. NOT shared across processes
    // — the two-terminal demo and the hook require CAUCUS_URL (see module doc).
    return new InMemoryBackbone();
  }
  // Fail fast on a malformed or non-http(s) URL (CAU-75). Neither message
  // echoes the value: a URL can embed userinfo credentials (ADR-C12).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("CAUCUS_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`CAUCUS_URL must use http: or https:, got "${parsed.protocol}"`);
  }
  // Shared mode: every MCP server + the hook point at the one HTTP backbone.
  // The ORIGINAL trimmed string is passed through (not parsed.toString(), which
  // can rewrite the URL). The bearer is CAUCUS_TOKEN verbatim; an empty/unset
  // token means no header is sent and writes will 401 (config.ts still requires
  // the token, so this is belt-and-suspenders). The HttpBackbone never logs or
  // echoes the token.
  return new HttpBackbone(url, { token: env.CAUCUS_TOKEN });
}
