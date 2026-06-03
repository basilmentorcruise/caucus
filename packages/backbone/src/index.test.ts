import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, packageName } from "./index.js";

describe("@caucus/backbone placeholder", () => {
  it("exposes its package name constant", () => {
    expect(PACKAGE_NAME).toBe("@caucus/backbone");
  });

  it("returns the package name from packageName()", () => {
    expect(packageName()).toBe("@caucus/backbone");
  });
});
