import { Interface, isCallException, isHexString } from "ethers";

import { AlreadyStamped, ModelTooLong, NetworkError } from "./errors.js";
import { stampRegistryAbi } from "./generated/stampRegistryAbi.js";

const registryInterface = new Interface(stampRegistryAbi);

/**
 * A decoded custom error's name and args, from wherever a provider put the
 * raw revert data. ethers' own `CallExceptionError.revert` is one source;
 * Hardhat's in-process EDR network reports reverts through its own
 * `data`-bearing error instead of a standard `CallExceptionError`, so this
 * also decodes that shape directly through the contract's ABI.
 */
function decodeRevert(error: unknown): { name: string; args: readonly unknown[] } | undefined {
  if (isCallException(error) && error.revert) {
    return error.revert;
  }

  const data: unknown = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string" && isHexString(data)) {
    try {
      const decoded = registryInterface.parseError(data);
      if (decoded) {
        return { name: decoded.name, args: decoded.args };
      }
    } catch {
      // Not decodable through this ABI; fall through to NetworkError.
    }
  }

  return undefined;
}

/**
 * Turns a thrown error from a `StampRegistry` call into the matching typed
 * SDK error. Any revert this doesn't recognize (including the contract's
 * own `EmptyHash`/`EmptyBatch`, which the SDK's own validation should have
 * already ruled out before the call was ever made) and anything that isn't
 * a revert at all becomes a {@link NetworkError} wrapping the original
 * error as `cause`.
 */
export function toHallmarqError(error: unknown): Error {
  const revert = decodeRevert(error);
  switch (revert?.name) {
    case "AlreadyStamped":
      return new AlreadyStamped(String(revert.args[0]));
    case "ModelTooLong":
      return new ModelTooLong();
    default:
      return new NetworkError(error);
  }
}
