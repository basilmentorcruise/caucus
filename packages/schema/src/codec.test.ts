import { describe, expect, it } from "vitest";
import { decode, encode } from "./codec.js";
import { MalformedMessageError } from "./errors.js";
import type { MessageInput } from "./types.js";

const MSG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THREAD = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

/** One representative input per message type. */
const inputs: Record<string, MessageInput> = {
  finding: {
    type: "finding",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: MSG_ID,
    body: "/login accepts expired JWTs.",
    artifact: "https://artifacts.example/01J",
  },
  claim: {
    type: "claim",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: MSG_ID,
    body: "Taking the auth-timeout repro.",
    target: "auth-timeout repro",
    lease_ttl: 60,
    heartbeat: false,
  },
  status: {
    type: "status",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: MSG_ID,
    body: "starting a sweep of payments",
  },
  question: {
    type: "question",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: MSG_ID,
    body: "is the 14:02 deploy related?",
    status: "needs-response",
  },
  answer: {
    type: "answer",
    agent_id: "sess-A",
    owner: "alice",
    msg_id: MSG_ID,
    body: "yes, the deploy flipped the flag",
    thread: THREAD,
    reply_to: THREAD,
    status: "resolved",
  },
  note: {
    type: "note",
    agent_id: "sess-C",
    owner: "carol",
    msg_id: MSG_ID,
    body: "Human steer: check the 14:02 deploy.",
    to: ["sess-A", "sess-B"],
  },
};

describe("round-trip identity per message type", () => {
  for (const [name, input] of Object.entries(inputs)) {
    it(`decode(encode(x)) deep-equals {...x, v:1} for ${name}`, () => {
      const round = decode(encode(input));
      expect(round).toEqual({ ...input, v: 1 });
    });
  }
});

describe("encode", () => {
  it("stamps v:1", () => {
    const out = JSON.parse(encode(inputs.note!));
    expect(out.v).toBe(1);
  });

  it("never sets ts", () => {
    const out = JSON.parse(encode(inputs.note!));
    expect("ts" in out).toBe(false);
  });

  it("does not mutate the caller's object", () => {
    const input = { ...inputs.note! };
    encode(input);
    expect("v" in input).toBe(false);
  });

  it("throws MalformedMessageError on invalid input", () => {
    // Empty body — bypass the input type with a cast.
    const bad = { ...inputs.note!, body: "" } as unknown as MessageInput;
    expect(() => encode(bad)).toThrow(MalformedMessageError);
  });
});

describe("decode", () => {
  it("accepts the post-append form with ts present", () => {
    const withTs = { ...inputs.finding!, v: 1, ts: "2026-06-03T00:00:00Z" };
    const round = decode(JSON.stringify(withTs));
    expect(round.ts).toBe("2026-06-03T00:00:00Z");
    expect(round).toEqual(withTs);
  });

  it("accepts an already-parsed object", () => {
    expect(() => decode({ ...inputs.note!, v: 1 })).not.toThrow();
  });

  it("throws MalformedMessageError on non-JSON string input", () => {
    expect(() => decode("not json")).toThrow(MalformedMessageError);
  });

  it("reports 'not valid JSON' on a truncated object string", () => {
    try {
      decode("{bad");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedMessageError);
      expect((err as MalformedMessageError).issues).toEqual(["not valid JSON"]);
    }
  });

  it("throws MalformedMessageError for a valid-version but bad-field object", () => {
    expect(() => decode({ v: 1, type: "note" })).toThrow(MalformedMessageError);
  });
});
