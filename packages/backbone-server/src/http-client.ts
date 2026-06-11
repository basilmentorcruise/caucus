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
  PutArtifactResult,
  ReadResult,
} from "@caucus/backbone";
import { BackboneError } from "@caucus/backbone";
import type { MessageInput } from "@caucus/schema";

import { backboneErrorFromWire, type WireErrorBody } from "./wire-errors.js";

/** Construction options for {@link HttpBackbone}. */
export interface HttpBackboneOptions {
  /** Override the global `fetch` (e.g. to inject a stub in unit tests). */
  readonly fetch?: typeof fetch;
  /**
   * Bearer token presented as `Authorization: Bearer <token>` on EVERY request
   * (CAU-13). The server gates only the three write routes on it and ignores it
   * on reads, so sending it everywhere is correct and keeps `#request` simple.
   * Omitted ⇒ no header sent (writes will 401 against a token-gated server). The
   * token is NEVER logged or echoed in a thrown error.
   */
  readonly token?: string;
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
  /** Held privately and only ever sent as a header — never logged or echoed. */
  readonly #token: string | undefined;

  /**
   * @param baseUrl Server base URL, e.g. `http://127.0.0.1:4317`. A trailing
   *   slash is tolerated.
   */
  constructor(baseUrl: string, opts: HttpBackboneOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    // Bind so `fetch` keeps its `undefined` `this` (some impls assert on it).
    const f = opts.fetch ?? fetch;
    this.#fetch = (input, init) => f(input, init);
    this.#token = opts.token;
  }

  /**
   * Join the base URL and an already-built path. Callers are responsible for
   * percent-encoding any dynamic segments (see `encodeURIComponent` at the call
   * sites); this only concatenates.
   */
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
    // A single-host localhost backbone never legitimately redirects. Default
    // follow-redirect would silently re-POST an ADR-C12-sensitive body to
    // wherever a `Location` header points (possibly cross-origin); refuse it.
    const init: RequestInit = { method, redirect: "error" };
    // Build headers up front so the bearer (CAU-13) is attached to every request
    // — reads ignore it server-side; writes require it. The token is only ever
    // placed in this header, never logged or surfaced in an error.
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    if (this.#token !== undefined && this.#token !== "") {
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
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
    // which only throws on non-2xx).
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

  /**
   * Upload an opaque blob to a channel's ephemeral evidence store (ADR-C14).
   * Sends the RAW bytes as `application/octet-stream` to
   * `PUT /channels/:channel/artifacts/:sha256` — NOT through the JSON `#request`
   * path (the body is binary, not JSON). Token-gated server-side like `append`;
   * the bearer is attached here. The server verifies `sha256(body)` and answers
   * 201 (new) / 200 (dedup) with the `{uri,sha256,size}` envelope. A non-2xx is
   * reconstructed into the real {@link BackboneError} (e.g. 413 →
   * `ArtifactTooLargeError`, 400 → `ArtifactIntegrityError`).
   *
   * The `deduplicated` flag is recovered from the response STATUS (200 = dedup,
   * 201 = new), since the success envelope carries only `{uri,sha256,size}`.
   */
  async putArtifact(
    channel: string,
    sha256: string,
    bytes: Uint8Array,
  ): Promise<PutArtifactResult> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (this.#token !== undefined && this.#token !== "") {
      headers.authorization = `Bearer ${this.#token}`;
    }
    const res = await this.#fetch(
      this.#url(
        `/channels/${encodeURIComponent(channel)}/artifacts/${encodeURIComponent(sha256)}`,
      ),
      {
        method: "PUT",
        redirect: "error",
        headers,
        // A Uint8Array is a valid BodyInit; the bytes ride verbatim, no encoding.
        body: bytes,
      },
    );
    if (!res.ok) {
      throw await this.#errorFromResponse(res);
    }
    const json = (await res.json()) as {
      uri: string;
      sha256: string;
      size: number;
    };
    return { ...json, deduplicated: res.status === 200 };
  }

  /**
   * Fetch an opaque blob from a channel's ephemeral evidence store (ADR-C14) via
   * `GET /channels/:channel/artifacts/:sha256` (tokenless within the boundary,
   * like `readSince`). Returns the raw bytes, or `undefined` on a 404 (missing
   * channel OR missing blob — both surface as a not-found here). Other non-2xx
   * responses reconstruct the real {@link BackboneError}.
   */
  async getArtifact(
    channel: string,
    sha256: string,
  ): Promise<Uint8Array | undefined> {
    const res = await this.#fetch(
      this.#url(
        `/channels/${encodeURIComponent(channel)}/artifacts/${encodeURIComponent(sha256)}`,
      ),
      { method: "GET", redirect: "error" },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw await this.#errorFromResponse(res);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Reconstruct the real {@link BackboneError} from a non-2xx artifact response
   * (the raw-bytes routes don't go through {@link #request}, so they reuse this
   * shared mapping). Parses the `{ error: { code, … } }` envelope defensively;
   * an unparseable body becomes a generic `http_error`.
   */
  async #errorFromResponse(res: Response): Promise<BackboneError> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (isWireErrorBody(parsed)) {
      return backboneErrorFromWire(parsed);
    }
    return new BackboneError(`backbone HTTP ${res.status}`, "http_error");
  }
}
