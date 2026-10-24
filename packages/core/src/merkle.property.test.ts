import { array, assert, nat, property, uint8Array } from "fast-check";
import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "./bytes.js";
import { buildTree, getProof, type MerkleTree, verifyProof } from "./merkle.js";
import type { Hex } from "./types.js";

const hexHashArb = uint8Array({ minLength: 32, maxLength: 32 }).map(toHex);
const hashesArb = array(hexHashArb, { minLength: 1, maxLength: 500 });

function flipOneBit(hex: Hex): Hex {
  const bytes = fromHex(hex);
  bytes[0] = bytes[0] ^ 0x01;
  return toHex(bytes);
}

/**
 * Test-only helper: the proof a node at `(layer, index)` — not necessarily
 * a leaf — would need to reach the root. Mirrors `getProof`'s walk, just
 * starting above the leaves, so the second-preimage test below can exercise
 * a real inner node from a randomly shaped tree.
 */
function getProofFromLayer(tree: MerkleTree, layer: number, index: number): Hex[] {
  const proof: Hex[] = [];
  let i = index;
  for (let level = layer; level < tree.layers.length - 1; level++) {
    const currentLayer = tree.layers[level];
    const siblingIndex = i % 2 === 0 ? i + 1 : i - 1;
    if (siblingIndex < currentLayer.length) {
      proof.push(currentLayer[siblingIndex]);
    }
    i = Math.floor(i / 2);
  }
  return proof;
}

describe("Merkle tree properties (fast-check)", () => {
  it("every leaf's honest proof verifies, for random batches of 1-500 items", () => {
    assert(
      property(hashesArb, (hashes) => {
        const tree = buildTree(hashes);
        for (let index = 0; index < hashes.length; index++) {
          expect(verifyProof(tree.root, hashes[index], getProof(tree, index))).toBe(true);
        }
      }),
    );
  });

  it("flipping one bit in the root, the leaf, or a proof element breaks verification", () => {
    assert(
      property(hashesArb, nat(), (hashes, seed) => {
        const tree = buildTree(hashes);
        const index = seed % hashes.length;
        const contentHash = hashes[index];
        const proof = getProof(tree, index);

        expect(verifyProof(flipOneBit(tree.root), contentHash, proof)).toBe(false);
        expect(verifyProof(tree.root, flipOneBit(contentHash), proof)).toBe(false);

        // A batch of one has an empty proof — nothing to flip there.
        if (proof.length > 0) {
          const flippedProof = [...proof];
          flippedProof[0] = flipOneBit(flippedProof[0]);
          expect(verifyProof(tree.root, contentHash, flippedProof)).toBe(false);
        }
      }),
    );
  });

  it("second-preimage: an inner node never verifies as if it were a leaf's contentHash", () => {
    assert(
      property(array(hexHashArb, { minLength: 2, maxLength: 500 }), (hashes) => {
        const tree = buildTree(hashes);
        const innerNode = tree.layers[1][0];
        const shortenedProof = getProofFromLayer(tree, 1, 0);
        expect(verifyProof(tree.root, innerNode, shortenedProof)).toBe(false);
      }),
    );
  });
});
