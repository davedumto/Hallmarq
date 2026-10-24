import { InvalidMeta } from "./errors.js";

/**
 * A deterministic JSON encoding of `value`: object keys are sorted
 * recursively (so the same data always produces the same string,
 * regardless of insertion order) and there is no whitespace. Used to turn
 * `stamp`'s `meta` option into bytes for `metaHash`.
 *
 * Throws {@link InvalidMeta} if `value`, or anything nested inside it, is
 * `undefined`, a function, a `bigint`, a `symbol`, `NaN`,
 * `Infinity`/`-Infinity`, a circular reference, or an object that isn't a
 * plain object or array (`Date`, `Map`, `Set`, `RegExp`, a typed array, a
 * class instance, ...). Those object kinds would otherwise silently encode
 * as `{}` (since `Object.keys` on them is typically empty), making two
 * different values hash identically — none of this is silently dropped or
 * coerced the way `JSON.stringify` does for some of it.
 */
export function canonicalJsonStringify(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === undefined) {
    throw new InvalidMeta("meta contains undefined, which canonical JSON can't represent");
  }
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new InvalidMeta(
          `meta contains a non-finite number (${value}), which JSON can't represent`,
        );
      }
      return JSON.stringify(value);
    case "bigint":
      throw new InvalidMeta("meta contains a BigInt, which JSON can't represent");
    case "function":
      throw new InvalidMeta("meta contains a function, which JSON can't represent");
    case "symbol":
      throw new InvalidMeta("meta contains a symbol, which JSON can't represent");
    default:
      break;
  }

  const object: object = value;
  if (ancestors.has(object)) {
    throw new InvalidMeta("meta contains a circular reference, which JSON can't represent");
  }
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidMeta(
        `meta contains a ${describeNonPlainObject(object)}, which canonical JSON only encodes as a plain object; ` +
          "convert it to a plain object or array first",
      );
    }

    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    const fields = keys.map((key) => `${JSON.stringify(key)}:${encode(entry[key], ancestors)}`);
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

function describeNonPlainObject(value: object): string {
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name && name !== "Object" ? name : "non-plain object";
}
