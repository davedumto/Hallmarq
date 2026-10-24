import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return { ...actual, Contract: vi.fn(), JsonRpcProvider: vi.fn() };
});

import { Contract, JsonRpcProvider, type Signer } from "ethers";

import {
  AlreadyStamped,
  ConfigError,
  InvalidMeta,
  ModelTooLong,
  NetworkError,
  NoSigner,
  NotConfirmed,
  WrongNetwork,
} from "./errors.js";
import { canonicalJsonStringify } from "./canonicalJson.js";
import {
  HallmarqError,
  hashBytes,
  hashText,
  EmptyContent,
  InvalidUtf8,
  InvalidHex,
} from "@hallmarq/core";
import { Hallmarq } from "./hallmarq.js";

const REGISTRY_ADDRESS = "0x" + "11".repeat(20);
const REGISTRANT = "0x" + "22".repeat(20);
const RPC_URL = "http://fake-rpc.invalid";
const CHAIN_ID = 31337;

function callException(revert: { name: string; args: unknown[] } | null = null) {
  return Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION", data: "0x", revert });
}

function networkFailure() {
  return Object.assign(new Error("timeout"), { code: "TIMEOUT" });
}

interface FakeContract {
  verify: Mock;
  getBatch: Mock;
  verifyInBatch: Mock;
  stamp: Mock & { staticCall: Mock };
  filters: { Stamped: Mock; BatchStamped: Mock };
  queryFilter: Mock;
}

function makeFakeContract(): FakeContract {
  const stamp = vi.fn() as Mock & { staticCall: Mock };
  stamp.staticCall = vi.fn().mockResolvedValue(undefined);
  return {
    verify: vi.fn(),
    getBatch: vi.fn(),
    verifyInBatch: vi.fn(),
    stamp,
    filters: {
      Stamped: vi.fn((contentHash: string) => ({ type: "Stamped", contentHash })),
      BatchStamped: vi.fn((root: string) => ({ type: "BatchStamped", root })),
    },
    queryFilter: vi.fn().mockResolvedValue([]),
  };
}

function makeFakeProvider(chainId = CHAIN_ID) {
  return { getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(chainId) }) };
}

function makeFakeSigner(provider: unknown = makeFakeProvider()): Signer {
  return {
    provider,
    getAddress: vi.fn().mockResolvedValue(REGISTRANT),
    connect: vi.fn((p: unknown) => makeFakeSigner(p)),
  } as unknown as Signer;
}

let fakeContract: FakeContract;

beforeEach(() => {
  fakeContract = makeFakeContract();
  // `new` requires the mock's own implementation to be constructible, so
  // these must be plain `function`s, not arrow functions.
  (Contract as unknown as Mock).mockImplementation(function () {
    return fakeContract;
  });
  (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
    return {};
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Hallmarq construction", () => {
  it("throws ConfigError at construction when registryAddress is missing", () => {
    expect(() => new Hallmarq({ rpcUrl: RPC_URL })).toThrow(ConfigError);
  });

  it("throws ConfigError at construction when rpcUrl is missing", () => {
    expect(() => new Hallmarq({ registryAddress: REGISTRY_ADDRESS })).toThrow(ConfigError);
  });

  it("does not touch the network at construction (no provider call is made)", () => {
    const signer = makeFakeSigner();
    new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS, signer });
    expect((signer.provider as unknown as { getNetwork: Mock }).getNetwork).not.toHaveBeenCalled();
  });

  it("connects a signer that has no provider to its own resolved provider", () => {
    const bareSigner = makeFakeSigner(null);
    new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS, signer: bareSigner });
    expect((bareSigner as unknown as { connect: Mock }).connect).toHaveBeenCalledTimes(1);
  });

  it("uses the signer's own provider when it has one, not a new JsonRpcProvider", () => {
    const signer = makeFakeSigner();
    new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS, signer });
    expect(JsonRpcProvider).not.toHaveBeenCalled();
  });
});

describe("Hallmarq.hashText / hashBytes (re-exported from core)", () => {
  it("delegate to @hallmarq/core's hashText and hashBytes exactly", () => {
    const hallmarq = new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS });
    expect(hallmarq.hashText("Hello")).toBe(hashText("Hello"));
    const bytes = new TextEncoder().encode("Hello");
    expect(hallmarq.hashBytes(bytes)).toBe(hashBytes(bytes));
  });
});

