# Hallmarq v1 roadmap

Ten PRs, in order. Each one is small enough to review in one sitting. Every PR
below comes with a **prompt**: paste it to the engineer (human or AI) as-is.

**Workflow**

1. The engineer branches from `dev` as `feat/<nn>-<slug>` (e.g. `feat/02-core-hashing`) and
   opens the PR against `dev`.
2. They implement the prompt, run `pnpm lint && pnpm test` locally, and open a PR
   using the template.
3. The CTO reviews against `CONTRIBUTING.md`. The engineer addresses every comment
   or replies with a reason, then pushes.
4. Squash-merge once CI is green and the CTO approves. The next PR starts from the
   updated `dev`.
5. At each milestone (after PRs 5, 8 and 10) the CTO opens a release PR from `dev` into
   `main`. `main` only ever holds reviewed, releasable code.

PRs 2 and 3 can run in parallel after PR 1. Everything else is sequential.

Read before any PR: `docs/Hallmarq_Technical_Documentation.pdf` (the spec) and
`docs/DECISIONS.md` (it overrides the spec where they differ).

---

## Open items: owner is the founder, needed before PR 5

These aren't engineering tasks. The engineer must not guess these values.

- [ ] MST testnet chain ID, public RPC URL, faucet
- [ ] MST mainnet chain ID and RPC URL
- [ ] Supported EVM hardfork (does `PUSH0` work? see D5)
- [ ] Blockscout verification on testnet.mstscan.com: is it enabled, and what's the API URL?
- [ ] A fresh deployer wallet funded from the faucet; its key lives only in `.env` / CI secrets
- [ ] SARAL / WASMify / grant terms: not needed for v1

---

## PR 1: Monorepo scaffold and CI

**Prompt**

