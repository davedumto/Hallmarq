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

| Option             | Type                        | Default             | Notes                                                                                                                                                                 |
| ------------------ | --------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpcUrl`           | `string`                    | from network config | **Required** (directly or via default); throws `ConfigError` if unresolved at construction.                                                                           |
| `chainId`          | `number`                    | from network config | Checked against the provider's actual chain before the first write; see `WrongNetwork`.                                                                               |
| `registryAddress`  | `string`                    | from network config | **Required** (directly or via default); throws `ConfigError` if unresolved at construction.                                                                           |
| `deploymentBlock`  | `number`                    | from network config | `verify`/`verifyInBatch` query event logs starting here, not from block 0.                                                                                            |
| `signer`           | `ethers.Signer`             | none                | Needed for `stamp`. Without one, only `verify`/`verifyInBatch`/hashing work. If the signer has no provider of its own, it's connected to the one `Hallmarq` resolves. |
| `confirmations`    | `number`                    | `2`                 | Blocks to wait for after sending, before `stamp` resolves.                                                                                                            |
| `confirmTimeoutMs` | `number`                    | `60000`             | Milliseconds to wait for `confirmations` before throwing `NotConfirmed`.                                                                                              |
| `batch`            | `{ maxItems?, maxWaitMs? }` | none                | Reserved for `stampBatched`/`flush` (roadmap item 7); accepted now so adding batching later isn't a breaking change, but nothing reads it yet.                        |

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

Read-only; no signer needed. Returns one of:

- `{ status: "not-found", contentHash }`
- `{ status: "found", contentHash, registrant, model, metaHash, timestamp, blockNumber, txHash }`

`blockNumber`/`txHash` come from the contract's `Stamped` event, filtered by
`contentHash` and queried from `deploymentBlock` (not block 0, which public
RPCs often reject for unbounded ranges).

### `verifyInBatch(content, { root, proof }): Promise<VerifyResult>`

Read-only; no signer needed. `root` and each element of `proof` are validated
as 32-byte hex (`InvalidHex`) before any contract call. Returns one of:

- `{ status: "not-found", contentHash }`
- `{ status: "found-in-batch", contentHash, registrant, model, count, timestamp, root, blockNumber, txHash }`

`blockNumber`/`txHash` come from the contract's `BatchStamped` event, same
`deploymentBlock` rule as `verify`.

## Errors

Every error extends `@hallmarq/core`'s `HallmarqError` (`abstract readonly
code: string`) and is safe to catch by class or by `.code`. A raw ethers or
unknown error never escapes a public method — anything unrecognized is
wrapped as `NetworkError`.

| Class            | `code`            | Thrown by                | Carries                            | When                                                                                                                                    |
| ---------------- | ----------------- | ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidUtf8`    | `INVALID_UTF8`    | `stamp`, `verify`        | —                                  | Byte content isn't valid UTF-8 and is hashed as text.                                                                                   |
| `EmptyContent`   | `EMPTY_CONTENT`   | `stamp`                  | —                                  | Normalized text is `""`, or bytes are empty.                                                                                            |
| `ModelTooLong`   | `MODEL_TOO_LONG`  | `stamp`                  | —                                  | `model` is longer than 64 UTF-8 bytes.                                                                                                  |
| `InvalidMeta`    | `INVALID_META`    | `stamp`                  | —                                  | `meta` (or something nested in it) can't be canonical JSON: `undefined`, a function, a `bigint`, `NaN`, or `Infinity`/`-Infinity`.      |
| `InvalidHex`     | `INVALID_HEX`     | `verifyInBatch`          | —                                  | `root` or a `proof` element isn't 32-byte hex.                                                                                          |
| `AlreadyStamped` | `ALREADY_STAMPED` | `stamp`                  | `contentHash`                      | The registry already has this content hashed (caught by the preflight; a transaction is never sent for this).                           |
| `NotConfirmed`   | `NOT_CONFIRMED`   | `stamp`                  | `txHash`                           | A transaction was sent (so it has a hash and is never resent) but didn't reach `confirmations` within `confirmTimeoutMs`.               |
| `NetworkError`   | `NETWORK_ERROR`   | any method               | `cause`                            | Sending or reading failed for a reason that isn't one of the above — including an exhausted retry and any unrecognized contract revert. |
| `NoSigner`       | `NO_SIGNER`       | `stamp`                  | —                                  | Called without a configured `signer`.                                                                                                   |
| `ConfigError`    | `CONFIG_ERROR`    | constructor              | —                                  | `rpcUrl` or `registryAddress` resolves to nothing, at construction time, not on first use.                                              |
| `WrongNetwork`   | `WRONG_NETWORK`   | `stamp` (before sending) | `expectedChainId`, `actualChainId` | The provider's actual chain ID doesn't match the configured one. Checked once, before the first write; never sent to the wrong chain.   |

## Retries

Only the broadcast step (before a transaction hash exists) is retried on a
network-ish failure — up to 3 attempts, with a growing delay between them. A
revert (e.g. a contract custom error) is never retried. Once a transaction
hash exists, it is **never resent**: `stamp` either waits for `confirmations`
or throws `NotConfirmed(txHash)`.

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
