import { expect } from "chai";
import type { ContractTransactionResponse, EventLog, Log } from "ethers";
import { network } from "hardhat";

const { ethers } = await network.create();

const ZERO_HASH = ethers.ZeroHash;

/** `keccak256(0x00 || contentHash)` — matches the contract's leaf prefix. */
function leafHash(contentHash: string): string {
  return ethers.keccak256(ethers.concat(["0x00", contentHash]));
}

/** `keccak256(0x01 || min || max)` — matches the contract's sorted-pair node prefix. */
function nodeHash(a: string, b: string): string {
  const [low, high] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat(["0x01", low, high]));
}

async function deploy() {
  const [alice, bob] = await ethers.getSigners();
  const registry = await ethers.deployContract("StampRegistry");
  return { registry, alice, bob };
}

type Registry = Awaited<ReturnType<typeof deploy>>["registry"];

/** Finds and decodes the first log named `eventName` in `logs`, using `registry`'s ABI. */
function findEvent(registry: Registry, logs: readonly (EventLog | Log)[], eventName: string) {
  for (const log of logs) {
    const parsed = registry.interface.parseLog(log);
    if (parsed?.name === eventName) return parsed;
  }
  return null;
}

async function blockTimestamp(txResponse: ContractTransactionResponse): Promise<bigint> {
  const receipt = await txResponse.wait();
  if (!receipt) throw new Error("transaction was not mined");
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("block not found");
  return BigInt(block.timestamp);
}

