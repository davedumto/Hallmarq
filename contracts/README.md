# contracts/

`StampRegistry.sol` registers a keccak256 fingerprint of content on-chain,
singly (`stamp`) or in Merkle-batched form (`stampRoot`). The first
registration of a hash or root wins and can never be changed or removed:
there is no owner, no upgrade path and no delete function.

See `docs/Hallmarq_Technical_Documentation.pdf` ("Contract specification",
"Reference implementation") for the full spec, and `docs/ROADMAP.md` for
where this fits in the project roadmap.
