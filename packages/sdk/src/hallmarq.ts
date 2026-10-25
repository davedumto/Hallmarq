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
  isCallException,
  JsonRpcProvider,
  keccak256,
  ZeroAddress,
  ZeroHash,
  type Provider,
  type Signer,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";

import { toHallmarqError } from "./abiErrors.js";
import { canonicalJsonStringify } from "./canonicalJson.js";
import {
  AlreadyStamped,
  ConfigError,
  ModelTooLong,
  NoSigner,
  NotConfirmed,
  WrongNetwork,
} from "./errors.js";
import { stampRegistryAbi } from "./generated/stampRegistryAbi.js";
import { isRetryableError, withRetry } from "./retry.js";
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
 * True when a broadcast attempt failed because the exact same signed
 * transaction was already accepted by the node on an earlier attempt —
 * the normal outcome of retrying `broadcastTransaction` after its first
 * response was lost, not a real failure.
 */
function isAlreadyBroadcastError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED") {
    return true;
  }
  return typeof message === "string" && /already known|nonce too low/i.test(message);
}

/**
 * True only when a signer genuinely can't produce a raw signed
 * transaction — ethers' `UNSUPPORTED_OPERATION`, a JSON-RPC "method not
 * found" (`-32601`), or a message that plainly says so (this is how
 * Hardhat's own test signers report it: `"... is not implemented"`).
 * Deliberately narrow: a signer that *can* sign raw transactions but
 * whose signing prompt the user rejected (`ACTION_REJECTED`) must not
 * fall into the fallback send below, or the user gets prompted twice for
 * one `stamp()` call.
 */
