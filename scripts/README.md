# scripts/

MST testnet tooling, run with `hardhat run --network mstTestnet --build-profile default`.
In practice they are run through the `deploy-testnet` GitHub Actions workflow
(`.github/workflows/deploy-testnet.yml`, manual trigger only), so the deploy key
never leaves GitHub's secret store.

- `deploy.ts`: deploys `StampRegistry` and writes `deployments/mstTestnet.json`.
  Refuses to run if the RPC's chain ID isn't 91562037, if the deployer holds less
  than 0.01 tMSTC, or if a deployment record already exists (unless `--force`).
- `verify.ts`: submits the exact compiled source to the testnet.mstscan.com
  explorer and waits for it to be verified (see `docs/DECISIONS.md` D14 for the
  current state of MST's verifier).
- `smoke.ts`: uses `@hallmarq/sdk` against the deployed contract: one stamp, one
  not-found lookup, and a batch across two model labels checked through their
  receipt files. Prints every transaction and the send-to-confirmed-read time.

`verify` and `smoke` read `deployments/mstTestnet.json`; until it is committed,
pass the contract address and deployment block as workflow inputs instead.
