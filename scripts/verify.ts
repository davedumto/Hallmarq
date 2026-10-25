// Verifies the deployed StampRegistry source on Blockscout (testnet.mstscan.com).
// Run with:
//   npx hardhat run scripts/verify.ts --network mstTestnet --build-profile default
// The --build-profile must match the one used to deploy (see hardhat-verify's
// README, "Build profiles and verification"), otherwise the recompiled
// bytecode won't match what's on chain even though the source is identical.
// Re-running this on an already-verified contract is treated as success.
import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";

const DEPLOYMENT_PATH = path.join(process.cwd(), "deployments", "mstTestnet.json");

interface DeploymentRecord {
  readonly address: string;
}

async function main(): Promise<void> {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as DeploymentRecord;

  console.log(`Verifying StampRegistry at ${deployment.address} on Blockscout...`);
  const verified = await verifyContract(
    {
      address: deployment.address,
      contract: "contracts/StampRegistry.sol:StampRegistry",
      provider: "blockscout",
    },
    hre,
  );

  if (!verified) {
    throw new Error("Verification did not succeed.");
  }
  console.log("Source verified (or was already verified).");
}

await main();
