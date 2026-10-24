// solhint errors on an empty glob match, and contracts/ stays empty until
// Roadmap PR 3 adds StampRegistry.sol. Skip the lint step instead of failing
// CI on a scaffold with no Solidity to lint yet.
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

const files = globSync("contracts/**/*.sol");

if (files.length === 0) {
  console.log("solhint: no .sol files yet (contracts/ is empty until Roadmap PR 3)");
  process.exit(0);
}

execFileSync("solhint", ["--config", ".solhint.json", ...files], { stdio: "inherit" });
