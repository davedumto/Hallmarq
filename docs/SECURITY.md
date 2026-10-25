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

Run as the `slither` CI job (`.github/workflows/ci.yml`), `solc 0.8.28`, EVM
target `paris`, `slither-analyzer` pinned to `0.11.6` (via
`crytic/slither-action@v0.4.2`). The job fails on any finding of medium
severity or above.

**Route:** `crytic/slither-action` against the Hardhat project directly
(`target: "."`), compiling via `npx hardhat compile --force`. This worked:
`crytic-compile` 0.4.2 (the version `slither-analyzer` 0.11.6 ships) reads
the split `build-info/<id>.json` + `<id>.output.json` pair Hardhat 3 writes,
not just Hardhat 2's single combined file. The direct-`.sol`-file fallback
was not needed.

### Findings

| # | Severity | Finding | Fix or justification |
| --- | --- | --- | --- |
| 1-3 | Low | `timestamp` (dangerous usage of `block.timestamp`) in `stamp`, `stampRoot` and `verifyInBatch` | **Timestamp use is intended.** The spec requires `timestamp` as a stored `Stamp`/`Batch` field ("Block timestamp when the stamp was mined") — that is the only use of `block.timestamp` in the contract, in `stamp`/`stampRoot`, and it is a plain assignment, not a comparison. Slither's `timestamp` detector flags every comparison in a function that *also* touches `block.timestamp` anywhere, which is why it lists `_stamps[contentHash].registrant != address(0)` and `_batches[root].registrant != address(0)`/`== address(0)` as "dangerous comparisons" — those are zero-address existence checks and don't read `block.timestamp`'s value at all, in `verifyInBatch`'s case not even in the same function. There is no time-locked logic, no access control and no fund-release gated on `block.timestamp`, so there is nothing here a miner's few-second timestamp latitude could exploit. |

No medium, high or informational findings. Full output (CI run
https://github.com/davedumto/Hallmarq/actions/runs/40132128162):

```
INFO:Detectors:
Detector: timestamp
StampRegistry.stamp(bytes32,string,bytes32) (contracts/StampRegistry.sol#54-61) uses timestamp for comparisons
	Dangerous comparisons:
	- _stamps[contentHash].registrant != address(0) (contracts/StampRegistry.sol#57)
StampRegistry.stampRoot(bytes32,uint32,string) (contracts/StampRegistry.sol#71-79) uses timestamp for comparisons
	Dangerous comparisons:
	- _batches[root].registrant != address(0) (contracts/StampRegistry.sol#75)
StampRegistry.verifyInBatch(bytes32,bytes32,bytes32[]) (contracts/StampRegistry.sol#101-113) uses timestamp for comparisons
	Dangerous comparisons:
	- _batches[root].registrant == address(0) (contracts/StampRegistry.sol#102)
Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#block-timestamp
INFO:Slither:. analyzed (1 contracts with 102 detectors), 3 result(s) found
```
