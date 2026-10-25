// Verifies the deployed StampRegistry source on Blockscout (testnet.mstscan.com)
// via its v2 REST API, submitting the exact build-info compiler input Hardhat
// actually compiled and deployed. Run with:
//   npx hardhat run scripts/verify.ts --network mstTestnet --build-profile default
//
// @nomicfoundation/hardhat-verify only implements Blockscout's legacy
// Etherscan-compatible v1 API (module=contract&action=verifysourcecode). Both
// its minimal- and full-compiler-input attempts failed against
// testnet.mstscan.com with "Fail - Unable to verify" (no further detail) —
// see the PR description for the full reproduction, including proof that the
// locally compiled deployedBytecode is byte-for-byte identical to
// eth_getCode at the deployed address, metadata tail included. Submitting the
// same exact input directly to the v2 API (this script) also never reaches
// is_verified: true, which points at MST's verifier service rather than
// anything on our side; see the PR for that evidence too. This script is
// still the correct way to verify once that's fixed upstream, and re-running
// it on an already-verified contract is treated as success.
import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

import { artifacts } from "hardhat";

const DEPLOYMENT_PATH = path.join(process.cwd(), "deployments", "mstTestnet.json");
const EXPLORER_API_BASE = "https://testnet.mstscan.com/api/v2";
const EXPLORER_URL = "https://testnet.mstscan.com";
const CONTRACT_NAME = "StampRegistry";
const LICENSE_TYPE = "mit";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60_000;

interface DeploymentRecord {
  readonly address: string;
}

interface BuildInfo {
  readonly solcLongVersion: string;
  readonly input: unknown;
}

interface SmartContractResponse {
  readonly is_verified?: boolean;
}

function explorerContractLink(address: string): string {
  return `${EXPLORER_URL}/address/${address}#code`;
}

async function readBuildInfo(): Promise<BuildInfo> {
  const buildInfoId = await artifacts.getBuildInfoId(CONTRACT_NAME);
  if (!buildInfoId) {
    throw new Error(`${CONTRACT_NAME} has no build info id; run \`hardhat build\` first.`);
  }
  const buildInfoPath = await artifacts.getBuildInfoPath(buildInfoId);
  if (!buildInfoPath) {
    throw new Error(`Build info ${buildInfoId} not found on disk.`);
  }
  return JSON.parse(readFileSync(buildInfoPath, "utf8")) as BuildInfo;
}

async function fetchSmartContract(address: string): Promise<SmartContractResponse | undefined> {
  const response = await fetch(`${EXPLORER_API_BASE}/smart-contracts/${address}`);
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as SmartContractResponse;
}

async function submitVerification(address: string, buildInfo: BuildInfo): Promise<void> {
  const form = new FormData();
  form.set("compiler_version", `v${buildInfo.solcLongVersion}`);
  form.set("license_type", LICENSE_TYPE);
  form.set("contract_name", CONTRACT_NAME);
  form.set("autodetect_constructor_args", "true");
  form.set(
    "files[0]",
    new Blob([JSON.stringify(buildInfo.input)], { type: "application/json" }),
    "input.json",
  );

  const url = `${EXPLORER_API_BASE}/smart-contracts/${address}/verification/via/standard-input`;
  const response = await fetch(url, { method: "POST", body: form });
  const bodyText = await response.text();

  if (!response.ok) {
    if (/already verified/i.test(bodyText)) {
      console.log("Already verified (submission rejected as a duplicate).");
      return;
    }
    throw new Error(
      `POST ${url}\nHTTP ${response.status}\nResponse: ${bodyText}\n\n` +
        "Blockscout rejected the verification submission.",
    );
  }
  console.log(`Submitted. Response: ${bodyText}`);
}

async function pollUntilVerified(address: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastBody: SmartContractResponse | undefined;
  while (Date.now() < deadline) {
    lastBody = await fetchSmartContract(address);
    if (lastBody?.is_verified === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for verification.\n` +
      `Last GET ${EXPLORER_API_BASE}/smart-contracts/${address} response: ${JSON.stringify(lastBody)}`,
  );
}

async function main(): Promise<void> {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as DeploymentRecord;
  const { address } = deployment;

  console.log(`Checking whether ${CONTRACT_NAME} at ${address} is already verified...`);
  const existing = await fetchSmartContract(address);
  if (existing?.is_verified === true) {
    console.log(`Already verified: ${explorerContractLink(address)}`);
    return;
  }

  const buildInfo = await readBuildInfo();
  console.log(
    `Submitting the exact build-info compiler input (solc ${buildInfo.solcLongVersion}) to Blockscout's v2 API...`,
  );
  await submitVerification(address, buildInfo);

  console.log("Waiting for Blockscout to finish verifying...");
  await pollUntilVerified(address);

  console.log(`Verified: ${explorerContractLink(address)}`);
}

await main();
