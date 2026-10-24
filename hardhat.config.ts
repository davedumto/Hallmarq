import "dotenv/config";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import type { HardhatUserConfig } from "hardhat/config";

// MST is a Parlia (BSC-family) chain; evmVersion is pinned to "paris" until the
// supported hardfork is confirmed (docs/DECISIONS.md D5).
const SOLIDITY_VERSION = "0.8.26";

type NetworksUserConfig = NonNullable<HardhatUserConfig["networks"]>;

const { MST_RPC_URL, MST_CHAIN_ID, DEPLOYER_PRIVATE_KEY } = process.env;

// The mstTestnet network only exists once every variable it needs is set, so a
// contributor without testnet credentials never sees a half-configured network.
// Local tests use Hardhat's built-in in-process network (via network.create()),
// so there's no need to declare one here.
const networks: NetworksUserConfig = {};

if (MST_RPC_URL && MST_CHAIN_ID && DEPLOYER_PRIVATE_KEY) {
  const chainId = Number(MST_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`MST_CHAIN_ID must be a positive integer, got "${MST_CHAIN_ID}"`);
  }

  networks.mstTestnet = {
    type: "http",
    chainType: "l1",
    url: MST_RPC_URL,
    chainId,
    accounts: [DEPLOYER_PRIVATE_KEY],
  };
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: SOLIDITY_VERSION,
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "paris",
        },
      },
    },
  },
  networks,
};

export default config;
