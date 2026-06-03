import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, packageName } from "./index.js";

describe("@caucus/schema placeholder", () => {
  it("exposes its package name constant", () => {
    expect(PACKAGE_NAME).toBe("@caucus/schema");
  });

  it("returns the package name from packageName()", () => {
    expect(packageName()).toBe("@caucus/schema");
  });
});
