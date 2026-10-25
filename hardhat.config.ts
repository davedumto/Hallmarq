import "dotenv/config";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import type { HardhatUserConfig } from "hardhat/config";

// MST supports up to Cancun, but v1 stays on "paris": every test, gas figure
// and the 3,030-byte contract size were measured on paris (docs/DECISIONS.md D5).
const SOLIDITY_VERSION = "0.8.26";

// MST testnet's chain ID (docs/DECISIONS.md D13), used as the chainDescriptors
// key below. Not read from MST_CHAIN_ID: chainDescriptors must exist even when
// no testnet credentials are configured.
const MST_TESTNET_CHAIN_ID = 91562037;

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
  // hardhat-toolbox-mocha-ethers already depends on @nomicfoundation/hardhat-verify,
  // so it isn't listed again here, nor as a direct devDependency: it only
  // implements Blockscout's legacy v1 API, which can't verify this contract
  // (see scripts/verify.ts, which talks to Blockscout's v2 API directly).
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
  // Blockscout verification config for MST testnet (docs/DECISIONS.md D13).
  // Blockscout v9.0.2 at testnet.mstscan.com needs no API key.
  chainDescriptors: {
    [MST_TESTNET_CHAIN_ID]: {
      name: "MST Testnet",
      chainType: "l1",
      blockExplorers: {
        blockscout: {
          name: "MST Testnet Explorer",
          url: "https://testnet.mstscan.com",
          apiUrl: "https://testnet.mstscan.com/api",
        },
      },
    },
  },
};

export default config;
