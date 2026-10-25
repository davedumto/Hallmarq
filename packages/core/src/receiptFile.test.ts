import { describe, expect, it } from "vitest";

import { InvalidReceipt } from "./errors.js";
import { parseReceiptFile, serializeReceiptFile, type ReceiptFile } from "./receiptFile.js";

const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);
const ROOT = "0x" + "cc".repeat(32);
const TX_HASH = "0x" + "dd".repeat(32);
const ADDRESS = "0x" + "ee".repeat(20);

const VALID: ReceiptFile = {
  version: 1,
  chainId: 31337,
  registryAddress: ADDRESS,
  contentHash: HASH_A,
  root: ROOT,
  proof: [HASH_B],
  model: "gpt-4o",
  txHash: TX_HASH,
  blockNumber: 42,
};

describe("parseReceiptFile", () => {
  it("accepts a valid receipt file (an already-parsed object)", () => {
    expect(parseReceiptFile(VALID)).toEqual(VALID);
  });

  it("accepts a valid receipt file as a JSON string", () => {
    expect(parseReceiptFile(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("accepts an empty proof (a batch of one)", () => {
    const single = { ...VALID, proof: [] };
    expect(parseReceiptFile(single)).toEqual(single);
  });

  it("accepts an empty model (the contract allows a zero-length label)", () => {
    const empty = { ...VALID, model: "" };
    expect(parseReceiptFile(empty)).toEqual(empty);
  });

  it("throws InvalidReceipt for a string that isn't valid JSON", () => {
    expect(() => parseReceiptFile("{not json")).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt for null", () => {
    expect(() => parseReceiptFile(null)).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt for a non-object (a JSON array, a number, a string)", () => {
    expect(() => parseReceiptFile([VALID])).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile(42)).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile('"just a string"')).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt for an unknown extra field", () => {
    expect(() => parseReceiptFile({ ...VALID, extra: "field" })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when version is not 1", () => {
    expect(() => parseReceiptFile({ ...VALID, version: 2 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, version: "1" })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, version: undefined })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when chainId is not a positive safe integer", () => {
    expect(() => parseReceiptFile({ ...VALID, chainId: 0 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, chainId: -1 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, chainId: 1.5 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, chainId: "31337" })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, chainId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      InvalidReceipt,
    );
  });

  it("throws InvalidReceipt when registryAddress isn't a 20-byte hex address", () => {
    expect(() => parseReceiptFile({ ...VALID, registryAddress: "0x1234" })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, registryAddress: HASH_A })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, registryAddress: 123 })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when contentHash isn't a 32-byte hash", () => {
    expect(() => parseReceiptFile({ ...VALID, contentHash: "0x1234" })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, contentHash: ADDRESS })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, contentHash: 123 })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when root isn't a 32-byte hash", () => {
    expect(() => parseReceiptFile({ ...VALID, root: "not-hex" })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when proof isn't an array", () => {
    expect(() => parseReceiptFile({ ...VALID, proof: HASH_A })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, proof: null })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when a proof element isn't a 32-byte hash", () => {
    expect(() => parseReceiptFile({ ...VALID, proof: [HASH_B, "0x1234"] })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when model isn't a string", () => {
    expect(() => parseReceiptFile({ ...VALID, model: 123 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, model: null })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when txHash isn't a 32-byte hash", () => {
    expect(() => parseReceiptFile({ ...VALID, txHash: "0xabc" })).toThrow(InvalidReceipt);
  });

  it("throws InvalidReceipt when blockNumber is not a positive safe integer", () => {
    expect(() => parseReceiptFile({ ...VALID, blockNumber: 0 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, blockNumber: -5 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, blockNumber: 1.1 })).toThrow(InvalidReceipt);
    expect(() => parseReceiptFile({ ...VALID, blockNumber: "42" })).toThrow(InvalidReceipt);
  });

  it("names the offending field in the error message", () => {
    expect.assertions(1);
    try {
      parseReceiptFile({ ...VALID, chainId: -1 });
    } catch (error) {
      expect((error as Error).message).toContain("chainId");
    }
  });
});

describe("serializeReceiptFile", () => {
  it("round-trips through parseReceiptFile", () => {
    expect(parseReceiptFile(serializeReceiptFile(VALID))).toEqual(VALID);
  });

  it("round-trips a receipt with an empty proof", () => {
    const single = { ...VALID, proof: [] };
    expect(parseReceiptFile(serializeReceiptFile(single))).toEqual(single);
  });

  it("always writes fields in the same order, regardless of input field order", () => {
    const reordered: ReceiptFile = {
      blockNumber: VALID.blockNumber,
      txHash: VALID.txHash,
      model: VALID.model,
      proof: VALID.proof,
      root: VALID.root,
      contentHash: VALID.contentHash,
      registryAddress: VALID.registryAddress,
      chainId: VALID.chainId,
      version: VALID.version,
    };
    expect(serializeReceiptFile(reordered)).toBe(serializeReceiptFile(VALID));
    expect(Object.keys(JSON.parse(serializeReceiptFile(VALID)) as object)).toEqual([
      "version",
      "chainId",
      "registryAddress",
      "contentHash",
      "root",
      "proof",
      "model",
      "txHash",
      "blockNumber",
    ]);
  });

  it("ends with a trailing newline", () => {
    expect(serializeReceiptFile(VALID).endsWith("\n")).toBe(true);
  });
});
