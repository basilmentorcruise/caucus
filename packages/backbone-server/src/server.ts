/**
 * The standalone HTTP backbone service (CAU-5).
 *
 * One shared server (ADR-C9), HTTP+JSON over localhost (CAU-2 verdict),
 * stateless. It is a THIN transport over an in-process {@link Backbone} (default:
 * a fresh {@link InMemoryBackbone}): the router only routes, parses the JSON
 * body, calls the backbone, and maps results/errors to status+JSON. It does NOT
 * re-validate inputs — the backbone is the single validation authority
 * (see `./wire-errors.ts`).
 *
 * **Security posture (v0).** WRITES are token-gated; READS are open within the
 * trust boundary (ADR-C9). The three write routes — `POST /channels`,
 * `/append`, `/claim` — require a bearer token that resolves in the configured
 * {@link TokenMap}; the server then ANCHORS the resolved identity onto the
 * message (overwriting any client-supplied `agent_id`/`owner`/`created_by`), so
 * the stored `owner` cannot be forged (ADR-C7, CAU-13). Reads and `/healthz`
 * are tokenless — the read-only hook stays open. **Fail-closed:** an
 * EMPTY/unset token map authorizes NOBODY, so with no `CAUCUS_TOKENS` ALL writes
 * return `401`. Bind localhost only; the listener is still unauthenticated for
 * reads, so do not expose the port off-host.
 *
 * The HTTP method/route handlers are `createChannel`, `listChannels`,
 * `describeChannel`, `subscribe`, `append`, `readSince` (CAU-5/CAU-6), and
 * `claim` (CAU-7). The claim route answers BOTH outcomes — `granted` and
 * `already_claimed` — as normal 200 results (the conflict is a value carrying
 * the holder, never an error envelope); the
 * {@link import("./http-client.js").HttpBackbone} client mirrors this.
 *
 * **Artifact routes (CAU-100, ADR-C14).** `PUT/GET
 * /channels/:channel/artifacts/:sha256` carry RAW BYTES, not JSON, so they take
 * a DEDICATED branch ({@link handleArtifactRoute}) BEFORE the JSON body
 * buffering: the PUT (token-gated like `append`) buffers bytes with its own
 * incremental {@link MAX_ARTIFACT_BYTES} cap (413 mid-stream, never the 256 KB
 * JSON cap), and the GET (tokenless like `readSince`) serves the blob as opaque
 * `application/octet-stream`. They never touch the JSON parser or the JSON
 * `send` helper.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { Backbone, ClaimAssignee, Cursor } from "@caucus/backbone";
import { InMemoryBackbone, MAX_ARTIFACT_BYTES } from "@caucus/backbone";
import type { MessageInput } from "@caucus/schema";
import { sanitizeErrorFragment } from "@caucus/schema";

import { resolveToken, type TokenIdentity, type TokenMap } from "./tokens.js";
import { mapError, UnauthorizedError, type WireErrorBody } from "./wire-errors.js";

/** Max raw request body the server will buffer before rejecting with 413. */
export const MAX_BODY_BYTES = 256 * 1024;

// Re-export the per-blob artifact upload cap (ADR-C14) so the transport's own
// incremental overflow-and-destroy branch and the `@caucus/backbone` authority
// share ONE constant — the raw-bytes branch must NOT be clamped by the JSON
// `MAX_BODY_BYTES`.
export { MAX_ARTIFACT_BYTES };

// Slowloris guard (CAU-75): the body cap alone does not bound TIME, so a client
// trickling bytes could hold a connection open indefinitely. Every request here
// is a small local JSON exchange — 30 s is far above any real request — so we
// pin tight, explicit socket timeouts.
/** Full header block must arrive within 10 s (must stay < REQUEST_TIMEOUT_MS). */
export const HEADERS_TIMEOUT_MS = 10_000;
/** Whole request (incl. body) must complete within 30 s. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Idle keep-alive sockets close after 5 s (Node default, pinned explicitly). */
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/**
 * How often Node sweeps sockets for expired headers/request timeouts. The
 * default 30 s would let a 10 s headersTimeout slip to ~40 s wall-clock.
 */
