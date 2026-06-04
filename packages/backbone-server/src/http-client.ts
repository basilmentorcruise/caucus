/**
 * `HttpBackbone` — a {@link Backbone} that speaks to the CAU-5 HTTP server over
 * the wire (ADR-C9 one shared server; CAU-2 HTTP+JSON). It is a faithful
 * implementation of the same contract `InMemoryBackbone` implements, so the
 * CAU-25 integration scenarios run unchanged over HTTP.
 *
 * Two invariants make it contract-faithful:
 *
 * 1. **Errors are reconstructed, not flattened.** A `{ error: { code, … } }`
 *    body is turned back into the REAL {@link BackboneError} subclass (via the
 *    `code→factory` registry in `./wire-errors.ts`), so callers keep their
 *    `instanceof UnknownChannelError` / `.code` branching across the wire.
 * 2. **`already_claimed` is a RESULT, not a throw.** The claim route answers
 *    200 with a `ClaimResult`; only non-2xx responses become thrown errors.
 *
 * Cursors and `ts` stamps are passed through OPAQUELY — never parsed or coerced
 * (`Date.parse(ts)` is intentionally `NaN`; a cursor is an opaque token).
 */
import type {
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
  CreateChannelOptions,
  Cursor,
  ReadResult,
} from "@caucus/backbone";
import { BackboneError } from "@caucus/backbone";
import type { MessageInput } from "@caucus/schema";

import { backboneErrorFromWire, type WireErrorBody } from "./wire-errors.js";

/** Construction options for {@link HttpBackbone}. */
export interface HttpBackboneOptions {
  /** Override the global `fetch` (e.g. to inject a stub in unit tests). */
  readonly fetch?: typeof fetch;
}

/** Type guard for the error wire body. */
function isWireErrorBody(value: unknown): value is WireErrorBody {
  if (value === null || typeof value !== "object") return false;
  const err = (value as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return false;
  return typeof (err as { code?: unknown }).code === "string";
}

export class HttpBackbone implements Backbone {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  /**
   * @param baseUrl Server base URL, e.g. `http://127.0.0.1:4317`. A trailing
   *   slash is tolerated.
   */
  constructor(baseUrl: string, opts: HttpBackboneOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    // Bind so `fetch` keeps its `undefined` `this` (some impls assert on it).
    const f = opts.fetch ?? fetch;
    this.#fetch = (input, init) => f(input, init);
  }

  /** Build a full URL for a path, percent-encoding each dynamic segment. */
  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  /**
   * Issue a request and return the parsed JSON body on a 2xx response. On any
   * non-2xx response, reconstruct and throw the matching {@link BackboneError}
   * (or a generic one for an unrecognized/absent error code).
   */
  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await this.#fetch(this.#url(path), init);
    const text = await res.text();

    if (res.ok) {
      // A 2xx body is always our JSON contract — parse it directly.
      return text.length > 0 ? JSON.parse(text) : undefined;
    }

    // On a non-2xx, the body MAY be a `{ error: { code, … } }` wire error or —
    // for a transport-level fault we didn't generate — arbitrary text. Parse
    // defensively so an unexpected non-JSON body becomes a generic error rather
    // than a raw `SyntaxError`.
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (isWireErrorBody(parsed)) {
      throw backboneErrorFromWire(parsed);
    }
    // A non-2xx with an unparseable / unexpected body: surface a generic error
    // rather than leak the raw text.
    throw new BackboneError(`backbone HTTP ${res.status}`, "http_error");
  }

  async createChannel(opts: CreateChannelOptions): Promise<ChannelDescriptor> {
    return (await this.#request("POST", "/channels", opts)) as ChannelDescriptor;
  }

  async describeChannel(channel: string): Promise<ChannelDescriptor> {
    return (await this.#request(
      "GET",
      `/channels/${encodeURIComponent(channel)}`,
    )) as ChannelDescriptor;
  }

  async listChannels(): Promise<readonly ChannelDescriptor[]> {
    const json = (await this.#request("GET", "/channels")) as {
      channels: readonly ChannelDescriptor[];
    };
    return json.channels;
  }

  async append(channel: string, msg: MessageInput): Promise<AppendResult> {
    return (await this.#request(
      "POST",
      `/channels/${encodeURIComponent(channel)}/append`,
      msg,
    )) as AppendResult;
  }

  async readSince(
    channel: string,
    cursor: Cursor,
    limit?: number,
  ): Promise<ReadResult> {
    return (await this.#request(
      "POST",
      `/channels/${encodeURIComponent(channel)}/read`,
      limit === undefined ? { cursor } : { cursor, limit },
    )) as ReadResult;
  }

  async claim(channel: string, msg: MessageInput): Promise<ClaimResult> {
    // `already_claimed` is a normal 200 result, never a throw (see #request,
    // which only throws on non-2xx). The server route is CAU-7; this client
    // method is complete and will work the moment that route exists.
    return (await this.#request(
      "POST",
      `/channels/${encodeURIComponent(channel)}/claim`,
      msg,
    )) as ClaimResult;
  }

  async subscribe(channel: string): Promise<Cursor> {
    const json = (await this.#request(
      "POST",
      `/channels/${encodeURIComponent(channel)}/subscribe`,
    )) as { cursor: Cursor };
    return json.cursor;
  }
}