describe("StampRegistry", () => {
  describe("stamp / verify", () => {
    it("stamps a content hash and verify returns every field", async () => {
      const { registry, alice } = await deploy();
      const contentHash = ethers.id("content-A");
      const metaHash = ethers.id("meta-A");
      const model = "gpt-4o";

      const tx = await registry.stamp(contentHash, model, metaHash);
      const timestamp = await blockTimestamp(tx);

      const record = await registry.verify(contentHash);
      expect(record.registrant).to.equal(alice.address);
      expect(record.timestamp).to.equal(timestamp);
      expect(record.metaHash).to.equal(metaHash);
      expect(record.model).to.equal(model);
    });

    it("emits Stamped with every field, including the timestamp", async () => {
      const { registry, alice } = await deploy();
      const contentHash = ethers.id("content-emit");
      const metaHash = ethers.id("meta-emit");
      const model = "gpt-4o";

      const tx = await registry.stamp(contentHash, model, metaHash);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("transaction was not mined");
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const parsed = findEvent(registry, receipt.logs, "Stamped");
      expect(parsed, "Stamped event was not emitted").to.not.equal(null);
      expect(parsed!.args.contentHash).to.equal(contentHash);
      expect(parsed!.args.registrant).to.equal(alice.address);
      expect(parsed!.args.model).to.equal(model);
      expect(parsed!.args.timestamp).to.equal(BigInt(block.timestamp));
    });

    it("reverts with EmptyHash when contentHash is the zero hash", async () => {
      const { registry } = await deploy();
      await expect(registry.stamp(ZERO_HASH, "model", ZERO_HASH)).to.be.revertedWithCustomError(
        registry,
        "EmptyHash",
      );
    });

    it("accepts an empty model string (spec allows a zero-length model label)", async () => {
      const { registry, alice } = await deploy();
      const contentHash = ethers.id("content-empty-model");

      await registry.stamp(contentHash, "", ZERO_HASH);

      const record = await registry.verify(contentHash);
      expect(record.registrant).to.equal(alice.address);
      expect(record.model).to.equal("");
    });

    it("accepts a model label of exactly 64 ASCII bytes", async () => {
      const { registry } = await deploy();
      const model = "a".repeat(64);
      expect(Buffer.byteLength(model, "utf8")).to.equal(64);

      await expect(registry.stamp(ethers.id("content-64-ascii"), model, ZERO_HASH)).to.not.revert(
        ethers,
      );
    });

    it("reverts with ModelTooLong for a model label of 65 ASCII bytes", async () => {
      const { registry } = await deploy();
      const model = "a".repeat(65);
      expect(Buffer.byteLength(model, "utf8")).to.equal(65);

      await expect(
        registry.stamp(ethers.id("content-65-ascii"), model, ZERO_HASH),
      ).to.be.revertedWithCustomError(registry, "ModelTooLong");
    });

    it("accepts a multi-byte UTF-8 model label of exactly 64 bytes", async () => {
      const { registry } = await deploy();
      // "é" ("e" with an acute accent) is 2 bytes in UTF-8; 32 copies is
      // exactly 64 bytes, well under the 64-character length a naive
      // (JS-string-length) check would also have allowed.
      const model = "é".repeat(32);
      expect(Buffer.byteLength(model, "utf8")).to.equal(64);

      await expect(registry.stamp(ethers.id("content-64-utf8"), model, ZERO_HASH)).to.not.revert(
        ethers,
      );
    });

    it("reverts with ModelTooLong for a multi-byte UTF-8 model label of 65 bytes", async () => {
      const { registry } = await deploy();
      // 32 copies of the 2-byte "é" (64 bytes) plus one ASCII byte is 65
      // bytes in UTF-8, over the limit — this is the byte-length check
      // rejecting input a character-length check would have accepted.
      const model = "é".repeat(32) + "a";
      expect(Buffer.byteLength(model, "utf8")).to.equal(65);

      await expect(
        registry.stamp(ethers.id("content-65-utf8"), model, ZERO_HASH),
      ).to.be.revertedWithCustomError(registry, "ModelTooLong");
    });

    it("reverts with AlreadyStamped(contentHash) on a repeat stamp, asserting the argument", async () => {
      const { registry } = await deploy();
      const contentHash = ethers.id("content-repeat");

      await registry.stamp(contentHash, "model-1", ZERO_HASH);

      await expect(registry.stamp(contentHash, "model-2", ZERO_HASH))
        .to.be.revertedWithCustomError(registry, "AlreadyStamped")
        .withArgs(contentHash);
    });

    it("a different signer cannot overwrite another signer's stamp", async () => {
      const { registry, alice, bob } = await deploy();
      const contentHash = ethers.id("content-contested");

      await registry.stamp(contentHash, "alice-model", ZERO_HASH);

      const asBob = registry.connect(bob) as Registry;
      await expect(asBob.stamp(contentHash, "bob-model", ZERO_HASH)).to.be.revertedWithCustomError(
        registry,
        "AlreadyStamped",
      );

      const record = await registry.verify(contentHash);
      expect(record.registrant).to.equal(alice.address);
      expect(record.model).to.equal("alice-model");
    });

    it("verify on an unknown hash returns a zero registrant and every other field zeroed", async () => {
      const { registry } = await deploy();
      const record = await registry.verify(ethers.id("never-stamped"));
      expect(record.registrant).to.equal(ethers.ZeroAddress);
      expect(record.timestamp).to.equal(0n);
      expect(record.metaHash).to.equal(ZERO_HASH);
      expect(record.model).to.equal("");
    });
  });

  describe("stampRoot / getBatch", () => {
    it("stamps a root and getBatch returns every field", async () => {
      const { registry, alice } = await deploy();
      const root = ethers.id("root-A");
      const model = "gpt-4o";
      const count = 10;

      const tx = await registry.stampRoot(root, count, model);
      const timestamp = await blockTimestamp(tx);

      const batch = await registry.getBatch(root);
      expect(batch.registrant).to.equal(alice.address);
      expect(batch.timestamp).to.equal(timestamp);
      expect(batch.count).to.equal(count);
      expect(batch.model).to.equal(model);
    });

    it("emits BatchStamped with every field, including the timestamp", async () => {
      const { registry, alice } = await deploy();
      const root = ethers.id("root-emit");
      const model = "gpt-4o";
      const count = 7;

      const tx = await registry.stampRoot(root, count, model);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("transaction was not mined");
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const parsed = findEvent(registry, receipt.logs, "BatchStamped");
      expect(parsed, "BatchStamped event was not emitted").to.not.equal(null);
      expect(parsed!.args.root).to.equal(root);
      expect(parsed!.args.registrant).to.equal(alice.address);
      expect(parsed!.args.count).to.equal(count);
      expect(parsed!.args.model).to.equal(model);
      expect(parsed!.args.timestamp).to.equal(BigInt(block.timestamp));
    });

    it("reverts with EmptyHash when root is the zero hash", async () => {
      const { registry } = await deploy();
      await expect(registry.stampRoot(ZERO_HASH, 1, "model")).to.be.revertedWithCustomError(
        registry,
        "EmptyHash",
      );
    });

    it("reverts with EmptyBatch when count is zero", async () => {
      const { registry } = await deploy();
      await expect(
        registry.stampRoot(ethers.id("root-empty-batch"), 0, "model"),
      ).to.be.revertedWithCustomError(registry, "EmptyBatch");
    });

    it("accepts a model label of exactly 64 bytes", async () => {
      const { registry } = await deploy();
      const model = "a".repeat(64);
      expect(Buffer.byteLength(model, "utf8")).to.equal(64);

      await expect(registry.stampRoot(ethers.id("root-model-64-bytes"), 1, model)).to.not.revert(
        ethers,
      );
    });

    it("reverts with ModelTooLong for a model label of 65 bytes", async () => {
      const { registry } = await deploy();
      const model = "a".repeat(65);
      await expect(
        registry.stampRoot(ethers.id("root-model-too-long"), 1, model),
      ).to.be.revertedWithCustomError(registry, "ModelTooLong");
    });

    it("reverts with AlreadyStamped(root) on a repeat root, asserting the argument", async () => {
      const { registry } = await deploy();
      const root = ethers.id("root-repeat");

      await registry.stampRoot(root, 5, "model-1");

      await expect(registry.stampRoot(root, 9, "model-2"))
        .to.be.revertedWithCustomError(registry, "AlreadyStamped")
        .withArgs(root);
    });

    it("accepts count = 2**32 - 1", async () => {
      const { registry } = await deploy();
      const root = ethers.id("root-max-count");
      const maxCount = 2 ** 32 - 1;

      await registry.stampRoot(root, maxCount, "model");

      const batch = await registry.getBatch(root);
      expect(batch.count).to.equal(maxCount);
    });
  });

  describe("namespace separation", () => {
    it("a hash stamped alone is not found by verifyInBatch", async () => {
      const { registry } = await deploy();
      const contentHash = ethers.id("solo-stamp");

      await registry.stamp(contentHash, "model", ZERO_HASH);

      // _batches[contentHash] was never set, even though _stamps[contentHash] was.
      expect(await registry.verifyInBatch(contentHash, contentHash, [])).to.equal(false);
    });

    it("a stamped root is not found by verify", async () => {
      const { registry } = await deploy();
      const root = ethers.id("solo-root");

      await registry.stampRoot(root, 1, "model");

      // _stamps[root] was never set, even though _batches[root] was.
      const record = await registry.verify(root);
      expect(record.registrant).to.equal(ethers.ZeroAddress);
    });
  });

  describe("verifyInBatch", () => {
    it("returns false when the root was never stamped", async () => {
      const { registry } = await deploy();
      const unknownRoot = ethers.id("never-stamped-root");
      expect(await registry.verifyInBatch(unknownRoot, ethers.id("some-content"), [])).to.equal(
        false,
      );
    });

    it("returns true for a leaf reconstructed from a valid sibling proof", async () => {
      const { registry } = await deploy();
      const contentHashA = ethers.id("batch-content-A");
      const contentHashB = ethers.id("batch-content-B");
      const leafA = leafHash(contentHashA);
      const leafB = leafHash(contentHashB);
      const root = nodeHash(leafA, leafB);

      await registry.stampRoot(root, 2, "model");

      expect(await registry.verifyInBatch(root, contentHashA, [leafB])).to.equal(true);
      expect(await registry.verifyInBatch(root, contentHashB, [leafA])).to.equal(true);
    });

    it("returns false for a leaf paired with an unrelated sibling proof", async () => {
      const { registry } = await deploy();
      const contentHashA = ethers.id("batch-content-C");
      const contentHashB = ethers.id("batch-content-D");
      const unrelatedLeaf = leafHash(ethers.id("batch-content-unrelated"));
      const root = nodeHash(leafHash(contentHashA), leafHash(contentHashB));

      await registry.stampRoot(root, 2, "model");

      expect(await registry.verifyInBatch(root, contentHashA, [unrelatedLeaf])).to.equal(false);
    });

    it("a batch of one has root = leafHash(contentHash) and an empty proof verifies", async () => {
      const { registry } = await deploy();
      const contentHash = ethers.id("batch-of-one");
      const root = leafHash(contentHash);

      await registry.stampRoot(root, 1, "model");

      expect(await registry.verifyInBatch(root, contentHash, [])).to.equal(true);
    });
  });
});
