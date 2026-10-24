import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return { ...actual, Contract: vi.fn(), JsonRpcProvider: vi.fn() };
});

import { Contract, JsonRpcProvider, keccak256, type Signer } from "ethers";

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
const OTHER_REGISTRANT = "0x" + "33".repeat(20);
const RPC_URL = "http://fake-rpc.invalid";
const CHAIN_ID = 31337;
// A valid signed-transaction stand-in: not real RLP, but a hex string so
// `keccak256` can hash it, exactly as production code does to learn the
// transaction's hash before ever broadcasting it.
const RAW_SIGNED_TX = "0x" + "cd".repeat(100);

function callException(revert: { name: string; args: unknown[] } | null = null) {
  return Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION", data: "0x", revert });
}

function networkFailure() {
  return Object.assign(new Error("timeout"), { code: "TIMEOUT" });
}

function unsupportedSigning() {
  return Object.assign(new Error("not supported"), { code: "UNSUPPORTED_OPERATION" });
}

function alreadyKnown(): Error {
  return new Error("already known");
}

interface FakeContract {
  verify: Mock;
  getBatch: Mock;
  verifyInBatch: Mock;
  stamp: Mock & { staticCall: Mock; populateTransaction: Mock };
  filters: { Stamped: Mock; BatchStamped: Mock };
  queryFilter: Mock;
}

function makeFakeContract(): FakeContract {
  const stamp = vi.fn() as Mock & { staticCall: Mock; populateTransaction: Mock };
  stamp.staticCall = vi.fn().mockResolvedValue(undefined);
  stamp.populateTransaction = vi
    .fn()
    .mockResolvedValue({ to: REGISTRY_ADDRESS, data: "0xcalldata" });
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

interface FakeProvider {
  getNetwork: Mock;
  getCode: Mock;
  broadcastTransaction: Mock;
  getTransaction: Mock;
}

function makeFakeProvider(chainId = CHAIN_ID): FakeProvider {
  return {
    getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(chainId) }),
    // Non-"0x": there's code at registryAddress, so #ensureContractExists
    // passes silently by default; tests for that check override this.
    getCode: vi.fn().mockResolvedValue("0x1234"),
    broadcastTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };
}

