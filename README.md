# Hallmarq

Hallmarq records a fingerprint (keccak256 hash) of AI-generated content on MST
Blockchain. Anyone can later check whether that exact content was registered, by
which account, and when. Only the hash goes on-chain. The content never leaves the
user's device.

v1 has three parts: a `StampRegistry` contract, a small TypeScript SDK, and a static
verifier page.

- Spec: [`docs/Hallmarq_Technical_Documentation.pdf`](docs/Hallmarq_Technical_Documentation.pdf)
- Engineering decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Build plan and PR prompts: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- How to contribute and what review checks: [`CONTRIBUTING.md`](CONTRIBUTING.md)

Status: `StampRegistry`, `@hallmarq/core` and `@hallmarq/sdk` (single and batched
stamping) are built and tested, and `StampRegistry` is deployed on MST testnet at
`0xce6803cb3027ec299E4FB9660c46547216955dF6`. Source verification on the explorer
is pending a fix on MST's side (see `docs/DECISIONS.md` D14). The verifier page
(`@hallmarq/verifier`) is next.

## Layout

```
hallmarq/
  contracts/            StampRegistry.sol
  test/                 Hardhat tests (unit, property, cross-check, SDK integration)
  scripts/              deploy.ts, verify.ts, smoke.ts (MST testnet tooling)
  tools/                ABI export, Solidity lint and contract-size helpers
  packages/core/        @hallmarq/core: normalize, hash, Merkle, receipt files
  packages/sdk/         @hallmarq/sdk: Hallmarq class (depends on core + ethers)
  packages/verifier/    @hallmarq/verifier: static page (depends on core + ethers)
  vectors/              shared test vectors
  docs/
  hardhat.config.ts
```

Node 22 LTS, pnpm 9, TypeScript strict, ESM only (see `docs/DECISIONS.md` D1).

## Getting started

```bash
pnpm install
```

Requires Node 22 and pnpm 9 (`corepack enable` picks up the version pinned in
`package.json`'s `packageManager` field).

## Running tests

```bash
pnpm test          # Hardhat tests, then every package's vitest suite
pnpm lint          # ESLint + solhint
pnpm format:check  # Prettier
pnpm build         # builds packages/*, type-checks the Hardhat project
```

To use the `mstTestnet` Hardhat network, copy `.env.example` to `.env` and fill
in `MST_RPC_URL`, `MST_CHAIN_ID` and `DEPLOYER_PRIVATE_KEY`. The network is only
defined when all three are set; `.env` is gitignored and must never be committed.