export const CONNECTIONS_CHECK_INTERVAL_MS = 5_000;

/** Options for {@link createServer} / {@link startServer}. */
export interface ServerOptions {
  /** Backbone to serve. Defaults to a fresh in-memory instance. */
  readonly backbone?: Backbone;
  /** TCP port. Defaults to 4317; pass 0 for an ephemeral port. */
  readonly port?: number;
  /** Bind host. Defaults to `127.0.0.1` (localhost only). */
  readonly host?: string;
  /**
   * Bearer-token → identity map gating the three write routes (CAU-13). Omitted
   * or empty ⇒ fail-closed: every write returns `401` (see the module doc).
   * Reads ignore it.
   */
  readonly tokens?: TokenMap;
}

/**
 * Per-request authorization context threaded into {@link dispatch}: the
 * configured token map plus the bearer token extracted from the request (the
 * `Authorization` header with its case-insensitive `Bearer ` prefix stripped).
 * Header extraction happens in {@link createServer} so `dispatch` stays
 * socket-free. Both fields are optional: an absent map ⇒ fail-closed (no writes
 * authorized); an absent bearer ⇒ the write is unauthenticated.
 */
export interface AuthContext {
  /** The configured token map; `undefined`/empty ⇒ all writes 401. */
  readonly tokens?: TokenMap;
  /** The presented bearer token, prefix-stripped; `undefined` ⇒ none sent. */
  readonly bearer?: string;
}

/** A started server with its resolved URL and a clean shutdown. */
export interface RunningServer {
  /** Base URL, e.g. `http://127.0.0.1:4317`. */
  readonly url: string;
  /**
   * The interface address the listener is ACTUALLY bound to, e.g. `0.0.0.0`
   * for a wildcard bind. `url` substitutes a dialable loopback literal for
   * wildcard binds (see {@link startServer}), so the two can differ — consumers
   * that report exposure (the bin's startup log) must use THIS field, never
   * parse the URL back (CAU-75).
   */
  readonly boundHost: string;
  /** The actually-bound port (resolved even when `port: 0` was requested). */
  readonly port: number;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/** The result of a pure {@link dispatch}: an HTTP status and a JSON body. */
export interface DispatchResult {
  readonly status: number;
  /** The JSON value to serialize as the response body. */
  readonly json: unknown;
}

/** Default bind host — localhost only (see the security note above). */
const DEFAULT_HOST = "127.0.0.1";
/** Default port (CAU-2 chose a fixed default for the shared local server). */
export const DEFAULT_PORT = 4317;

/** A parsed request line: the method and the path segments after `/`. */
interface Route {
  readonly method: string;
  /** e.g. `/channels/incident-1/append` → `["channels", "incident-1", "append"]`. */
  readonly segments: readonly string[];
}

/**
 * Sentinel thrown by {@link parseSegments} when a path segment carries malformed
 * percent-encoding (e.g. `/channels/%ZZ`). Caught in {@link dispatch} and turned
 * into a clean 400 `invalid_request`, so a `URIError` can never escape as an
 * unhandled rejection that drops the response.
 */
class MalformedPathError extends Error {}

/**
 * Split a URL path into non-empty, percent-decoded segments. Throws
 * {@link MalformedPathError} if any segment is not valid percent-encoding —
 * `decodeURIComponent` would otherwise raise a bare `URIError`.
 */
function parseSegments(path: string): string[] {
  const query = path.indexOf("?");
  const clean = query === -1 ? path : path.slice(0, query);
  return clean
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // `s` is the raw, caller-controlled path segment and this message rides
        // into the 400 `invalid_request` body (ADR-C12 / CAU-88). Node's llhttp
        // rejects control/high bytes in `req.url` before dispatch TODAY, but that
        // guard reopens under `insecureHTTPParser` or a raw-forwarding proxy —
        // strip-and-cap here as defense-in-depth so the boundary holds regardless.
        throw new MalformedPathError(
          `malformed percent-encoding in path: ${sanitizeErrorFragment(s)}`,
        );
      }
    });
}

