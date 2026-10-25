// Exercises a real deployment end to end: a single stamp + verify (with the
// N4 send-to-confirmed-read timing), a not-found verify, and a 3-item,
// 2-model stampBatched batch verified back via verifyReceipt. Run with:
//   npx hardhat run scripts/smoke.ts --network mstTestnet
// Reads registryAddress/chainId/deploymentBlock explicitly from
// deployments/mstTestnet.json rather than @hallmarq/core's networks.ts,
// since that file isn't filled in until Roadmap PR 5b.
import "dotenv/config";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Hallmarq } from "@hallmarq/sdk";
import { Wallet } from "ethers";

const DEPLOYMENT_PATH = path.join(process.cwd(), "deployments", "mstTestnet.json");
const RECEIPT_DIR = path.join(process.cwd(), "deployments", "smoke-receipts");
const EXPLORER_URL = "https://testnet.mstscan.com";

interface DeploymentRecord {
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: number;
}

interface BatchItem {
  readonly content: string;
  readonly model: string;
}

function explorerTxLink(txHash: string): string {
  return `${EXPLORER_URL}/tx/${txHash}`;
}

async function main(): Promise<void> {
  const { MST_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;
  if (!MST_RPC_URL || !DEPLOYER_PRIVATE_KEY) {
    throw new Error("MST_RPC_URL and DEPLOYER_PRIVATE_KEY must be set.");
  }

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as DeploymentRecord;
  const signer = new Wallet(DEPLOYER_PRIVATE_KEY);
  const hallmarq = new Hallmarq({
    rpcUrl: MST_RPC_URL,
    chainId: deployment.chainId,
    registryAddress: deployment.address,
    deploymentBlock: deployment.blockNumber,
    signer,
  });

  const txHashes: string[] = [];

  try {
    // (a) stamp a unique string and verify it; this is the N4 measurement.
    const uniqueContent = `Hallmarq testnet smoke test ${new Date().toISOString()}`;
    console.log(`(a) Stamping: ${JSON.stringify(uniqueContent)}`);
    const sendStart = Date.now();
    const receipt = await hallmarq.stamp(uniqueContent, { model: "smoke-test" });
    txHashes.push(receipt.txHash);
    console.log(`    tx: ${receipt.txHash}  ${explorerTxLink(receipt.txHash)}`);

    const found = await hallmarq.verify(uniqueContent);
    const sendToConfirmedReadMs = Date.now() - sendStart;
    if (found.status !== "found") {
      throw new Error(`Expected "found", got "${found.status}"`);
    }
    console.log(`    verify: found (send -> confirmed read: ${sendToConfirmedReadMs}ms)`);

    // (b) verify an unrelated, never-stamped string.
    const unrelated = `Hallmarq testnet smoke test, never stamped, ${new Date().toISOString()}`;
    console.log("(b) Verifying an unrelated string...");
    const notFound = await hallmarq.verify(unrelated);
    if (notFound.status !== "not-found") {
      throw new Error(`Expected "not-found", got "${notFound.status}"`);
    }
    console.log("    verify: not-found");

    // (c) stampBatched: 3 items across 2 model labels, flush, verifyReceipt each.
    console.log("(c) Batching 3 items across 2 model labels...");
    const now = new Date().toISOString();
    const batchItems: readonly BatchItem[] = [
      { content: `Hallmarq smoke batch item 0, ${now}`, model: "smoke-model-a" },
      { content: `Hallmarq smoke batch item 1, ${now}`, model: "smoke-model-a" },
      { content: `Hallmarq smoke batch item 2, ${now}`, model: "smoke-model-b" },
    ];
    const batchPromises = batchItems.map((item) =>
      hallmarq.stampBatched(item.content, { model: item.model }),
    );
    await hallmarq.flush();
    const batchReceipts = await Promise.all(batchPromises);

    mkdirSync(RECEIPT_DIR, { recursive: true });

    for (const [index, batchReceipt] of batchReceipts.entries()) {
      txHashes.push(batchReceipt.txHash);
      const receiptPath = path.join(RECEIPT_DIR, `item-${index}.json`);
      writeFileSync(receiptPath, `${JSON.stringify(batchReceipt.receiptFile, null, 2)}\n`);

      const item = batchItems[index];
      const verifyResult = await hallmarq.verifyReceipt(item.content, batchReceipt.receiptFile);
      if (verifyResult.status !== "found-in-batch") {
        throw new Error(
          `Expected "found-in-batch" for item ${index}, got "${verifyResult.status}"`,
        );
      }
      console.log(
        `    item ${index} (${item.model}): found-in-batch, tx ${batchReceipt.txHash}  ${explorerTxLink(batchReceipt.txHash)}`,
      );
    }

    // (d) print every transaction with its explorer link.
    console.log("\nAll transactions:");
    for (const txHash of txHashes) {
      console.log(`  ${txHash}  ${explorerTxLink(txHash)}`);
    }
    console.log(`\nSend -> confirmed read time (N4): ${sendToConfirmedReadMs}ms`);
  } finally {
    await hallmarq.close();
  }
}

await main();
