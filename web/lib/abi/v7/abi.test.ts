import { type AbiFunction, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { v7ClearinghouseAbi } from "./clearinghouse";
import { v7OrderBookAbi } from "./orderBook";

const ABI = [...v7ClearinghouseAbi, ...v7OrderBookAbi] as const;
const MUTATING_ALLOWLIST = ["cancel", "claimOwed", "close", "redeem", "withdraw"] as const;

/**
 * The five v7 exit selectors, frozen.
 *
 * These are the one thing in this directory that a v7 holder's wallet has already signed
 * against, so they are pinned as literals on purpose — a pin that recomputed its own expectation
 * would agree with any value. What matters is the OTHER side of the comparison: the selectors
 * below are checked against selectors DERIVED FROM `v7ClearinghouseAbi` AND `v7OrderBookAbi`,
 * not from signature strings retyped in this file.
 *
 * That distinction is the whole point of the test. Until 2026-09-20 this block read
 * `toFunctionSelector("redeem(uint256,address)")` and compared it to `"0x7bde82f2"` — keccak of a
 * literal against a literal, with neither ABI imported into the assertion. It passed identically
 * whether the frozen files were intact, mutated or DELETED, which is to say the one assertion
 * whose job is to catch a frozen file being edited could not see the file.
 */
const FROZEN_SELECTORS = {
  cancel: "0x2e340823",
  claimOwed: "0xf2652d9c",
  close: "0x9a11815c",
  redeem: "0x7bde82f2",
  withdraw: "0x69328dec",
} as const;

/** Every `function` entry in the frozen subset, as viem's ABI type rather than as JSON. */
function frozenFunctions(): AbiFunction[] {
  return ABI.filter((entry) => entry.type === "function") as unknown as AbiFunction[];
}

describe("frozen v7 run-off ABI", () => {
  it("contains only the five exit writes", () => {
    const writes = ABI
      .filter((entry) => entry.type === "function" && entry.stateMutability === "nonpayable")
      .map((entry) => entry.name)
      .sort();
    expect(writes).toEqual([...MUTATING_ALLOWLIST].sort());
  });

  it("pins every exit selector, derived from the frozen ABI itself", () => {
    const functions = frozenFunctions();

    // The control that makes the pin below load-bearing rather than vacuous. The selector map is
    // built BY ITERATING THE ABI, so if a frozen file is emptied, truncated or deleted the map
    // simply has fewer keys — and a comparison that only walks the keys it was given would pass
    // on nothing at all. Assert the subject is present, by name, before asserting anything about
    // its contents, and fail here with a message that says the ABI is the thing that changed.
    expect(functions.map((entry) => entry.name).sort()).toEqual([...MUTATING_ALLOWLIST].sort());

    const derived = Object.fromEntries(
      functions.map((entry) => [entry.name, toFunctionSelector(entry)]),
    );
    expect(derived).toEqual(FROZEN_SELECTORS);
  });

  it("keeps the v7 redeem return tuple rather than the v8 shape", () => {
    const redeem = v7ClearinghouseAbi.find((entry) => entry.name === "redeem");
    expect(redeem?.outputs).toEqual([
      { name: "paid", type: "uint256", internalType: "uint256" },
      { name: "inUsdg", type: "bool", internalType: "bool" },
    ]);
  });
});
