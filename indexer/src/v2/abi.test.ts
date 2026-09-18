/**
 * The v2 ABI pipeline's consumer end, as the indexer sees it.
 *
 * WHY THIS FILE EXISTS: abis/v2/*.ts and src/v2/seriesId.ts are generated from ops/
 * and committed, because Ponder's type inference needs the `as const` literal
 * at build time. Nothing else notices when a contract lane re-exports ops/abis/v2 and nobody
 * reruns `pnpm gen:abis`; the handlers would keep decoding against the old ABI. So:
 *   1. the drift test runs the generator in `--check` mode, which renders every output in memory
 *      and fails on any drifted, missing or stale file;
 *   2. the series id mirror is checked against the vectors Solidity wrote
 *      (callhouse-contracts script/v2/EmitSeriesIds.s.sol → ops/fixtures/v2/series-ids.json);
 *   3. a smoke test pins that the clearinghouse module is a narrow literal carrying the functions,
 *      events and V2Errors errors the indexer will decode (the type-level half runs under
 *      `pnpm typecheck`, the runtime half here).
 *
 * DELIBERATELY ABSENT: no RPC. Every check is against files in the repository.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Address, ContractErrorName, ContractEventName, ContractFunctionName } from "viem";
import { describe, expect, it } from "vitest";

import { clearinghouseAbi } from "../../abis/v2/clearinghouse";
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
  it("the committed v1 and v2 modules and the seriesId copy match a fresh render of ops/", () => {
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

describe("abis/v2/clearinghouse.ts", () => {
  // Type level: these assignments fail `pnpm typecheck` if a name leaves the ABI, and the two
  // expected-error lines fail it if the module stops being a narrow `as const` literal (a widened
  // ABI types every name as `string` and the expected error disappears).
  const functions: ContractFunctionName<typeof clearinghouseAbi>[] = ["longIdOf", "createSeries", "redeem"];
  const events: ContractEventName<typeof clearinghouseAbi>[] = ["SeriesCreated"];
  const errors: ContractErrorName<typeof clearinghouseAbi>[] = ["InsufficientCollateral", "UnknownSeries"];
  // @ts-expect-error not a function of the clearinghouse
  const notAFunction: ContractFunctionName<typeof clearinghouseAbi> = "notAFunction";
  // @ts-expect-error not an error of the clearinghouse or V2Errors
  const notAnError: ContractErrorName<typeof clearinghouseAbi> = "NotAnError";

  const names = (type: string) => new Set(clearinghouseAbi.flatMap((item) => (item.type === type && "name" in item ? [item.name] : [])));

  it("carries the functions, events and V2Errors errors the indexer decodes", () => {
    for (const name of functions) expect(names("function")).toContain(name);
    for (const name of events) expect(names("event")).toContain(name);
    for (const name of errors) expect(names("error")).toContain(name);
    expect(names("function")).not.toContain(notAFunction);
    expect(names("error")).not.toContain(notAnError);
  });
});

describe("v7 rent tuple and event ABI pins", () => {
  it("retains appended series and market rent fields and changed selectors", async () => {
    const { toFunctionSelector, toEventSelector } = await import("viem");
    const market = clearinghouseAbi.find((item) => item.type === "function" && item.name === "market")!;
    const series = clearinghouseAbi.find((item) => item.type === "function" && item.name === "series")!;
    expect(market.outputs[0].components.map((field) => [field.name, field.type])).toEqual([
      ["enabled", "bool"], ["mintPaused", "bool"], ["strikeTick", "uint64"],
      ["exerciseFeeBps", "uint16"], ["oracle", "address"], ["mintFeePpm", "uint32"],
    ]);
    expect(series.outputs[0].components.slice(-2).map((field) => [field.name, field.type])).toEqual([
      ["mintFeePpm", "uint32"], ["mintFeesHeld", "uint128"],
    ]);
    expect(toFunctionSelector(clearinghouseAbi.find((item) => item.type === "function" && item.name === "registerMarket")!)).toBe("0xfb2a821f");
    expect(toFunctionSelector(clearinghouseAbi.find((item) => item.type === "function" && item.name === "mintFee")!)).toBe("0xdb66f63c");
    expect(toEventSelector(clearinghouseAbi.find((item) => item.type === "event" && item.name === "Minted")!)).toBe("0x89b7f2e14bc7bca4f2fd443683827b62e46c6f22ac4145d38f930082a62fcab5");
    expect(toEventSelector(clearinghouseAbi.find((item) => item.type === "event" && item.name === "Closed")!)).toBe("0x895110f6bb596a7019986496b866a4cebf45e0d53ff8946c952974d456540381");
    expect(toEventSelector(clearinghouseAbi.find((item) => item.type === "event" && item.name === "MintFeesAccrued")!)).toBe("0x7370e99169ee22a18273e3ff9c18124c7a0019b6f23db1f73cb86777d2b245fb");
  });

  it("retains stale cancellation and the MakerVault's appended native USDG cap", async () => {
    const { toFunctionSelector, toEventSelector } = await import("viem");
    const { autoRollerAbi } = await import("../../abis/v2/autoRoller");
    const { makerVaultAbi } = await import("../../abis/v2/makerVault");
    expect(toFunctionSelector(autoRollerAbi.find((item) => item.type === "function" && item.name === "cancelStale")!)).toBe("0xbd1a6747");
    expect(toEventSelector(autoRollerAbi.find((item) => item.type === "event" && item.name === "StaleAskCancelled")!)).toBe("0xcebe2d1e4742352b05b507fd5e0c0df36f9521884bd871d344cb9969b15ff942");
    const limits = makerVaultAbi.find((item) => item.type === "function" && item.name === "limits")!;
    expect(limits.outputs[0].components.at(-1)).toMatchObject({ name: "maxDailyOutflow", type: "uint128" });
    expect(toFunctionSelector(makerVaultAbi.find((item) => item.type === "function" && item.name === "setLimits")!)).toBe("0x6693cc27");
  });
});
