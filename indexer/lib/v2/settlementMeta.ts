/**
 * The settlement metadata /v2/markets serves (source count, single-source wait, payout route).
 *
 * Every field is a setting the admin can change on chain: `SettlementOracle.setMarket` (sources and
 * uncorroboratedDelay, CONFIG_ADMIN) and `PayoutRouter.setRouteV3/setRouteV4/clearRoute`. The registry holds the values
 * the deploy configured, so serving it alone shows the launch-day numbers after the admin changes one. The indexer
 * already records the live values (`v2OracleMarketConfig` from `MarketConfigured`, `v2PayoutRoute` from
 * `RouteSet`/`RouteCleared`), so those win. The registry is only the fallback for a field the indexer has not seen an
 * event for yet (an indexer started after the deploy block), which is the value the deploy configured.
 */

export type SettlementRoute =
  | null
  | { venue: "v3"; fee: number }
  | { venue: "v4"; fee: number; tickSpacing: number; poolId: `0x${string}` };

export type SettlementMeta = { sourceCount: number; uncorroboratedDelayS: number; route: SettlementRoute };

/** A `v2OracleMarketConfig` row: the market's current configuration. */
export type OracleConfigRow = { sources: readonly string[]; uncorroboratedDelayS: bigint };

/** A `v2PayoutRoute` row. `venue` is IPayoutRouter.Venue: 0 none, 1 v3, 2 v4. */
export type PayoutRouteRow = { active: boolean; venue: number; fee: number; tickSpacing: number; poolId: string };

/** The wire route of an indexed row: an inactive or venue-0 row is "no route", an unknown venue is not guessed. */
export function routeFromRow(row: PayoutRouteRow): SettlementRoute | undefined {
  if (!row.active || row.venue === 0) return null;
  if (row.venue === 1) return { venue: "v3", fee: row.fee };
  if (row.venue === 2) return { venue: "v4", fee: row.fee, tickSpacing: row.tickSpacing, poolId: row.poolId.toLowerCase() as `0x${string}` };
  return undefined;
}

/**
 * The served metadata: each field from its indexed row when there is one, else from the registry. `undefined` when the
 * market is not a registry market (unchanged: such a market is served without a settlement block).
 */
export function settlementMeta(
  registered: SettlementMeta | undefined,
  oracle: OracleConfigRow | undefined,
  route: PayoutRouteRow | undefined,
): SettlementMeta | undefined {
  if (registered === undefined) return undefined;
  const liveRoute = route === undefined ? undefined : routeFromRow(route);
  return {
    sourceCount: oracle !== undefined && oracle.sources.length > 0 ? oracle.sources.length : registered.sourceCount,
    uncorroboratedDelayS: oracle !== undefined ? Number(oracle.uncorroboratedDelayS) : registered.uncorroboratedDelayS,
    route: liveRoute === undefined ? registered.route : liveRoute,
  };
}
