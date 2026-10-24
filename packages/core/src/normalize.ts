import { InvalidUtf8 } from "./errors.js";

const SPACE = " ";
const TAB = "\t";
const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";

/**
 * Decodes bytes as strict UTF-8, throwing {@link InvalidUtf8} on anything
 * that isn't. `TextDecoder` is a Web API available in both Node and
 * browsers, so this has no platform-specific dependency.
 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidUtf8();
  }
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
  const text = typeof input === "string" ? input : decodeUtf8Strict(input);
  const withUnixNewlines = normalizeLineEndings(text);
  const withoutTrailingLineWhitespace = stripTrailingLineWhitespace(withUnixNewlines);
  return stripTrailingTextWhitespace(withoutTrailingLineWhitespace);
}
