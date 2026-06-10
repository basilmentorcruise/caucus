/**
 * Integration scenario — error-message / issues[] sanitization over the real
 * HTTP wire (CAU-88).
 *
 * CAU-71 rejects control-character FIELD VALUES at write; CAU-88 closes the
 * adjacent conduit: a control-byte UNKNOWN KEY is echoed verbatim by the schema
 * validator into the thrown `invalid_message` error's `.message` AND its
 * wire-forwarded `.issues[]`. DEL/C1 survive `JSON.stringify`, so without the
 * construction-time strip a token-holding poster could ride terminal escapes /
 * C1 bytes into the requester's context or TTY via the error response.
 *
 * This scenario boots a REAL `@caucus/backbone-server` and POSTs an append whose
 * JSON body carries a control-byte key directly (bypassing any typed client), so
 * we exercise the on-the-wire 400 body itself. It asserts the response
 * `error.message` AND every `error.issues[]` entry are control-byte-free.
 */
import {
  startServer,
  tokenDigest,
  type RunningServer,
  type TokenIdentity,
} from "@caucus/backbone-server";
import { InMemoryBackbone } from "@caucus/backbone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CH = "incident-err-sanitize";
const TOKEN = "tok-alice";
const IDENTITY: TokenIdentity = { agent_id: "alice-agent", owner: "alice" };

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

interface WireError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly string[];
  };
}

describe("CAU-88 — invalid_message wire body carries no control bytes (over HTTP)", () => {
  let server: RunningServer;

  beforeAll(async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: CH,
      purpose: "error sanitization",
      created_by: "alice",
    });
    const tokens = new Map([[tokenDigest(TOKEN), IDENTITY]]);
    server = await startServer({ port: 0, backbone, tokens });
  });

  afterAll(async () => {
    await server.close();
  });

  it("an append whose body has a control-byte KEY → 400 invalid_message, message + every issues[] entry clean", async () => {
    // A control-byte JSON key (DEL + C1 CSI). Both bytes survive JSON.stringify,
    // so this is exactly the conduit CAU-88 closes. We hand-build the JSON so the
    // dirty bytes ride raw on the wire (no typed client to scrub them first).
    const dirtyKey = "pwn\x7f\x9b[2Jevil";
    const body = JSON.stringify({
      type: "note",
      agent_id: "alice-agent",
      owner: "alice",
      msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      body: "hello",
      [dirtyKey]: 1,
    });
    // Sanity: the raw request body itself DOES carry the control bytes — so a
    // pass below is the strip working, not the bytes never arriving.
    expect(body).toMatch(CONTROL_CHARS);

    const res = await fetch(`${server.url}/channels/${CH}/append`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body,
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as WireError;
    expect(json.error.code).toBe("invalid_message");

    // THE ASSERTIONS: neither the message nor any issues[] entry carries a
    // control byte, even though the offending key is named.
    expect(json.error.message).not.toMatch(CONTROL_CHARS);
    expect(json.error.issues).toBeDefined();
    for (const issue of json.error.issues ?? []) {
      expect(issue).not.toMatch(CONTROL_CHARS);
    }
    // The clean key text is preserved so the report is still actionable.
    expect(json.error.issues).toContain('unknown field "pwn[2Jevil"');
    // And the whole serialized body is control-byte-free end to end.
    expect(JSON.stringify(json)).not.toMatch(CONTROL_CHARS);
  });

  it("a C1 byte arriving as MULTIBYTE UTF-8 (0xC2 0x9B) in a body key is still stripped (decode-boundary guard, CAU-81/88)", async () => {
    // The canonical CAU-81 vector: C1 CSI as the two raw UTF-8 bytes 0xC2 0x9B,
    // not a literal 0x9b. This pins that stripping runs AFTER the utf8 decode
    // (server reads Buffer.toString("utf8") → JSON.parse → strip on code points),
    // so a future refactor that moved stripping ahead of the decode would fail here.
    const dirtyKey = "pwnevil"; // U+009B = C1 CSI; UTF-8-encodes to 0xC2 0x9B
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "note",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        body: "hello",
        [dirtyKey]: 1,
      }),
    );
    // Sanity: the bytes actually on the wire carry the 0xC2 0x9B sequence (the
    // multibyte form), so a clean response is the decode-then-strip working —
    // not the byte being absent or pre-scrubbed.
    const hasC2C1 = bodyBytes.some(
      (b, i) => b === 0xc2 && bodyBytes[i + 1] === 0x9b,
    );
    expect(hasC2C1).toBe(true);

    const res = await fetch(`${server.url}/channels/${CH}/append`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: bodyBytes,
    });

    expect(res.status).toBe(400);
    // Assert on the RAW response bytes: no lone 0x9b and no 0xC2 0x9B survive.
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(raw.some((b) => b === 0x9b)).toBe(false);
    expect(
      raw.some((b, i) => b === 0xc2 && raw[i + 1] === 0x9b),
    ).toBe(false);
    const json = JSON.parse(new TextDecoder().decode(raw)) as WireError;
    expect(json.error.code).toBe("invalid_message");
    expect(json.error.message).not.toMatch(CONTROL_CHARS);
    expect(json.error.issues).toContain('unknown field "pwnevil"');
  });
});
