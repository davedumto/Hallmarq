# @hallmarq/sdk

TypeScript SDK that hashes content and talks to a deployed `StampRegistry`
contract through [ethers.js](https://docs.ethers.org/v6/) v6. Browser-safe: no
Node built-ins anywhere in `src`.

## Usage

```ts
import { Hallmarq } from "@hallmarq/sdk";

const hallmarq = new Hallmarq({ signer });
const receipt = await hallmarq.stamp("my content", { model: "gpt-4o" });
const result = await hallmarq.verify("my content"); // { status: "found", ... }
```

## Install

```bash
pnpm add @hallmarq/sdk ethers
```

## `new Hallmarq(options)`

Every option is optional except where noted; unset ones fall back to
`@hallmarq/core`'s network defaults (D8).

| Option             | Type                        | Default             | Notes                                                                                                                                                                                                           |
| ------------------ | --------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpcUrl`           | `string`                    | from network config | **Required** (directly or via default); throws `ConfigError` if unresolved at construction.                                                                                                                     |
| `chainId`          | `number`                    | from network config | Checked against the provider's actual chain before the first use of any method (`stamp`, `verify` or `verifyInBatch`); see `WrongNetwork`.                                                                      |
| `registryAddress`  | `string`                    | from network config | **Required** (directly or via default); throws `ConfigError` if unresolved at construction, or if there's no contract code there on first use.                                                                  |
| `deploymentBlock`  | `number`                    | from network config | `verify`/`verifyInBatch` query event logs starting here, not from block 0.                                                                                                                                      |
| `signer`           | `ethers.Signer`             | none                | Needed for `stamp`. Without one, only `verify`/`verifyInBatch`/hashing work. If the signer has no provider of its own, it's connected to the one `Hallmarq` resolves.                                           |
| `confirmations`    | `number`                    | `2`                 | Blocks to wait for after sending, before `stamp` resolves.                                                                                                                                                      |
| `confirmTimeoutMs` | `number`                    | `60000`             | Milliseconds to wait for `confirmations` before throwing `NotConfirmed`.                                                                                                                                        |
| `batch`            | `{ maxItems?, maxWaitMs? }` | `{ 256, 30000 }`    | Controls `stampBatched`'s batching (see "Batching" below). `maxItems` must be an integer from 1 to 2\*\*32 - 1; `maxWaitMs` must be a non-negative integer. Invalid values throw `ConfigError` at construction. |

The provider is the signer's own provider if it has one, otherwise a
read-only `JsonRpcProvider(rpcUrl)`.

## Methods

### `hashText(text: string | Uint8Array): Hex` / `hashBytes(bytes: Uint8Array): Hex`

Re-exported from `@hallmarq/core`, unchanged. No second implementation.

### `stamp(content: string | Uint8Array, { model, meta? }): Promise<Receipt>`

Hashes `content` (`hashText` for strings, `hashBytes` for bytes), validates
`model` and `meta` client-side, preflights with `staticCall` so a revert like
`AlreadyStamped` is caught without spending gas, then sends and waits for
`confirmations`.

- `meta` is hashed as `metaHash`: canonical JSON (object keys sorted
  recursively, array order preserved, no whitespace) over the keccak256 of
  its UTF-8 bytes. Omit `meta` to leave `metaHash` zero.
- Returns `Receipt`: `{ contentHash, txHash, blockNumber, registrant, model }`.

### `verify(content: string | Uint8Array): Promise<VerifyResult>`

Read-only; no signer needed. Checks the chain and contract address first
(same as `stamp`; see "Network and contract checks" below), so a wrong chain
or address can never be misread as a plain "not found". Returns one of:

- `{ status: "not-found", contentHash }`
- `{ status: "found", contentHash, registrant, model, metaHash, timestamp, blockNumber, txHash }`

`blockNumber`/`txHash` come from the contract's `Stamped` event, filtered by
`contentHash` and queried from `deploymentBlock` (not block 0, which public
RPCs often reject for unbounded ranges).

### `verifyInBatch(content, { root, proof }): Promise<VerifyResult>`

Read-only; no signer needed. `root` and each element of `proof` are validated
as 32-byte hex (`InvalidHex`) before any contract call, then the chain and
contract address are checked (see "Network and contract checks" below).
Returns one of:

- `{ status: "not-found", contentHash }`
- `{ status: "found-in-batch", contentHash, registrant, model, count, timestamp, root, blockNumber, txHash }`

`blockNumber`/`txHash` come from the contract's `BatchStamped` event, same
`deploymentBlock` rule as `verify`.

### `verifyReceipt(content, receiptFile): Promise<VerifyResult>`

Read-only; no signer needed. A convenience over `verifyInBatch` for the
common case of checking content against a saved `ReceiptFile` (see
"Batching" and "Receipt files" below): parses `receiptFile` with
`@hallmarq/core`'s `parseReceiptFile` (accepts either a JSON string or an
already-parsed value; throws `InvalidReceipt` if it isn't a well-formed
receipt file), checks its `chainId` (when this instance has one configured)
and `registryAddress` against this instance's own configuration — throwing
`ConfigError` on a mismatch, never silently checking a receipt against the
wrong network or registry — then calls `verifyInBatch(content, { root:
receiptFile.root, proof: receiptFile.proof })`. Same return shape as
`verifyInBatch`.

### `stampBatched(content, { model }): Promise<BatchReceipt>`

Queues `content` into the open batch for `model` and resolves once that
batch is confirmed on-chain through one `stampRoot` transaction. See
"Batching" below for the full lifecycle. Unlike `stamp`, there's no `meta`
option — `stampRoot` has no `metaHash` field at all.

Validates synchronously before `content` ever joins a batch — `NoSigner`,
`EmptyContent`, `ModelTooLong`, and (once `close()` has been called)
`Closed` — so invalid input never ties up a batch slot or waits on a timer.

Returns `BatchReceipt`: `Receipt`'s fields (`contentHash`, `txHash`,
`blockNumber`, `registrant`, `model`) plus `root`, `proof` (this item's
sibling hashes — the chain only stores `root`, so this is the one thing
_you_ must keep to ever verify this item again), `batchSize` (the whole
batch's item count), `index` (this item's position in the tree), and
`receiptFile` — the same data, pre-assembled as a ready-to-save
`ReceiptFile` (see "Receipt files" below).

### `flush(): Promise<void>`

Sends every currently open batch right now, regardless of `maxItems` or
`maxWaitMs`, and resolves once all of them have settled (confirmed or
failed). **Never rejects** — a batch that fails delivers its error through
each of its own items' `stampBatched` promises, not through `flush()`'s. Use
it to drain batches before your process exits, or whenever you need a
batch's contents to go out immediately.

### `close(): Promise<void>`

`flush()`s every open batch, then permanently refuses new ones: any later
`stampBatched` call throws `Closed`. Also guarantees every batch timer is
cleared, so nothing is left that could keep a Node process alive. Call this
once, when you're done with an instance for good (a server shutting down, a
script about to exit, a test suite tearing down).

### Network and contract checks

Before the first call to any method, `stamp`, `verify`, `verifyInBatch` and
a batch's own send (triggered by `stampBatched`/`flush`/`close`) all check
(each cached after its first successful check, so this runs at most once
per `Hallmarq` instance):

- The provider's actual chain ID matches the configured `chainId` (skipped
  entirely when `chainId` isn't configured) — otherwise `WrongNetwork`.
- There's contract code at `registryAddress` — otherwise `ConfigError`.

Without this, a wrong `registryAddress`, or a correct one on the wrong
chain, would read back as all-zero data: `verify` would report
`"not-found"` for content that may well be stamped, rather than surfacing
the configuration problem it actually is.

## Errors

Every error extends `@hallmarq/core`'s `HallmarqError` (`abstract readonly
code: string`) and is safe to catch by class or by `.code`. A raw ethers or
unknown error never escapes a public method — anything unrecognized is
wrapped as `NetworkError`.

| Class            | `code`            | Thrown by                         | Carries                            | When                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------- | --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `InvalidUtf8`    | `INVALID_UTF8`    | `stamp`, `stampBatched`, `verify` | —                                  | Byte content isn't valid UTF-8 and is hashed as text.                                                                                                                                                                                                                                                                                                                                                              |
| `EmptyContent`   | `EMPTY_CONTENT`   | `stamp`, `stampBatched`           | —                                  | Normalized text is `""`, or bytes are empty. For `stampBatched`, checked before the item ever joins a batch.                                                                                                                                                                                                                                                                                                       |
| `ModelTooLong`   | `MODEL_TOO_LONG`  | `stamp`, `stampBatched`           | —                                  | `model` is longer than 64 UTF-8 bytes. For `stampBatched`, checked before the item ever joins a batch.                                                                                                                                                                                                                                                                                                             |
| `InvalidMeta`    | `INVALID_META`    | `stamp`                           | —                                  | `meta` (or something nested in it) can't be canonical JSON: `undefined`, a function, a `bigint`, `NaN`, `Infinity`/`-Infinity`, a circular reference, or an object that isn't a plain object or array (a `Date`, `Map`, `Set`, `RegExp`, a typed array, a class instance, ...).                                                                                                                                    |
| `InvalidHex`     | `INVALID_HEX`     | `verifyInBatch`                   | —                                  | `root` or a `proof` element isn't 32-byte hex.                                                                                                                                                                                                                                                                                                                                                                     |
| `InvalidReceipt` | `INVALID_RECEIPT` | `verifyReceipt`                   | —                                  | `receiptFile` isn't a well-formed `ReceiptFile` (from `@hallmarq/core`'s `parseReceiptFile`); names the offending field.                                                                                                                                                                                                                                                                                           |
| `AlreadyStamped` | `ALREADY_STAMPED` | `stamp`, `stampBatched`           | `contentHash`, `txHash?`           | The registry already has this content hash (`stamp`) or Merkle root (`stampBatched`) registered. Usually caught by the preflight (`txHash` unset: no transaction was ever sent for this call); occasionally a transaction is mined and reverts because someone else's stamp (or batch root) landed first — `txHash` is set in that case. For `stampBatched`, every item in the batch rejects with this same error. |
| `NotConfirmed`   | `NOT_CONFIRMED`   | `stamp`, `stampBatched`           | `txHash`                           | A transaction was sent (so it has a hash and is never resent) but didn't reach `confirmations` within `confirmTimeoutMs`; or every broadcast retry exhausted on a transport error, leaving the transaction's fate unknown. For `stampBatched`, every item in the batch rejects with this same error.                                                                                                               |
| `NetworkError`   | `NETWORK_ERROR`   | any method                        | `cause`                            | Sending or reading failed for a reason that isn't one of the above — including an exhausted retry and any unrecognized contract revert.                                                                                                                                                                                                                                                                            |
| `NoSigner`       | `NO_SIGNER`       | `stamp`, `stampBatched`           | —                                  | Called without a configured `signer`.                                                                                                                                                                                                                                                                                                                                                                              |
| `Closed`         | `CLOSED`          | `stampBatched`                    | —                                  | `close()` was already called on this instance; no new batched stamps can be queued.                                                                                                                                                                                                                                                                                                                                |
| `ConfigError`    | `CONFIG_ERROR`    | constructor, any method           | —                                  | `rpcUrl` or `registryAddress` resolves to nothing (at construction, not on first use); there's no contract code at `registryAddress` (checked once, on first use of any method); `batch.maxItems`/`batch.maxWaitMs` is out of range (at construction); or (`verifyReceipt` only) the receipt's `chainId`/`registryAddress` doesn't match this instance's own.                                                      |
| `WrongNetwork`   | `WRONG_NETWORK`   | any method                        | `expectedChainId`, `actualChainId` | The provider's actual chain ID doesn't match the configured one. Checked once, before the first use of any method; never sent to the wrong chain.                                                                                                                                                                                                                                                                  |

## Retries

`stamp` (and a batch's own `stampRoot` send, triggered by `stampBatched`;
see "Batching" below — both go through the exact same code) sign their
transaction exactly once — populating and signing the call up front, fixing
its nonce and hash before anything is sent — and only retry the idempotent
re-broadcast of those same signed bytes, never a second,
independently-signed transaction. This matters: a broadcast whose response
is lost (a timeout, a dropped connection) still often reaches the node, so
naively resending by calling the contract method again would sign and send
a _second_ transaction with a new nonce, leaving two transactions in flight
and the user paying gas for a doomed second one.

- Only an allowlisted transport failure is retried — ethers' own
  `NETWORK_ERROR`, `TIMEOUT`, `SERVER_ERROR`, or an uncoded error whose
  message plainly describes one (`fetch failed`, `ECONNRESET`, ...). Up to 3
  attempts, with a growing delay between them. Everything else — a revert, a
  wallet rejection (`ACTION_REJECTED`), insufficient funds, a stale or
  conflicting nonce, and so on — fails the exact same way on every attempt,
  so it's never retried.
- If a retried broadcast comes back "already known" (the node accepted the
  first attempt after all), `stamp` looks the transaction up by its
  already-known hash instead of resending it.
- Not every signer can produce a raw signed transaction — a browser wallet
  only exposes `eth_sendTransaction`, and Hardhat's own test signers don't
  implement `signTransaction` at all. For those, `stamp` falls back to a
  single, **unretried** send instead (the ordinary `signer.sendTransaction`
  path): without a raw signed transaction to re-broadcast, a retry here
  would have to resend by calling the contract method again, which risks
  the same double-send the sign-once design exists to avoid. This fallback
  only triggers when the signer genuinely can't sign raw transactions
  (`UNSUPPORTED_OPERATION`, a JSON-RPC "method not found", or a message
  that says so) — a signer that _can_ sign but whose signing prompt the
  user rejected (`ACTION_REJECTED`) is never silently retried through the
  fallback, or the user would be prompted to sign twice for one call.
- If every broadcast retry exhausts on a transport error, the transaction's
  fate is unknown — the node may have received it despite the lost
  response, so it could still be in flight. `stamp` throws
  `NotConfirmed(txHash)` in that case (never a hashless `NetworkError`),
  since the caller already has a signed transaction out there and must
  look it up by hash rather than ever stamping the same content again.
- Once a transaction hash exists, it is **never resent** by any path:
  `stamp` either waits for `confirmations` or throws `NotConfirmed(txHash)`.
  If that transaction is mined but reverts because someone else's stamp for
  the same content landed first, `stamp` resolves it to `AlreadyStamped`
  (with `txHash` set) rather than a generic `NetworkError`.

## Batching

`stampRoot` records a Merkle root over many content hashes in one
transaction, so cost per item falls roughly in proportion to batch size
(see the roadmap PR's gas measurement). `stampBatched` builds and sends
these batches for you.

**Lifecycle.** A batch for a given `model` label goes through these states:

1. **Open.** The first `stampBatched(content, { model })` call for a
   label with no currently-open batch creates one, starts its
   `maxWaitMs` timer, and adds `content`'s hash as the first item. Every
   later call for the same label, while this batch is still open, adds
   another item to it.
2. **Sending.** The batch is removed from the open set and its
   `stampRoot` transaction is sent — whichever happens first:
   - it reaches `batch.maxItems` (default 256),
   - `batch.maxWaitMs` (default 30000) has passed since its first item, or
   - `flush()` or `close()` is called.

   Once a batch is sending, it's closed for good: a `stampBatched` call
   for the same label that arrives while it's still in flight **always**
   starts a brand new batch, never joins the one already sending.

3. **Settled.** The transaction confirms (resolving every item's promise
   with its own `BatchReceipt`) or fails (rejecting every item's promise
   with the same error — a reverted preflight, `NotConfirmed`, or
   anything else `stamp` itself could throw while sending).

```ts
const hallmarq = new Hallmarq({ signer, batch: { maxItems: 50, maxWaitMs: 5000 } });

// Each call resolves independently, once ITS batch confirms.
const receipts = await Promise.all(
  replies.map((reply) => hallmarq.stampBatched(reply, { model: "gpt-4o" })),
);
```

**`flush()` and `close()`.** Call `flush()` to send every open batch right
now rather than waiting out `maxWaitMs` — useful before your process exits,
or whenever you need the in-flight items to go out immediately. `flush()`
**never rejects**: a batch's failure is only ever visible through that
batch's own items' promises, so always wait on (or otherwise observe) the
`stampBatched` promises themselves, not just `flush()`, to learn whether a
batch actually succeeded. `close()` does the same, then refuses any further
`stampBatched` call (throwing `Closed`) and guarantees every batch timer is
cleared — call it once, when you're done with an instance for good, so
nothing is left that could keep a Node process alive.

```ts
process.on("beforeExit", () => void hallmarq.close());
```

## Receipt files

The registry only ever stores a batch's Merkle **root** — never the proof
for any individual item. Once a batch confirms, the one and only place
`contentHash`'s `proof` exists is in whatever `BatchReceipt` `stampBatched`
handed back; lose it, and that item can never be verified again, even
though it's genuinely registered on-chain. **Keep the receipt.**

Each `BatchReceipt` carries `receiptFile`, a `ReceiptFile` (from
`@hallmarq/core`, so the verifier page can read one without depending on
this SDK or ethers) ready to serialize:

```ts
interface ReceiptFile {
  version: 1;
  chainId: number;
  registryAddress: string;
  contentHash: Hex;
  root: Hex;
  proof: Hex[];
  model: string;
  txHash: Hex;
  blockNumber: number;
}
```

Saving one:

```ts
import { serializeReceiptFile } from "@hallmarq/core";
import { writeFile } from "node:fs/promises";

const receipt = await hallmarq.stampBatched(reply, { model: "gpt-4o" });
await writeFile(`receipts/${receipt.contentHash}.json`, serializeReceiptFile(receipt.receiptFile));
```

Loading one back later, from the same or a different machine, to verify:

```ts
import { readFile } from "node:fs/promises";

const receiptFile = await readFile(`receipts/${contentHash}.json`, "utf8");
const result = await hallmarq.verifyReceipt(reply, receiptFile); // parses + verifies in one call
```

`@hallmarq/core`'s `parseReceiptFile(json)` strictly validates a receipt
file (from a JSON string or an already-parsed value): `version` must be
`1`; `contentHash`, `root`, every `proof` element and `txHash` must be
32-byte hex; `registryAddress` must be 20-byte hex; `chainId` and
`blockNumber` must be positive integers; `model` must be a string; and any
other field is rejected. Every failure throws `InvalidReceipt` naming the
bad field. `serializeReceiptFile(receiptFile)` writes one back out with a
stable key order (matching the interface above), so saved files diff
cleanly in version control.

## What this SDK never does

- Never sends content anywhere. Only the content's hash leaves the caller's
  machine.
- Never stores or generates keys. Signing is the caller's own `ethers.Signer`.

## Spec deviations

- **Canonical-JSON `meta`.** The spec doesn't define a `metaHash` encoding;
  this SDK defines one (sorted object keys, preserved array order, no
  whitespace) so `metaHash` is reproducible across implementations. See
  `vectors/vectors.json`'s `meta` vector.
- **`deploymentBlock`.** Added to `@hallmarq/core`'s `NetworkConfig` (not in
  the original spec) so `verify`/`verifyInBatch` can query event logs from a
  known starting block instead of block 0, which public RPCs often reject for
  unbounded ranges.
- **The receipt file format lives in `@hallmarq/core`, `verifyReceipt`, and
  the `Closed`/`InvalidReceipt` errors.** See `docs/DECISIONS.md` D12.