> Set up the Hallmarq monorepo per `docs/DECISIONS.md` D1, D5, D6.
> - pnpm workspace with `packages/core`, `packages/sdk`, `packages/verifier` (empty
>   `src/index.ts` each, with a placeholder test), and a root Hardhat 3 project
>   (`contracts/`, `test/`, `scripts/`, `hardhat.config.ts`) using ethers v6 + mocha.
> - Hardhat config: solc 0.8.26, optimizer 200 runs, `evmVersion: "paris"`. A `mstTestnet`
>   network reads `MST_RPC_URL`, `MST_CHAIN_ID` and `DEPLOYER_PRIVATE_KEY` from env and is
>   only defined when they're all set. Add `.env.example`; `.env` is gitignored.
> - TypeScript strict, ESM, a shared `tsconfig.base.json`. ESLint (typescript-eslint) +
>   Prettier, plus `solhint` for Solidity.
> - Root scripts: `pnpm build`, `pnpm test` (Hardhat tests + every package's vitest),
>   `pnpm lint`, `pnpm format:check`.
> - GitHub Actions `ci.yml` on PRs and pushes to `dev` and `main`: install with a frozen lockfile,
>   lint, format check, build, test. Node 22.
> - `README.md` with a one-paragraph description, layout, and how to run tests.
> - `.nvmrc`, `.editorconfig`, MIT `LICENSE`.
>
> Done when: a fresh clone runs `pnpm i && pnpm lint && pnpm build && pnpm test` green, and CI passes.
> No product code in this PR.

---

## PR 2: `@hallmarq/core`: normalization, hashing, Merkle

**Prompt**

> Implement `packages/core` per the spec sections "Hashing specification" and
> "Merkle batch specification", plus DECISIONS D2, D3, D4.
> - `normalizeText(input: string | Uint8Array): string`. Bytes are decoded as **strict**
>   UTF-8 (`new TextDecoder("utf-8", { fatal: true })`) and throw `InvalidUtf8` if they're
>   invalid. Then apply steps 2–4 exactly as D3 defines whitespace. Don't use regex `\s`
>   or `trimEnd()`.
> - `hashText(input): Hex`, `hashBytes(bytes: Uint8Array): Hex` (keccak256, lowercase
>   `0x` hex). Use `ethers` `keccak256` or `@noble/hashes/sha3` `keccak_256`. Pick one and
>   say which in the PR.
> - `leafHash(contentHash)`, `nodeHash(a, b)` (sorts as 256-bit unsigned integers),
>   `buildTree(contentHashes: Hex[]): { root, layers }`, `getProof(tree, index): Hex[]`,
>   `verifyProof(root, contentHash, proof): boolean`. Odd node moves up unchanged; a batch of one has
>   `root = leaf`; an empty input throws. Duplicate content hashes are allowed.
> - Typed errors: `HallmarqError` base class with a `code` field; `InvalidUtf8`, `EmptyContent`.
> - `networks.ts` per D8, with `hardhat` filled in and `mstTestnet` values left `undefined` and a TODO.
> - `vectors/vectors.json` at the repo root, holding every vector in the spec (the two text vectors,
>   the raw unnormalized hash, and the full A/B/C Merkle example including proofs for A and C), plus
>   new cases: NBSP at the end is kept; lone `\r`; tabs at the end of a line; leading whitespace
>   kept; NFC vs NFD `é` give different hashes; invalid UTF-8 bytes throw; empty and
>   whitespace-only text normalizes to `""`.
>   Write each input as a JSON-escaped string (or hex for bytes) so there's no ambiguity.
> - Vitest suite that loads `vectors.json` and checks every case. Also add a property test with
>   fast-check: for random lists of 1–500 hashes, every honest proof verifies and a flipped bit
>   in the proof, the leaf or the root fails.
>
> Done when: all vectors match the spec byte for byte, coverage of `src/` is at least 95%, and the
> package has zero runtime deps beyond the keccak implementation.

---

## PR 3: `StampRegistry` contract and unit tests

**Prompt**

> Add `contracts/StampRegistry.sol` from the spec's "Reference implementation". Change
> only these things:
> - Pin `pragma solidity 0.8.26;`.
> - Add NatSpec on every external function, event and error.
> - Keep it under 100 lines with no owner, no proxy and no delete (N2). Don't add features.
>
> Tests in `test/StampRegistry.test.ts` (spec "Testing plan → Contract unit"):
> stamp then verify returns every field; a repeat stamp reverts `AlreadyStamped(hash)`; a zero hash
> reverts `EmptyHash` on both paths; a 64-byte model is accepted and 65 bytes reverts `ModelTooLong`
> (use a multi-byte UTF-8 string too, since the cap is in bytes); `count == 0` reverts `EmptyBatch`;
> a repeat root reverts; `Stamped` and `BatchStamped` carry the exact args and timestamp;
> `verify` on an unknown hash returns a zero registrant; `getBatch` works; single stamps and
> batches are separate namespaces (spec "Design notes"); `stampRoot` with `count = 2**32-1` works.
> Add `hardhat-gas-reporter` output, kept out of CI failure conditions. Paste the
> gas table into the PR description.
>
> Done when: all tests pass, `solhint` is clean, and the compile has no warnings.

---

## PR 4: Contract property tests, cross-check, Slither

**Prompt**

> Depends on PRs 2 and 3.
> - `test/StampRegistry.property.test.ts`: fast-check, `numRuns: 1000`. Generate 1–500 random
>   hashes, build the tree with `@hallmarq/core`, call `stampRoot`, and assert that
>   `verifyInBatch` returns true for a random sample of leaves (at least the first, the last and one random).
>   Also assert that each of these returns false: a proof with one byte changed, a changed leaf,
>   a changed root, a root that was never stamped, and the **second-preimage case** (pass an
>   inner node as the `contentHash` with the shortened proof).
>   Deploy once and stamp a different root per run so it stays fast.
> - `test/crosscheck.test.ts`: load `vectors/vectors.json`, stamp the A/B/C root, and check that
>   `verifyInBatch` accepts the published proofs for A and C and rejects a wrong proof (spec
>   "Cross-check").
> - CI job `slither` running `crytic/slither-action` on `contracts/`. Fix every finding or
>   document it in `docs/SECURITY.md` with a reason (e.g. `timestamp` use is intended).
>
> Done when: the property tests pass with 1000 runs in under ~2 minutes in CI and Slither has no
> undocumented findings.

---

## PR 5: Deploy script, MST testnet deployment, explorer verification

**Blocked on the Open Items above.**

**Prompt**

> - Fill in `mstTestnet` in `packages/core/src/networks.ts` and `hardhat.config.ts` with the confirmed
>   values, and adjust `evmVersion` if the hardfork check allows it.
> - `scripts/deploy.ts`: deploy `StampRegistry`, wait 2 confirmations, and print the address, tx
>   hash, block and chain ID. Write them to `deployments/<network>.json` (committed). Refuse to run
>   if the chain ID from the RPC doesn't match the config.
> - Configure Blockscout verification (`@nomicfoundation/hardhat-verify` with a custom chain) and
>   verify the deployed source (N5).
> - `scripts/smoke.ts`: send one real `stamp` and read it back with `verify`.
> - Update `networks.ts` with `registryAddress`. Add the address, chain ID and explorer links to the
>   README.
>
> Done when: the explorer shows verified source, the smoke test passes, and
> `deployments/mstTestnet.json` is committed. Never commit keys.

---

## PR 6: SDK: single stamp and verify

**Prompt**

> Implement `packages/sdk` per the spec sections "SDK" and "SDK reference", except batching (PR 7).
> - `new Hallmarq({ rpcUrl?, chainId?, registryAddress?, signer?, confirmations = 2, batch? })`.
>   Defaults come from `@hallmarq/core` networks (D8). `signer` is optional; without one, only
>   `verify` / hashing work, and the write methods throw `NoSigner`.
> - Re-export `hashText` and `hashBytes` from core.
> - `stamp(content: string | Uint8Array, { model, meta? })`: strings go through `hashText`, bytes
>   through `hashBytes`. `meta`, if given, is an object hashed to `metaHash` with
>   `keccak256(canonical JSON)`; otherwise it's zero. Validate before sending: `EmptyContent`, and
>   `ModelTooLong` when `TextEncoder().encode(model).length > 64`. Use a
>   `staticCall` preflight to catch `AlreadyStamped` without spending gas. Send, wait for
>   `confirmations`, and return `Receipt { contentHash, txHash, blockNumber, registrant, model }`.
> - `verify(content)`: read-only. Returns `VerifyResult { status: "found" | "not-found", registrant?,
>   model?, blockNumber?, timestamp? }`. To get `blockNumber`, query the `Stamped` event filtered by
>   `contentHash`.
>   Also export `verifyInBatch(content, { root, proof })` returning `found-in-batch` + batch info.
> - Errors (all extend `HallmarqError`): `InvalidUtf8`, `EmptyContent`, `ModelTooLong`, `AlreadyStamped`,
>   `NotConfirmed` (sent but confirmations didn't arrive within `confirmTimeoutMs`, default 60s;
>   includes `txHash`), `NetworkError`, `NoSigner`. Decode custom revert errors from the ABI.
> - Retries: up to 3 attempts with backoff **only** when a send fails before a tx hash exists.
>   Once there's a tx hash, never resend. Wait or throw `NotConfirmed`.
> - Ship the ABI from the compiled artifact, generated at build time and not hand-copied.
> - Tests: vitest against an in-process Hardhat network (or a mocked provider where that's simpler),
>   covering every error path, receipt fields and the no-resend rule.
> - README in the package showing the three-line usage from the spec.
>
> Done when: the tests pass, and the bundle doesn't import Node built-ins, so it runs in browsers and Node.

---

## PR 7: SDK: batching

**Prompt**

> Add `stampBatched(content, { model })` and `flush()` per the spec's "Batching behaviour".
> - One open batch per model label. A batch is sent at `maxItems` (default 256), at `maxWaitMs`
>   (default 30000) after its first item, or on `flush()`. Each call returns a promise that resolves
>   with `Receipt` + `{ root, proof, batchSize }` when the batch confirms, or rejects with the same error for every
>   item in the batch.
> - A batch is sent through `stampRoot(root, count, model)`. The proof comes from `@hallmarq/core`.
>   Same retry and no-resend rules as PR 6.
> - Export `Receipt` as JSON-serializable, so the verifier can load it as a "proof file". Define
>   `ReceiptFile` with `{ version: 1, chainId, registryAddress, contentHash, root, proof, model, txHash }`
>   and document it.
> - Timers must not keep the Node process alive after `flush()` (`unref`), and `close()` flushes and
>   clears timers.
> - Tests with fake timers: triggers on size, triggers on time, flush sends everything, separate
>   models get separate batches, the no-resend rule, `NotConfirmed`, and a 1-item batch has an empty proof.
>
> Done when: the tests pass and every receipt from a batch verifies with `verifyInBatch` on-chain.

---

## PR 8: Verifier page

**Prompt**

> Build `packages/verifier` per the spec sections "Verifier page" and "Verification algorithm",
> plus D7.
> - Vite + vanilla TS. Inputs: a textarea, a file drop (raw bytes) and an optional receipt file
>   (`ReceiptFile` from PR 7). The page runs the spec's 5-step algorithm exactly.
> - Four result states with **exactly** the visitor wording from the spec table: Registered,
>   Registered in a batch, No record found, Network error (with retry). Always show the computed
>   hash. Show the model as "declared by registrant". Show times in UTC. Link to the tx on
>   `explorerUrl`.
> - For a text paste, run `normalizeText` and show "normalized" with a toggle to view it, so
>   users understand why a hash changed.
> - No wallet code, no `window.ethereum`. Use a CSP meta tag that allows `connect-src` only to the RPC
>   origin. No external fonts or scripts (N1). Read-only `JsonRpcProvider`.
> - Accessible: labelled inputs, keyboard file picker, results in an `aria-live` region, and works at
>   360px wide.
> - Tests: vitest + jsdom for the state logic, plus one Playwright test running against a local Hardhat node
>   with a stamped fixture that sees each of the four states.
> - CI: build and deploy to GitHub Pages on merge to `main`.
>
> Done when: the Playwright test passes, the built page has no third-party requests, and the bundle is
> under 250 KB gzipped.

---

## PR 9: End-to-end test and cost measurement

**Prompt**

> - `scripts/e2e.ts` (manual / `workflow_dispatch`, uses testnet secrets): take a canned LLM reply
>   (a fixture, no API key needed), `stamp` it with the SDK, wait 2 confirmations, and record the time
>   from send to the first confirmed `verify` read (N4). Then open the deployed verifier with
>   Playwright in a clean context with no wallet, paste the text and assert **Registered**. Do the
>   same for a batched item using its receipt file.
> - `scripts/measure-gas.ts`: on testnet, send one `stamp` and `stampRoot` for N = 1, 16, 256, 1024,
>   and read `gasUsed × effectiveGasPrice`. Write `docs/COSTS.md` with the spec's cost table
>   filled in with measured numbers, plus the break-even N.
>
> Done when: an e2e run is green and linked in the PR, and `docs/COSTS.md` holds real numbers.

---

## PR 10: Docs and release

**Prompt**

> - README: what Hallmarq proves and what it doesn't (spec "Security and limits"), quick start,
>   deployed addresses, verifier URL, a link to the explorer's verified source, and how to run the tests.
> - `docs/SPEC.md`: the spec as Markdown, updated so it matches the code (final SDK names,
>   `ReceiptFile`, D3 whitespace rule, addresses, measured costs). Mark resolved Open Items.
> - `docs/SECURITY.md`: threat table from the spec + Slither notes + "front-running accepted for v1".
> - Tag `v0.1.0`. Publish `@hallmarq/core` and `@hallmarq/sdk` to npm only if the founder says so.
>
> Done when: someone new can stamp and verify from the README alone.
