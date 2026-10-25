/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Hex } from "@hallmarq/core";
import { describe, expect, it } from "vitest";

import { canonicalJsonStringify } from "./canonicalJson.js";
import { hashBytes, hashText } from "./index.js";

interface TextVector {
  name: string;
  input: string;
  normalized: string;
  contentHash: Hex;
}

interface MetaVector {
  value: Record<string, unknown>;
  canonical: string;
  metaHash: Hex;
}

interface VectorsFile {
  hashing: { text: TextVector[] };
  meta: MetaVector;
}

// vectors/vectors.json lives at the repo root (D1), shared by every
// package's test suite (D2) — not vendored into this package.
const vectorsPath = fileURLToPath(new URL("../../../vectors/vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as VectorsFile;

describe("vectors.json: text vectors through the SDK's re-exported hashText", () => {
  for (const vector of vectors.hashing.text) {
    it(vector.name, () => {
      expect(hashText(vector.input)).toBe(vector.contentHash);
    });
  }
});

describe("vectors.json: meta vector", () => {
  it("canonicalJsonStringify and hashBytes reproduce the shared meta vector", () => {
    const canonical = canonicalJsonStringify(vectors.meta.value);
    expect(canonical).toBe(vectors.meta.canonical);
    expect(hashBytes(new TextEncoder().encode(canonical))).toBe(vectors.meta.metaHash);
  });
});
