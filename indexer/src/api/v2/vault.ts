import type { Hono } from "hono";

import { USDG, V2_MAKER_VAULT } from "../../../lib/env";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { readMakerVaultState } from "./chain";
import { address, error, money } from "./shared";

const marketAssets = new Map(V2_REGISTRY.markets.map((market) => [
  market.underlying.toLowerCase(), market.ticker,
]));

function assetMeta(asset: string) {
  if (asset.toLowerCase() === USDG.toLowerCase()) return { symbol: "USDG", decimals: 6 };
  return { symbol: marketAssets.get(asset.toLowerCase()) ?? "Stock Token", decimals: 18 };
}

export function registerVaultRoutes(app: Hono) {
  app.get("/vault", async (c) => {
    if (V2_MAKER_VAULT === undefined) {
      return error(c, "not_configured", "MakerVault is not configured.", 404);
    }
    const live = await readMakerVaultState(V2_MAKER_VAULT);
    if (live === null) {
      return error(c, "vault_unavailable", "MakerVault live state is temporarily unavailable.", 503);
    }
    const balances = live.assets.map((item) => {
      const meta = assetMeta(item.asset);
      return {
        asset: address(item.asset),
        symbol: meta.symbol,
        wallet: money(item.wallet, meta.decimals),
        ledger: money(item.ledger, meta.decimals),
      };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol) || left.asset.localeCompare(right.asset));

    return c.json({
      vault: address(V2_MAKER_VAULT),
      protocol: true as const,
      balances: {
        wallet: balances.map(({ asset, symbol, wallet: free }) => ({ asset, symbol, free })),
        ledger: balances.map(({ asset, symbol, ledger: free }) => ({ asset, symbol, free })),
      },
      limits: {
        maxSeriesUnits: live.limits.maxSeriesUnits.toString(),
        maxTotalNotional: live.limits.maxTotalNotional.toString(),
        askToleranceBps: live.limits.askToleranceBps,
        maxBidBpsOfSpot: live.limits.maxBidBpsOfSpot,
        maxOrderLifetime: live.limits.maxOrderLifetime,
        maxDailyOutflow: live.limits.maxDailyOutflow.toString(),
      },
      outflow: {
        used: money(live.outflowUsed),
        cap: money(live.limits.maxDailyOutflow),
      },
      liveOrderCount: live.liveOrderCount,
      trackedSeries: live.trackedSeries.map((longId) => longId.toString()),
    });
  });
}
