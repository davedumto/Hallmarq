// Deploys StampRegistry to MST testnet. Run with:
//   npx hardhat run scripts/deploy.ts
// Refuses to run against the wrong chain, an underfunded deployer, or over an
// existing deployment record (pass --force to redeploy and overwrite it).
import "dotenv/config";

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { artifacts, network } from "hardhat";

const MST_TESTNET_CHAIN_ID = 91562037;
const MIN_DEPLOYER_BALANCE_MSTC = "0.01";
const CONFIRMATIONS = 2;
const DEPLOYMENT_PATH = path.join(process.cwd(), "deployments", "mstTestnet.json");

interface DeploymentRecord {
  readonly chainId: number;
  readonly address: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly deployer: string;
  readonly gitCommit: string;
  readonly solcVersion: string;
  readonly evmVersion: string;
  readonly optimizerRuns: number;
  readonly deployedBytecodeSize: number;
  readonly deployedAt: string;
}

interface BuildInfo {
  readonly solcLongVersion: string;
  readonly input: {
    readonly settings: {
      readonly evmVersion: string;
      readonly optimizer: { readonly runs: number };
    };
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  const envChainId = Number(process.env.MST_CHAIN_ID);
  if (envChainId !== MST_TESTNET_CHAIN_ID) {
    throw new Error(
      `MST_CHAIN_ID must be ${MST_TESTNET_CHAIN_ID}, got "${process.env.MST_CHAIN_ID ?? ""}".`,
    );
  }

  const connection = await network.create("mstTestnet");
  const { ethers } = connection;

  try {
    const rpcNetwork = await ethers.provider.getNetwork();
    const rpcChainId = Number(rpcNetwork.chainId);
    if (rpcChainId !== MST_TESTNET_CHAIN_ID) {
      throw new Error(`RPC reports chain ID ${rpcChainId}, expected ${MST_TESTNET_CHAIN_ID}.`);
    }

    const [deployer] = await ethers.getSigners();
    const deployerAddress = await deployer.getAddress();
    const balance = await ethers.provider.getBalance(deployerAddress);
    console.log(`Deployer: ${deployerAddress}`);
    console.log(`Balance:  ${ethers.formatEther(balance)} tMSTC`);

    const minBalance = ethers.parseEther(MIN_DEPLOYER_BALANCE_MSTC);
    if (balance < minBalance) {
      throw new Error(
        `Deployer balance ${ethers.formatEther(balance)} tMSTC is below the ${MIN_DEPLOYER_BALANCE_MSTC} tMSTC floor.`,
      );
    }

    if (existsSync(DEPLOYMENT_PATH) && !force) {
      throw new Error(`${DEPLOYMENT_PATH} already exists. Pass --force to redeploy.`);
    }

    console.log("Deploying StampRegistry...");
    const registry = await ethers.deployContract("StampRegistry", deployer);
    const deployTx = registry.deploymentTransaction();
    if (!deployTx) {
      throw new Error("StampRegistry deployment did not produce a transaction.");
    }
    console.log(`Tx hash: ${deployTx.hash}`);
    console.log(`Waiting for ${CONFIRMATIONS} confirmations...`);
    const receipt = await deployTx.wait(CONFIRMATIONS);
    if (!receipt) {
      throw new Error("Deployment transaction did not produce a receipt.");
    }

    const address = await registry.getAddress();
    console.log(`StampRegistry deployed at ${address} (block ${receipt.blockNumber})`);

    const artifact = await artifacts.readArtifact("StampRegistry");
    const deployedBytecodeSize = (artifact.deployedBytecode.length - 2) / 2;

    const buildInfoId = await artifacts.getBuildInfoId("StampRegistry");
    if (!buildInfoId) {
      throw new Error("StampRegistry has no build info id; run `hardhat build` first.");
    }
    const buildInfoPath = await artifacts.getBuildInfoPath(buildInfoId);
    if (!buildInfoPath) {
      throw new Error(`Build info ${buildInfoId} not found on disk.`);
    }
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as BuildInfo;

    const record: DeploymentRecord = {
      chainId: rpcChainId,
      address,
      txHash: deployTx.hash,
      blockNumber: receipt.blockNumber,
      deployer: deployerAddress,
      gitCommit: execSync("git rev-parse HEAD").toString().trim(),
      solcVersion: buildInfo.solcLongVersion,
      evmVersion: buildInfo.input.settings.evmVersion,
      optimizerRuns: buildInfo.input.settings.optimizer.runs,
      deployedBytecodeSize,
      deployedAt: new Date().toISOString(),
    };

    mkdirSync(path.dirname(DEPLOYMENT_PATH), { recursive: true });
    writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Wrote ${DEPLOYMENT_PATH}`);
  } finally {
    await connection.close();
  }
}

await main();