/**
 * A recognized artifact route (ADR-C14): `/channels/:channel/artifacts/:sha256`.
 * Returned by {@link matchArtifactRoute} so the socket-facing handler can take
 * the RAW-BYTES branch (PUT/GET) instead of the JSON body-buffering path. The
 * segments are already percent-decoded; the backbone validates `channel` and
 * `sha256` (a bad sha256 is an integrity miss, a bad channel a 400/404).
 */
interface ArtifactRoute {
  readonly channel: string;
  readonly sha256: string;
}

/**
 * Match `/channels/:channel/artifacts/:sha256` and return its decoded segments,
 * or `undefined` for any other path. Throws {@link MalformedPathError} on bad
 * percent-encoding (same handling as {@link parseSegments}), surfaced as a clean
 * 400. Kept separate from {@link dispatch} because these routes carry RAW BYTES,
 * not JSON, and must never traverse the JSON parser or the JSON `send()` helper.
 */
function matchArtifactRoute(path: string): ArtifactRoute | undefined {
  const segments = parseSegments(path);
  if (
    segments.length === 4 &&
    segments[0] === "channels" &&
    segments[2] === "artifacts"
  ) {
    return { channel: segments[1] as string, sha256: segments[3] as string };
  }
  return undefined;
}

function notFound(): DispatchResult {
  const body: WireErrorBody = {
    error: { code: "not_found", message: "no such route" },
  };
  return { status: 404, json: body };
}

function methodNotAllowed(): DispatchResult {
  const body: WireErrorBody = {
    error: { code: "method_not_allowed", message: "method not allowed" },
  };
  return { status: 405, json: body };
}

function invalidRequest(message: string): DispatchResult {
  const body: WireErrorBody = {
    error: { code: "invalid_request", message },
  };
  return { status: 400, json: body };
}

/** A non-null, non-array object — the only structurally valid JSON request body. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reusable 400 for a body that is absent or not a JSON object. */
const BODY_MUST_BE_OBJECT = "request body must be a JSON object";

/**
 * Extract the bearer token from a raw `Authorization` header value: strip a
 * case-insensitive `Bearer ` prefix and trim. Returns `undefined` for an absent
 * header or one without the prefix (so a non-Bearer scheme never resolves). The
 * token text is never logged here (ADR-C12). Lives in the socket-facing layer so
 * {@link dispatch} stays header-free.
 */
function bearerFromHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match?.[1] === undefined) return undefined;
  const token = match[1].trim();
  return token === "" ? undefined : token;
}

/**
 * Resolve the bearer in `auth` to its identity, or throw {@link
 * UnauthorizedError} when it is missing, empty, or unknown (CAU-13). The throw
 * is mapped to an IDENTICAL `401` by `mapError`, so the response is the same for
 * "no token" and "unknown token" — no oracle. A `undefined`/empty token map
 * resolves nothing, which is the fail-closed default (all writes 401).
 */
function requireIdentity(auth: AuthContext): TokenIdentity {
  const identity = resolveToken(auth.tokens ?? new Map(), auth.bearer);
  if (identity === undefined) {
    throw new UnauthorizedError();
  }
  return identity;
}

/**
 * Write a JSON body on the raw-bytes artifact path. The raw-bytes branch has its
 * OWN serialization (the request handler's `send` is scoped inside
 * {@link createServer}) — it is used for both the error envelopes and the small
 * `{uri,sha256,size}` success body, never for the blob itself (which is written
 * as `application/octet-stream`).
 */
function sendArtifactJson(res: ServerResponse, status: number, json: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(json));
}

/**
 * Buffer a request's RAW bytes with an INCREMENTAL {@link MAX_ARTIFACT_BYTES}
 * cap (ADR-C14), mirroring the JSON path's overflow-and-destroy pattern but with
 * the artifact cap, NOT {@link MAX_BODY_BYTES}: a single 256 KB JSON cap must
 * NOT clamp a ≤1 MiB upload, and an over-cap upload must be cut off MID-STREAM
 * (`413` + socket destroyed) rather than buffered in full. Resolves with the
 * assembled buffer, or `null` when it already responded 413 and destroyed the
 * socket (the caller must then do nothing).
 */
