import type { Market } from "@/lib/v2/api-types";

/**
 * Put surfaces follow each market's registry
 * `puts` flag, never a hard-coded rule, so they come back the day a market enables puts. These are the LIVE markets
 * whose flag is `true`: a planned or paused market's flag offers nothing to buy. Nothing is known while the markets
 * load, so nothing shows until then.
 */
export function putTickers(markets: readonly Pick<Market, "ticker" | "puts" | "status">[] | undefined): ReadonlySet<string> {
  return new Set((markets ?? []).filter((market) => market.status === "live" && market.puts === true)
    .map((market) => market.ticker));
}
