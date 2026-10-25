import { describe, expect, it } from "vitest";

import { hardhat, mstTestnet } from "./networks.js";

describe("networks", () => {
  it("hardhat has the standard local chain ID and RPC URL, no deployed registry yet", () => {
    expect(hardhat.chainId).toBe(31337);
    expect(hardhat.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(hardhat.explorerUrl).toBeUndefined();
    expect(hardhat.registryAddress).toBeUndefined();
    expect(hardhat.deploymentBlock).toBeUndefined();
  });

  it("mstTestnet has every value left undefined until the founder confirms them", () => {
    expect(mstTestnet.chainId).toBeUndefined();
    expect(mstTestnet.rpcUrl).toBeUndefined();
    expect(mstTestnet.explorerUrl).toBeUndefined();
    expect(mstTestnet.registryAddress).toBeUndefined();
    expect(mstTestnet.deploymentBlock).toBeUndefined();
  });
});
