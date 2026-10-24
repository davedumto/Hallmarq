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

`solc 0.8.26`, optimizer at 200 runs, **`evmVersion: "paris"`** until we confirm
which hardfork MST supports. MST is a Parlia (BSC-family) chain. Shanghai's
`PUSH0` (the solc default since 0.8.20) may not be live there, and it would make
the deploy fail. Once MST is confirmed to support it, we bump to `shanghai`/`cancun`
in its own PR.

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
