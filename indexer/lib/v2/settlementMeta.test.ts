import { describe, expect, it } from "vitest";

import { routeFromRow, settlementMeta, type SettlementMeta } from "./settlementMeta";

const POOL_ID = "0xDF5C0BCD967D54774C139A4EF803EC994779736346FB4C21B50ED241B1FD2682";
const REGISTERED: SettlementMeta = {
  sourceCount: 2,
  uncorroboratedDelayS: 21_600,
  route: { venue: "v4", fee: 375, tickSpacing: 4, poolId: POOL_ID.toLowerCase() as `0x${string}` },
};
const route = (over: Partial<Parameters<typeof routeFromRow>[0]> = {}) =>
  ({ active: true, venue: 1, fee: 500, tickSpacing: 0, poolId: `0x${"0".repeat(64)}`, ...over });

describe("settlementMeta: the live settings win, the registry is only the fallback", () => {
  it("serves the registry when the indexer has seen no MarketConfigured or RouteSet", () => {
    expect(settlementMeta(REGISTERED, undefined, undefined)).toEqual(REGISTERED);
  });

  it("serves the live source count and single-source wait after the owner calls setMarket", () => {
    const live = settlementMeta(REGISTERED, { sources: ["0x01"], uncorroboratedDelayS: 43_200n }, undefined);
    expect(live).toEqual({ ...REGISTERED, sourceCount: 1, uncorroboratedDelayS: 43_200 });
  });

  it("serves the live payout route after setRouteV3, and no route after clearRoute", () => {
    expect(settlementMeta(REGISTERED, undefined, route())?.route).toEqual({ venue: "v3", fee: 500 });
    expect(settlementMeta(REGISTERED, undefined, route({ active: false, venue: 0 }))?.route).toBeNull();
  });

  it("keeps a v4 route's tick spacing and lower-cases its pool id", () => {
    expect(routeFromRow(route({ venue: 2, fee: 375, tickSpacing: 4, poolId: POOL_ID }))).toEqual(REGISTERED.route);
  });

  it("does not guess an unknown venue or an empty source list: the registry field stays", () => {
    expect(settlementMeta(REGISTERED, { sources: [], uncorroboratedDelayS: 21_600n }, route({ venue: 7 }))).toEqual(REGISTERED);
  });

  it("serves no settlement block for a market the registry does not know, as before", () => {
    expect(settlementMeta(undefined, { sources: ["0x01", "0x02"], uncorroboratedDelayS: 1_800n }, route())).toBeUndefined();
  });
});
