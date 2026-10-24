import { HallmarqError } from "@hallmarq/core";

/** Thrown by `stamp` when the model label is longer than 64 UTF-8 bytes. */
export class ModelTooLong extends HallmarqError {
  readonly code = "MODEL_TOO_LONG";

  constructor(message = "Model label is longer than 64 UTF-8 bytes") {
    super(message);
    this.name = "ModelTooLong";
  }
}

/**
 * Thrown by `stamp` when `meta` can't be turned into canonical JSON: it (or
 * something nested inside it) is `undefined`, a function, a `bigint`,
 * `NaN` or `Infinity`/`-Infinity` — none of which JSON can represent.
 */
export class InvalidMeta extends HallmarqError {
  readonly code = "INVALID_META";

  constructor(message = "meta cannot be represented as canonical JSON") {
    super(message);
    this.name = "InvalidMeta";
  }
}

/**
 * Thrown when the registry reports `contentHash` (or a batch `root`) is
 * already stamped. `txHash` is set when this came from a transaction that
 * was actually mined (a front-run: someone else's stamp for the same hash
 * landed first) rather than from the `staticCall` preflight, which never
 * sends a transaction at all.
 */
export class AlreadyStamped extends HallmarqError {
  readonly code = "ALREADY_STAMPED";
  readonly contentHash: string;
  readonly txHash: string | undefined;

  constructor(contentHash: string, txHash?: string, message = `Already stamped: ${contentHash}`) {
    super(message);
    this.name = "AlreadyStamped";
    this.contentHash = contentHash;
    this.txHash = txHash;
  }
}

/**
 * Thrown when a transaction was sent (so it has a hash and must never be
 * resent) but didn't reach the configured number of confirmations within
 * `confirmTimeoutMs`.
 */
export class NotConfirmed extends HallmarqError {
  readonly code = "NOT_CONFIRMED";
  readonly txHash: string;

  constructor(txHash: string, message = `Transaction ${txHash} did not confirm in time`) {
    super(message);
    this.name = "NotConfirmed";
    this.txHash = txHash;
  }
}

/** Thrown when sending or reading fails for a reason that isn't a typed Hallmarq error. */
export class NetworkError extends HallmarqError {
  readonly code = "NETWORK_ERROR";
  readonly cause: unknown;

  constructor(cause: unknown, message = "Network request failed") {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** Thrown by a write method (`stamp`) when the client was constructed without a `signer`. */
export class NoSigner extends HallmarqError {
  readonly code = "NO_SIGNER";

  constructor(message = "This operation needs a signer; none was configured") {
    super(message);
    this.name = "NoSigner";
  }
}

/** Thrown at construction when a required option (and no default) resolves to nothing. */
export class ConfigError extends HallmarqError {
  readonly code = "CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Thrown before the first write if the provider's chain ID doesn't match the configured one. */
export class WrongNetwork extends HallmarqError {
  readonly code = "WRONG_NETWORK";
  readonly expectedChainId: number;
  readonly actualChainId: number;

  constructor(expectedChainId: number, actualChainId: number) {
    super(`Configured for chain ${expectedChainId}, but the provider is on chain ${actualChainId}`);
    this.name = "WrongNetwork";
    this.expectedChainId = expectedChainId;
    this.actualChainId = actualChainId;
  }
}
