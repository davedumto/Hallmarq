/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildTree,
  getProof,
  hashBytes,
  hashText,
  leafHash,
  nodeHash,
  normalizeText,
} from "./index.js";
import type { Hex } from "./types.js";

interface TextVector {
  name: string;
  input: string;
  normalized: string;
  contentHash: Hex;
}

interface ByteVector {
  name: string;
  inputHex: Hex;
  hash?: Hex;
  hashTextThrows?: string;
  hashBytesResult?: Hex;
}

interface VectorsFile {
  hashing: { text: TextVector[]; bytes: ByteVector[] };
  merkle: {
    abc: {
      contentHashA: Hex;
      contentHashB: Hex;
      contentHashC: Hex;
      leafA: Hex;
      leafB: Hex;
      leafC: Hex;
      nodeAB: Hex;
      root: Hex;
      proofA: Hex[];
      proofC: Hex[];
    };
    single: { contentHash: Hex; root: Hex };
  };
}

// vectors/vectors.json lives at the repo root (D1), shared by every
// package's test suite (D2) — not vendored into any one package.
const vectorsPath = fileURLToPath(new URL("../../../vectors/vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as VectorsFile;

function hexToBytes(hex: Hex): Uint8Array {
  const digits = hex.slice(2);
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("vectors.json: text vectors", () => {
  for (const vector of vectors.hashing.text) {
    it(vector.name, () => {
      expect(normalizeText(vector.input)).toBe(vector.normalized);
      expect(hashText(vector.input)).toBe(vector.contentHash);
      // Bytes input must produce the same hash as string input for the
      // same (valid UTF-8) content.
      expect(hashText(new TextEncoder().encode(vector.input))).toBe(vector.contentHash);
    });
  }
});

describe("vectors.json: byte vectors", () => {
  for (const vector of vectors.hashing.bytes) {
    it(vector.name, () => {
      const bytes = hexToBytes(vector.inputHex);
      if (vector.hash !== undefined) {
        expect(hashBytes(bytes)).toBe(vector.hash);
      }
      if (vector.hashTextThrows !== undefined) {
        expect(() => hashText(bytes)).toThrowError(
          expect.objectContaining({ name: vector.hashTextThrows }),
        );
      }
      if (vector.hashBytesResult !== undefined) {
        expect(hashBytes(bytes)).toBe(vector.hashBytesResult);
      }
    });
  }
});

describe("vectors.json: merkle A/B/C worked example", () => {
  const { abc, single } = vectors.merkle;

  it("content hashes, leaves and the A-B node match the spec", () => {
    expect(hashText("A")).toBe(abc.contentHashA);
    expect(hashText("B")).toBe(abc.contentHashB);
    expect(hashText("C")).toBe(abc.contentHashC);
    expect(leafHash(abc.contentHashA)).toBe(abc.leafA);
    expect(leafHash(abc.contentHashB)).toBe(abc.leafB);
    expect(leafHash(abc.contentHashC)).toBe(abc.leafC);
    expect(nodeHash(abc.leafA, abc.leafB)).toBe(abc.nodeAB);
  });

  it("buildTree reproduces the spec's root and proofs for A and C", () => {
    const tree = buildTree([abc.contentHashA, abc.contentHashB, abc.contentHashC]);
    expect(tree.root).toBe(abc.root);
    expect(getProof(tree, 0)).toEqual(abc.proofA);
    expect(getProof(tree, 2)).toEqual(abc.proofC);
  });

  it("a batch of one has root = leaf", () => {
    const tree = buildTree([single.contentHash]);
    expect(tree.root).toBe(single.root);
  });
});
