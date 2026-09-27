/**
 * (poster side). `merkle` keys the proofs it returns by the entry's published index, and
 * RewardsDistributor keys its claim bitmap by the same index, so a duplicate index must stop the build: before this
 * row the second entry silently overwrote the first one's proof.
 *
 *   node --test indexer/scripts/lib/epoch-merkle.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { merkle } from "./epoch-merkle.mjs";

const EPOCH = 2958n;
const entries = () => [
  { index: 0, account: "0x0000000000000000000000000000000000000a01", amount: 700_000n },
  { index: 1, account: "0x0000000000000000000000000000000000000a02", amount: 600_000n },
  { index: 2, account: "0x0000000000000000000000000000000000000a03", amount: 450_001n },
];
const TYPES = ["uint256", "uint256", "address", "uint256"];
const values = (list) => list.map((entry) => [EPOCH.toString(), String(entry.index), entry.account, entry.amount.toString()]);

test("distinct indices: the root is OpenZeppelin's and every proof verifies under its own index", () => {
  const list = entries();
  const { root, proofs } = merkle(EPOCH, list);
  const oz = StandardMerkleTree.of(values(list), TYPES);
  assert.equal(root, oz.root);
  assert.equal(proofs.size, list.length);
  for (const [i, value] of values(list).entries()) {
    assert.ok(StandardMerkleTree.verify(root, TYPES, value, proofs.get(list[i].index)), `proof of index ${i}`);
  }
});

test("a duplicate index is refused, not resolved by overwriting a proof", () => {
  const list = entries();
  list[2].index = 1;
  assert.throws(() => merkle(EPOCH, list), /duplicate index 1/);
});

test("the duplicate check compares index VALUES, so 1 and 1n and \"1\" collide", () => {
  const bigint = entries();
  bigint[2].index = 1n;
  assert.throws(() => merkle(EPOCH, bigint), /duplicate index 1/);
  const string = entries();
  string[0].index = "2";
  assert.throws(() => merkle(EPOCH, string), /duplicate index 2/);
});