describe("Hallmarq.stamp", () => {
  function makeHallmarq(options: { signer?: unknown } = {}) {
    const signer = "signer" in options ? options.signer : makeFakeSigner();
    return new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      chainId: CHAIN_ID,
      signer: signer as never,
    });
  }

  it("throws NoSigner when constructed without a signer", async () => {
    const hallmarq = new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS });
    await expect(hallmarq.stamp("hello", { model: "gpt-4o" })).rejects.toThrow(NoSigner);
  });

  it("throws EmptyContent for an empty (or whitespace-only) string, before touching the network", async () => {
    const hallmarq = makeHallmarq();
    await expect(hallmarq.stamp("   ", { model: "gpt-4o" })).rejects.toThrow(EmptyContent);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
  });

  it("throws EmptyContent for empty bytes", async () => {
    const hallmarq = makeHallmarq();
    await expect(hallmarq.stamp(new Uint8Array(0), { model: "gpt-4o" })).rejects.toThrow(
      EmptyContent,
    );
  });

  it("throws InvalidUtf8 for a string with an unpaired surrogate", async () => {
    const hallmarq = makeHallmarq();
    await expect(hallmarq.stamp("\ud800", { model: "gpt-4o" })).rejects.toThrow(InvalidUtf8);
  });

  it("throws ModelTooLong when the model label exceeds 64 UTF-8 bytes, before touching the network", async () => {
    const hallmarq = makeHallmarq();
    await expect(hallmarq.stamp("hello", { model: "a".repeat(65) })).rejects.toThrow(ModelTooLong);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
  });

  it("accepts a model label of exactly 64 UTF-8 bytes", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 1 }),
    });
    const hallmarq = makeHallmarq();
    await expect(hallmarq.stamp("hello", { model: "a".repeat(64) })).resolves.toBeDefined();
  });

  it("throws InvalidMeta for meta that can't be canonical JSON, before touching the network", async () => {
    const hallmarq = makeHallmarq();
    await expect(
      hallmarq.stamp("hello", { model: "gpt-4o", meta: { bad: undefined } }),
    ).rejects.toThrow(InvalidMeta);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
  });

  it("hashes meta to the same metaHash canonicalJsonStringify + hashBytes would produce", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 1 }),
    });
    const hallmarq = makeHallmarq();
    const meta = { b: 1, a: { z: 1, y: 2 } };
    const expectedMetaHash = hashBytes(new TextEncoder().encode(canonicalJsonStringify(meta)));

    await hallmarq.stamp("hello", { model: "gpt-4o", meta });

    expect(fakeContract.stamp.staticCall).toHaveBeenCalledWith(
      hashText("hello"),
      "gpt-4o",
      expectedMetaHash,
    );
    expect(fakeContract.stamp).toHaveBeenCalledWith(hashText("hello"), "gpt-4o", expectedMetaHash);
  });

  it("uses the zero hash for metaHash when meta is omitted", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 1 }),
    });
    const hallmarq = makeHallmarq();
    await hallmarq.stamp("hello", { model: "gpt-4o" });
    const zeroHash = "0x" + "0".repeat(64);
    expect(fakeContract.stamp.staticCall).toHaveBeenCalledWith(
      hashText("hello"),
      "gpt-4o",
      zeroHash,
    );
  });

  it("checks the network before the first write, throwing WrongNetwork on a mismatch", async () => {
    const signer = makeFakeSigner(makeFakeProvider(999));
    const hallmarq = makeHallmarq({ signer });
    await expect(hallmarq.stamp("hello", { model: "gpt-4o" })).rejects.toThrow(WrongNetwork);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
  });

  it("only checks the network once, not on every stamp call", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 1 }),
    });
    const signer = makeFakeSigner();
    const hallmarq = makeHallmarq({ signer });

    await hallmarq.stamp("one", { model: "gpt-4o" });
    await hallmarq.stamp("two", { model: "gpt-4o" });

    expect((signer.provider as unknown as { getNetwork: Mock }).getNetwork).toHaveBeenCalledTimes(
      1,
    );
  });

  it("skips the network check entirely when chainId isn't configured", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 1 }),
    });
    const signer = makeFakeSigner();
    const hallmarq = new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS, signer });
    await hallmarq.stamp("hello", { model: "gpt-4o" });
    expect((signer.provider as unknown as { getNetwork: Mock }).getNetwork).not.toHaveBeenCalled();
  });

  it("throws AlreadyStamped(contentHash) from the preflight, without ever sending a transaction", async () => {
    const contentHash = hashText("hello");
    fakeContract.stamp.staticCall.mockRejectedValue(
      callException({ name: "AlreadyStamped", args: [contentHash] }),
    );
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyStamped);
    expect((error as AlreadyStamped).contentHash).toBe(contentHash);
    expect(fakeContract.stamp).not.toHaveBeenCalled();
  });

  it("retries a transient send failure (no tx hash yet) and succeeds on a later attempt", async () => {
    fakeContract.stamp.mockRejectedValueOnce(networkFailure()).mockResolvedValueOnce({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue({ blockNumber: 42 }),
    });
    const hallmarq = makeHallmarq();

    const receipt = await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect(fakeContract.stamp).toHaveBeenCalledTimes(2);
    expect(receipt.blockNumber).toBe(42);
  }, 10_000);

  it("never retries a revert (CALL_EXCEPTION) from the send step itself", async () => {
    fakeContract.stamp.mockRejectedValue(callException({ name: "ModelTooLong", args: [] }));
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTooLong);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("wraps an unrecognized network failure that exhausts every retry as NetworkError", async () => {
    fakeContract.stamp.mockRejectedValue(networkFailure());
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("never resends once a transaction hash exists: a wait() timeout throws NotConfirmed, not a second send", async () => {
    const hangingWait = vi.fn(() => new Promise(() => {}));
    fakeContract.stamp.mockResolvedValue({ hash: "0xtx", wait: hangingWait });
    const hallmarq = new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      signer: makeFakeSigner(),
      confirmTimeoutMs: 20,
    });

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfirmed);
    expect((error as NotConfirmed).txHash).toBe("0xtx");
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("throws NotConfirmed when wait() resolves null, without resending", async () => {
    fakeContract.stamp.mockResolvedValue({ hash: "0xtx", wait: vi.fn().mockResolvedValue(null) });
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfirmed);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("never resends when wait() itself rejects with a network failure (wraps as NetworkError)", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockRejectedValue(networkFailure()),
    });
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("decodes AlreadyStamped from a late revert surfaced through wait() (a race after preflight)", async () => {
    const contentHash = hashText("hello");
    fakeContract.stamp.mockResolvedValue({
      hash: "0xtx",
      wait: vi
        .fn()
        .mockRejectedValue(callException({ name: "AlreadyStamped", args: [contentHash] })),
    });
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyStamped);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("returns a Receipt with every field on success", async () => {
    fakeContract.stamp.mockResolvedValue({
      hash: "0xdeadbeef",
      wait: vi.fn().mockResolvedValue({ blockNumber: 777 }),
    });
    const hallmarq = makeHallmarq();

    const receipt = await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect(receipt).toEqual({
      contentHash: hashText("hello"),
      txHash: "0xdeadbeef",
      blockNumber: 777,
      registrant: REGISTRANT,
      model: "gpt-4o",
    });
  });

  it("wraps a thrown non-Error, non-ethers value as NetworkError (never lets it escape raw)", async () => {
    fakeContract.stamp.staticCall.mockRejectedValue("a plain string, not an Error");
    const hallmarq = makeHallmarq();

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HallmarqError);
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe("Hallmarq.verify", () => {
  function makeHallmarq() {
    return new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS });
  }

  it("works without a signer at all", async () => {
    fakeContract.verify.mockResolvedValue({
      registrant: "0x0000000000000000000000000000000000000000",
      timestamp: 0n,
      metaHash: "0x" + "0".repeat(64),
      model: "",
    });
    const hallmarq = makeHallmarq();
    await expect(hallmarq.verify("never stamped")).resolves.toMatchObject({ status: "not-found" });
  });

  it("returns not-found with the computed contentHash when the registrant is the zero address", async () => {
    fakeContract.verify.mockResolvedValue({
      registrant: "0x0000000000000000000000000000000000000000",
      timestamp: 0n,
      metaHash: "0x" + "0".repeat(64),
      model: "",
    });
    const hallmarq = makeHallmarq();
    const result = await hallmarq.verify("hello");
    expect(result).toEqual({ status: "not-found", contentHash: hashText("hello") });
  });

  it("returns found with every field, read from the contract and the Stamped event log", async () => {
    const contentHash = hashText("hello");
    const metaHash = "0x" + "ab".repeat(32);
    fakeContract.verify.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1_700_000_000n,
      metaHash,
      model: "gpt-4o",
    });
    fakeContract.queryFilter.mockResolvedValue([{ blockNumber: 555, transactionHash: "0xtxhash" }]);

    const hallmarq = makeHallmarq();
    const result = await hallmarq.verify("hello");

    expect(result).toEqual({
      status: "found",
      contentHash,
      registrant: REGISTRANT,
      model: "gpt-4o",
      metaHash,
      timestamp: 1_700_000_000,
      blockNumber: 555,
      txHash: "0xtxhash",
    });
  });

  it("queries the Stamped event from deploymentBlock, not block 0, when configured", async () => {
    fakeContract.verify.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1n,
      metaHash: "0x" + "0".repeat(64),
      model: "gpt-4o",
    });
    fakeContract.queryFilter.mockResolvedValue([{ blockNumber: 1, transactionHash: "0xtx" }]);

    const hallmarq = new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      deploymentBlock: 12_345,
    });
    await hallmarq.verify("hello");

    expect(fakeContract.queryFilter).toHaveBeenCalledWith(expect.anything(), 12_345, "latest");
  });

  it("wraps a missing event despite a non-zero registrant as NetworkError", async () => {
    fakeContract.verify.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1n,
      metaHash: "0x" + "0".repeat(64),
      model: "gpt-4o",
    });
    fakeContract.queryFilter.mockResolvedValue([]);

    const hallmarq = makeHallmarq();
    await expect(hallmarq.verify("hello")).rejects.toThrow(NetworkError);
  });

  it("wraps a raw provider failure as NetworkError", async () => {
    fakeContract.verify.mockRejectedValue(networkFailure());
    const hallmarq = makeHallmarq();
    const error: unknown = await hallmarq.verify("hello").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe("Hallmarq.verifyInBatch", () => {
  function makeHallmarq() {
    return new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS });
  }

  const validRoot = "0x" + "aa".repeat(32);
  const validProofElement = "0x" + "bb".repeat(32);

  it("throws InvalidHex for a malformed root, before calling the contract", async () => {
    const hallmarq = makeHallmarq();
    await expect(
      hallmarq.verifyInBatch("hello", { root: "not-a-hash", proof: [] }),
    ).rejects.toThrow(InvalidHex);
    expect(fakeContract.getBatch).not.toHaveBeenCalled();
  });

  it("throws InvalidHex for a malformed proof element", async () => {
    const hallmarq = makeHallmarq();
    await expect(
      hallmarq.verifyInBatch("hello", { root: validRoot, proof: ["not-a-hash"] }),
    ).rejects.toThrow(InvalidHex);
  });

  it("returns not-found when the root was never stamped", async () => {
    fakeContract.getBatch.mockResolvedValue({
      registrant: "0x0000000000000000000000000000000000000000",
      timestamp: 0n,
      count: 0n,
      model: "",
    });
    const hallmarq = makeHallmarq();
    const result = await hallmarq.verifyInBatch("hello", { root: validRoot, proof: [] });
    expect(result).toEqual({ status: "not-found", contentHash: hashText("hello") });
    expect(fakeContract.verifyInBatch).not.toHaveBeenCalled();
  });

  it("returns not-found when the batch exists but the proof doesn't verify", async () => {
    fakeContract.getBatch.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1n,
      count: 2n,
      model: "gpt-4o",
    });
    fakeContract.verifyInBatch.mockResolvedValue(false);
    const hallmarq = makeHallmarq();
    const result = await hallmarq.verifyInBatch("hello", {
      root: validRoot,
      proof: [validProofElement],
    });
    expect(result).toEqual({ status: "not-found", contentHash: hashText("hello") });
  });

  it("returns found-in-batch with every field when the proof verifies", async () => {
    fakeContract.getBatch.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1_700_000_000n,
      count: 3n,
      model: "gpt-4o",
    });
    fakeContract.verifyInBatch.mockResolvedValue(true);
    fakeContract.queryFilter.mockResolvedValue([{ blockNumber: 99, transactionHash: "0xbatchtx" }]);

    const hallmarq = makeHallmarq();
    const result = await hallmarq.verifyInBatch("hello", {
      root: validRoot,
      proof: [validProofElement],
    });

    expect(result).toEqual({
      status: "found-in-batch",
      contentHash: hashText("hello"),
      registrant: REGISTRANT,
      model: "gpt-4o",
      count: 3,
      timestamp: 1_700_000_000,
      root: validRoot,
      blockNumber: 99,
      txHash: "0xbatchtx",
    });
  });
});
