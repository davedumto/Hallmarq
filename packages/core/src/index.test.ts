import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@hallmarq/core", () => {
  it("has a placeholder export until PR 2 adds normalization, hashing and Merkle logic", () => {
    expect(PACKAGE_NAME).toBe("@hallmarq/core");
  });
});
