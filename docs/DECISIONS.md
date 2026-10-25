# Engineering decisions

Decisions made on top of `docs/Hallmarq_Technical_Documentation.pdf` (the spec).
Where this file and the spec disagree, this file wins until the spec is re-exported.
Each entry is final unless a PR proposes a change with a reason.

## D1. Monorepo with pnpm workspaces

```
hallmarq/
  contracts/StampRegistry.sol
  test/                    Hardhat tests (unit, property, cross-check)
  scripts/                 deploy.ts, measure-gas.ts, e2e.ts
  packages/core/           @hallmarq/core: normalize, hash, Merkle (no chain code)
  packages/sdk/            @hallmarq/sdk: Hallmarq class (depends on core + ethers)
  packages/verifier/       static page (depends on core + ethers)
  vectors/vectors.json     the single source of test vectors
  docs/
  hardhat.config.ts
```

Node 22 LTS, pnpm 9, TypeScript strict, ESM only.

## D2. One shared hashing package (`@hallmarq/core`)

The spec requires the SDK and the verifier to produce byte-identical hashes (F5).
Rather than two implementations kept in sync by tests, both import the same
`normalizeText`, `hashText`, `hashBytes`, `buildTree`, `getProof` and `verifyProof`
from `@hallmarq/core`. The shared vectors still run in every package, so a broken
bundling step can't slip through.

## D3. Whitespace means ASCII whitespace

The spec says "remove all whitespace at the very end of the text". To keep this
the same in every language, it means only:

- Step 3 (end of each line): U+0020 space and U+0009 tab.
- Step 4 (end of text): U+0020, U+0009 and U+000A. U+000D can't appear by then.

Unicode spaces (NBSP U+00A0, U+2003, etc.) are content and are kept. **Don't** use
JS `\s` or `String.prototype.trimEnd()`, because both strip Unicode spaces. A vector
for this goes in `vectors.json`.

## D4. Empty content is rejected by the SDK

If normalized text is empty, `hashText` still returns `keccak256("")`, but
`stamp` / `stampBatched` throw `EmptyContent`. Nobody gets to squat on the empty
document. The contract stays as specified: it only rejects the zero hash.

## D5. Compiler and EVM target

`solc 0.8.28`, optimizer at 200 runs, **`evmVersion: "paris"`**. MST supports up
to Cancun (D13); we deliberately stay on paris for v1 because every test, gas
figure and the 3,030-byte size were measured on paris; moving to
shanghai/cancun is optional future work.

Originally `0.8.26`; switched to `0.8.28` to make the deployed contract
source-verifiable on MST's Blockscout explorer — see D14 for why.

## D6. Hardhat 3 + ethers v6 + mocha; fast-check for property tests

Hardhat follows the spec. Property tests (spec, "Contract property") use
`fast-check` with `numRuns: 1000`. The tree is built in TS with `@hallmarq/core`
and checked against the contract's `verifyInBatch` (a view call, so it stays fast).

## D7. Verifier is Vite + vanilla TypeScript, no framework

It's a static page with four states and no wallet. A framework adds weight and
attack surface for no gain. It's deployed to GitHub Pages from CI. The only
network calls allowed are JSON-RPC to the configured endpoint (N1). That means
no analytics, no fonts CDN and no external scripts.

## D8. The chain config lives in one place

`packages/core/src/networks.ts` exports `{ chainId, rpcUrl, explorerUrl, registryAddress }`
per network (`hardhat`, `mstTestnet`). The SDK defaults and the verifier read from
it. Fill in the values only after they're confirmed (see Open Items in ROADMAP.md).

## D9. Naming

The product is **Hallmarq**. "StampAI" in the spec is a leftover name. Keep it
only inside the test-vector string `Hello, StampAI.`, because that's the content
the published hash was computed from.

## D10. Verified so far

The CTO recomputed every hash in the spec with ethers v6 `keccak256` before
work began. The two text vectors, the raw (unnormalized) hash, and every value in
the A/B/C Merkle example match the spec exactly. The step that's still open is
running these values against the contract, which is PR 4.

