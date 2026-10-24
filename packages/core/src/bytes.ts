import type { Hex } from "./types.js";

const HEX_CHARS = "0123456789abcdef";

/** Encodes bytes as a lowercase, `0x`-prefixed hex string. */
export function toHex(bytes: Uint8Array): Hex {
  let hex = "0x";
  for (const byte of bytes) {
    hex += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return hex as Hex;
}

/** Decodes a `0x`-prefixed hex string (any case) into bytes. */
export function fromHex(hex: Hex): Uint8Array {
  const digits = hex.slice(2);
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
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
