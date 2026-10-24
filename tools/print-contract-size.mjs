import { readFileSync } from "node:fs";

const artifactPath = "artifacts/contracts/StampRegistry.sol/StampRegistry.json";
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

const deployedBytes = (artifact.deployedBytecode.length - 2) / 2;
console.log(`StampRegistry deployed bytecode: ${deployedBytes} bytes`);
