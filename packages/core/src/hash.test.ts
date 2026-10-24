import { describe, expect, it } from "vitest";

import { InvalidUtf8 } from "./errors.js";
import { hashBytes, hashText } from "./hash.js";

const HEX32 = /^0x[0-9a-f]{64}$/;

describe("hashBytes", () => {
  it("returns a lowercase 0x-prefixed 32-byte hex string", () => {
    expect(hashBytes(new Uint8Array())).toMatch(HEX32);
  });

  it("is sensitive to every byte, with no normalization", () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
  });

  it("never validates UTF-8 — invalid bytes hash just fine", () => {
    const invalidUtf8 = new Uint8Array([0xff]);
    expect(() => hashBytes(invalidUtf8)).not.toThrow();
    expect(hashBytes(invalidUtf8)).toMatch(HEX32);
  });

  it("is deterministic", () => {
    const bytes = new TextEncoder().encode("same input");
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
  });
});

describe("hashText", () => {
  it("returns a lowercase 0x-prefixed 32-byte hex string", () => {
    expect(hashText("")).toMatch(HEX32);
  });

  it("hashes the normalized form, not the raw input", () => {
    expect(hashText("trailing spaces   ")).toBe(hashText("trailing spaces"));
  });

  it("gives string and equivalent valid-UTF-8-bytes input the same hash", () => {
    const text = "Hello, StampAI.";
    expect(hashText(new TextEncoder().encode(text))).toBe(hashText(text));
  });

  it("throws InvalidUtf8 for invalid UTF-8 byte input", () => {
    expect(() => hashText(new Uint8Array([0xff]))).toThrow(InvalidUtf8);
  });

  it("still returns keccak256('') for empty or whitespace-only text (D4: core never rejects empty content)", () => {
    expect(hashText("")).toBe(hashText("   \t\n"));
  });
});
