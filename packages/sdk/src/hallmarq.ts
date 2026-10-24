import {
  assertHash32,
  EmptyContent,
  HallmarqError,
  hashBytes,
  hashText,
  mstTestnet,
  normalizeText,
} from "@hallmarq/core";
import type { Hex } from "@hallmarq/core";
import {
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  ZeroHash,
  type ContractTransactionResponse,
  type Provider,
  type Signer,
} from "ethers";

import { toHallmarqError } from "./abiErrors.js";
import { canonicalJsonStringify } from "./canonicalJson.js";
import { ConfigError, ModelTooLong, NoSigner, NotConfirmed, WrongNetwork } from "./errors.js";
import { stampRegistryAbi } from "./generated/stampRegistryAbi.js";
import { withRetry } from "./retry.js";
import type {
  HallmarqOptions,
  Receipt,
  StampOptions,
  VerifyInBatchOptions,
  VerifyResult,
} from "./types.js";

const MAX_MODEL_BYTES = 64;

/**
 * The raw shapes `StampRegistry.verify`/`getBatch` resolve to. Without
 * TypeChain, ethers' generic `Contract` types every call `any`; these let
 * the one cast at each call site stand in for the real ABI-derived type,
 * instead of `any` leaking through every field access after it.
 */
interface StampStruct {
  readonly registrant: string;
  readonly timestamp: bigint;
  readonly metaHash: string;
  readonly model: string;
}

interface BatchStruct {
  readonly registrant: string;
  readonly timestamp: bigint;
  readonly count: bigint;
  readonly model: string;
}

function computeContentHash(content: string | Uint8Array): Hex {
  return typeof content === "string" ? hashText(content) : hashBytes(content);
}

function assertContentNotEmpty(content: string | Uint8Array): void {
  const isEmpty =
    typeof content === "string" ? normalizeText(content) === "" : content.length === 0;
  if (isEmpty) {
    throw new EmptyContent();
  }
}

function assertModelNotTooLong(model: string): void {
  if (new TextEncoder().encode(model).length > MAX_MODEL_BYTES) {
    throw new ModelTooLong();
  }
}

function computeMetaHash(meta: Record<string, unknown> | undefined): Hex {
  if (meta === undefined) {
    return ZeroHash as Hex;
  }
  const canonical = canonicalJsonStringify(meta);
  return hashBytes(new TextEncoder().encode(canonical));
}

/**
 * Waits for `tx` to reach `confirmations`, racing against `timeoutMs`.
 * Never resends `tx` — a transaction hash already exists by the time this
 * is called, so from here it's either confirmed or {@link NotConfirmed}.
 */
