import {
  assertHash32,
  buildTree,
  EmptyContent,
  getProof,
  HallmarqError,
  hashBytes,
  hashText,
  mstTestnet,
  normalizeText,
  parseReceiptFile,
} from "@hallmarq/core";
import type { Hex, MerkleTree, ReceiptFile } from "@hallmarq/core";
import {
  Contract,
  isCallException,
  JsonRpcProvider,
  keccak256,
  ZeroAddress,
  ZeroHash,
  type ContractTransaction,
  type Provider,
  type Signer,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";

import { toHallmarqError } from "./abiErrors.js";
import { canonicalJsonStringify } from "./canonicalJson.js";
import {
  AlreadyStamped,
  Closed,
  ConfigError,
  ModelTooLong,
  NonceOutOfSync,
  NoSigner,
  NotConfirmed,
  WrongNetwork,
} from "./errors.js";
import { stampRegistryAbi } from "./generated/stampRegistryAbi.js";
import { isRetryableError, withRetry } from "./retry.js";
import type {
  BatchReceipt,
  HallmarqOptions,
  Receipt,
  StampBatchedOptions,
  StampOptions,
  VerifyInBatchOptions,
  VerifyResult,
} from "./types.js";

const MAX_MODEL_BYTES = 64;
const DEFAULT_BATCH_MAX_ITEMS = 256;
const DEFAULT_BATCH_MAX_WAIT_MS = 30_000;
const MAX_BATCH_MAX_ITEMS = 2 ** 32 - 1;

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

/** One item queued by `stampBatched`, waiting for its batch to send. */
interface PendingBatchItem {
  readonly contentHash: Hex;
  readonly resolve: (receipt: BatchReceipt) => void;
  readonly reject: (error: unknown) => void;
}

/** One open batch: every item queued for `model` since the batch started. */
interface OpenBatch {
  readonly model: string;
  readonly items: PendingBatchItem[];
  timer: ReturnType<typeof setTimeout> | undefined;
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
 * one call.
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

function validateBatchMaxItems(maxItems: number): void {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_BATCH_MAX_ITEMS) {
    throw new ConfigError(
      `batch.maxItems must be an integer from 1 to ${MAX_BATCH_MAX_ITEMS}, got ${maxItems}`,
    );
  }
}

function validateBatchMaxWaitMs(maxWaitMs: number): void {
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new ConfigError(`batch.maxWaitMs must be a non-negative integer, got ${maxWaitMs}`);
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
  readonly #registryAddress: string;
  readonly #chainId: number | undefined;
  readonly #deploymentBlock: number | undefined;
  readonly #confirmations: number;
  readonly #confirmTimeoutMs: number;
  readonly #batchMaxItems: number;
  readonly #batchMaxWaitMs: number;
  #networkChecked = false;
  #contractExistenceChecked = false;
  readonly #openBatches = new Map<string, OpenBatch>();
  #closed = false;
  /**
   * An async mutex (a plain promise chain) serializing every
   * populate/sign/broadcast section across this instance. See
   * {@link Hallmarq.#withSendLock}.
   */
  #sendLock: Promise<void> = Promise.resolve();
  /**
   * Every `#sendBatch` call currently in flight, so `flush`/`close` can
   * wait for batches that already left `#openBatches` (sent by their own
   * timer or by reaching `maxItems`) and not just the ones they're about
   * to send themselves.
   */
  readonly #inFlightSends = new Set<Promise<void>>();
  /**
   * This instance's own record of the next nonce to use, kept because some
   * nodes' `eth_getTransactionCount(address, "pending")` doesn't include a
   * transaction this instance has already broadcast but that hasn't been
   * mined yet (MST's testnet node observed doing this — see the README's
   * "Retries/nonces" section). `undefined` means "unknown; trust the
   * node's own count next time", which is also the state after a
   * {@link NonceOutOfSync} resync.
   */
  #nextNonce: number | undefined;

  constructor(options: HallmarqOptions = {}) {
    const rpcUrl = options.rpcUrl ?? mstTestnet.rpcUrl;
    const chainId = options.chainId ?? mstTestnet.chainId;
    const registryAddress = options.registryAddress ?? mstTestnet.registryAddress;
    const deploymentBlock = options.deploymentBlock ?? mstTestnet.deploymentBlock;
    const batchMaxItems = options.batch?.maxItems ?? DEFAULT_BATCH_MAX_ITEMS;
    const batchMaxWaitMs = options.batch?.maxWaitMs ?? DEFAULT_BATCH_MAX_WAIT_MS;

    if (!registryAddress) {
      throw new ConfigError(
        "registryAddress is required: no default is configured for this network yet",
      );
    }
    if (!rpcUrl) {
      throw new ConfigError("rpcUrl is required: no default is configured for this network yet");
    }
    validateBatchMaxItems(batchMaxItems);
    validateBatchMaxWaitMs(batchMaxWaitMs);

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
      this.#batchMaxItems = batchMaxItems;
      this.#batchMaxWaitMs = batchMaxWaitMs;

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

  /** The chain ID to put in a `ReceiptFile`: the configured one, or the provider's actual one. */
  async #resolveChainId(): Promise<number> {
    if (this.#chainId !== undefined) {
      return this.#chainId;
    }
    const network = await this.#provider.getNetwork();
    return Number(network.chainId);
  }

  /**
   * A minimal async mutex: queues `fn` behind every call already queued on
   * this instance, via a plain promise chain (no dependency needed).
   * `populateTransaction` resolves the signer's `"pending"` nonce, so two
   * concurrent `#signAndBroadcast` calls racing through populate-then-sign
   * would both read the *same* nonce and each sign a transaction that
   * can't both land — one would always come back a `NetworkError`. This is
   * invisible against a signer whose nonce is assigned server-side (a
   * JSON-RPC wallet, or Hardhat's own test signers going through the
   * `eth_sendTransaction` fallback) but hits immediately with a plain
   * `ethers.Wallet`, the common case for a backend. Serializing only this
   * section (never confirmation waiting, which runs after `fn` resolves
   * and releases the lock) keeps batches confirming in parallel while
   * still ruling out the nonce race.
   */
  async #withSendLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#sendLock;
    let release!: () => void;
    this.#sendLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Signs `populateTx`'s transaction exactly once so that a retry — needed
   * only when the broadcast's response is lost, not when it fails outright
   * — can never end up as a second, independently-signed transaction. The
   * transaction (and its hash) is fixed before anything is sent; only the
   * idempotent re-broadcast of those exact signed bytes is retried. Shared
   * by `stamp` (`StampRegistry.stamp`) and the batch sender
   * (`StampRegistry.stampRoot`) — the only difference between them is which
   * contract call gets populated and, as a fallback, sent directly.
   *
   * Not every signer can produce a raw signed transaction: a browser
   * wallet only exposes `eth_sendTransaction`, and even Hardhat's own test
   * signers don't implement `signTransaction`. For any of those (see
   * {@link isUnsupportedSigning}), this falls back to `fallbackSend` — a
   * single, unretried send — instead; nothing has been broadcast yet, so
   * falling back is always safe. Anything else `signTransaction` throws (a
   * wallet rejection in particular) is rethrown as-is, or the caller would
   * get prompted to sign twice for one call. See the README's "Retries"
   * section.
   *
   * The whole populate/sign/broadcast (or fallback-send) section runs
   * under {@link Hallmarq.#withSendLock}, so two calls on this instance
   * never race for the same nonce; see that method's doc for why.
   *
   * The nonce itself is assigned explicitly — `max(#nextNonce, the node's
   * own "pending" count)` — rather than left for `signer.populateTransaction`
   * to resolve, because a serialized nonce from `#nextNonce` alone isn't
   * enough on a node whose "pending" count lags behind what this instance
   * has already broadcast (see {@link Hallmarq.#nextNonce}'s doc). If the
   * node rejects that nonce outright (not simply this same transaction
   * already landed), {@link Hallmarq.#nextNonce} is cleared and this send
   * fails with {@link NonceOutOfSync} rather than silently resigning and
   * resending — the no-resend rule applies here too.
   */
  async #signAndBroadcast(
    populateTx: () => Promise<ContractTransaction>,
    fallbackSend: (nonce: number) => Promise<TransactionResponse>,
  ): Promise<TransactionResponse> {
    return this.#withSendLock(async () => {
      const signer = this.#signer!;
      const address = await signer.getAddress();
      const nonce = Math.max(
        await this.#provider.getTransactionCount(address, "pending"),
        this.#nextNonce ?? 0,
      );

      const populatedCall = await populateTx();
      const populated = await signer.populateTransaction({ ...populatedCall, nonce });

      let raw: string;
      try {
        raw = await signer.signTransaction(populated);
      } catch (error) {
        if (isUnsupportedSigning(error)) {
          const tx = await fallbackSend(nonce);
          this.#nextNonce = nonce + 1;
          return tx;
        }
        throw error;
      }

      const txHash = keccak256(raw);
      try {
        const tx = await withRetry(() => this.#provider.broadcastTransaction(raw));
        this.#nextNonce = nonce + 1;
        return tx;
      } catch (error) {
        if (isAlreadyBroadcastError(error)) {
          const existing = await this.#provider.getTransaction(txHash);
          if (existing) {
            this.#nextNonce = nonce + 1;
            return existing;
          }
          // The node rejected this nonce, and it isn't because this exact
          // transaction already landed: this instance's nonce tracking has
          // drifted from what the node expects. Resync — the next send
          // re-reads "pending" from scratch — and fail this one outright.
          this.#nextNonce = undefined;
          throw new NonceOutOfSync(nonce, error);
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
    });
  }

  async #sendStampTransaction(
    contentHash: Hex,
    model: string,
    metaHash: Hex,
  ): Promise<TransactionResponse> {
    const signerContract = this.#signerContract!;
    return this.#signAndBroadcast(
      () => signerContract.stamp.populateTransaction(contentHash, model, metaHash),
      (nonce) =>
        signerContract.stamp(contentHash, model, metaHash, {
          nonce,
        }) as Promise<TransactionResponse>,
    );
  }

  async #sendStampRootTransaction(
    root: Hex,
    count: number,
    model: string,
  ): Promise<TransactionResponse> {
    const signerContract = this.#signerContract!;
    return this.#signAndBroadcast(
      () => signerContract.stampRoot.populateTransaction(root, count, model),
      (nonce) =>
        signerContract.stampRoot(root, count, model, {
          nonce,
        }) as Promise<TransactionResponse>,
    );
  }

  async #waitForConfirmations(
    tx: TransactionResponse,
    resolveMinedFailure: (error: unknown) => Promise<Error>,
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
      throw await resolveMinedFailure(error);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * A transaction that reverted after being mined throws here with no
   * decodable revert data (there's no `eth_call` response to parse one
   * from, only a receipt with `status: 0`), so {@link toHallmarqError}
   * alone can't tell a front-run apart from a genuine network failure. The
   * most common cause — someone else's stamp (or batch root) for the same
   * key got mined first, the front-running case `docs/SECURITY.md` names —
   * is resolved here by reading the registry back via `lookupRegistrant`,
   * so the caller gets the specific, non-retryable {@link AlreadyStamped}
   * instead of a {@link NetworkError} that looks worth retrying forever.
   * Shared by `stamp` (looks up by `contentHash` via `verify`) and the
   * batch sender (looks up by `root` via `getBatch`).
   */
  async #resolveMinedFailure(
    error: unknown,
    key: Hex,
    txHash: string,
    lookupRegistrant: (key: Hex) => Promise<string>,
  ): Promise<Error> {
    if (isCallException(error)) {
      try {
        const registrant = await lookupRegistrant(key);
        if (registrant !== ZeroAddress) {
          const signerAddress = await this.#signer!.getAddress();
          if (registrant.toLowerCase() !== signerAddress.toLowerCase()) {
            return new AlreadyStamped(key, txHash);
          }
        }
      } catch {
        // The lookup itself failed; fall through to the generic mapping.
      }
    }
    return toHallmarqError(error);
  }

  async #lookupStampRegistrant(contentHash: Hex): Promise<string> {
    return ((await this.#readOnly.verify(contentHash)) as StampStruct).registrant;
  }

  async #lookupBatchRegistrant(root: Hex): Promise<string> {
    return ((await this.#readOnly.getBatch(root)) as BatchStruct).registrant;
  }

  /**
   * Sends one stamp transaction and waits for confirmations.
   *
   * Validates everything it can client-side first (content, model, meta),
   * then preflights with `staticCall` so a would-be revert (most commonly
   * `AlreadyStamped`) is caught without spending gas. The transaction is
   * signed once; only its broadcast is retried, and only for a network
   * failure before any response was received (see
   * {@link Hallmarq.#signAndBroadcast}). Once a transaction hash exists,
   * this never resends — it either waits for confirmations or throws
   * {@link NotConfirmed}.
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

      const receipt = await this.#waitForConfirmations(tx, (error) =>
        this.#resolveMinedFailure(error, contentHash, tx.hash, (hash) =>
          this.#lookupStampRegistrant(hash),
        ),
      );

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

  /**
   * Parses `receiptFile` with `parseReceiptFile` (from `@hallmarq/core`),
   * checks it was issued for this instance's own `chainId` (when
   * configured) and `registryAddress` — never silently checking a receipt
   * against the wrong network or registry — then delegates to
   * {@link Hallmarq.verifyInBatch}. Read-only; needs no signer.
   */
  async verifyReceipt(content: string | Uint8Array, receiptFile: unknown): Promise<VerifyResult> {
    try {
      const parsed = parseReceiptFile(receiptFile);

      if (this.#chainId !== undefined && parsed.chainId !== this.#chainId) {
        throw new ConfigError(
          `Receipt file is for chain ${parsed.chainId}, but this Hallmarq instance is configured for chain ${this.#chainId}`,
        );
      }
      if (parsed.registryAddress.toLowerCase() !== this.#registryAddress.toLowerCase()) {
        throw new ConfigError(
          `Receipt file is for registry ${parsed.registryAddress}, but this Hallmarq instance ` +
            `is configured for ${this.#registryAddress}`,
        );
      }

      return await this.verifyInBatch(content, { root: parsed.root, proof: parsed.proof });
    } catch (error) {
      if (error instanceof HallmarqError) {
        throw error;
      }
      throw toHallmarqError(error);
    }
  }

  /**
   * Queues `content` into the open batch for `model` (one batch per model
   * label, since `stampRoot` records a single label per root), creating it
   * if none is open. The batch is sent once it reaches
   * `batch.maxItems` (default 256), once `batch.maxWaitMs` (default
   * 30000) has passed since its first item, or when {@link Hallmarq.flush}
   * is called — whichever happens first. Once a batch starts sending it is
   * closed: this never adds an item to a batch that's already in flight,
   * even if that send hasn't resolved yet; a new item for the same model
   * starts a fresh batch.
   *
   * Validates everything it can synchronously before this item ever joins
   * a batch: `NoSigner`, `EmptyContent`, `ModelTooLong`, and — once
   * {@link Hallmarq.close} has been called — `Closed`. Every item in a
   * batch resolves or rejects together: a batch that confirms resolves
   * every item's promise with its own {@link BatchReceipt}; a batch that
   * fails (the preflight reverts, every retry is exhausted, confirmation
   * times out, ...) rejects every item's promise with that same error.
   */
  async stampBatched(
    content: string | Uint8Array,
    options: StampBatchedOptions,
  ): Promise<BatchReceipt> {
    if (this.#closed) {
      throw new Closed();
    }
    if (!this.#signerContract || !this.#signer) {
      throw new NoSigner();
    }
    assertContentNotEmpty(content);
    const contentHash = computeContentHash(content);
    assertModelNotTooLong(options.model);
    const model = options.model;

    return new Promise<BatchReceipt>((resolve, reject) => {
      let batch = this.#openBatches.get(model);
      if (!batch) {
        const newBatch: OpenBatch = { model, items: [], timer: undefined };
        newBatch.timer = setTimeout(() => {
          this.#openBatches.delete(model);
          void this.#trackSend(newBatch);
        }, this.#batchMaxWaitMs);
        newBatch.timer.unref?.();
        this.#openBatches.set(model, newBatch);
        batch = newBatch;
      }

      batch.items.push({ contentHash, resolve, reject });

      if (batch.items.length >= this.#batchMaxItems) {
        this.#openBatches.delete(model);
        if (batch.timer) {
          clearTimeout(batch.timer);
        }
        void this.#trackSend(batch);
      }
    });
  }

  /**
   * Builds the batch's Merkle tree, sends one `stampRoot` transaction
   * through the same sign-once/retry/no-resend path `stamp` uses (see
   * {@link Hallmarq.#signAndBroadcast}), and settles every item's promise.
   * Never throws: any failure, at any stage, is delivered by rejecting
   * every item in `batch` with the same error, so a caller driving many
   * batches through {@link Hallmarq.flush} never needs to wrap each one in
   * its own `try`/`catch`.
   */
  async #sendBatch(batch: OpenBatch): Promise<void> {
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    if (batch.items.length === 0) {
      return;
    }

    let tree: MerkleTree;
    try {
      if (!this.#signerContract || !this.#signer) {
        throw new NoSigner();
      }

      const contentHashes = batch.items.map((item) => item.contentHash);
      tree = buildTree(contentHashes);
      const root = tree.root;
      const count = contentHashes.length;

      await this.#ensureCorrectNetwork();
      await this.#ensureContractExists();

      try {
        await this.#signerContract.stampRoot.staticCall(root, count, batch.model);
      } catch (error) {
        throw toHallmarqError(error);
      }

      let tx: TransactionResponse;
      try {
        tx = await this.#sendStampRootTransaction(root, count, batch.model);
      } catch (error) {
        if (error instanceof HallmarqError) {
          throw error;
        }
        throw toHallmarqError(error);
      }

      const receipt = await this.#waitForConfirmations(tx, (error) =>
        this.#resolveMinedFailure(error, root, tx.hash, (key) => this.#lookupBatchRegistrant(key)),
      );

      const registrant = await this.#signer.getAddress();
      const chainId = await this.#resolveChainId();
      const blockNumber = receipt.blockNumber;
      const txHash = tx.hash;

      batch.items.forEach((item, index) => {
        const proof = getProof(tree, index);
        const receiptFile: ReceiptFile = {
          version: 1,
          chainId,
          registryAddress: this.#registryAddress,
          contentHash: item.contentHash,
          root,
          proof,
          model: batch.model,
          txHash: txHash as Hex,
          blockNumber,
        };
        item.resolve({
          contentHash: item.contentHash,
          txHash,
          blockNumber,
          registrant,
          model: batch.model,
          root,
          proof,
          batchSize: count,
          index,
          receiptFile,
        });
      });
    } catch (error) {
      const hallmarqError = error instanceof HallmarqError ? error : toHallmarqError(error);
      for (const item of batch.items) {
        item.reject(hallmarqError);
      }
    }
  }

  /**
   * Starts sending `batch` and tracks it in {@link Hallmarq.#inFlightSends}
   * until it settles, so {@link Hallmarq.flush} can wait for a batch that
   * already left `#openBatches` on its own (sent by its `maxWaitMs` timer
   * or by reaching `maxItems`), not just the ones `flush` itself triggers.
   * `#sendBatch` never rejects (see its own doc), but `.then` is used with
   * both handlers rather than `.finally` so cleanup is guaranteed even if
   * that ever changes.
   */
  #trackSend(batch: OpenBatch): Promise<void> {
    const sendPromise = this.#sendBatch(batch);
    this.#inFlightSends.add(sendPromise);
    const cleanup = (): void => {
      this.#inFlightSends.delete(sendPromise);
    };
    sendPromise.then(cleanup, cleanup);
    return sendPromise;
  }

  /**
   * Sends every open batch now, regardless of `maxItems`/`maxWaitMs`, and
   * resolves once all of them — including any batch already sending on its
   * own before this call (see {@link Hallmarq.#trackSend}) — have settled.
   * **Never rejects**: a batch that fails delivers its error through each
   * of its items' own promises (see {@link Hallmarq.stampBatched}), not
   * through `flush`'s — so a caller awaiting `flush()` only learns a batch
   * failed by also awaiting (or otherwise observing) that batch's own item
   * promises.
   */
  async flush(): Promise<void> {
    const batches = [...this.#openBatches.values()];
    this.#openBatches.clear();
    for (const batch of batches) {
      void this.#trackSend(batch);
    }
    // #trackSend adds synchronously, before any await, so by this point
    // #inFlightSends already holds both the batches just started above and
    // any that were already sending before this call.
    await Promise.all([...this.#inFlightSends]);
  }

  /**
   * Flushes every open batch, then permanently refuses new ones: any
   * later {@link Hallmarq.stampBatched} call throws {@link Closed}. Also
   * guarantees no batch timer is left running — {@link Hallmarq.flush}
   * clears each one as it sends. `#closed` is set before the flush even
   * starts, so a `stampBatched` call that arrives while `close()` is still
   * flushing is refused immediately rather than slipping into a batch
   * that's about to be (or already was) flushed without it.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }
}
