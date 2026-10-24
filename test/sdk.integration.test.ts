import { createServer } from "node:http";

import { buildTree, getProof, hashText } from "@hallmarq/core";
import { AlreadyStamped, Hallmarq } from "@hallmarq/sdk";
import type { Receipt, VerifyResult } from "@hallmarq/sdk";
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
});
