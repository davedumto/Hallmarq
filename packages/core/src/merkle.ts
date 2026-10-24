import { concatBytes, fromHex } from "./bytes.js";
import { EmptyBatch } from "./errors.js";
import { hashBytes } from "./hash.js";
import type { Hex } from "./types.js";

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** One built Merkle tree: every layer from the leaves up to the root. */
export interface MerkleTree {
  readonly root: Hex;
  /** `layers[0]` is the leaves; the last layer is `[root]`. */
  readonly layers: readonly Hex[][];
}

/** `keccak256(0x00 || contentHash)`. The `0x00` prefix marks this as a leaf. */
export function leafHash(contentHash: Hex): Hex {
  return hashBytes(concatBytes(LEAF_PREFIX, fromHex(contentHash)));
}

/**
 * `keccak256(0x01 || min(a, b) || max(a, b))`, comparing `a` and `b` as
 * 256-bit unsigned integers. The `0x01` prefix marks this as an inner
 * node — distinct from a leaf's `0x00` prefix, which is what stops an
 * inner node from ever being mistaken for (or substituted as) a leaf.
 * Sorting the pair means callers never need to track left/right.
 */
export function nodeHash(a: Hex, b: Hex): Hex {
  const [low, high] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return hashBytes(concatBytes(NODE_PREFIX, fromHex(low), fromHex(high)));
}

/**
 * Builds a Merkle tree over `contentHashes`. An odd node at the end of a
 * layer moves up unchanged. A batch of one has `root = leafHash(contentHashes[0])`.
 * Duplicate content hashes are allowed. Throws {@link EmptyBatch} on empty input.
 */
export function buildTree(contentHashes: readonly Hex[]): MerkleTree {
  if (contentHashes.length === 0) {
    throw new EmptyBatch();
  }

  const leaves = contentHashes.map(leafHash);
  const layers: Hex[][] = [leaves];

  let currentLayer = leaves;
  while (currentLayer.length > 1) {
    const nextLayer: Hex[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const hasPair = i + 1 < currentLayer.length;
      nextLayer.push(hasPair ? nodeHash(currentLayer[i], currentLayer[i + 1]) : currentLayer[i]);
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

/**
 * The sibling hashes from leaf `index` up to the root, in order — exactly
 * what {@link verifyProof} (and the contract's `verifyInBatch`) expect.
 */
export function getProof(tree: MerkleTree, index: number): Hex[] {
  const leafCount = tree.layers[0].length;
  if (!Number.isInteger(index) || index < 0 || index >= leafCount) {
    throw new RangeError(`index ${index} is out of range for a tree with ${leafCount} leaves`);
  }

  const proof: Hex[] = [];
  let i = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const siblingIndex = i % 2 === 0 ? i + 1 : i - 1;
    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
    }
    i = Math.floor(i / 2);
  }
  return proof;
}

/**
 * Recomputes the root from `contentHash` and `proof` and compares it
 * against `root`. Always hashes `contentHash` as a leaf first (`0x00`
 * prefix), so passing an inner node's hash as `contentHash` can never
 * verify, even with a shortened proof — the domain separation blocks the
 * second-preimage forgery this guards against.
 */
export function verifyProof(root: Hex, contentHash: Hex, proof: readonly Hex[]): boolean {
  let computed = leafHash(contentHash);
  for (const sibling of proof) {
    computed = nodeHash(computed, sibling);
  }
  return computed === root;
}
