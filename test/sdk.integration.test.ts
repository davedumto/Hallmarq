import { createServer } from "node:http";

import { buildTree, getProof, hashText } from "@hallmarq/core";
import { AlreadyStamped, Hallmarq } from "@hallmarq/sdk";
import type { BatchReceipt, Receipt, VerifyResult } from "@hallmarq/sdk";
import { expect } from "chai";
import { Wallet, type Signer } from "ethers";
import { network } from "hardhat";

const connection = await network.create();
const { ethers } = connection;

/**
 * Hardhat's in-process network has no real listening RPC endpoint — only
 * the in-process EIP-1193 `connection.provider.request(...)`. A `Hallmarq`
 * constructed without a `signer` has no provider to borrow and falls back
 * to `new JsonRpcProvider(rpcUrl)`, which needs a real URL to connect to.
 * This starts a tiny local JSON-RPC-over-HTTP server that forwards every
 * request straight to `connection.provider`, so the SDK's "no signer"
 * path can be exercised against the same in-process chain as every other
 * test in this file, instead of needing a second, separately-started
 * Hardhat node.
 */
async function startRpcBridge(): Promise<{ url: string; close: () => Promise<void> }> {
  interface JsonRpcRequest {
    readonly id: unknown;
    readonly method: string;
    readonly params?: unknown[];
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      void (async () => {
        const parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        const responses = await Promise.all(
          requests.map(async ({ id, method, params }) => {
            try {
              const result = await connection.provider.request({ method, params: params ?? [] });
              return { jsonrpc: "2.0", id, result };
            } catch (error) {
              const { code, message, data } = error as {
                code?: number;
                message?: string;
                data?: unknown;
              };
              return {
                jsonrpc: "2.0",
                id,
                error: { code: code ?? -32000, message: message ?? String(error), data },
              };
            }
          }),
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind the local RPC bridge");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    // An open listening server keeps the process (and `hardhat test`) alive
    // indefinitely, so every test run must close it once done.
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const bridge = await startRpcBridge();
const rpcUrl = bridge.url;

after(async () => {
  await bridge.close();
});

async function deploy() {
  const [alice, bob] = await ethers.getSigners();
  const registry = await ethers.deployContract("StampRegistry");
  const registryAddress = await registry.getAddress();
  const { chainId } = await ethers.provider.getNetwork();
  const deploymentBlock = await ethers.provider.getBlockNumber();
  return { registry, registryAddress, chainId: Number(chainId), deploymentBlock, alice, bob };
}

function makeHallmarq(options: {
  registryAddress: string;
  chainId: number;
  deploymentBlock: number;
  signer?: Signer;
  confirmations?: number;
  confirmTimeoutMs?: number;
  batch?: { maxItems?: number; maxWaitMs?: number };
}): Hallmarq {
  return new Hallmarq({
    // Unused when `signer` has its own provider (every write-path test
    // here); only the no-signer, read-only tests actually dial out to it.
    rpcUrl,
    chainId: options.chainId,
    registryAddress: options.registryAddress,
    deploymentBlock: options.deploymentBlock,
    signer: options.signer,
    // Automine mines exactly one block per transaction, i.e. one
    // confirmation; the default of 2 would wait out the full
    // confirmTimeoutMs on every test that doesn't mine an extra block
    // itself. The dedicated "2 confirmations" test overrides this.
    confirmations: options.confirmations ?? 1,
    confirmTimeoutMs: options.confirmTimeoutMs,
    batch: options.batch,
  });
}

describe("SDK integration (Hallmarq against a real deployed StampRegistry)", () => {
  it("stamp then verify round-trip: every field matches what was sent and mined", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({
      registryAddress,
      chainId,
      deploymentBlock,
      signer: alice,
      confirmations: 1,
    });

    const content = "integration: stamp then verify";
    const receipt: Receipt = await hallmarq.stamp(content, {
      model: "gpt-4o",
      meta: { reviewed: true },
    });

    expect(receipt.contentHash).to.equal(hashText(content));
    expect(receipt.registrant).to.equal(await alice.getAddress());
    expect(receipt.model).to.equal("gpt-4o");
    expect(receipt.txHash).to.be.a("string");
    expect(receipt.blockNumber).to.be.a("number");

    const result: VerifyResult = await hallmarq.verify(content);
    expect(result.status).to.equal("found");
    if (result.status !== "found") throw new Error("expected status 'found'");
    expect(result.contentHash).to.equal(receipt.contentHash);
    expect(result.registrant).to.equal(receipt.registrant);
    expect(result.model).to.equal(receipt.model);
    expect(result.blockNumber).to.equal(receipt.blockNumber);
    expect(result.txHash).to.equal(receipt.txHash);
    expect(result.timestamp).to.be.a("number");
  });

  it("AlreadyStamped from the preflight: a second stamp of the same content never sends a transaction", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer: alice });
    const content = "integration: already stamped";

    await hallmarq.stamp(content, { model: "gpt-4o" });

    let error: unknown;
    try {
      await hallmarq.stamp(content, { model: "gpt-4o" });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).name).to.equal("AlreadyStamped");
    expect((error as { contentHash?: unknown }).contentHash).to.equal(hashText(content));
  });

  it("verify returns not-found for content that was never stamped", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock });

    const result = await hallmarq.verify("integration: never stamped");
    expect(result.status).to.equal("not-found");
  });

  it("verify works with no signer configured (read-only)", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const writer = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer: alice });
    const content = "integration: verify with no signer";
    await writer.stamp(content, { model: "gpt-4o" });

    const reader = makeHallmarq({ registryAddress, chainId, deploymentBlock });
    const result = await reader.verify(content);
    expect(result.status).to.equal("found");
  });

  it("verifyInBatch accepts a proof from a root stamped with @hallmarq/core's buildTree", async () => {
    const { registry, registryAddress, chainId, deploymentBlock } = await deploy();
    const contentA = "integration: batch content A";
    const contentB = "integration: batch content B";
    const tree = buildTree([hashText(contentA), hashText(contentB)]);

    await (await registry.stampRoot(tree.root, 2, "gpt-4o")).wait();

    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock });
    const result = await hallmarq.verifyInBatch(contentA, {
      root: tree.root,
      proof: getProof(tree, 0),
    });

    expect(result.status).to.equal("found-in-batch");
    if (result.status !== "found-in-batch") throw new Error("expected status 'found-in-batch'");
    expect(result.contentHash).to.equal(hashText(contentA));
    expect(result.root).to.equal(tree.root);
    expect(result.count).to.equal(2);
    expect(result.model).to.equal("gpt-4o");

    const notInBatch = await hallmarq.verifyInBatch(contentB, {
      root: tree.root,
      proof: getProof(tree, 0),
    });
    expect(notInBatch.status).to.equal("not-found");
  });

  it("resolves a mined-but-reverted stamp to AlreadyStamped when two signers race for the same content", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const content = "integration: two signers race for the same content";

    // Hardhat's own test signers (HardhatEthersSigner) can't `signTransaction`
    // — they only implement eth_sendTransaction, which (unlike a raw
    // broadcast) validates against pending state and would resolve this
    // race before either side ever broadcasts, masking the exact path this
    // test means to exercise. Real `Wallet`s sign locally instead, so this
    // goes through the SDK's real sign-once-then-broadcast code. The keys
    // are Hardhat's well-known default test accounts — public fixtures,
    // not secrets — the same accounts `network.create()`'s own signers use.
    const alice = new Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ethers.provider,
    );
    const bob = new Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      ethers.provider,
    );

    const aliceHallmarq = makeHallmarq({
      registryAddress,
      chainId,
      deploymentBlock,
      signer: alice,
      confirmTimeoutMs: 15_000,
    });
    const bobHallmarq = makeHallmarq({
      registryAddress,
      chainId,
      deploymentBlock,
      signer: bob,
      confirmTimeoutMs: 15_000,
    });

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const aliceNonceBefore = await ethers.provider.getTransactionCount(alice.address, "pending");
      const bobNonceBefore = await ethers.provider.getTransactionCount(bob.address, "pending");

      // Both preflights run against the same not-yet-stamped state and pass,
      // so both signers broadcast a transaction for the same content hash —
      // the front-running case docs/SECURITY.md names.
      const alicePromise = aliceHallmarq.stamp(content, { model: "gpt-4o" });
      const bobPromise = bobHallmarq.stamp(content, { model: "gpt-4o" });

      // Wait until both transactions have actually reached the mempool
      // before mining, rather than racing them with a fixed delay.
      while (
        (await ethers.provider.getTransactionCount(alice.address, "pending")) ===
          aliceNonceBefore ||
        (await ethers.provider.getTransactionCount(bob.address, "pending")) === bobNonceBefore
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // One block mines both: whichever is applied first succeeds, and the
      // other reverts with AlreadyStamped against the content hash the first
      // one just claimed.
      await ethers.provider.send("evm_mine", []);

      const [aliceResult, bobResult] = await Promise.allSettled([alicePromise, bobPromise]);
      const fulfilled = [aliceResult, bobResult].filter((r) => r.status === "fulfilled");
      const rejected = [aliceResult, bobResult].filter((r) => r.status === "rejected");

      expect(fulfilled).to.have.lengthOf(1);
      expect(rejected).to.have.lengthOf(1);
      const error = rejected[0].reason;
      expect(error).to.be.instanceOf(AlreadyStamped);
      expect((error as AlreadyStamped).contentHash).to.equal(hashText(content));
      expect((error as AlreadyStamped).txHash).to.be.a("string");
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("waits for 2 confirmations, resolving only once the extra block is mined", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({
      registryAddress,
      chainId,
      deploymentBlock,
      signer: alice,
      confirmations: 2,
      confirmTimeoutMs: 15_000,
    });

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const nonceBefore = await ethers.provider.getTransactionCount(
        await alice.getAddress(),
        "pending",
      );

      const pending = hallmarq.stamp("integration: two confirmations", { model: "gpt-4o" });

      // Wait until the transaction has actually reached the mempool before
      // mining, rather than racing it with a fixed delay.
      while (
        (await ethers.provider.getTransactionCount(await alice.getAddress(), "pending")) ===
        nonceBefore
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // One block to include the transaction, one more for its confirmation.
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      const receipt = await pending;
      expect(receipt.blockNumber).to.be.a("number");
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("a batch of 5 (one duplicate) sends exactly one transaction; every receipt verifies via verifyInBatch and verifyReceipt", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer: alice });

    const contents = [
      "integration: batch item A",
      "integration: batch item B",
      "integration: batch item A", // duplicate of the first, at a different position
      "integration: batch item D",
      "integration: batch item E",
    ];

    const pending = contents.map((content) => hallmarq.stampBatched(content, { model: "gpt-4o" }));
    await hallmarq.flush();
    const receipts: BatchReceipt[] = await Promise.all(pending);

    // Every item's receipt shares the same txHash: proof that all 5 went
    // out in a single stampRoot transaction, not 5 separate ones.
    const uniqueTxHashes = new Set(receipts.map((r) => r.txHash));
    expect(uniqueTxHashes.size).to.equal(1);
    expect(receipts.every((r) => r.batchSize === 5)).to.equal(true);
    expect(receipts.map((r) => r.index)).to.deep.equal([0, 1, 2, 3, 4]);
    // The duplicate (index 0 and 2) gets two different, independently
    // correct proofs, since each is a distinct position in the tree.
    expect(receipts[0].proof).to.not.deep.equal(receipts[2].proof);

    for (let i = 0; i < contents.length; i++) {
      const receipt = receipts[i];

      const viaVerifyInBatch = await hallmarq.verifyInBatch(contents[i], {
        root: receipt.root,
        proof: receipt.proof,
      });
      expect(viaVerifyInBatch.status).to.equal("found-in-batch");
      if (viaVerifyInBatch.status !== "found-in-batch") throw new Error("unreachable");
      expect(viaVerifyInBatch.root).to.equal(receipt.root);

      const viaVerifyReceipt = await hallmarq.verifyReceipt(contents[i], receipt.receiptFile);
      expect(viaVerifyReceipt.status).to.equal("found-in-batch");
    }
  });

  it("verifyReceipt throws ConfigError when the receipt's chainId doesn't match this instance's configured chainId", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer: alice });

    const content = "integration: receipt with the wrong chainId";
    const pending = hallmarq.stampBatched(content, { model: "gpt-4o" });
    await hallmarq.flush();
    const receipt = await pending;

    let error: unknown;
    try {
      await hallmarq.verifyReceipt(content, { ...receipt.receiptFile, chainId: chainId + 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).name).to.equal("ConfigError");
  });

  it("verifyReceipt throws ConfigError when the receipt's registryAddress doesn't match this instance's", async () => {
    const { registryAddress, chainId, deploymentBlock, alice } = await deploy();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer: alice });

    const content = "integration: receipt with the wrong registryAddress";
    const pending = hallmarq.stampBatched(content, { model: "gpt-4o" });
    await hallmarq.flush();
    const receipt = await pending;

    const otherAddress = "0x" + "99".repeat(20);
    let error: unknown;
    try {
      await hallmarq.verifyReceipt(content, {
        ...receipt.receiptFile,
        registryAddress: otherAddress,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).name).to.equal("ConfigError");
  });

  it("measures gas: one stampRoot(5) vs 5 individual stamp() calls, for the PR's cost comparison", async () => {
    // registry is deployed by (and so already sends as) the default
    // signer, the same account as alice; connect()ing it to alice again
    // would only widen its type back down to the untyped BaseContract.
    const { registry } = await deploy();

    let singleStampGasTotal = 0n;
    for (let i = 0; i < 5; i++) {
      const contentHash = hashText(`integration: gas measurement single stamp ${i}`);
      const tx = await registry.stamp(contentHash, "gpt-4o", ethers.ZeroHash);
      const txReceipt = await tx.wait();
      singleStampGasTotal += txReceipt!.gasUsed;
    }

    const hashes = Array.from({ length: 5 }, (_, i) =>
      hashText(`integration: gas measurement batch item ${i}`),
    );
    const tree = buildTree(hashes);
    const batchTx = await registry.stampRoot(tree.root, 5, "gpt-4o");
    const batchTxReceipt = await batchTx.wait();
    const batchGas = batchTxReceipt!.gasUsed;

    console.log(
      `\n    gas: 5x stamp()     = ${singleStampGasTotal} total, ${singleStampGasTotal / 5n} avg/item` +
        `\n    gas: 1x stampRoot(5) = ${batchGas} total, ${batchGas / 5n} avg/item\n`,
    );

    expect(batchGas).to.be.lessThan(singleStampGasTotal);
  });

  // These four tests all need a signer that can actually `signTransaction`
  // — Hardhat's own test signers (HardhatEthersSigner, the `alice`/`bob`
  // every other test in this file uses) can't, and silently take the
  // fallback `eth_sendTransaction` send path instead, where Hardhat itself
  // assigns the nonce and the race these tests exist to catch can't
  // happen. A real `ethers.Wallet` signs locally and goes through the real
  // populate/sign/broadcast path the send lock protects. The key is
  // Hardhat's well-known default account #0 — a public test fixture, not
  // a secret, the same one the two-signer race test above uses for alice.
  function lockTestSigner() {
    return new Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ethers.provider,
    );
  }

  /**
   * Wraps a real provider so `getTransactionCount(address, "pending")`
   * answers with the "latest" (mined-only) count instead — exactly what
   * MST's testnet node was observed doing (docs/DECISIONS.md and the
   * README's "Retries/nonces" section): it never reflects a transaction
   * this signer has already broadcast but that hasn't been mined yet.
   * Every other method is forwarded to the real provider, each explicitly
   * bound to it so ethers' own internals (which rely on private class
   * fields) still see their real `this`, not this wrapper.
   */
  function withStalePendingNonce<T extends object>(real: T): T {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "getTransactionCount") {
          const original = (
            target as unknown as {
              getTransactionCount: (address: string, blockTag?: string) => Promise<number>;
            }
          ).getTransactionCount.bind(target);
          return (address: string, blockTag?: string) =>
            original(address, blockTag === "pending" ? "latest" : blockTag);
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return (value as (...args: unknown[]) => unknown).bind(target);
        }
        return value;
      },
    });
  }

  it("flush() sends concurrent stampRoot transactions for 3 models from one signer with consecutive nonces, not a nonce collision", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const signer = lockTestSigner();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer });

    const pending = [
      hallmarq.stampBatched("integration: lock test model-a item", { model: "model-a" }),
      hallmarq.stampBatched("integration: lock test model-b item", { model: "model-b" }),
      hallmarq.stampBatched("integration: lock test model-c item", { model: "model-c" }),
    ];
    await hallmarq.flush();
    const receipts = await Promise.all(pending);

    expect(receipts).to.have.lengthOf(3);
    const nonces = await Promise.all(
      receipts.map(async (r) => (await ethers.provider.getTransaction(r.txHash))!.nonce),
    );
    const sorted = [...nonces].sort((a, b) => a - b);
    expect(sorted).to.deep.equal([sorted[0], sorted[0] + 1, sorted[0] + 2]);
    expect(new Set(nonces).size).to.equal(3);
  });

  it("two concurrent stamp() calls from the same signer both succeed, with consecutive nonces", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const signer = lockTestSigner();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer });

    const [a, b] = await Promise.all([
      hallmarq.stamp("integration: lock test concurrent stamp A", { model: "gpt-4o" }),
      hallmarq.stamp("integration: lock test concurrent stamp B", { model: "gpt-4o" }),
    ]);

    const [nonceA, nonceB] = await Promise.all([
      ethers.provider.getTransaction(a.txHash).then((tx) => tx!.nonce),
      ethers.provider.getTransaction(b.txHash).then((tx) => tx!.nonce),
    ]);
    expect(Math.abs(nonceA - nonceB)).to.equal(1);
  });

  it("a size-triggered batch firing while another is already in flight: both succeed, with consecutive nonces", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const signer = lockTestSigner();
    const hallmarq = makeHallmarq({
      registryAddress,
      chainId,
      deploymentBlock,
      signer,
      batch: { maxItems: 1, maxWaitMs: 30_000 },
    });

    // maxItems: 1 means each call below triggers its own batch send
    // immediately — the second fires while the first is still (at least
    // momentarily) in flight.
    const first = hallmarq.stampBatched("integration: lock test size-triggered A", {
      model: "gpt-4o",
    });
    const second = hallmarq.stampBatched("integration: lock test size-triggered B", {
      model: "gpt-4o",
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a.batchSize).to.equal(1);
    expect(b.batchSize).to.equal(1);
    const [nonceA, nonceB] = await Promise.all([
      ethers.provider.getTransaction(a.txHash).then((tx) => tx!.nonce),
      ethers.provider.getTransaction(b.txHash).then((tx) => tx!.nonce),
    ]);
    expect(Math.abs(nonceA - nonceB)).to.equal(1);
  });

  it("releases the send lock when a transaction fails, so a later call from the same signer isn't stuck", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const signer = lockTestSigner();
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer });
    const content = "integration: lock test duplicate content from one signer";

    // Both calls target the same content. Automine stays on: the first
    // call's populate/sign/broadcast (and, with automine, its mining) runs
    // to completion under the send lock before the second call's populate
    // step starts. By then the content is already stamped, so the
    // second's own gas estimation (inside `signer.populateTransaction`)
    // simulates against that state and fails before it ever signs or
    // broadcasts anything — a failure inside the locked section, same as
    // the "Must fix" review comment's concern, just surfacing at
    // estimation rather than at the broadcast call itself.
    const firstPromise = hallmarq.stamp(content, { model: "gpt-4o" });
    const secondPromise = hallmarq.stamp(content, { model: "gpt-4o" }).catch((e: unknown) => e);

    const [firstReceipt, secondError] = await Promise.all([firstPromise, secondPromise]);
    expect(firstReceipt.txHash).to.be.a("string");
    expect(secondError).to.be.instanceOf(Error);

    // The lock must have been released despite the second call's failure:
    // a third, unrelated call from the same signer still succeeds.
    const third = await hallmarq.stamp("integration: lock test after failure", {
      model: "gpt-4o",
    });
    expect(third.txHash).to.be.a("string");
  });

  it("flush() across 3 models all succeed even when the node's 'pending' count only reports 'latest' (mimics MST)", async () => {
    const { registryAddress, chainId, deploymentBlock } = await deploy();
    const signer = lockTestSigner().connect(withStalePendingNonce(ethers.provider));
    const hallmarq = makeHallmarq({ registryAddress, chainId, deploymentBlock, signer });

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const nonceBefore = await ethers.provider.getTransactionCount(
        await signer.getAddress(),
        "pending",
      );

      const pending = [
        hallmarq.stampBatched("integration: stale-pending model-a item", { model: "model-a" }),
        hallmarq.stampBatched("integration: stale-pending model-b item", { model: "model-b" }),
        hallmarq.stampBatched("integration: stale-pending model-c item", { model: "model-c" }),
      ];
      const flushed = hallmarq.flush();

      // Wait until all three transactions have actually reached the
      // mempool — still unmined, so the real provider's own "pending"
      // count (not the wrapper's "latest" one) must have advanced by 3 —
      // before mining, rather than racing them with a fixed delay.
      while (
        (await ethers.provider.getTransactionCount(await signer.getAddress(), "pending")) <
        nonceBefore + 3
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // One block mines all three.
      await ethers.provider.send("evm_mine", []);
      await flushed;

      const receipts = await Promise.all(pending);
      expect(receipts).to.have.lengthOf(3);
      const nonces = await Promise.all(
        receipts.map(async (r) => (await ethers.provider.getTransaction(r.txHash))!.nonce),
      );
      expect(new Set(nonces).size).to.equal(3);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });
});
