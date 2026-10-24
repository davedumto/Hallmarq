import { keccak_256 } from "@noble/hashes/sha3.js";

import { toHex } from "./bytes.js";
import { normalizeText } from "./normalize.js";
import type { Hex } from "./types.js";

/**
 * keccak256 of raw bytes, with no normalization of any kind. Use this for
 * files; text content goes through {@link hashText} instead.
 */
export function hashBytes(bytes: Uint8Array): Hex {
  return toHex(keccak_256(bytes));
}

/**
 * keccak256 of the UTF-8 bytes of `normalizeText(input)`. Byte input is
 * decoded as strict UTF-8 first (throws {@link InvalidUtf8} if invalid);
 * string input is used as-is. Empty or whitespace-only input normalizes to
 * `""` and still returns a hash (`keccak256("")`) — rejecting empty
 * content is the SDK's job (D4), not this function's.
 */
export function hashText(input: string | Uint8Array): Hex {
  const normalized = normalizeText(input);
  const bytes = new TextEncoder().encode(normalized);
  return hashBytes(bytes);
}
