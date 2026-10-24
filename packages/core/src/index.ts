export type { Hex } from "./types.js";

export { normalizeText } from "./normalize.js";
export { hashText, hashBytes } from "./hash.js";
export { assertHash32 } from "./bytes.js";
export { leafHash, nodeHash, buildTree, getProof, verifyProof } from "./merkle.js";
export type { MerkleTree } from "./merkle.js";
export { HallmarqError, InvalidUtf8, EmptyContent, EmptyBatch, InvalidHex } from "./errors.js";
export { hardhat, mstTestnet } from "./networks.js";
export type { NetworkConfig } from "./networks.js";
