import { describe, expect, it } from "vitest";

import { buildTree, getProof, hashText, leafHash, nodeHash, verifyProof } from "./index.js";
import { EmptyBatch, InvalidHex } from "./errors.js";
import type { Hex } from "./types.js";

const A = hashText("A");
const B = hashText("B");
const C = hashText("C");
const D = hashText("D");

describe("leafHash", () => {
  it("is deterministic and distinct from the raw content hash", () => {
    expect(leafHash(A)).toBe(leafHash(A));
    expect(leafHash(A)).not.toBe(A);
  });
});

describe("nodeHash", () => {
  it("sorts its two arguments, so order never matters", () => {
    expect(nodeHash(leafHash(A), leafHash(B))).toBe(nodeHash(leafHash(B), leafHash(A)));
  });

  it("is sensitive to which pair of hashes it's given", () => {
    expect(nodeHash(leafHash(A), leafHash(B))).not.toBe(nodeHash(leafHash(A), leafHash(C)));
  });
});

describe("buildTree", () => {
  it("throws EmptyBatch for zero content hashes", () => {
    expect(() => buildTree([])).toThrow(EmptyBatch);
  });

  it("a batch of one has root = leaf", () => {
    const tree = buildTree([A]);
    expect(tree.root).toBe(leafHash(A));
    expect(tree.layers).toEqual([[leafHash(A)]]);
  });

  it("an even batch pairs every node with no leftover", () => {
    const tree = buildTree([A, B, C, D]);
    expect(tree.layers[0]).toHaveLength(4);
    expect(tree.layers[1]).toHaveLength(2);
    expect(tree.layers[2]).toHaveLength(1);
    expect(tree.root).toBe(tree.layers[2][0]);
  });

  it("an odd node at the end of a layer moves up unchanged", () => {
    const tree = buildTree([A, B, C]);
    // layer 0 has 3 leaves, so layer 1 has 2 nodes: node(leafA, leafB) and
    // leafC moved up unchanged.
    expect(tree.layers[1]).toEqual([nodeHash(leafHash(A), leafHash(B)), leafHash(C)]);
  });

  it("allows duplicate content hashes", () => {
    const tree = buildTree([A, A]);
    expect(tree.root).toBe(nodeHash(leafHash(A), leafHash(A)));
  });
});

describe("getProof / verifyProof", () => {
  it("every leaf's honest proof verifies against the tree's root", () => {
    const hashes = [A, B, C, D];
    const tree = buildTree(hashes);
    hashes.forEach((hash, index) => {
      expect(verifyProof(tree.root, hash, getProof(tree, index))).toBe(true);
    });
  });

  it("rejects a proof that doesn't match the content hash", () => {
    const tree = buildTree([A, B, C]);
    const proofForA = getProof(tree, 0);
    expect(verifyProof(tree.root, B, proofForA)).toBe(false);
  });

  it("rejects a root that was never built from the given proof", () => {
    const tree = buildTree([A, B, C]);
    const otherRoot = buildTree([A, B, D]).root;
    expect(verifyProof(otherRoot, A, getProof(tree, 0))).toBe(false);
  });

  it("getProof throws RangeError for an out-of-range or non-integer index", () => {
    const tree = buildTree([A, B]);
    expect(() => getProof(tree, -1)).toThrow(RangeError);
    expect(() => getProof(tree, 2)).toThrow(RangeError);
    expect(() => getProof(tree, 0.5)).toThrow(RangeError);
  });

  it("second-preimage protection: an inner node can't be verified as if it were a leaf", () => {
    const tree = buildTree([A, B, C, D]);
    const innerNode = tree.layers[1][0]; // node(leafA, leafB)
    const shortenedProof = tree.layers[1].slice(1); // what a leaf at this level would need

    // Passing the inner node's hash as if it were a contentHash, with the
    // proof a leaf at that level would use, must not verify: leafHash
    // prepends 0x00 to it, which never equals the 0x01-prefixed value the
    // tree actually computed for that node.
    expect(verifyProof(tree.root, innerNode, shortenedProof)).toBe(false);
  });

  it("accepts an uppercase-hex root as equal to the lowercase root it computes", () => {
    const tree = buildTree([A, B, C]);
    const proofForA = getProof(tree, 0);
    const uppercaseRoot = tree.root.toUpperCase() as Hex;
    expect(verifyProof(uppercaseRoot, A, proofForA)).toBe(true);
  });
});

describe("hex validation (leafHash / nodeHash / verifyProof)", () => {
  // These simulate a value that *looks* like it satisfies the `Hex` type
  // (it's a string starting with "0x") but isn't actually a valid 32-byte
  // hash — exactly what a receipt file parsed with `JSON.parse` could hand
  // these functions at runtime, with nothing from TypeScript to stop it.
  const notHex = "0xzz" as Hex;
  const tooShort = "0x1234" as Hex;
  const tooLong = ("0x" + "ab".repeat(33)) as Hex;

  it("leafHash throws InvalidHex on malformed or wrongly-sized input", () => {
    expect(() => leafHash(notHex)).toThrow(InvalidHex);
    expect(() => leafHash(tooShort)).toThrow(InvalidHex);
    expect(() => leafHash(tooLong)).toThrow(InvalidHex);
  });

  it("nodeHash throws InvalidHex if either argument is malformed or wrongly sized", () => {
    expect(() => nodeHash(notHex, leafHash(A))).toThrow(InvalidHex);
    expect(() => nodeHash(leafHash(A), tooShort)).toThrow(InvalidHex);
    expect(() => nodeHash(tooLong, leafHash(A))).toThrow(InvalidHex);
  });

  it("verifyProof throws InvalidHex for a malformed root", () => {
    const tree = buildTree([A, B, C]);
    expect(() => verifyProof(notHex, A, getProof(tree, 0))).toThrow(InvalidHex);
  });

  it("verifyProof throws InvalidHex for a malformed contentHash", () => {
    const tree = buildTree([A, B, C]);
    expect(() => verifyProof(tree.root, tooShort, getProof(tree, 0))).toThrow(InvalidHex);
  });

  it("verifyProof throws InvalidHex for a malformed proof element", () => {
    const tree = buildTree([A, B, C]);
    expect(() => verifyProof(tree.root, A, [notHex])).toThrow(InvalidHex);
  });
});
