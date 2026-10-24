import { buildTree, getProof } from "@hallmarq/core";
import type { Hex, MerkleTree } from "@hallmarq/core";
import { expect } from "chai";
import * as fc from "fast-check";
import { network } from "hardhat";

const { ethers } = await network.create();

function hex(value: string): Hex {
  return value as Hex;
}

function flipByte(value: Hex, rawIndex: number): Hex {
  const bytes = ethers.getBytes(value);
  const index = rawIndex % bytes.length;
  bytes[index] ^= 0xff;
  return hex(ethers.hexlify(bytes));
}

/**
 * The sibling hashes from `(layer, index)` up to the root — like
 * `@hallmarq/core`'s `getProof`, but starting above the leaf layer, for the
 * second-preimage check (f): an inner node's own "proof" to the root.
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

async function deploy() {
  const registry = await ethers.deployContract("StampRegistry");
  return { registry };
}

// Fixed so CI is deterministic; on a failure fast-check also prints the
// seed and the shrunk counterexample's path, which reproduces it exactly
// regardless of this value (see "How it was tested" in the PR description).
const FAST_CHECK_SEED = 20261024;

const contentHashArb: fc.Arbitrary<Hex> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => hex(ethers.hexlify(bytes)));

// fast-check v4's default `size` caps generated array lengths well below
// `maxLength` regardless of what `maxLength` says (12 at most for this
// arbitrary), so the spec's "1 to 500" range was never actually being
// generated. `size: "max"` makes `maxLength` the real ceiling; mixing in a
// small-only arbitrary via `oneof` keeps low leaf counts (1-12) — where
// tree-shape edge cases like odd-node promotion live — from being drowned
// out by the much larger average size `size: "max"` produces.
const contentHashesArb = fc.oneof(
  fc.array(contentHashArb, { minLength: 1, maxLength: 20 }),
  fc.array(contentHashArb, { minLength: 1, maxLength: 500, size: "max" }),
);

describe("StampRegistry property tests (spec: Testing plan -> Contract property)", () => {
  it("every honest proof verifies, and every tampered input is rejected", async function () {
    this.timeout(150_000);
    const { registry } = await deploy();

    const stampedRoots = new Set<Hex>();
    let previousRoot: Hex | undefined;

    const sizes: number[] = [];

    console.log(`fast-check seed: ${FAST_CHECK_SEED}`);
    const start = Date.now();

    await fc.assert(
      fc.asyncProperty(
        contentHashesArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        async (
          contentHashes,
          rawLeafIndex,
          rawProofElementIndex,
          rawByteIndex,
          rawInnerLayerIndex,
        ) => {
          const tree = buildTree(contentHashes);

          // Skip (don't fail) if this exact root was already stamped by an
          // earlier run — astronomically unlikely by chance, but fast-check's
          // shrinking can revisit inputs.
          fc.pre(!stampedRoots.has(tree.root));
          stampedRoots.add(tree.root);

          const n = contentHashes.length;
          sizes.push(n);
          await registry.stampRoot(tree.root, n, "model");

          const randomIndex = rawLeafIndex % n;
          const randomLeafProof = getProof(tree, randomIndex);

          // (a) honest proofs verify: first, last, and one random leaf.
          for (const index of new Set([0, n - 1, randomIndex])) {
            const proof = getProof(tree, index);
            expect(await registry.verifyInBatch(tree.root, contentHashes[index], proof)).to.equal(
              true,
            );
          }

          // (b) flipping one byte of one proof element -> false.
          if (randomLeafProof.length > 0) {
            const elementIndex = rawProofElementIndex % randomLeafProof.length;
            const tamperedProof = [...randomLeafProof];
            tamperedProof[elementIndex] = flipByte(tamperedProof[elementIndex], rawByteIndex);
            expect(
              await registry.verifyInBatch(tree.root, contentHashes[randomIndex], tamperedProof),
            ).to.equal(false);
          }

          // (c) flipping one byte of the content hash -> false.
          const tamperedHash = flipByte(contentHashes[randomIndex], rawByteIndex);
          expect(await registry.verifyInBatch(tree.root, tamperedHash, randomLeafProof)).to.equal(
            false,
          );

          // (d) a valid proof checked against a different, already-stamped
          // root -> false.
          if (previousRoot !== undefined) {
            expect(
              await registry.verifyInBatch(
                previousRoot,
                contentHashes[randomIndex],
                randomLeafProof,
              ),
            ).to.equal(false);
          }

          // (e) a root that was never stamped -> false.
          const neverStampedRoot = hex(ethers.id(`never-stamped:${tree.root}`));
          if (!stampedRoots.has(neverStampedRoot)) {
            expect(
              await registry.verifyInBatch(
                neverStampedRoot,
                contentHashes[randomIndex],
                randomLeafProof,
              ),
            ).to.equal(false);
          }

          // (f) second preimage: an inner node (tree.layers[1] or higher)
          // passed as the contentHash, with the proof shortened to start
          // from that layer instead of the leaf layer -> false. Picks a
          // random inner layer, not always the one just above the leaves,
          // so this also exercises nodes several levels up in deep trees.
          // Only meaningful once there's a real inner layer distinct from
          // both the leaves and the root.
          if (tree.layers.length >= 3) {
            const innerLayerCount = tree.layers.length - 2;
            const layer = 1 + (rawInnerLayerIndex % innerLayerCount);
            const innerLayer = tree.layers[layer];
            const innerIndex = rawLeafIndex % innerLayer.length;
            const innerNode = innerLayer[innerIndex];
            const shortenedProof = getProofFromLayer(tree, layer, innerIndex);
            expect(await registry.verifyInBatch(tree.root, innerNode, shortenedProof)).to.equal(
              false,
            );
          }

          // (g) for trees with 3+ levels, reversing a (2+ element) proof's
          // order -> false.
          if (tree.layers.length >= 3 && randomLeafProof.length >= 2) {
            const reversedProof = [...randomLeafProof].reverse();
            expect(
              await registry.verifyInBatch(tree.root, contentHashes[randomIndex], reversedProof),
            ).to.equal(false);
          }

          previousRoot = tree.root;
        },
      ),
      { numRuns: 1000, seed: FAST_CHECK_SEED },
    );

    const over100 = sizes.filter((n) => n > 100).length;
    const mean = sizes.reduce((sum, n) => sum + n, 0) / sizes.length;
    console.log(
      `fast-check: ${sizes.length} runs in ${Date.now() - start}ms; ` +
        `leaf count min ${Math.min(...sizes)}, max ${Math.max(...sizes)}, ` +
        `mean ${mean.toFixed(1)}, runs with >100 leaves: ${over100}`,
    );
  });
});