## D11. Two SDK additions beyond the spec (PR 6)

The spec doesn't define how `meta` turns into `metaHash`, or how `verify`/
`verifyInBatch` should query event logs without scanning from block 0. Two
additions, both backward-compatible (no existing field or method changed):

- **Canonical-JSON `metaHash`.** `metaHash = hashBytes(utf8(canonicalJson(meta)))`,
  where `canonicalJson` sorts object keys recursively, preserves array order,
  and emits no whitespace. This makes `metaHash` reproducible across
  implementations instead of depending on `JSON.stringify`'s unspecified key
  order. A vector lives in `vectors/vectors.json`'s `meta` entry.
- **`deploymentBlock` on `NetworkConfig`.** Added alongside `chainId`/`rpcUrl`/
  `explorerUrl`/`registryAddress` (D8). `verify`/`verifyInBatch` filter the
  `Stamped`/`BatchStamped` events from this block instead of block 0, which
  public RPCs often reject for unbounded ranges. `undefined` until Roadmap
  PR 5's deployment fills it in, same as `registryAddress`.

## D12. The receipt file format lives in `@hallmarq/core`, not the SDK (PR 7)

A batched item's `proof` only exists off-chain — the contract stores just the
root — so a caller must keep it to ever verify that item again. `ReceiptFile`
(`{ version: 1, chainId, registryAddress, contentHash, root, proof, model,
txHash, blockNumber }`) is the serializable record of everything
`verifyInBatch` needs for one item, plus enough context (`chainId`,
`registryAddress`) to catch a receipt being checked against the wrong
network or registry. `parseReceiptFile`/`serializeReceiptFile` live in
`@hallmarq/core`, alongside `verifyProof`, rather than in `packages/sdk`,
because the verifier page (roadmap item 8) reads a visitor-supplied receipt
file directly and must not have to depend on the SDK (or ethers) just to
parse one. Three small additions beyond the spec's `ReceiptFile` sketch, all
backward-compatible:

- **Strict parsing.** `parseReceiptFile` rejects anything that isn't exactly
  this shape — wrong `version`, a malformed hash or address, a non-integer
  `chainId`/`blockNumber`, or an unknown extra field — throwing the new
  `InvalidReceipt` error (a `HallmarqError` subclass) naming the bad field,
  rather than silently accepting a near-miss that would only fail later, and
  more confusingly, inside `verifyInBatch`.
- **`Hallmarq.verifyReceipt(content, receiptFile)`.** A convenience built on
  `parseReceiptFile` + `verifyInBatch` that also checks the receipt's
  `chainId`/`registryAddress` against the instance's own configuration
  first, throwing `ConfigError` on a mismatch — so a receipt saved against
  one deployment is never silently checked against a different one it
  happens to share a hash format with.
- **`Hallmarq.close()` and the `Closed` error.** `stampBatched`'s open
  batches hold timers and pending promises; `close()` flushes every open
  batch and then refuses new ones (`Closed`, a `HallmarqError` subclass),
  so a caller shutting down (a server process exiting, a test suite
  finishing) has one call that guarantees no batch is left stranded and no
  timer keeps the process alive.

## D13. MST testnet facts

Checked by the CTO against the live chain on 2026-10-25, closing the "Open
items" in `docs/ROADMAP.md` that this PR needed. Every value below is used
exactly as given here; none of it is guessed or re-derived.

- **Chain ID** `91562037` (`0x5752035`). **RPC** `https://testnetrpc.mstblockchain.com`.
  **Explorer** `https://testnet.mstscan.com`. Checked by calling `eth_chainId`
  against the RPC and comparing it to the explorer's own reported chain ID.
- **Native coin** tMSTC, 18 decimals. Checked via a balance query against the
  funded deployer wallet (below) and the explorer's unit display.
- **Gas**: gas price 1 gwei, base fee 0, block gas limit 55,000,000, block
  time about 3.0s. Checked by reading recent blocks over `eth_getBlockByNumber`.
