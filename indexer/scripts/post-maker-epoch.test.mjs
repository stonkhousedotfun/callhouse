import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEpoch } from "./post-maker-epoch.mjs";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../src/v2/fixtures/maker-epoch-2958.oz.json", import.meta.url))));
const copy = () => structuredClone(vector);

test("accepts the contract's OpenZeppelin epoch vector", () => {
  const result = validateEpoch(copy());
  assert.equal(result.epoch, 2958n);
  assert.equal(result.total, 1_750_001n);
  assert.equal(result.root, vector.root);
  assert.equal(result.makers, 4);
});

test("refuses changed allocation, root, proof and duplicate recipient", () => {
  const amount = copy(); amount.entries[0].amount = "700001";
  assert.throws(() => validateEpoch(amount), /entry sum/);
  const root = copy(); root.root = `0x${"1".repeat(64)}`;
  assert.throws(() => validateEpoch(root), /Merkle root/);
  const proof = copy(); proof.entries[0].proof[0] = `0x${"1".repeat(64)}`;
  assert.throws(() => validateEpoch(proof), /proof does not verify/);
  const duplicate = copy(); duplicate.entries[1].account = duplicate.entries[0].account;
  assert.throws(() => validateEpoch(duplicate), /duplicate account/);
  const rounded = copy(); rounded.entries[0].amount = 9007199254740993;
  assert.throws(() => validateEpoch(rounded), /decimal integer string/);
});
