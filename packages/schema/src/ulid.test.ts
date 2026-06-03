import { describe, expect, it } from "vitest";
import { isUlid, newMsgId } from "./ulid.js";

describe("isUlid", () => {
  it("accepts a valid 26-char Crockford ULID", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  it("rejects a too-short string", () => {
    expect(isUlid("01ARZ3NDEK")).toBe(false);
  });

  it("rejects a too-long string", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVZ")).toBe(false);
  });

  it("rejects strings containing the excluded letters I, L, O, U", () => {
    expect(isUlid("0IARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("0LARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("0OARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("0UARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
  });

  it("rejects lowercase", () => {
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isUlid(123)).toBe(false);
    expect(isUlid(null)).toBe(false);
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid({})).toBe(false);
  });
});

describe("newMsgId", () => {
  it("produces a value that passes isUlid", () => {
    expect(isUlid(newMsgId())).toBe(true);
  });

  it("produces distinct values across calls", () => {
    const a = newMsgId();
    const b = newMsgId();
    expect(a).not.toBe(b);
  });

  it("produces unique values across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newMsgId());
    }
    expect(ids.size).toBe(1000);
  });
});
