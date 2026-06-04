/**
 * Contract-level tests: the public surface compiles to the documented shapes,
 * `InMemoryBackbone` is assignable to `Backbone`, and `index.ts` re-exports the
 * contract types, the error taxonomy, and the reference implementation.
 */
import { newMsgId } from "@caucus/schema";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AppendedMessage,
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
  Cursor,
  ReadResult,
} from "./contract.js";
import * as backbone from "./index.js";
import {
  BackboneError,
  ChannelExistsError,
  InMemoryBackbone,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  MAX_BODY_CHARS,
  UnknownChannelError,
} from "./index.js";

const CHANNEL = "incident-42";

function makeBackbone(): Backbone {
  // Type-conformance: the reference implementation IS a Backbone.
  return new InMemoryBackbone();
}

describe("index re-exports", () => {
  it("exposes the contract value exports", () => {
    expect(backbone.InMemoryBackbone).toBe(InMemoryBackbone);
    expect(backbone.MAX_BODY_CHARS).toBe(MAX_BODY_CHARS);
  });

  it("exposes the full error taxonomy", () => {
    expect(backbone.BackboneError).toBe(BackboneError);
    expect(backbone.InvalidChannelNameError).toBe(InvalidChannelNameError);
    expect(backbone.UnknownChannelError).toBe(UnknownChannelError);
    expect(backbone.ChannelExistsError).toBe(ChannelExistsError);
    expect(backbone.InvalidCursorError).toBe(InvalidCursorError);
    expect(backbone.InvalidMessageError).toBe(InvalidMessageError);
  });

  it("error subclasses extend BackboneError with stable codes", () => {
    expect(new InvalidChannelNameError("BAD")).toBeInstanceOf(BackboneError);
    expect(new InvalidChannelNameError("BAD").code).toBe("invalid_channel_name");
    expect(new UnknownChannelError("x").code).toBe("unknown_channel");
    expect(new ChannelExistsError("x").code).toBe("channel_exists");
    expect(new InvalidCursorError("nope", -1).code).toBe("invalid_cursor");
    expect(new InvalidMessageError(["bad"]).code).toBe("invalid_message");
  });
});

describe("type conformance", () => {
  it("InMemoryBackbone satisfies the Backbone interface", () => {
    expectTypeOf<InMemoryBackbone>().toMatchTypeOf<Backbone>();
    expect(makeBackbone()).toBeInstanceOf(InMemoryBackbone);
  });

  it("Cursor is a number alias", () => {
    expectTypeOf<Cursor>().toEqualTypeOf<number>();
  });
});

describe("result shapes", () => {
  it("append/read/claim/channel results carry the documented fields", async () => {
    const b = makeBackbone();
    const desc: ChannelDescriptor = await b.createChannel({
      channel: CHANNEL,
      purpose: "p",
      created_by: "alice",
    });
    expect(desc).toMatchObject({
      channel: CHANNEL,
      kind: "ephemeral",
      purpose: "p",
      verbosity: "quiet",
      created_by: "alice",
      head: 0,
    });
    expect(typeof desc.created_ts).toBe("string");

    const appended: AppendResult = await b.append(CHANNEL, {
      type: "finding",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "found it",
    });
    expect(appended.cursor).toBe(1);
    const msg: AppendedMessage = appended.message;
    expect(typeof msg.ts).toBe("string");
    expect(msg.v).toBe(0);

    const read: ReadResult = await b.readSince(CHANNEL, 0);
    expect(read.messages).toHaveLength(1);
    expect(read.cursor).toBe(1);

    const claim: ClaimResult = await b.claim(CHANNEL, {
      type: "claim",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "claiming",
      target: "db",
    });
    expect(claim.outcome).toBe("granted");
    if (claim.outcome === "granted") {
      expect(claim.cursor).toBe(2);
      expect(claim.message.type).toBe("claim");
    }
  });
});
