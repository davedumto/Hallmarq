import { describe, expect, it } from "vitest";

import { canonicalJsonStringify } from "./canonicalJson.js";
import { InvalidMeta } from "./errors.js";

describe("canonicalJsonStringify", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ outer: { z: 1, y: { d: 1, c: 2 } } })).toBe(
      '{"outer":{"y":{"c":2,"d":1},"z":1}}',
    );
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJsonStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("produces no whitespace", () => {
    expect(canonicalJsonStringify({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  it("encodes primitives with JSON.stringify", () => {
    expect(canonicalJsonStringify("hello")).toBe('"hello"');
    expect(canonicalJsonStringify('with "quotes" and \n newline')).toBe(
      JSON.stringify('with "quotes" and \n newline'),
    );
    expect(canonicalJsonStringify(42)).toBe("42");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
    expect(canonicalJsonStringify(null)).toBe("null");
  });

  it("handles an empty object and an empty array", () => {
    expect(canonicalJsonStringify({})).toBe("{}");
    expect(canonicalJsonStringify([])).toBe("[]");
  });

  it("throws InvalidMeta on undefined, at the top level and nested", () => {
    expect(() => canonicalJsonStringify(undefined)).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify([undefined])).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on a function", () => {
    expect(() => canonicalJsonStringify(() => {})).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify({ fn: () => {} })).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on a BigInt", () => {
    expect(() => canonicalJsonStringify(1n)).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify({ big: 1n })).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on NaN and Infinity", () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify(Number.NEGATIVE_INFINITY)).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify({ n: Number.NaN })).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on a symbol", () => {
    expect(() => canonicalJsonStringify(Symbol("x"))).toThrow(InvalidMeta);
  });

  it("every error has the stable INVALID_META code", () => {
    try {
      canonicalJsonStringify(undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMeta);
      expect((error as InvalidMeta).code).toBe("INVALID_META");
    }
  });
});
