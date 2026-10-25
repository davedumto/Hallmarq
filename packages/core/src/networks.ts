/**
 * Per-network configuration the SDK and the verifier read their defaults
 * from (D8). Every field is always present; a value is `undefined` only
 * when it genuinely isn't known yet — never guessed.
 */
export interface NetworkConfig {
  readonly chainId: number | undefined;
  readonly rpcUrl: string | undefined;
  readonly explorerUrl: string | undefined;
  readonly registryAddress: string | undefined;
  /** Block the registry was deployed at; event queries start here, not at block 0. */
  readonly deploymentBlock: number | undefined;
}

/** Hardhat's standard local in-process network. No deployed registry yet. */
export const hardhat: NetworkConfig = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  explorerUrl: undefined,
  registryAddress: undefined,
  deploymentBlock: undefined,
};

/**
 * TODO(docs/ROADMAP.md "Open items: owner is the founder, needed before PR 5"):
 * fill in chainId, rpcUrl and explorerUrl once the founder confirms the MST
 * testnet chain ID, public RPC URL and Blockscout API URL; fill in
 * registryAddress and deploymentBlock once Roadmap PR 5 deploys
 * StampRegistry. None of these may be guessed.
 */
export const mstTestnet: NetworkConfig = {
  chainId: undefined,
  rpcUrl: undefined,
  explorerUrl: undefined,
  registryAddress: undefined,
  deploymentBlock: undefined,
};
