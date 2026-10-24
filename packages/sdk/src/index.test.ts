import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@hallmarq/sdk", () => {
  it("has a placeholder export until PRs 6 and 7 add the Hallmarq class", () => {
    expect(PACKAGE_NAME).toBe("@hallmarq/sdk");
  });
});
