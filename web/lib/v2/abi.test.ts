/**
 * The v2 ABI pipeline's consumer end, as the dapp sees it.
 *
 * WHY THIS FILE EXISTS: lib/abi/v2/*.ts and lib/v2/seriesId.ts are generated from ops/
 * and committed. Nothing else notices when a contract lane re-exports
 * ops/abis/v2 and nobody reruns `pnpm gen:abis`: the app would encode calls against the old ABI and
 * print a new revert as a bare selector. So:
 *   1. the drift test runs the generator in `--check` mode, which renders every output in memory
 *      (lib/abi/vault.ts included) and fails on any drifted, missing or stale file;
 *   2. the series id mirror is checked against the vectors Solidity wrote
 *      (callhouse-contracts script/v2/EmitSeriesIds.s.sol → ops/fixtures/v2/series-ids.json), since
 *      a wrong id here would show a user an empty position or build a redeem for the wrong series;
 *   3. a smoke test pins that the clearinghouse module is a narrow literal carrying the functions,
 *      events and V2Errors errors the app will call and decode (the type-level half runs under
 *      `pnpm typecheck`, the runtime half here).
 *
 * DELIBERATELY ABSENT: no RPC and no React. Every check is against files in the repository.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Address, ContractErrorName, ContractEventName, ContractFunctionName } from "viem";
import { describe, expect, it } from "vitest";

import { accessManagerAbi } from "@/lib/abi/v2/accessManager";
import { clearinghouseAbi } from "@/lib/abi/v2/clearinghouse";
import { orderBookAbi } from "@/lib/abi/v2/orderBook";
import { payoutAdapterAbi } from "@/lib/abi/v2/payoutAdapter";

import { isShortId, longIdOf, shortIdOf } from "./seriesId";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixturePath = fileURLToPath(new URL("../../../ops/fixtures/v2/series-ids.json", import.meta.url));

/** One vector of ops/fixtures/v2/series-ids.json: uint256 / uint128 as decimal strings. */
interface SeriesIdVector {
  underlying: Address;
  isPut: boolean;
  strike: string;
  expiry: number;
  longId: string;
  shortId: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { vectors: SeriesIdVector[] };

describe("gen-abis --check", () => {
  it("the committed vault, v2 modules and seriesId copy match a fresh render of ops/", () => {
    const run = spawnSync(process.execPath, ["scripts/gen-abis.mjs", "--check"], { cwd: pkgRoot, encoding: "utf8" });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });
});

describe("seriesId mirrors V2Ids.sol", () => {
  it("has vectors to check, starting with the NVDA weekly call", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
    // Pinned so an emptied or regenerated-from-nothing fixture cannot pass by agreeing with itself.
    expect(fixture.vectors[0]).toEqual({
      underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      isPut: false,
      strike: "215000000",
      expiry: 1789675200,
      longId: "1581680213800746635134346334031613802560117164807063567697891155383864121172",
      shortId: "1581680213800746635134346334031613802560117164807063567697891155383864121173",
    });
  });

  it.each(fixture.vectors)("$underlying isPut=$isPut strike=$strike expiry=$expiry", (v) => {
    const longId = BigInt(v.longId);
    const shortId = BigInt(v.shortId);
    const strike = BigInt(v.strike);

    expect(longIdOf(v.underlying, v.isPut, strike, v.expiry)).toBe(longId);
    expect(longIdOf(v.underlying, v.isPut, strike, BigInt(v.expiry))).toBe(longId);
    expect(longIdOf(v.underlying.toLowerCase() as Address, v.isPut, strike, v.expiry)).toBe(longId);
    expect(shortIdOf(longId)).toBe(shortId);
    expect(shortIdOf(shortId)).toBe(shortId);
    expect(isShortId(longId)).toBe(false);
    expect(isShortId(shortId)).toBe(true);
  });

  it("refuses what the Solidity signature would: a strike above uint128, an expiry above uint40", () => {
    const v = fixture.vectors[0]!;
    expect(() => longIdOf(v.underlying, false, 2n ** 128n, v.expiry)).toThrow();
    expect(() => longIdOf(v.underlying, false, 1n, 2 ** 40)).toThrow();
  });
});

