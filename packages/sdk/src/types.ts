import type { Hex, ReceiptFile } from "@hallmarq/core";
import type { Signer } from "ethers";

/**
 * Controls how `stampBatched` groups items into batches. Every open batch
 * (there's one per `model` label; see `StampBatchedOptions`) is sent once
 * it reaches `maxItems`, once `maxWaitMs` has passed since its first item,
 * or when `flush()` is called — whichever happens first.
 */
export interface BatchOptions {
  /** Items per batch before it's sent automatically. Default `256`. */
  readonly maxItems?: number;
  /** Milliseconds to wait, from the first item, before sending. Default `30000`. */
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
  /** Controls how `stampBatched` groups items into batches. See `BatchOptions`. */
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

/**
 * `stampRoot` (and therefore every batch) has no `metaHash` field at all —
 * unlike `stamp`, `stampBatched` doesn't accept `meta`.
 */
export interface StampBatchedOptions {
  /** A model label, for example `"gpt-4o"`. At most 64 UTF-8 bytes. One open batch per label. */
  readonly model: string;
}

export interface Receipt {
  readonly contentHash: Hex;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly registrant: string;
  readonly model: string;
}

/**
 * What `stampBatched` resolves with once its batch is confirmed. Everything
 * in `Receipt`, plus the batch's Merkle `root`, this item's own `proof`
 * (the chain only stores `root` — callers must keep `proof` themselves to
 * ever verify this item again), the batch's total size, this item's index
 * within it, and `receiptFile` — the same data as a ready-to-save
 * `ReceiptFile` (see `@hallmarq/core`).
 */
export interface BatchReceipt extends Receipt {
  readonly root: Hex;
  readonly proof: readonly Hex[];
  readonly batchSize: number;
  readonly index: number;
  readonly receiptFile: ReceiptFile;
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