function isUnsupportedSigning(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "UNSUPPORTED_OPERATION" || code === -32601) {
    return true;
  }
  return typeof message === "string" && /not supported|not implemented/i.test(message);
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
  readonly #registryAddress: string;
  readonly #chainId: number | undefined;
  readonly #deploymentBlock: number | undefined;
  readonly #confirmations: number;
  readonly #confirmTimeoutMs: number;
  #networkChecked = false;
  #contractExistenceChecked = false;

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

      this.#registryAddress = registryAddress;
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
   * Checked once, on the first call of any kind. Without this, a wrong
   * `registryAddress` (or a correct one on the wrong chain, when `chainId`
   * isn't configured) reads back as all-zero data — `verify` would report
   * `"not-found"` instead of the config error it actually is, which the
   * verifier page would show as "No record found" for content that may
   * well be stamped.
   */
  async #ensureContractExists(): Promise<void> {
    if (this.#contractExistenceChecked) {
      return;
    }
    const code = await this.#provider.getCode(this.#registryAddress);
    if (code === "0x") {
      throw new ConfigError(`No contract code found at registryAddress ${this.#registryAddress}`);
    }
    this.#contractExistenceChecked = true;
  }

  /**
   * Sends the stamp transaction, signing it once so that a retry — needed
   * only when the broadcast's response is lost, not when it fails outright
   * — can never end up as a second, independently-signed transaction. The
   * transaction (and its hash) is fixed before anything is sent; only the
   * idempotent re-broadcast of those exact signed bytes is retried.
   *
   * Not every signer can produce a raw signed transaction: a browser
   * wallet only exposes `eth_sendTransaction`, and even Hardhat's own test
   * signers don't implement `signTransaction`. For any of those (see
   * {@link isUnsupportedSigning}), this falls back to a single, unretried
   * send instead — nothing has been broadcast yet, so falling back is
   * always safe. Anything else `signTransaction` throws (a wallet
   * rejection in particular) is rethrown as-is, or the caller would get
   * prompted to sign twice for one `stamp()` call. See the README's
   * "Retries" section.
   */
  async #sendStampTransaction(
    contentHash: Hex,
    model: string,
    metaHash: Hex,
  ): Promise<TransactionResponse> {
    const signerContract = this.#signerContract!;
    const signer = this.#signer!;

    const populatedCall = await signerContract.stamp.populateTransaction(
      contentHash,
      model,
      metaHash,
    );
    const populated = await signer.populateTransaction(populatedCall);

    let raw: string;
    try {
      raw = await signer.signTransaction(populated);
    } catch (error) {
      if (isUnsupportedSigning(error)) {
        return (await signerContract.stamp(contentHash, model, metaHash)) as TransactionResponse;
      }
      throw error;
    }

    const txHash = keccak256(raw);
    try {
      return await withRetry(() => this.#provider.broadcastTransaction(raw));
    } catch (error) {
      if (isAlreadyBroadcastError(error)) {
        const existing = await this.#provider.getTransaction(txHash);
        if (existing) {
          return existing;
        }
      }
      if (isRetryableError(error)) {
        // Every attempt failed as a transport error, so the broadcast's
        // outcome is unknown: the signed transaction may have reached the
        // node despite the lost response, and could still be in flight.
        // The caller gets the hash to look up, never a reason to sign and
        // send a second, independent transaction for the same content.
        throw new NotConfirmed(txHash);
      }
      throw error;
    }
  }

  async #waitForConfirmations(
    tx: TransactionResponse,
    contentHash: Hex,
  ): Promise<TransactionReceipt> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new NotConfirmed(tx.hash)), this.#confirmTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const receipt = await Promise.race([tx.wait(this.#confirmations), timeout]);
      if (receipt === null) {
        throw new NotConfirmed(tx.hash);
      }
      return receipt;
    } catch (error) {
      if (error instanceof NotConfirmed) {
        throw error;
      }
      throw await this.#resolveMinedFailure(error, contentHash, tx.hash);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * A transaction that reverted after being mined throws here with no
   * decodable revert data (there's no `eth_call` response to parse one
   * from, only a receipt with `status: 0`), so {@link toHallmarqError}
   * alone can't tell a front-run apart from a genuine network failure. The
   * most common cause — someone else's stamp for the same content got
   * mined first, the front-running case `docs/SECURITY.md` names — is
   * resolved here by reading the registry back, so the caller gets the
   * specific, non-retryable {@link AlreadyStamped} instead of a
   * {@link NetworkError} that looks worth retrying forever.
   */
  async #resolveMinedFailure(error: unknown, contentHash: Hex, txHash: string): Promise<Error> {
    if (isCallException(error)) {
      try {
        const stamp = (await this.#readOnly.verify(contentHash)) as StampStruct;
        if (stamp.registrant !== ZeroAddress) {
          const signerAddress = await this.#signer!.getAddress();
          if (stamp.registrant.toLowerCase() !== signerAddress.toLowerCase()) {
            return new AlreadyStamped(contentHash, txHash);
          }
        }
      } catch {
        // The lookup itself failed; fall through to the generic mapping.
      }
    }
    return toHallmarqError(error);
  }

  /**
   * Sends one stamp transaction and waits for confirmations.
   *
   * Validates everything it can client-side first (content, model, meta),
   * then preflights with `staticCall` so a would-be revert (most commonly
   * `AlreadyStamped`) is caught without spending gas. The transaction is
   * signed once; only its broadcast is retried, and only for a network
   * failure before any response was received (see
   * {@link Hallmarq.#sendStampTransaction}). Once a transaction hash
   * exists, this never resends — it either waits for confirmations or
   * throws {@link NotConfirmed}.
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
      await this.#ensureContractExists();

      try {
        await this.#signerContract.stamp.staticCall(contentHash, options.model, metaHash);
      } catch (error) {
        throw toHallmarqError(error);
      }

      let tx: TransactionResponse;
      try {
        tx = await this.#sendStampTransaction(contentHash, options.model, metaHash);
      } catch (error) {
        // #sendStampTransaction can throw NotConfirmed directly (an
        // exhausted-retry broadcast whose outcome is unknown); that must
        // reach the caller as-is, not get re-wrapped into NetworkError.
        if (error instanceof HallmarqError) {
          throw error;
        }
        throw toHallmarqError(error);
      }

      const receipt = await this.#waitForConfirmations(tx, contentHash);

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
      await this.#ensureCorrectNetwork();
      await this.#ensureContractExists();

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

      await this.#ensureCorrectNetwork();
      await this.#ensureContractExists();

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
