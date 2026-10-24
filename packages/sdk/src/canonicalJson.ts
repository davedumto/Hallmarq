import { InvalidMeta } from "./errors.js";

/**
 * A deterministic JSON encoding of `value`: object keys are sorted
 * recursively (so the same data always produces the same string,
 * regardless of insertion order) and there is no whitespace. Used to turn
 * `stamp`'s `meta` option into bytes for `metaHash`.
 *
 * Throws {@link InvalidMeta} if `value`, or anything nested inside it, is
 * `undefined`, a function, a `bigint`, a `symbol`, `NaN` or
 * `Infinity`/`-Infinity` — none of which JSON can represent, and none of
 * which this silently drops or coerces the way `JSON.stringify` does for
 * some of them.
 */
export function canonicalJsonStringify(value: unknown): string {
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

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }

  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  const fields = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry[key])}`);
  return `{${fields.join(",")}}`;
}
