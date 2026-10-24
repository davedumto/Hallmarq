import { InvalidUtf8 } from "./errors.js";

const SPACE = " ";
const TAB = "\t";
const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";

/**
 * Decodes bytes as strict UTF-8, throwing {@link InvalidUtf8} on anything
 * that isn't. `TextDecoder` is a Web API available in both Node and
 * browsers, so this has no platform-specific dependency.
 *
 * `ignoreBOM: true` is required even though it reads backwards: the
 * default (`false`) makes `TextDecoder` treat a leading U+FEFF as a byte-order
 * mark and silently remove it. The spec leaves leading content untouched,
 * and a dropped BOM would make the same bytes hash differently than the
 * equivalent string (which never loses its leading byte-order mark) — an
 * F5 violation.
 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidUtf8();
  }
}

/**
 * True if `text` contains a UTF-16 surrogate code unit with no matching
 * partner — i.e. `text` has no UTF-8 encoding at all. A plain JS string
 * can hold these (e.g. `"\uD800"`); `TextEncoder` would silently replace
 * each one with U+FFFD, letting unrelated inputs collide on the same hash.
 *
 * Equivalent to `!text.isWellFormed()` (ES2024), reimplemented by hand so
 * this package doesn't have to raise its `lib` target off ES2022 — see the
 * PR description for why that matters here.
 */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // High surrogate: must be immediately followed by a low surrogate.
      // charCodeAt returns NaN past the end of the string, and every
      // comparison with NaN is false, so that case is checked explicitly
      // rather than relying on the range check to catch it.
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1; // The low surrogate is consumed as part of this pair.
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // A low surrogate reached without first consuming its high surrogate
      // above is, by construction, unpaired.
      return true;
    }
  }
  return false;
}

/** Throws {@link InvalidUtf8} if `text` has no valid UTF-8 encoding. */
function assertWellFormed(text: string): string {
  if (hasUnpairedSurrogate(text)) {
    throw new InvalidUtf8();
  }
  return text;
}

/**
 * Step 2 of the hashing specification: every `\r\n` and every remaining
 * (lone) `\r` becomes `\n`. Uses literal string splitting, not a regex,
 * so it can't accidentally match anything beyond these exact characters.
 */
function normalizeLineEndings(text: string): string {
  return text.split("\r\n").join(LINE_FEED).split(CARRIAGE_RETURN).join(LINE_FEED);
}

/**
 * Removes trailing U+0020 (space) and U+0009 (tab) characters, walking
 * from the end by hand. Deliberately not `trimEnd()`: it also strips other
 * Unicode whitespace (e.g. NBSP, U+00A0), which D3 requires we keep as
 * content.
 */
function stripTrailingSpacesAndTabs(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === SPACE || line[end - 1] === TAB)) {
    end -= 1;
  }
  return line.slice(0, end);
}

/** Step 3: strip trailing spaces and tabs at the end of every line. */
function stripTrailingLineWhitespace(text: string): string {
  return text.split(LINE_FEED).map(stripTrailingSpacesAndTabs).join(LINE_FEED);
}

/**
 * Step 4: strip U+0020, U+0009 and U+000A from the very end of the whole
 * text. By the time this runs, `\r` can no longer appear (step 2 already
 * replaced every occurrence), so only these three characters are in play.
 */
function stripTrailingTextWhitespace(text: string): string {
  let end = text.length;
  while (
    end > 0 &&
    (text[end - 1] === SPACE || text[end - 1] === TAB || text[end - 1] === LINE_FEED)
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Normalizes text per the Hallmarq hashing specification: decode (bytes
 * only), normalize line endings, strip trailing whitespace per line, then
 * strip trailing whitespace from the whole text. Leading whitespace and
 * Unicode normalization form (NFC vs NFD) are left untouched — they're
 * content, not formatting noise.
 */
export function normalizeText(input: string | Uint8Array): string {
  const text = typeof input === "string" ? assertWellFormed(input) : decodeUtf8Strict(input);
  const withUnixNewlines = normalizeLineEndings(text);
  const withoutTrailingLineWhitespace = stripTrailingLineWhitespace(withUnixNewlines);
  return stripTrailingTextWhitespace(withoutTrailingLineWhitespace);
}