describe("lib/abi/v2/clearinghouse.ts", () => {
  // Type level: these assignments fail `pnpm typecheck` if a name leaves the ABI, and the two
  // expected-error lines fail it if the module stops being a narrow `as const` literal (a widened
  // ABI types every name as `string` and the expected error disappears).
  const functions: ContractFunctionName<typeof clearinghouseAbi>[] = ["longIdOf", "createSeries", "redeem", "mintFee", "closeRefund"];
  const events: ContractEventName<typeof clearinghouseAbi>[] = ["SeriesCreated", "MintFeesAccrued"];
  const errors: ContractErrorName<typeof clearinghouseAbi>[] = ["InsufficientCollateral", "UnknownSeries", "InTheMoney", "OutflowCapExceeded"];
  // @ts-expect-error not a function of the clearinghouse
  const notAFunction: ContractFunctionName<typeof clearinghouseAbi> = "notAFunction";
  // @ts-expect-error not an error of the clearinghouse or V2Errors
  const notAnError: ContractErrorName<typeof clearinghouseAbi> = "NotAnError";

  const names = (type: string) => new Set(clearinghouseAbi.flatMap((item) => (item.type === type && "name" in item ? [item.name] : [])));

  it("carries the functions, events and V2Errors errors the app calls and decodes", () => {
    for (const name of functions) expect(names("function")).toContain(name);
    for (const name of events) expect(names("event")).toContain(name);
    for (const name of errors) expect(names("error")).toContain(name);
    expect(names("function")).not.toContain(notAFunction);
    expect(names("error")).not.toContain(notAnError);
  });
});

describe("v8 take, authority and payout router ABI pins", () => {
  it("pins the appended maxTotalFee field and four-field quote", async () => {
    const { toFunctionSelector } = await import("viem");
    const take = orderBookAbi.find((item) => item.type === "function" && item.name === "take")!;
    const quoteTake = orderBookAbi.find((item) => item.type === "function" && item.name === "quoteTake")!;
    const fields = [
      ["longId", "uint256"], ["buying", "bool"], ["orderIds", "uint256[]"], ["units", "uint64"],
      ["minUnits", "uint64"], ["limitPrice", "uint128"], ["writeToSell", "bool"],
      ["recipient", "address"], ["deadline", "uint40"], ["maxTotalFee", "uint128"],
    ];
    expect(take.inputs[0]!.components.map((field) => [field.name, field.type])).toEqual(fields);
    expect(quoteTake.inputs[0]!.components.map((field) => [field.name, field.type])).toEqual(fields);
    expect(quoteTake.outputs.map((field) => [field.name, field.type])).toEqual([
      ["unitsFilled", "uint64"], ["premium", "uint256"], ["takerFee", "uint256"], ["sellerFees", "uint256"],
    ]);
    expect(take.outputs.map((field) => [field.name, field.type])).toEqual([
      ["unitsFilled", "uint64"], ["premium", "uint256"], ["takerFee", "uint256"],
    ]);
    expect(toFunctionSelector(take)).toBe("0xcf96851b");
    expect(toFunctionSelector(quoteTake)).toBe("0xe2e13f01");
  });

  it("decodes AccessManager's uint64 role and complete scheduled operation", () => {
    const roleGranted = accessManagerAbi.find((item) => item.type === "event" && item.name === "RoleGranted")!;
    expect(roleGranted.inputs.map((input) => [input.name, input.type, input.indexed])).toEqual([
      ["roleId", "uint64", true], ["account", "address", true], ["delay", "uint32", false],
      ["since", "uint48", false], ["newMember", "bool", false],
    ]);
    const scheduled = accessManagerAbi.find((item) => item.type === "event" && item.name === "OperationScheduled")!;
    expect(scheduled.inputs.map((input) => [input.name, input.type])).toEqual([
      ["operationId", "bytes32"], ["nonce", "uint32"], ["schedule", "uint48"],
      ["caller", "address"], ["target", "address"], ["data", "bytes"],
    ]);
  });

  it("pins the unchanged routes selector and the v8 router return tuple", async () => {
    const { toFunctionSelector } = await import("viem");
    const routes = payoutAdapterAbi.find((item) => item.type === "function" && item.name === "routes")!;
    expect(toFunctionSelector(routes)).toBe("0xd7409659");
    expect(routes.outputs).toHaveLength(1);
    expect(routes.outputs[0]).toMatchObject({ type: "tuple" });
    expect(routes.outputs[0]!.components.map((field) => [field.name, field.type])).toEqual([
      ["venue", "uint8"], ["fee", "uint24"], ["tickSpacing", "int24"],
      ["v3Pool", "address"], ["feeBps", "uint16"],
    ]);
  });
});
