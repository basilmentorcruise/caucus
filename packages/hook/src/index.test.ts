import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, packageName } from "./index.js";

describe("@caucus/hook placeholder", () => {
  it("exposes its package name constant", () => {
    expect(PACKAGE_NAME).toBe("@caucus/hook");
  });

  it("returns the package name from packageName()", () => {
    expect(packageName()).toBe("@caucus/hook");
  });
});
