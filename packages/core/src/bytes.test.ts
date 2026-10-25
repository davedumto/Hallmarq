import { describe, expect, it } from "vitest";

import { assertAddress, assertHash32, concatBytes, fromHex, toHex } from "./bytes.js";
import { InvalidHex } from "./errors.js";

describe("toHex / fromHex", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("encodes as lowercase, 0x-prefixed, two hex digits per byte", () => {
    expect(toHex(new Uint8Array([0x0a, 0xb2]))).toBe("0x0ab2");
  });

  it("encodes the empty byte array as just 0x", () => {
    expect(toHex(new Uint8Array())).toBe("0x");
  });

  it("accepts uppercase hex digits", () => {
    expect(fromHex("0xAB12")).toEqual(new Uint8Array([0xab, 0x12]));
  });

  it("accepts an uppercase 0X prefix (e.g. a fully-uppercased hash)", () => {
    expect(fromHex("0XAB12")).toEqual(new Uint8Array([0xab, 0x12]));
  });

  it("throws InvalidHex for a missing 0x prefix", () => {
    expect(() => fromHex("ab12")).toThrow(InvalidHex);
    expect(() => fromHex("")).toThrow(InvalidHex);
  });

  it("throws InvalidHex for an odd number of hex digits", () => {
    expect(() => fromHex("0xabc")).toThrow(InvalidHex);
  });

  it("throws InvalidHex for a non-hex character", () => {
    expect(() => fromHex("0xzz")).toThrow(InvalidHex);
    expect(() => fromHex("0xab1g")).toThrow(InvalidHex);
  });

  it("accepts a bare 0x (zero bytes)", () => {
    expect(fromHex("0x")).toEqual(new Uint8Array());
  });
});

describe("assertHash32", () => {
  const validHash = "0x" + "ab".repeat(32);

  it("returns the 32 bytes of a well-formed hash", () => {
    expect(assertHash32(validHash)).toEqual(fromHex(validHash));
  });

  it("throws InvalidHex for a hash shorter than 32 bytes", () => {
    expect(() => assertHash32("0x1234")).toThrow(InvalidHex);
  });

  it("throws InvalidHex for a hash longer than 32 bytes", () => {
    expect(() => assertHash32("0x" + "ab".repeat(33))).toThrow(InvalidHex);
  });

  it("throws InvalidHex for malformed hex, not just the wrong length", () => {
    expect(() => assertHash32("0x" + "zz".repeat(32))).toThrow(InvalidHex);
    expect(() => assertHash32("not-hex-at-all")).toThrow(InvalidHex);
  });
});

describe("assertAddress", () => {
  const validAddress = "0x" + "ab".repeat(20);

  it("returns a well-formed 20-byte address unchanged", () => {
    expect(assertAddress(validAddress)).toBe(validAddress);
  });

  it("accepts uppercase hex digits", () => {
    const upper = "0x" + "AB".repeat(20);
    expect(assertAddress(upper)).toBe(upper);
  });

  it("throws InvalidHex for an address shorter than 20 bytes", () => {
    expect(() => assertAddress("0x1234")).toThrow(InvalidHex);
  });

  it("throws InvalidHex for an address longer than 20 bytes (e.g. a 32-byte hash)", () => {
    expect(() => assertAddress("0x" + "ab".repeat(32))).toThrow(InvalidHex);
  });

  it("throws InvalidHex for a missing 0x prefix", () => {
    expect(() => assertAddress("ab".repeat(20))).toThrow(InvalidHex);
  });

  it("throws InvalidHex for a non-hex character", () => {
    expect(() => assertAddress("0x" + "zz".repeat(20))).toThrow(InvalidHex);
  });
});

describe("concatBytes", () => {
  it("concatenates any number of byte arrays, in order", () => {
    const result = concatBytes(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]));
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns an empty array for no parts", () => {
    expect(concatBytes()).toEqual(new Uint8Array());
  });
});
