/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildTree, getProof } from "@hallmarq/core";
import type { Hex } from "@hallmarq/core";
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

interface VectorsFile {
  merkle: {
    abc: {
      contentHashA: Hex;
      contentHashB: Hex;
      contentHashC: Hex;
      root: Hex;
      proofA: Hex[];
      proofC: Hex[];
    };
    single: { contentHash: Hex; root: Hex };
  };
}

// vectors/vectors.json lives at the repo root (D1), shared by every
// package's test suite (D2) — this is the Hardhat-side half of that sharing.
const vectorsPath = fileURLToPath(new URL("../vectors/vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as VectorsFile;

async function deploy() {
  const registry = await ethers.deployContract("StampRegistry");
  return { registry };
}

function flipByte(value: Hex, index: number): Hex {
  const bytes = ethers.getBytes(value);
  bytes[index % bytes.length] ^= 0xff;
  return ethers.hexlify(bytes) as Hex;
}

// Spec D10 / "Testing plan -> Cross-check": the A/B/C worked example is
// published in the spec and recomputed in vectors/vectors.json; this is the
// test that finally checks those values against the contract itself, not
// just against @hallmarq/core's own Merkle code.
describe("Cross-check: spec's A/B/C worked example against the contract (D10)", () => {
  const { abc, single } = vectors.merkle;

  it("verifyInBatch accepts the published proofs for A and C exactly as written in vectors.json", async () => {
    const { registry } = await deploy();

    await registry.stampRoot(abc.root, 3, "model");

    expect(await registry.verifyInBatch(abc.root, abc.contentHashA, abc.proofA)).to.equal(true);
    expect(await registry.verifyInBatch(abc.root, abc.contentHashC, abc.proofC)).to.equal(true);
  });

  it("B's proof, built fresh from @hallmarq/core's getProof, also verifies", async () => {
    const { registry } = await deploy();

    await registry.stampRoot(abc.root, 3, "model");

    const tree = buildTree([abc.contentHashA, abc.contentHashB, abc.contentHashC]);
    expect(tree.root).to.equal(abc.root);

    const proofB = getProof(tree, 1);
    expect(await registry.verifyInBatch(abc.root, abc.contentHashB, proofB)).to.equal(true);
  });

  it("a wrong proof is rejected: A's proof used for C, and A's proof with one byte flipped", async () => {
    const { registry } = await deploy();

    await registry.stampRoot(abc.root, 3, "model");

    expect(await registry.verifyInBatch(abc.root, abc.contentHashC, abc.proofA)).to.equal(false);

    const tamperedProofA = [flipByte(abc.proofA[0], 0), abc.proofA[1]];
    expect(await registry.verifyInBatch(abc.root, abc.contentHashA, tamperedProofA)).to.equal(
      false,
    );
  });

  it("a batch of one (vectors.json's merkle.single) verifies with an empty proof", async () => {
    const { registry } = await deploy();

    await registry.stampRoot(single.root, 1, "model");

    expect(await registry.verifyInBatch(single.root, single.contentHash, [])).to.equal(true);
  });
});