function makeFakeSigner(provider: unknown = makeFakeProvider()): Signer {
  return {
    provider,
    getAddress: vi.fn().mockResolvedValue(REGISTRANT),
    connect: vi.fn((p: unknown) => makeFakeSigner(p)),
    populateTransaction: vi.fn((tx: unknown) => Promise.resolve(tx)),
    signTransaction: vi.fn().mockResolvedValue(RAW_SIGNED_TX),
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
    return makeFakeProvider();
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
  function makeHallmarq(signer: unknown = makeFakeSigner()) {
    return new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      chainId: CHAIN_ID,
      signer: signer as never,
    });
  }

  /** A signer/provider pair whose broadcast succeeds, returning the given tx. */
  function makeWritableSigner(tx: { hash: string; wait: Mock }) {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue(tx);
    return { provider, signer: makeFakeSigner(provider) };
  }

  function successfulTx(hash: string, blockNumber: number) {
    return { hash, wait: vi.fn().mockResolvedValue({ blockNumber }) };
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
    const { signer } = makeWritableSigner(successfulTx("0xtx", 1));
    const hallmarq = makeHallmarq(signer);
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
    const { signer } = makeWritableSigner(successfulTx("0xtx", 1));
    const hallmarq = makeHallmarq(signer);
    const meta = { b: 1, a: { z: 1, y: 2 } };
    const expectedMetaHash = hashBytes(new TextEncoder().encode(canonicalJsonStringify(meta)));

    await hallmarq.stamp("hello", { model: "gpt-4o", meta });

    expect(fakeContract.stamp.staticCall).toHaveBeenCalledWith(
      hashText("hello"),
      "gpt-4o",
      expectedMetaHash,
    );
    expect(fakeContract.stamp.populateTransaction).toHaveBeenCalledWith(
      hashText("hello"),
      "gpt-4o",
      expectedMetaHash,
    );
  });

  it("uses the zero hash for metaHash when meta is omitted", async () => {
    const { signer } = makeWritableSigner(successfulTx("0xtx", 1));
    const hallmarq = makeHallmarq(signer);
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
    const hallmarq = makeHallmarq(signer);
    await expect(hallmarq.stamp("hello", { model: "gpt-4o" })).rejects.toThrow(WrongNetwork);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
  });

  it("only checks the network and contract code once, not on every stamp call", async () => {
    const { provider, signer } = makeWritableSigner(successfulTx("0xtx", 1));
    const hallmarq = makeHallmarq(signer);

    await hallmarq.stamp("one", { model: "gpt-4o" });
    await hallmarq.stamp("two", { model: "gpt-4o" });

    expect(provider.getNetwork).toHaveBeenCalledTimes(1);
    expect(provider.getCode).toHaveBeenCalledTimes(1);
  });

  it("skips the network check entirely when chainId isn't configured", async () => {
    const { provider, signer } = makeWritableSigner(successfulTx("0xtx", 1));
    const hallmarq = new Hallmarq({ rpcUrl: RPC_URL, registryAddress: REGISTRY_ADDRESS, signer });
    await hallmarq.stamp("hello", { model: "gpt-4o" });
    expect(provider.getNetwork).not.toHaveBeenCalled();
  });

  it("throws ConfigError when there is no contract code at registryAddress", async () => {
    const provider = makeFakeProvider();
    provider.getCode.mockResolvedValue("0x");
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    await expect(hallmarq.stamp("hello", { model: "gpt-4o" })).rejects.toThrow(ConfigError);
    expect(fakeContract.stamp.staticCall).not.toHaveBeenCalled();
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
    expect(fakeContract.stamp.populateTransaction).not.toHaveBeenCalled();
  });

  it("signs the stamp transaction exactly once, even when the broadcast itself is retried", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce(successfulTx("0xtx", 1));
    const signer = makeFakeSigner(provider);
    const hallmarq = makeHallmarq(signer);

    await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect((signer as unknown as { signTransaction: Mock }).signTransaction).toHaveBeenCalledTimes(
      1,
    );
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  it("retries a transient broadcast failure (no tx hash yet) and succeeds on a later attempt", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce(successfulTx("0xtx", 42));
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const receipt = await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(2);
    expect(receipt.blockNumber).toBe(42);
  }, 10_000);

  it("never retries a non-retryable error from the broadcast step itself", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockRejectedValue(
      callException({ name: "ModelTooLong", args: [] }),
    );
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTooLong);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("wraps an unrecognized network failure that exhausts every retry as NetworkError", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockRejectedValue(networkFailure());
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("recovers from an 'already known' broadcast error by looking up the already-broadcast transaction, instead of resending", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockRejectedValue(alreadyKnown());
    const expectedTxHash = keccak256(RAW_SIGNED_TX);
    provider.getTransaction.mockResolvedValue({
      hash: expectedTxHash,
      wait: vi.fn().mockResolvedValue({ blockNumber: 9 }),
    });
    const signer = makeFakeSigner(provider);
    const hallmarq = makeHallmarq(signer);

    const receipt = await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect(receipt.blockNumber).toBe(9);
    expect(receipt.txHash).toBe(expectedTxHash);
    expect((signer as unknown as { signTransaction: Mock }).signTransaction).toHaveBeenCalledTimes(
      1,
    );
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(provider.getTransaction).toHaveBeenCalledWith(expectedTxHash);
  });

  it("falls back to a single, unretried send when the signer can't sign a raw transaction", async () => {
    const provider = makeFakeProvider();
    const signer = makeFakeSigner(provider);
    (signer.signTransaction as Mock).mockRejectedValue(unsupportedSigning());
    fakeContract.stamp.mockResolvedValue(successfulTx("0xtx", 1));
    const hallmarq = makeHallmarq(signer);

    const receipt = await hallmarq.stamp("hello", { model: "gpt-4o" });

    expect(receipt.txHash).toBe("0xtx");
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("never retries the fallback send for a signer that can't sign a raw transaction", async () => {
    const provider = makeFakeProvider();
    const signer = makeFakeSigner(provider);
    (signer.signTransaction as Mock).mockRejectedValue(unsupportedSigning());
    fakeContract.stamp.mockRejectedValue(networkFailure());
    const hallmarq = makeHallmarq(signer);

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(fakeContract.stamp).toHaveBeenCalledTimes(1);
  });

  it("never resends once a transaction hash exists: a wait() timeout throws NotConfirmed, not a second send", async () => {
    const hangingWait = vi.fn(() => new Promise(() => {}));
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({ hash: "0xtx", wait: hangingWait });
    const hallmarq = new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      signer: makeFakeSigner(provider),
      confirmTimeoutMs: 20,
    });

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfirmed);
    expect((error as NotConfirmed).txHash).toBe("0xtx");
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws NotConfirmed when wait() resolves null, without resending", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockResolvedValue(null),
    });
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfirmed);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("never resends when wait() itself rejects with a network failure (wraps as NetworkError)", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockRejectedValue(networkFailure()),
    });
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("resolves a mined-but-reverted tx to AlreadyStamped when someone else's stamp landed first (a front-run after preflight)", async () => {
    const contentHash = hashText("hello");
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockRejectedValue(callException(null)),
    });
    fakeContract.verify.mockResolvedValue({
      registrant: OTHER_REGISTRANT,
      timestamp: 1n,
      metaHash: "0x" + "0".repeat(64),
      model: "gpt-4o",
    });
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyStamped);
    expect((error as AlreadyStamped).contentHash).toBe(contentHash);
    expect((error as AlreadyStamped).txHash).toBe("0xtx");
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not misreport AlreadyStamped when a mined revert's registrant is actually us", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockRejectedValue(callException(null)),
    });
    fakeContract.verify.mockResolvedValue({
      registrant: REGISTRANT,
      timestamp: 1n,
      metaHash: "0x" + "0".repeat(64),
      model: "gpt-4o",
    });
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(AlreadyStamped);
  });

  it("wraps a mined revert as NetworkError when the registry lookup to resolve it also fails", async () => {
    const provider = makeFakeProvider();
    provider.broadcastTransaction.mockResolvedValue({
      hash: "0xtx",
      wait: vi.fn().mockRejectedValue(callException(null)),
    });
    fakeContract.verify.mockRejectedValue(networkFailure());
    const hallmarq = makeHallmarq(makeFakeSigner(provider));

    const error: unknown = await hallmarq
      .stamp("hello", { model: "gpt-4o" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it("returns a Receipt with every field on success", async () => {
    const { signer } = makeWritableSigner(successfulTx("0xdeadbeef", 777));
    const hallmarq = makeHallmarq(signer);

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
  function makeHallmarq(options: { chainId?: number } = {}) {
    return new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      chainId: options.chainId,
    });
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

  it("checks the network before reading, throwing WrongNetwork on a mismatch instead of a silent not-found", async () => {
    (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
      return makeFakeProvider(999);
    });
    const hallmarq = makeHallmarq({ chainId: CHAIN_ID });

    await expect(hallmarq.verify("hello")).rejects.toThrow(WrongNetwork);
    expect(fakeContract.verify).not.toHaveBeenCalled();
  });

  it("throws ConfigError when there is no contract code at registryAddress, instead of returning not-found", async () => {
    (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
      const provider = makeFakeProvider();
      provider.getCode.mockResolvedValue("0x");
      return provider;
    });
    const hallmarq = makeHallmarq();

    await expect(hallmarq.verify("hello")).rejects.toThrow(ConfigError);
    expect(fakeContract.verify).not.toHaveBeenCalled();
  });

  it("checks the network and contract code only once across multiple verify calls", async () => {
    fakeContract.verify.mockResolvedValue({
      registrant: "0x0000000000000000000000000000000000000000",
      timestamp: 0n,
      metaHash: "0x" + "0".repeat(64),
      model: "",
    });
    let provider: FakeProvider | undefined;
    (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
      provider = makeFakeProvider();
      return provider;
    });
    const hallmarq = makeHallmarq({ chainId: CHAIN_ID });

    await hallmarq.verify("one");
    await hallmarq.verify("two");

    expect(provider?.getNetwork).toHaveBeenCalledTimes(1);
    expect(provider?.getCode).toHaveBeenCalledTimes(1);
  });
});

describe("Hallmarq.verifyInBatch", () => {
  function makeHallmarq(options: { chainId?: number } = {}) {
    return new Hallmarq({
      rpcUrl: RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      chainId: options.chainId,
    });
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

  it("checks the network before calling the contract, throwing WrongNetwork on a mismatch", async () => {
    (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
      return makeFakeProvider(999);
    });
    const hallmarq = makeHallmarq({ chainId: CHAIN_ID });

    await expect(hallmarq.verifyInBatch("hello", { root: validRoot, proof: [] })).rejects.toThrow(
      WrongNetwork,
    );
    expect(fakeContract.getBatch).not.toHaveBeenCalled();
  });

  it("throws ConfigError when there is no contract code at registryAddress, instead of returning not-found", async () => {
    (JsonRpcProvider as unknown as Mock).mockImplementation(function () {
      const provider = makeFakeProvider();
      provider.getCode.mockResolvedValue("0x");
      return provider;
    });
    const hallmarq = makeHallmarq();

    await expect(hallmarq.verifyInBatch("hello", { root: validRoot, proof: [] })).rejects.toThrow(
      ConfigError,
    );
    expect(fakeContract.getBatch).not.toHaveBeenCalled();
  });
});
