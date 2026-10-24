import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@hallmarq/verifier", () => {
  it("has a placeholder export until PR 8 adds the verifier page", () => {
    expect(PACKAGE_NAME).toBe("@hallmarq/verifier");
  });
});