async function waitForConfirmations(
  tx: ContractTransactionResponse,
  confirmations: number,
  timeoutMs: number,
) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new NotConfirmed(tx.hash)), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const receipt = await Promise.race([tx.wait(confirmations), timeout]);
    if (receipt === null) {
      throw new NotConfirmed(tx.hash);
    }
    return receipt;
  } catch (error) {
    if (error instanceof NotConfirmed) {
      throw error;
    }
    throw toHallmarqError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Hashes content and talks to a deployed `StampRegistry` through ethers.js.
 * Never sends content or prompts anywhere — only the hash leaves the
 * caller's machine — and never stores or generates keys; signing is the
 * caller's own `Signer`.
 */
export class Hallmarq {
  readonly #provider: Provider;
  #signer: Signer | undefined;
  readonly #readOnly: Contract;
  readonly #signerContract: Contract | undefined;
  readonly #chainId: number | undefined;
  readonly #deploymentBlock: number | undefined;
  readonly #confirmations: number;
  readonly #confirmTimeoutMs: number;
  #networkChecked = false;

  constructor(options: HallmarqOptions = {}) {
    const rpcUrl = options.rpcUrl ?? mstTestnet.rpcUrl;
    const chainId = options.chainId ?? mstTestnet.chainId;
    const registryAddress = options.registryAddress ?? mstTestnet.registryAddress;
    const deploymentBlock = options.deploymentBlock ?? mstTestnet.deploymentBlock;

    if (!registryAddress) {
      throw new ConfigError(
        "registryAddress is required: no default is configured for this network yet",
      );
    }
    if (!rpcUrl) {
      throw new ConfigError("rpcUrl is required: no default is configured for this network yet");
    }

    try {
      this.#signer = options.signer;
      this.#provider = this.#signer?.provider ?? new JsonRpcProvider(rpcUrl);
      if (this.#signer && !this.#signer.provider) {
        this.#signer = this.#signer.connect(this.#provider);
      }

      this.#chainId = chainId;
      this.#deploymentBlock = deploymentBlock;
      this.#confirmations = options.confirmations ?? 2;
      this.#confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;

      this.#readOnly = new Contract(registryAddress, stampRegistryAbi, this.#provider);
      this.#signerContract = this.#signer
        ? new Contract(registryAddress, stampRegistryAbi, this.#signer)
        : undefined;
    } catch (error) {
      if (error instanceof HallmarqError) {
        throw error;
      }
      throw new ConfigError(`Could not construct Hallmarq: ${String(error)}`);
    }
  }

  /** Normalizes and hashes text per the hashing specification. Re-exported from `@hallmarq/core`. */
  hashText(text: string | Uint8Array): Hex {
    return hashText(text);
  }

  /** Hashes raw bytes with no normalization. Re-exported from `@hallmarq/core`. */
  hashBytes(bytes: Uint8Array): Hex {
    return hashBytes(bytes);
  }

  async #ensureCorrectNetwork(): Promise<void> {
    if (this.#networkChecked || this.#chainId === undefined) {
      return;
    }
    const network = await this.#provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (actualChainId !== this.#chainId) {
      throw new WrongNetwork(this.#chainId, actualChainId);
    }
    this.#networkChecked = true;
  }

  /**
   * Sends one stamp transaction and waits for confirmations.
   *
   * Validates everything it can client-side first (content, model, meta),
   * then preflights with `staticCall` so a would-be revert (most commonly
   * `AlreadyStamped`) is caught without spending gas. Only the broadcast
   * step itself is retried on a network failure (up to 3 attempts, growing
   * delays); once a transaction hash exists, this never resends — it
   * either waits for confirmations or throws {@link NotConfirmed}.
   */
  async stamp(content: string | Uint8Array, options: StampOptions): Promise<Receipt> {
    try {
      if (!this.#signerContract || !this.#signer) {
        throw new NoSigner();
      }

      assertContentNotEmpty(content);
      const contentHash = computeContentHash(content);
      assertModelNotTooLong(options.model);
      const metaHash = computeMetaHash(options.meta);

      await this.#ensureCorrectNetwork();

      try {
        await this.#signerContract.stamp.staticCall(contentHash, options.model, metaHash);
      } catch (error) {
        throw toHallmarqError(error);
      }

      let tx: ContractTransactionResponse;
      try {
        tx = await withRetry(
          async () =>
            (await this.#signerContract!.stamp(
              contentHash,
              options.model,
              metaHash,
            )) as ContractTransactionResponse,
        );
      } catch (error) {
        throw toHallmarqError(error);
      }

      const receipt = await waitForConfirmations(tx, this.#confirmations, this.#confirmTimeoutMs);

      return {
        contentHash,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        registrant: await this.#signer.getAddress(),
        model: options.model,
      };
    } catch (error) {
      if (error instanceof HallmarqError) {
        throw error;
      }
      throw toHallmarqError(error);
    }
  }

  /** Looks up `content`'s hash on-chain. Read-only; needs no signer. */
  async verify(content: string | Uint8Array): Promise<VerifyResult> {
    try {
      const contentHash = computeContentHash(content);
      const stamp = (await this.#readOnly.verify(contentHash)) as StampStruct;

      if (stamp.registrant === ZeroAddress) {
        return { status: "not-found", contentHash };
      }

      const fromBlock = this.#deploymentBlock ?? 0;
      const filter = this.#readOnly.filters.Stamped(contentHash);
      const logs = await this.#readOnly.queryFilter(filter, fromBlock, "latest");
      const log = logs[0];
      if (!log) {
        throw toHallmarqError(
          new Error(`Stamped event not found for ${contentHash} despite a non-zero registrant`),
        );
      }

      return {
        status: "found",
        contentHash,
        registrant: stamp.registrant,
        model: stamp.model,
        metaHash: stamp.metaHash as Hex,
        timestamp: Number(stamp.timestamp),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      };
    } catch (error) {
      if (error instanceof HallmarqError) {
        throw error;
      }
      throw toHallmarqError(error);
    }
  }

  /** Checks `content` against a Merkle batch. Read-only; needs no signer. */
  async verifyInBatch(
    content: string | Uint8Array,
    options: VerifyInBatchOptions,
  ): Promise<VerifyResult> {
    try {
      assertHash32(options.root);
      for (const element of options.proof) {
        assertHash32(element);
      }

      const contentHash = computeContentHash(content);
      const root = options.root as Hex;

      const batch = (await this.#readOnly.getBatch(root)) as BatchStruct;
      if (batch.registrant === ZeroAddress) {
        return { status: "not-found", contentHash };
      }

      const matches = (await this.#readOnly.verifyInBatch(
        root,
        contentHash,
        options.proof,
      )) as boolean;
      if (!matches) {
        return { status: "not-found", contentHash };
      }

      const fromBlock = this.#deploymentBlock ?? 0;
      const filter = this.#readOnly.filters.BatchStamped(root);
      const logs = await this.#readOnly.queryFilter(filter, fromBlock, "latest");
      const log = logs[0];
      if (!log) {
        throw toHallmarqError(
          new Error(`BatchStamped event not found for root ${root} despite a non-zero registrant`),
        );
      }

      return {
        status: "found-in-batch",
        contentHash,
        registrant: batch.registrant,
        model: batch.model,
        count: Number(batch.count),
        timestamp: Number(batch.timestamp),
        root,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      };
    } catch (error) {
      if (error instanceof HallmarqError) {
        throw error;
      }
      throw toHallmarqError(error);
    }
  }
}
