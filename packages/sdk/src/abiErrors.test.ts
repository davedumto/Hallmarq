import { Interface } from "ethers";
import { describe, expect, it } from "vitest";

import { toHallmarqError } from "./abiErrors.js";
import { AlreadyStamped, ModelTooLong, NetworkError } from "./errors.js";
import { stampRegistryAbi } from "./generated/stampRegistryAbi.js";

const registryInterface = new Interface(stampRegistryAbi);

function callException(revert: { name: string; args: unknown[] } | null) {
  return { code: "CALL_EXCEPTION", action: "call", data: "0x", reason: null, revert };
}

/**
 * Hardhat's in-process EDR network doesn't throw a standard ethers
 * `CallExceptionError`; it throws its own error with the raw ABI-encoded
 * revert data on `.data` instead. This builds that shape directly.
 */
function edrRevert(name: string, args: unknown[]) {
  const data = registryInterface.encodeErrorResult(name, args);
  return Object.assign(new Error(`reverted with custom error '${name}'`), { code: 3, data });
}

describe("toHallmarqError", () => {
  it("maps AlreadyStamped(key) to the SDK's AlreadyStamped, carrying the key", () => {
    const key = "0x" + "ab".repeat(32);
    const error = toHallmarqError(callException({ name: "AlreadyStamped", args: [key] }));
    expect(error).toBeInstanceOf(AlreadyStamped);
    expect((error as AlreadyStamped).contentHash).toBe(key);
    expect((error as AlreadyStamped).code).toBe("ALREADY_STAMPED");
  });

  it("maps ModelTooLong to the SDK's ModelTooLong", () => {
    const error = toHallmarqError(callException({ name: "ModelTooLong", args: [] }));
    expect(error).toBeInstanceOf(ModelTooLong);
    expect((error as ModelTooLong).code).toBe("MODEL_TOO_LONG");
  });

  it("wraps an unrecognized revert (e.g. EmptyHash) in NetworkError", () => {
    const original = callException({ name: "EmptyHash", args: [] });
    const error = toHallmarqError(original);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(original);
  });

  it("wraps a call exception with no decoded revert in NetworkError", () => {
    const original = callException(null);
    const error = toHallmarqError(original);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(original);
  });

  it("wraps a non-call-exception error (a plain network failure) in NetworkError", () => {
    const original = Object.assign(new Error("timeout"), { code: "TIMEOUT" });
    const error = toHallmarqError(original);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(original);
  });

  it("wraps a thrown non-object value in NetworkError", () => {
    const error = toHallmarqError("boom");
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe("boom");
  });

  it("decodes AlreadyStamped from Hardhat's EDR-shaped error (raw `.data`, not a CallException)", () => {
    const key = "0x" + "cd".repeat(32);
    const error = toHallmarqError(edrRevert("AlreadyStamped", [key]));
    expect(error).toBeInstanceOf(AlreadyStamped);
    expect((error as AlreadyStamped).contentHash).toBe(key);
  });

  it("decodes ModelTooLong from Hardhat's EDR-shaped error", () => {
    const error = toHallmarqError(edrRevert("ModelTooLong", []));
    expect(error).toBeInstanceOf(ModelTooLong);
  });

  it("wraps an EDR-shaped error whose `.data` isn't decodable through this ABI in NetworkError", () => {
    const original = Object.assign(new Error("reverted"), { code: 3, data: "0xdeadbeef" });
    const error = toHallmarqError(original);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(original);
  });

  it("wraps an error whose `.data` isn't a hex string in NetworkError", () => {
    const original = Object.assign(new Error("reverted"), { code: 3, data: 123 });
    const error = toHallmarqError(original);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(original);
  });
});
