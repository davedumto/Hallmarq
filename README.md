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

Status: pre-build. PR 1 (monorepo scaffold) is next.
