import type { V2MarketStatus } from "../markets";

export const NOT_LISTED_LABEL = "Not listed yet";

export type MarketEnablement = "checking" | "enabled" | "disabled" | "unavailable";
export type MarketRouteState = "checking" | "listed" | "not-listed" | "unavailable";

export type MarketAccessInput = {
  /** Registration written back to the compiled registry. */
  registered: boolean;
  /** Coordinated app release state, independent of on-chain registration. */
  releaseStatus: V2MarketStatus;
  /** Current chain state, normally supplied by the indexer and read on chain on indexer failure. */
  enablement: MarketEnablement;
  /** Executable ask depth, when a caller has book evidence. Registration never implies liquidity. */
  executableAskUnits?: bigint | null;
};

export type MarketAccess = {
  registered: boolean;
  enabled: boolean | null;
  routeState: MarketRouteState;
  hasExecutableOrder: boolean | null;
};

/** Keep registration, release, enablement and executable liquidity as four separate facts. */
export function marketAccess(input: MarketAccessInput): MarketAccess {
  const enabled = input.enablement === "enabled" ? true : input.enablement === "disabled" ? false : null;
  let routeState: MarketRouteState;
  if (!input.registered || input.releaseStatus !== "live" || enabled === false) routeState = "not-listed";
  else if (enabled === true) routeState = "listed";
  else routeState = input.enablement === "unavailable" ? "unavailable" : "checking";

  return {
    registered: input.registered,
    enabled,
    routeState,
    hasExecutableOrder: input.executableAskUnits === undefined
      ? null
      : routeState === "listed" && (input.executableAskUnits ?? 0n) > 0n,
  };
}