function bufferArtifactBytes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) {
        // Mid-stream rejection: respond 413 and DESTROY the socket so the rest
        // of a gigabyte body is never read into memory (no GB buffering).
        done = true;
        sendArtifactJson(res, 413, {
          error: {
            code: "artifact_too_large",
            message: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`,
          },
        });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      // A socket error mid-upload (e.g. the peer aborted): never resolve with a
      // partial buffer. The outer handler's catch already covers a thrown path;
      // here we simply stop — the socket is gone.
      if (done) return;
      done = true;
      resolve(null);
    });
  });
}

/**
 * Handle the two artifact routes (ADR-C14) on the RAW-BYTES branch — never JSON.
 * `PUT` is token-gated like `append` (fail-closed); `GET` is tokenless within
 * the trust boundary like `readSince`. Returns `true` when it handled the route
 * (recognized method), `false` for an unsupported method on the artifact path
 * (the caller then emits 405). The backbone is the single validation/integrity
 * authority; thrown {@link import("@caucus/backbone").BackboneError}s flow
 * through {@link mapError} to the same wire envelope as every other route.
 */
async function handleArtifactRoute(
  backbone: Backbone,
  route: ArtifactRoute,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method === "PUT") {
    // Fail-closed token gate (CAU-13) — resolve identity BEFORE reading the
    // body, so an unauthorized upload never streams bytes into memory. The 401
    // is identical for missing vs unknown token (no oracle). The upload is NOT
    // identity-anchored content (the bytes are opaque), so we only authorize.
    try {
      requireIdentity(auth);
    } catch (err) {
      const mapped = mapError(err);
      sendArtifactJson(res, mapped.status, mapped.body);
      return true;
    }
    const bytes = await bufferArtifactBytes(req, res);
    if (bytes === null) return true; // already responded 413 / aborted.
    try {
      const result = await backbone.putArtifact(
        route.channel,
        route.sha256,
        bytes,
      );
      // Idempotent: a brand-new blob is 201, a dedup hit is 200 (ADR-C14).
      sendArtifactJson(res, result.deduplicated ? 200 : 201, {
        uri: result.uri,
        sha256: result.sha256,
        size: result.size,
      });
    } catch (err) {
      const mapped = mapError(err);
      sendArtifactJson(res, mapped.status, mapped.body);
    }
    return true;
  }
  if (method === "GET") {
    // Tokenless read within the boundary (like readSince). Serve the raw blob as
    // opaque application/octet-stream — never through the JSON send() helper.
    try {
      const bytes = await backbone.getArtifact(route.channel, route.sha256);
      if (bytes === undefined) {
        sendArtifactJson(res, 404, {
          error: { code: "not_found", message: "no such artifact" },
        });
        return true;
      }
      if (res.writableEnded) return true;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      });
      res.end(Buffer.from(bytes));
    } catch (err) {
      const mapped = mapError(err);
      sendArtifactJson(res, mapped.status, mapped.body);
    }
    return true;
  }
  return false;
}

/**
 * Pure request dispatch — NO sockets. Given a method, path, already-parsed JSON
 * body (or `undefined` when there was no body), and the per-request
 * {@link AuthContext}, call the backbone and return a status + JSON. This is the
 * whole router; {@link createServer} only wraps it with body-buffering, header
 * extraction, and serialization, so every route, status, and error-mapping case
 * is unit-testable without a live socket.
 *
 * The write routes (`POST /channels`, `/append`, `/claim`, and the CAU-18
 * lifecycle routes `/reassign`, `/done`) require a resolved bearer identity and
 * ANCHOR it onto the message — building a NEW body with the resolved
 * `agent_id`/`owner` (createChannel: `created_by`) overwriting whatever the
 * client supplied (anti-forgery by construction; client identity fields are
 * advisory). On `/reassign` the anchored identity is the AUTHORIZER (the holder),
 * while the `assignee` (new ledger holder) rides as poster-asserted body data,
 * never anchored. Reads and `/healthz` ignore `auth`.
 *
 * Malformed-JSON and payload-too-large are detected during body buffering, so
 * they never reach here — `dispatch` assumes `body` is a parsed value.
 */
export async function dispatch(
  backbone: Backbone,
  method: string,
  path: string,
  body: unknown,
  auth: AuthContext = {},
): Promise<DispatchResult> {
  try {
    // Path parsing can throw on malformed percent-encoding (`/channels/%ZZ`);
    // keep it inside the try so it surfaces as a clean 400, never a `URIError`
    // escaping the dispatch.
    const route: Route = { method, segments: parseSegments(path) };
    const { segments } = route;

    // GET /healthz
    if (segments.length === 1 && segments[0] === "healthz") {
      if (method !== "GET") return methodNotAllowed();
      return { status: 200, json: { ok: true } };
    }

    // /channels ...
    if (segments[0] === "channels") {
      // /channels
      if (segments.length === 1) {
        if (method === "POST") {
          // Reject a structurally impossible body (undefined / array / scalar)
          // at the transport with a typed 400, before it reaches the backbone
          // as a raw `TypeError` → generic 500. The backbone remains the single
          // SEMANTIC validation authority; this only guards the body's shape.
          if (!isPlainObject(body)) return invalidRequest(BODY_MUST_BE_OBJECT);
          // Anchor `created_by` to the token's owner (overwrite, never reject —
          // any client-supplied `created_by` is advisory). Build a NEW object;
          // never mutate the parsed body.
          const identity = requireIdentity(auth);
          const anchored = { ...body, created_by: identity.owner };
          const descriptor = await backbone.createChannel(
            anchored as unknown as Parameters<Backbone["createChannel"]>[0],
          );
          return { status: 201, json: descriptor };
        }
        if (method === "GET") {
          const channels = await backbone.listChannels();
          return { status: 200, json: { channels } };
        }
        return methodNotAllowed();
      }

      const channel = segments[1] as string;

      // /channels/:channel
      if (segments.length === 2) {
        if (method === "GET") {
          const descriptor = await backbone.describeChannel(channel);
          return { status: 200, json: descriptor };
        }
        return methodNotAllowed();
      }

      // /channels/:channel/:action
      if (segments.length === 3) {
        const action = segments[2];
        if (method !== "POST") return methodNotAllowed();

        switch (action) {
          case "subscribe": {
            const cursor = await backbone.subscribe(channel);
            return { status: 200, json: { cursor } };
          }
          case "append": {
            // Structural guard only — the backbone validates message fields.
            if (!isPlainObject(body)) return invalidRequest(BODY_MUST_BE_OBJECT);
            // Anchor identity to the token (overwrite, never reject). A NEW
            // object is built — the parsed body is never mutated — and this
            // happens BEFORE the backbone, so seatbelt accounting keys on the
            // anchored agent_id, not the client's claimed one.
            const identity = requireIdentity(auth);
            const anchored = {
              ...body,
              agent_id: identity.agent_id,
              owner: identity.owner,
            };
            const result = await backbone.append(
              channel,
              anchored as unknown as MessageInput,
            );
            return { status: 201, json: result };
          }
          case "read": {
            // A missing body coerces to `{}` (→ cursor undefined →
            // invalid_cursor 400 at the backbone, the established behavior). A
            // PRESENT-but-non-object body (array / scalar) is structurally
            // impossible and rejected here as invalid_request.
            if (body !== undefined && !isPlainObject(body)) {
              return invalidRequest(BODY_MUST_BE_OBJECT);
            }
            const { cursor, limit } = (body ?? {}) as {
              cursor: Cursor;
              limit?: number;
            };
            const result = await backbone.readSince(channel, cursor, limit);
            return { status: 200, json: result };
          }
          case "claim": {
            // Structural guard only — the backbone validates message fields and
            // enforces first-write-wins atomically. BOTH outcomes (`granted`
            // and `already_claimed`) are normal 200 results, never errors: the
            // conflict carries the holder, and the client maps it as a value
            // (see http-client.ts / wire-errors.ts). Only validation/not-found
            // failures throw, and those flow through the centralized mapper.
            if (!isPlainObject(body)) return invalidRequest(BODY_MUST_BE_OBJECT);
            // Anchor identity to the token (overwrite, never reject); NEW object,
            // no mutation. The overwrite precedes the backbone, so first-write-
            // wins and seatbelt accounting both key on the anchored identity.
            const identity = requireIdentity(auth);
            const anchored = {
              ...body,
              agent_id: identity.agent_id,
              owner: identity.owner,
            };
            const result = await backbone.claim(
              channel,
              anchored as unknown as MessageInput,
            );
            return { status: 200, json: result };
          }
          case "reassign": {
            // Reassign (CAU-18): the current holder hands a live target to an
            // assignee. Identity is anchored to the bearer EXACTLY as `claim` —
            // the anchored identity is the AUTHORIZER (matched against the holder
            // on `owner`, ADR-C7). The `assignee` (new ledger holder) rides as a
            // sibling field of the body; it is poster-asserted data the
            // authenticated holder vouches for (like `to[]`), NOT identity-
            // anchored. All outcomes are normal 200 results, like `claim`.
            if (!isPlainObject(body)) return invalidRequest(BODY_MUST_BE_OBJECT);
            const identity = requireIdentity(auth);
            // Split the assignee out of the message body (a NEW object, no
            // mutation), then anchor the authorizer's identity onto the message.
            const { assignee, ...msg } = body as Record<string, unknown>;
            const anchored = {
              ...msg,
              agent_id: identity.agent_id,
              owner: identity.owner,
            };
            const result = await backbone.reassignClaim(
              channel,
              anchored as unknown as MessageInput,
              assignee as unknown as ClaimAssignee,
            );
            return { status: 200, json: result };
          }
          case "done": {
            // Done (CAU-18): the holder marks a live target finished, freeing it.
            // Identity is anchored to the bearer as `claim` (the holder owner is
            // the authorizer). Outcomes (`granted`/`already_claimed`/`not_held`)
            // are all normal 200 results.
            if (!isPlainObject(body)) return invalidRequest(BODY_MUST_BE_OBJECT);
            const identity = requireIdentity(auth);
            const anchored = {
              ...body,
              agent_id: identity.agent_id,
              owner: identity.owner,
            };
            const result = await backbone.markClaimDone(
              channel,
              anchored as unknown as MessageInput,
            );
            return { status: 200, json: result };
          }
          default:
            return notFound();
        }
      }
    }

    return notFound();
  } catch (err) {
    if (err instanceof MalformedPathError) {
      return invalidRequest(err.message);
    }
    const mapped = mapError(err);
    return { status: mapped.status, json: mapped.body };
  }
}

/**
 * Build the `http.Server` without starting it. Buffers the request body (capped
 * at {@link MAX_BODY_BYTES} → 413), parses JSON (malformed → 400), then defers
 * to the pure {@link dispatch}. A fresh {@link InMemoryBackbone} is created when
 * none is supplied.
 */
export function createServer(opts: ServerOptions = {}): Server {
  const backbone = opts.backbone ?? new InMemoryBackbone();
  const tokens = opts.tokens;

  // `connectionsCheckingInterval` is a creation option (the others are plain
  // instance properties, set after construction below): it tunes how often Node
  // sweeps sockets for expired headers/request timeouts — see the constants
  // above for rationale.
  const server = createHttpServer(
    { connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS },
    (req, res) => {
      // Artifact routes (ADR-C14) take a DEDICATED raw-bytes branch BEFORE the
      // JSON body-buffering below: the upload is opaque bytes (no JSON parse, no
      // JSON `send`) with its own incremental MAX_ARTIFACT_BYTES cap, and the GET
      // serves binary. We branch here so the JSON `MAX_BODY_BYTES` cap and parser
      // never touch an artifact request. A malformed-percent path throws
      // MalformedPathError, mapped to a clean 400 (same as the JSON path).
      let artifactRoute: ArtifactRoute | undefined;
      try {
        artifactRoute = matchArtifactRoute(req.url ?? "/");
      } catch (err) {
        const message =
          err instanceof MalformedPathError ? err.message : "invalid request";
        sendArtifactJson(res, 400, {
          error: { code: "invalid_request", message },
        });
        return;
      }
      if (artifactRoute !== undefined) {
        const route = artifactRoute;
        void (async () => {
          const handled = await handleArtifactRoute(backbone, route, req, res, {
            tokens,
            bearer: bearerFromHeader(req.headers.authorization),
          });
          if (!handled && !res.writableEnded) {
            sendArtifactJson(res, 405, {
              error: { code: "method_not_allowed", message: "method not allowed" },
            });
          }
        })().catch((err: unknown) => {
          if (res.writableEnded) return;
          const mapped = mapError(err);
          sendArtifactJson(res, mapped.status, mapped.body);
        });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;

      const send = (status: number, json: unknown): void => {
        const payload = JSON.stringify(json);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(payload);
      };

      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          const body: WireErrorBody = {
            error: { code: "payload_too_large", message: "request body too large" },
          };
          send(413, body);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (aborted) return;
        void (async () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              const body: WireErrorBody = {
                error: { code: "invalid_json", message: "request body is not valid JSON" },
              };
              send(400, body);
              return;
            }
          }
          const result = await dispatch(
            backbone,
            req.method ?? "GET",
            req.url ?? "/",
            parsed,
            { tokens, bearer: bearerFromHeader(req.headers.authorization) },
          );
          send(result.status, result.json);
        })().catch((err: unknown) => {
          // Defense-in-depth: `dispatch` maps its own errors, so reaching here
          // means an unexpected throw in the handler itself. Never let it become
          // an unhandled rejection that drops the response — map it to a clean
          // envelope (500) via the same path the router uses.
          if (aborted || res.writableEnded) return;
          const mapped = mapError(err);
          send(mapped.status, mapped.body);
        });
      });
    },
  );

  // Bounded socket timeouts (CAU-75) — see the constants above for rationale.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return server;
}

/**
 * Start a server and resolve once it is listening, with the bound URL/port and a
 * promise-based {@link RunningServer.close}.
 */
export function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const server = createServer(opts);

  return new Promise<RunningServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      // Build the URL from the BOUND address, not the requested host (CAU-75):
      // a wildcard bind ("0.0.0.0" / "::") is not dialable, and every consumer
      // dials this URL locally — so substitute the matching loopback literal.
      // IPv6 hosts need brackets in a URL; IPv4 literals do not. The REAL bind
      // is still exposed as `boundHost`, so the substitution can never mask
      // exposure: the bin logs a warning from it (see `bindExposureWarning`).
      const dialHost =
        address.address === "0.0.0.0" ? "127.0.0.1"
        : address.address === "::" ? "::1"
        : address.address;
      const hostForUrl = address.family === "IPv6" ? `[${dialHost}]` : dialHost;
      resolve({
        url: `http://${hostForUrl}:${address.port}`,
        boundHost: address.address,
        port: address.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/** Interface addresses that keep the listener reachable on-host only. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

/**
 * The startup warning for a non-loopback bind, or `undefined` for a loopback
 * one (CAU-75). {@link RunningServer.url} substitutes a dialable loopback
 * literal for wildcard binds, so the startup log alone would make a
 * `HOST=0.0.0.0` server LOOK loopback-only while it is exposed on every
 * interface — HOST is the single knob that widens exposure (SECURITY.md). The
 * bin prints this warning from {@link RunningServer.boundHost} so the real bind
 * is always visible. Kept pure (and out of `bin.ts`) so the wording and the
 * loopback/non-loopback split are unit-testable; `boundHost` is the
 * kernel-resolved bind of the operator-configured `HOST`, so naming it in the
 * log is fine under ADR-C12 (operator-controlled, never caller content).
 */
export function bindExposureWarning(boundHost: string): string | undefined {
  if (LOOPBACK_ADDRESSES.has(boundHost)) return undefined;
  return `WARNING: bound to ${boundHost} — reads are open to anyone who can reach this port (see SECURITY.md)`;
}
