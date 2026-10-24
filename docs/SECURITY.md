# Security

## What a stamp proves

A stamp proves who registered a hash and when. It does not prove who wrote
the content or which model actually produced it.

## Security and limits (spec)

| Risk | Effect | Mitigation |
| --- | --- | --- |
| False model label | Registrant can name any model | Show the label as "declared by registrant"; later, add signed attestations from AI providers |
| Front-running | Someone copies a hash from the mempool and registers it first | Accept it for v1 and document it; a commit-reveal step is a later option |
| Content edited after stamping | Hash no longer matches | Verifier states that matches are exact only |
| Missing stamp | Absence proves nothing | Verifier wording says so explicitly |
| Key loss or theft | Attacker can stamp as the registrant | SDK supports a dedicated low-value signing key |
| Bugs in the contract | Permanent wrong records | Keep it under 100 lines, test thoroughly, and verify the source on the explorer |

Front-running is accepted for v1.

## Slither

Run as the `slither` CI job (`.github/workflows/ci.yml`), `solc 0.8.26`, EVM
target `paris`, `slither-analyzer` pinned to `0.11.6` (via
`crytic/slither-action@v0.4.2`). The job fails on any finding of medium
severity or above.

<!--
  TODO (filled in once the first CI run on this PR reports back): the route
  actually taken (crytic/slither-action against the Hardhat project, or the
  direct-.sol-file fallback with solc-select, and why), and the full list of
  findings below, each with its severity and a fix or justification.
-->

Findings:

_To be filled in from the CI run on this PR._
