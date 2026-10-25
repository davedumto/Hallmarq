import type { Hex } from "@hallmarq/core";
import type { Signer } from "ethers";

/**
 * Reserved for `stampBatched`/`flush` (roadmap item 7). Accepted here so a
 * caller can pass it now without a breaking change later; `Hallmarq`
 * doesn't read it yet.
 */
export interface BatchOptions {
  readonly maxItems?: number;
  readonly maxWaitMs?: number;
}

export interface HallmarqOptions {
  /** MST RPC endpoint. Defaults from `@hallmarq/core`'s network config (D8). */
  readonly rpcUrl?: string;
  /** MST chain ID. Defaults from `@hallmarq/core`'s network config (D8). */
  readonly chainId?: number;
  /** Deployed `StampRegistry` address. Defaults from `@hallmarq/core`'s network config (D8). */
  readonly registryAddress?: string;
  /** Block `StampRegistry` was deployed at; event queries start here, not at block 0. */
  readonly deploymentBlock?: number;
  /** An ethers Signer. The SDK never stores keys; without one, only `verify`/hashing work. */
  readonly signer?: Signer;
  /** Blocks to wait for before `stamp` resolves. */
  readonly confirmations?: number;
  /** Milliseconds to wait for `confirmations` before `stamp` throws `NotConfirmed`. */
  readonly confirmTimeoutMs?: number;
  /** Reserved for roadmap item 7 (`stampBatched`/`flush`); unused by this version. */
  readonly batch?: BatchOptions;
}

export interface StampOptions {
  /** A model label, for example `"gpt-4o"`. At most 64 UTF-8 bytes. */
  readonly model: string;
  /**
   * Arbitrary metadata hashed into `metaHash` via canonical JSON. Omit it
   * (or pass nothing) to leave `metaHash` zero.
   */
  readonly meta?: Record<string, unknown>;
}

export interface Receipt {
  readonly contentHash: Hex;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly registrant: string;
  readonly model: string;
}

export interface VerifyInBatchOptions {
  readonly root: string;
  readonly proof: readonly string[];
}

export interface NotFoundResult {
  readonly status: "not-found";
  readonly contentHash: Hex;
}

export interface FoundResult {
  readonly status: "found";
  readonly contentHash: Hex;
  readonly registrant: string;
  readonly model: string;
  readonly metaHash: Hex;
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly txHash: string;
}

export interface FoundInBatchResult {
  readonly status: "found-in-batch";
  readonly contentHash: Hex;
  readonly registrant: string;
  readonly model: string;
  readonly count: number;
  readonly timestamp: number;
  readonly root: Hex;
  readonly blockNumber: number;
  readonly txHash: string;
}

export type VerifyResult = NotFoundResult | FoundResult | FoundInBatchResult;
