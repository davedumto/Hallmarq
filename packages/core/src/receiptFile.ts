import { assertAddress, assertHash32 } from "./bytes.js";
import { InvalidReceipt } from "./errors.js";
import type { Hex } from "./types.js";

/**
 * A self-contained, JSON-serializable record of one item's place in a
 * batch: everything `verifyInBatch` needs that the chain itself doesn't
 * store (the contract only keeps `root`, not any individual item's
 * `proof`). This is the "proof file" the SDK reference calls out — without
 * it, a batched item can't be verified from its content alone, because the
 * root isn't derivable from one leaf.
 *
 * Lives in `@hallmarq/core`, not the SDK, so the verifier page (roadmap
 * item 8) can parse a receipt file a visitor drops in without depending on
 * the SDK or ethers.
 */
export interface ReceiptFile {
  readonly version: 1;
  readonly chainId: number;
  readonly registryAddress: string;
  readonly contentHash: Hex;
  readonly root: Hex;
  readonly proof: readonly Hex[];
  readonly model: string;
  readonly txHash: Hex;
  readonly blockNumber: number;
}

const RECEIPT_FIELDS: readonly string[] = [
  "version",
  "chainId",
  "registryAddress",
  "contentHash",
  "root",
  "proof",
  "model",
  "txHash",
  "blockNumber",
];

function assertHashField(value: unknown, field: string): Hex {
  if (typeof value !== "string") {
    throw new InvalidReceipt(`"${field}" must be a 32-byte hex string, got ${typeof value}`);
  }
  try {
    assertHash32(value);
  } catch (error) {
    throw new InvalidReceipt(`"${field}" is not a valid 32-byte hash: ${(error as Error).message}`);
  }
  return value as Hex;
}

function assertAddressField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidReceipt(`"${field}" must be a 20-byte hex address, got ${typeof value}`);
  }
  try {
    return assertAddress(value);
  } catch (error) {
    throw new InvalidReceipt(`"${field}" is not a valid address: ${(error as Error).message}`);
  }
}

function assertStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidReceipt(`"${field}" must be a string, got ${typeof value}`);
  }
  return value;
}

function assertPositiveSafeIntegerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidReceipt(`"${field}" must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertProofField(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) {
    throw new InvalidReceipt(`"${field}" must be an array, got ${typeof value}`);
  }
  return value.map((element: unknown, index) => assertHashField(element, `${field}[${index}]`));
}

/**
 * Parses and strictly validates a `ReceiptFile`, from either a JSON string
 * or an already-parsed value (e.g. `JSON.parse`'d by the caller, or read
 * from a form upload). Every field is checked: `version` must be exactly
 * `1`; `contentHash`, `root`, every element of `proof` and `txHash` go
 * through {@link assertHash32}; `registryAddress` must be 20-byte hex;
 * `chainId` and `blockNumber` must be positive safe integers; `model` must
 * be a string; and any field not in the `ReceiptFile` shape is rejected.
 * Every failure throws {@link InvalidReceipt} naming the offending field —
 * a receipt file is usually hand-saved and later hand-loaded, so the
 * failure needs to be actionable without a debugger.
 */
export function parseReceiptFile(json: unknown): ReceiptFile {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch (error) {
      throw new InvalidReceipt(`receipt file is not valid JSON: ${(error as Error).message}`);
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReceipt("receipt file must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!RECEIPT_FIELDS.includes(key)) {
      throw new InvalidReceipt(`receipt file has an unknown field "${key}"`);
    }
  }

  if (record.version !== 1) {
    throw new InvalidReceipt(`"version" must be 1, got ${JSON.stringify(record.version)}`);
  }

  return {
    version: 1,
    chainId: assertPositiveSafeIntegerField(record.chainId, "chainId"),
    registryAddress: assertAddressField(record.registryAddress, "registryAddress"),
    contentHash: assertHashField(record.contentHash, "contentHash"),
    root: assertHashField(record.root, "root"),
    proof: assertProofField(record.proof, "proof"),
    model: assertStringField(record.model, "model"),
    txHash: assertHashField(record.txHash, "txHash"),
    blockNumber: assertPositiveSafeIntegerField(record.blockNumber, "blockNumber"),
  };
}

/**
 * Serializes a `ReceiptFile` with a stable key order (matching the
 * interface's own field order) and two-space indentation, so saved receipt
 * files diff cleanly in version control instead of reordering on every
 * write. Round-trips with {@link parseReceiptFile}.
 */
export function serializeReceiptFile(receipt: ReceiptFile): string {
  const ordered: ReceiptFile = {
    version: receipt.version,
    chainId: receipt.chainId,
    registryAddress: receipt.registryAddress,
    contentHash: receipt.contentHash,
    root: receipt.root,
    proof: receipt.proof,
    model: receipt.model,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
