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

  it("throws InvalidMeta on a Date instead of silently encoding it as {}", () => {
    expect(() => canonicalJsonStringify(new Date("2026-01-01"))).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify({ at: new Date("2026-01-01") })).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on a Map, a Set and a RegExp", () => {
    expect(() => canonicalJsonStringify(new Map([["a", 1]]))).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify(new Set([1, 2]))).toThrow(InvalidMeta);
    expect(() => canonicalJsonStringify(/abc/)).toThrow(InvalidMeta);
  });

  it("throws InvalidMeta on a typed array and a class instance", () => {
    expect(() => canonicalJsonStringify(new Uint8Array([1, 2, 3]))).toThrow(InvalidMeta);
    class Point {
      x = 1;
      y = 2;
    }
    expect(() => canonicalJsonStringify(new Point())).toThrow(InvalidMeta);
  });

  it("accepts a plain object created with Object.create(null)", () => {
    const plain = Object.create(null) as Record<string, unknown>;
    plain.a = 1;
    expect(canonicalJsonStringify(plain)).toBe('{"a":1}');
  });

  it("throws InvalidMeta on a circular reference instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(InvalidMeta);

    const cyclicArray: unknown[] = [1, 2];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalJsonStringify(cyclicArray)).toThrow(InvalidMeta);
  });

  it("does not mistake two sibling references to the same object for a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJsonStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
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
