import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

const files = globSync("contracts/**/*.sol");

execFileSync("solhint", ["--config", ".solhint.json", ...files], { stdio: "inherit" });