- **EVM**: supports up to Cancun. `PUSH0`, `TSTORE` and `MCOPY` were each
  confirmed live with a one-off `eth_call` probe (a tiny bytecode snippet
  using just that opcode, called against an arbitrary address); Osaka is
  **not** supported. This is strictly ahead of D5's `paris` target, so paris
  stays correct; see D5 for why we don't move up yet.
- **Explorer**: Blockscout v9.0.2. Source verification is enabled; solc
  `v0.8.26+commit.8a97fa7a` is listed as available and standard-input (JSON)
  upload verification is supported. **Correction (D14): listed does not mean
  working.** 0.8.26 (and 0.8.25) verify 0 of 713 contracts on this explorer in
  practice; neighbouring versions verify routinely. Use solc 0.8.28 (D5), not
  0.8.26, for anything that needs to verify here. The verification API is
  Etherscan-compatible, at `https://testnet.mstscan.com/api`. Checked by
  reading the explorer's own version/about page and its API docs.
- **`eth_getLogs`** works over the full chain range (no block-range cap was
  hit querying from genesis). Checked by querying the full range directly.
- **Deployer wallet**: `0xE5439B81cab5813226AD3be0EA5de2aceFB3f750`, funded
  with 50 tMSTC from the faucet. This is the "fresh deployer wallet" open
  item from `docs/ROADMAP.md`; its key lives only in the `testnet` GitHub
  environment's `DEPLOYER_PRIVATE_KEY` secret, never in this repository.

## D14. Compiler switch for explorer verification

D13 listed solc `v0.8.26+commit.8a97fa7a` as available on MST's Blockscout
explorer. Available isn't the same as working: the CTO checked MST's
verification statistics and found 0.8.26 and 0.8.25 verify **0 of 713**
contracts ever verified on this explorer, while neighbouring versions verify
routinely (0.8.24: 180, 0.8.27: 47, 0.8.28: 155, 0.8.29: 186). The explorer's
verifier has a specific, undiagnosed problem with exactly these two
versions, not with this contract: our 0.8.26 testnet deployment at
`0x97d24c9728475C9612864593173035a7663bb948` (block 6547527) has bytecode
byte-for-byte identical to the committed source (confirmed independently
twice, in this PR and in PR #10), and submitting the exact build-info
standard input *and* a flattened single-file variant both got "verification
started" from Blockscout's v2 API and then never completed — pointing at
MST's verifier service, not at our input or our bytecode.

**Fix: compiler version only.** Switched `solc` from `0.8.26` to `0.8.28`
(D5) everywhere it's pinned — `contracts/StampRegistry.sol`'s pragma,
`hardhat.config.ts`'s `SOLIDITY_VERSION`, `.solhint.json`'s
`compiler-version` rule, and the `slither` CI job's `solc-version` input.
Nothing else about the contract, the optimizer settings or `evmVersion`
changes. Confirmed `v0.8.28+commit.7893614a` is offered by MST's explorer via
`GET /api/v2/smart-contracts/verification/config` before switching.

**Why 0.8.28 and not some other neighbour.** It has the most verified
contracts of the versions the CTO checked (186 for 0.8.29 is higher, but
0.8.29 wasn't confirmed available in MST's own `verification/config` list at
the time of checking) and no functionality in `StampRegistry.sol` depends on
anything 0.8.28 changes relative to 0.8.26 — confirmed directly: the compiled
`deployedBytecode` is byte-for-byte identical between the two compiler
versions except for the trailing CBOR metadata (the embedded IPFS hash and
solc-version marker, which *must* differ since they encode the compiler
itself). Same bytecode body means same gas costs and the same 3,030-byte
size; see the PR description for the side-by-side numbers.

**The 0.8.26 testnet deployment is abandoned.** The contract at
`0x97d24c9728475C9612864593173035a7663bb948` (block 6547527) stays on-chain
— nothing deletes or migrates it, and nothing in this codebase points at it
after this PR — but it is unused going forward. No data depends on it: its
`smoke.ts` stamps are throwaway test content, never referenced by anything
else. The next `deploy` run (Roadmap item 5b) produces a fresh 0.8.28
deployment at a new address; `deployments/mstTestnet.json` isn't committed,
so that deploy needs no `--force`.
