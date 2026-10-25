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
| `chainId`          | `number`                    | from network config | Checked against the provider's actual chain before the first use of any method (`stamp`, `verify` or `verifyInBatch`); see `WrongNetwork`.                            |
| `registryAddress`  | `string`                    | from network config | **Required** (directly or via default); throws `ConfigError` if unresolved at construction, or if there's no contract code there on first use.                        |
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

### Network and contract checks

Before the first call to any method, `stamp`, `verify` and `verifyInBatch`
all check (each cached after its first successful check, so this runs at
most once per `Hallmarq` instance):

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

| Class            | `code`            | Thrown by               | Carries                            | When                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------- | ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `InvalidUtf8`    | `INVALID_UTF8`    | `stamp`, `verify`       | —                                  | Byte content isn't valid UTF-8 and is hashed as text.                                                                                                                                                                                                                                      |
| `EmptyContent`   | `EMPTY_CONTENT`   | `stamp`                 | —                                  | Normalized text is `""`, or bytes are empty.                                                                                                                                                                                                                                               |
| `ModelTooLong`   | `MODEL_TOO_LONG`  | `stamp`                 | —                                  | `model` is longer than 64 UTF-8 bytes.                                                                                                                                                                                                                                                     |
| `InvalidMeta`    | `INVALID_META`    | `stamp`                 | —                                  | `meta` (or something nested in it) can't be canonical JSON: `undefined`, a function, a `bigint`, `NaN`, `Infinity`/`-Infinity`, a circular reference, or an object that isn't a plain object or array (a `Date`, `Map`, `Set`, `RegExp`, a typed array, a class instance, ...).            |
| `InvalidHex`     | `INVALID_HEX`     | `verifyInBatch`         | —                                  | `root` or a `proof` element isn't 32-byte hex.                                                                                                                                                                                                                                             |
| `AlreadyStamped` | `ALREADY_STAMPED` | `stamp`                 | `contentHash`, `txHash?`           | The registry already has this content hashed. Usually caught by the preflight (`txHash` unset: no transaction was ever sent for this call); occasionally a transaction is mined and reverts because someone else's stamp for the same content landed first — `txHash` is set in that case. |
| `NotConfirmed`   | `NOT_CONFIRMED`   | `stamp`                 | `txHash`                           | A transaction was sent (so it has a hash and is never resent) but didn't reach `confirmations` within `confirmTimeoutMs`; or every broadcast retry exhausted on a transport error, leaving the transaction's fate unknown.                                                                 |
| `NetworkError`   | `NETWORK_ERROR`   | any method              | `cause`                            | Sending or reading failed for a reason that isn't one of the above — including an exhausted retry and any unrecognized contract revert.                                                                                                                                                    |
| `NoSigner`       | `NO_SIGNER`       | `stamp`                 | —                                  | Called without a configured `signer`.                                                                                                                                                                                                                                                      |
| `ConfigError`    | `CONFIG_ERROR`    | constructor, any method | —                                  | `rpcUrl` or `registryAddress` resolves to nothing (at construction, not on first use); or there's no contract code at `registryAddress` (checked once, on first use of any method).                                                                                                        |
| `WrongNetwork`   | `WRONG_NETWORK`   | any method              | `expectedChainId`, `actualChainId` | The provider's actual chain ID doesn't match the configured one. Checked once, before the first use of any method; never sent to the wrong chain.                                                                                                                                          |

## Retries

`stamp` signs its transaction exactly once — it populates and signs the call
up front, fixing its nonce and hash before anything is sent — and only
retries the idempotent re-broadcast of those same signed bytes, never a
second, independently-signed transaction. This matters: a broadcast whose
response is lost (a timeout, a dropped connection) still often reaches the
node, so naively resending by calling the contract method again would sign
and send a _second_ transaction with a new nonce, leaving two transactions
in flight and the user paying gas for a doomed second one.

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
