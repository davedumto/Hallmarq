import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Hardhat scaffold", function () {
  it("connects to the in-memory network until StampRegistry lands in PR 3", async function () {
    const blockNumber = await ethers.provider.getBlockNumber();
    expect(blockNumber).to.be.a("number");
  });
});
