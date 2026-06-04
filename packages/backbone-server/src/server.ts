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
 * **Security posture (v0).** This server is UNAUTHENTICATED and intended for
 * localhost only. Identity anchoring (verifying `agent_id`/`owner`) is CAU-9 /
 * CAU-13; until then anyone who can reach the port can post as any principal.
 * Do not bind it to a public interface.
 *
 * The HTTP method/route handlers are `createChannel`, `listChannels`,
 * `describeChannel`, `subscribe`, `append`, `readSince` (CAU-5/CAU-6), and
 * `claim` (CAU-7). The claim route answers BOTH outcomes — `granted` and
 * `already_claimed` — as normal 200 results (the conflict is a value carrying
 * the holder, never an error envelope); the
 * {@link import("./http-client.js").HttpBackbone} client mirrors this.
 */
import { createServer as createHttpServer, type Server } from "node:http";

import type { Backbone, Cursor } from "@caucus/backbone";
import { InMemoryBackbone } from "@caucus/backbone";
import type { MessageInput } from "@caucus/schema";

import { mapError, type WireErrorBody } from "./wire-errors.js";

/** Max raw request body the server will buffer before rejecting with 413. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Options for {@link createServer} / {@link startServer}. */
export interface ServerOptions {
  /** Backbone to serve. Defaults to a fresh in-memory instance. */
  readonly backbone?: Backbone;
  /** TCP port. Defaults to 4317; pass 0 for an ephemeral port. */
  readonly port?: number;
  /** Bind host. Defaults to `127.0.0.1` (localhost only). */
  readonly host?: string;
}

/** A started server with its resolved URL and a clean shutdown. */
export interface RunningServer {
  /** Base URL, e.g. `http://127.0.0.1:4317`. */
  readonly url: string;
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
        throw new MalformedPathError(`malformed percent-encoding in path: ${s}`);
      }
    });
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
 * Pure request dispatch — NO sockets. Given a method, path, and already-parsed
 * JSON body (or `undefined` when there was no body), call the backbone and
 * return a status + JSON. This is the whole router; {@link createServer} only
 * wraps it with body-buffering and serialization, so every route, status, and
 * error-mapping case is unit-testable without a live socket.
 *
 * Malformed-JSON and payload-too-large are detected during body buffering, so
 * they never reach here — `dispatch` assumes `body` is a parsed value.
 */
export async function dispatch(
  backbone: Backbone,
  method: string,
  path: string,
  body: unknown,
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
          const descriptor = await backbone.createChannel(
            body as unknown as Parameters<Backbone["createChannel"]>[0],
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
            const result = await backbone.append(channel, body as unknown as MessageInput);
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
            const result = await backbone.claim(channel, body as unknown as MessageInput);
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

  return createHttpServer((req, res) => {
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
  });
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
      // IPv6 hosts need brackets in a URL; 127.0.0.1 / localhost do not.
      const hostForUrl = address.family === "IPv6" ? `[${host}]` : host;
      resolve({
        url: `http://${hostForUrl}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
