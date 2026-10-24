import { describe, expect, it } from "vitest";

import { InvalidUtf8 } from "./errors.js";
import { normalizeText } from "./normalize.js";

describe("normalizeText", () => {
  it("decodes valid UTF-8 bytes the same way as the equivalent string", () => {
    const text = "Hello, StampAI.";
    const bytes = new TextEncoder().encode(text);
    expect(normalizeText(bytes)).toBe(normalizeText(text));
  });

  it("throws InvalidUtf8 for a truncated multi-byte sequence", () => {
    // 0xE2 0x82 starts a 3-byte sequence (e.g. U+20AC) but is cut short.
    const truncated = new Uint8Array([0xe2, 0x82]);
    expect(() => normalizeText(truncated)).toThrow(InvalidUtf8);
  });

  it("throws InvalidUtf8 for an overlong encoding", () => {
    // 0xC0 0x80 is an overlong (invalid) encoding of NUL.
    const overlong = new Uint8Array([0xc0, 0x80]);
    expect(() => normalizeText(overlong)).toThrow(InvalidUtf8);
  });

  it("collapses every CRLF and every lone CR to LF, in the same pass", () => {
    expect(normalizeText("a\r\nb\rc\r\nd")).toBe("a\nb\nc\nd");
  });

  it("strips only trailing ASCII space and tab per line, not other whitespace", () => {
    expect(normalizeText("a \t \nb")).toBe("a\nb");
  });

  it("keeps NBSP (U+00A0) and other Unicode whitespace, trailing or not", () => {
    const withNbsp = "a  \nb ";
    // Trailing ASCII space after the NBSP on line 1 is stripped; the NBSP
    // itself, and the trailing NBSP on line 2 (now the end of the text),
    // are both kept.
    expect(normalizeText(withNbsp)).toBe("a \nb ");
  });

  it("keeps leading whitespace untouched", () => {
    expect(normalizeText("  \t a")).toBe("  \t a");
  });

  it("does not apply Unicode normalization (NFC and NFD stay distinct)", () => {
    const nfc = "café";
    const nfd = "café";
    expect(normalizeText(nfc)).toBe(nfc);
    expect(normalizeText(nfd)).toBe(nfd);
    expect(nfc).not.toBe(nfd);
  });

  it("normalizes empty and whitespace-only text to the empty string", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   \t\n  ")).toBe("");
  });

  it("does not use trim()/trimEnd() semantics: NBSP survives at the very end", () => {
    // A naive trimEnd() implementation would strip this; ours must not.
    expect(normalizeText("hi ")).toBe("hi ");
    expect(normalizeText("hi ").trimEnd()).not.toBe("hi ");
  });
});
