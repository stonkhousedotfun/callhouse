/**
 * The epoch Merkle primitives, shared by every reward program.
 *
 * WHY THIS FILE EXISTS. `maker-epoch.mjs` and `lender-epoch.mjs` must produce IDENTICAL trees -- the same leaf,
 * the same node hash, the same ordering -- because both are verified on chain by the same
 * `RewardsDistributor.claim` and off chain by the same `validateEpoch`, which rebuilds with the real
 * `@openzeppelin/merkle-tree`. Two hand-maintained copies of that algorithm is how they drift, and a drifted
 * copy does not fail loudly: it produces a DIFFERENT ROOT for the same input, which looks like a valid epoch
 * until a claim reverts. So there is one copy and both programs import it.
 *
 * THE FORMAT IS NOT OURS TO CHOOSE. It mirrors, and must keep mirroring:
 *   - the leaf, `contracts src/v2/mm/RewardsDistributor.sol:201`:
 *       keccak256(bytes.concat(keccak256(abi.encode(epoch, index, account, amount))))
 *   - the node hash: OpenZeppelin's sorted-pair commutative keccak, which `MerkleProof` verifies with
 *   - the layout: `StandardMerkleTree` with its DEFAULT sortLeaves -- hash-sort the leaves, then reverse-fill
 *     a complete tree of 2n-1 nodes
 * Extracted verbatim from `indexer/scripts/maker-epoch.mjs:7-13,104-132`, which is the implementation the
 * published vector `indexer/src/v2/fixtures/maker-epoch-2958.oz.json` was produced with.
 */
import { encodeAbiParameters, keccak256, concatHex } from "viem";

/** Seconds in an epoch. Mirrors `maker-epoch.mjs:7`. */
export const WEEK_SECONDS = 604_800n;
/** Monday 1970-01-05 00:00 UTC, epoch 0. Mirrors `maker-epoch.mjs:8`. */
export const FIRST_MONDAY_SECONDS = 345_600n;
/** The leaf tuple. Mirrors `maker-epoch.mjs:11-13` and the contract's `leaf()` argument order. */
export const leafTypes = [
  { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
];

/** The §1.9 double-hashed leaf. The double hash is why a 64-byte inner node can never pose as a leaf. */
export function leaf(epoch, entry) {
  const inner = keccak256(encodeAbiParameters(leafTypes, [epoch, BigInt(entry.index), entry.account, entry.amount]));
  return keccak256(inner);
}

/** OpenZeppelin's commutative node hash: the pair is sorted, so proof siblings carry no side. */
export function pair(left, right) {
  return keccak256(concatHex(left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left]));
}

/**
 * Matches OpenZeppelin StandardMerkleTree: hash-sort leaves, then reverse-fill the complete tree.
 * @returns {{root: `0x${string}`, proofs: Map<number, `0x${string}`[]>}} keyed by the entry's PUBLISHED index,
 *          which is its position in the epoch file, not its position in the sorted tree.
 */
export function merkle(epoch, entries) {
  const sorted = entries.map((entry) => ({ entry, hash: leaf(epoch, entry) }))
    .sort((a, b) => a.hash.toLowerCase().localeCompare(b.hash.toLowerCase()));
  const n = sorted.length;
  if (n === 0) throw new Error("no allocated entries");
  const tree = Array(2 * n - 1);
  for (let i = 0; i < n; i++) tree[tree.length - 1 - i] = sorted[i].hash;
  for (let i = n - 2; i >= 0; i--) tree[i] = pair(tree[2 * i + 1], tree[2 * i + 2]);
  const proofs = new Map();
  for (let i = 0; i < n; i++) {
    const proof = [];
    let position = tree.length - 1 - i;
    while (position > 0) {
      proof.push(tree[position % 2 === 0 ? position - 1 : position + 1]);
      position = Math.floor((position - 1) / 2);
    }
    proofs.set(sorted[i].entry.index, proof);
  }
  return { root: tree[0], proofs };
}

/** The epoch's window, [start, end). Mirrors the arithmetic at `maker-epoch.mjs:38-40`. */
export function epochWindow(epoch) {
  const start = FIRST_MONDAY_SECONDS + epoch * WEEK_SECONDS;
  if ((start - FIRST_MONDAY_SECONDS) / WEEK_SECONDS !== epoch) throw new Error("invalid epoch");
  return { start, end: start + WEEK_SECONDS };
}
