import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex } from "./bytes.js";

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
