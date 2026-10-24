/**
 * Base class for every typed error Hallmarq throws, across core, the SDK
 * and the verifier. `code` is a stable machine-readable identifier,
 * distinct from `message` (which is free to change) and from `name`
 * (which is the subclass name).
 */
export abstract class HallmarqError extends Error {
  abstract readonly code: string;
}

/**
 * Thrown by `normalizeText` (and therefore `hashText`) when byte input is
 * not valid UTF-8.
 */
export class InvalidUtf8 extends HallmarqError {
  readonly code = "INVALID_UTF8";

  constructor(message = "Input is not valid UTF-8") {
    super(message);
    this.name = "InvalidUtf8";
  }
}

/**
 * Defined here so core and the SDK share one definition (D2), but thrown
 * by the SDK's `stamp` / `stampBatched`, not by core (D4). `hashText` of
 * empty or whitespace-only input still returns `keccak256("")`.
 */
export class EmptyContent extends HallmarqError {
  readonly code = "EMPTY_CONTENT";

  constructor(message = "Content is empty") {
    super(message);
    this.name = "EmptyContent";
  }
}

/** Thrown by `buildTree` when given zero content hashes. */
export class EmptyBatch extends HallmarqError {
  readonly code = "EMPTY_BATCH";

  constructor(message = "Cannot build a Merkle tree from zero content hashes") {
    super(message);
    this.name = "EmptyBatch";
  }
}
