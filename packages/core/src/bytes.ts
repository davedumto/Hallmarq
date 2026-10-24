import { InvalidHex } from "./errors.js";
import type { Hex } from "./types.js";

const HEX_CHARS = "0123456789abcdef";
const HEX_DIGITS_ONLY = /^[0-9a-fA-F]*$/;

/** Encodes bytes as a lowercase, `0x`-prefixed hex string. */
export function toHex(bytes: Uint8Array): Hex {
  let hex = "0x";
  for (const byte of bytes) {
    hex += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return hex as Hex;
}

/**
 * Decodes a `0x`-prefixed hex string (any case) into bytes. `hex` is typed
 * as a plain `string`, not `Hex`: the `Hex` brand only constrains code that
 * goes through the type checker, and this function exists precisely to
 * validate hex strings that didn't (JSON parsed at runtime, for instance).
 * Throws {@link InvalidHex} on a missing `0x` prefix, an odd number of
 * digits, or any non-hex character.
 */
export function fromHex(hex: string): Uint8Array {
  if (!/^0x/i.test(hex)) {
    throw new InvalidHex(`expected a "0x"-prefixed hex string, got "${hex}"`);
  }

  const digits = hex.slice(2);
  if (digits.length % 2 !== 0) {
    throw new InvalidHex(`expected an even number of hex digits, got ${digits.length} in "${hex}"`);
  }
  if (!HEX_DIGITS_ONLY.test(digits)) {
    throw new InvalidHex(`expected only hex digits after "0x", got "${hex}"`);
  }

  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Validates that `hex` is a well-formed hex string encoding exactly 32
 * bytes — what every hash in this package is expected to be — and returns
 * its bytes. Used wherever a `Hex` value actually needs to be hashed, so
 * malformed input (a truncated proof element, a corrupted receipt file)
 * throws a clear {@link InvalidHex} instead of silently producing a wrong
 * hash.
 */
export function assertHash32(hex: string): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) {
    throw new InvalidHex(`expected a 32-byte hash, got ${bytes.length} bytes in "${hex}"`);
  }
  return bytes;
}

/** Concatenates any number of byte arrays into one. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
