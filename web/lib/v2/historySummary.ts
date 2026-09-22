import { v2Api } from "./api";
import type { HistoryItem } from "./api-types";

export type StockAmount = { asset: string; ticker: string; decimals: number; raw: bigint };

/** These are independent settled-history figures, not components of a single account balance. */
export function summariseHistory(items: readonly HistoryItem[], account?: string) {
  let realisedUsdg = 0n;
  let fillFeesUsdg = 0n;
  let mintFeesUsdg = 0n;
  let fillRebatesUsdg = 0n;
  let primaryMakerPremiumUsdg = 0n;
  let mintFeesWithoutPayer = 0;
  let mintFeesPaidByAnother = 0;
  const stockPayouts = new Map<string, StockAmount>();
  const stockMintFees = new Map<string, StockAmount>();
  const seen = new Set<string>();
  const wallet = account?.toLowerCase();

  for (const item of items) {
    // Cursor pages can overlap while the indexer is catching up. Count a transaction row once.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if ("realisedPnl" in item.data && item.data.realisedPnl)
      realisedUsdg += BigInt(item.data.realisedPnl.raw);

    if (item.kind === "fill") {
      fillFeesUsdg += BigInt(item.data.fee.raw);
      fillRebatesUsdg += BigInt(item.data.rebate.raw);
      if (item.data.role === "maker" && item.data.side === "sell" && item.data.primary)
        primaryMakerPremiumUsdg += BigInt(item.data.premium.raw) - BigInt(item.data.fee.raw) + BigInt(item.data.rebate.raw);
    }

    if (item.kind === "mint" && BigInt(item.data.fee.raw) > 0n) {
      if (!item.data.payer) mintFeesWithoutPayer++;
      else if (wallet) {
        if (item.data.payer.toLowerCase() !== wallet) mintFeesPaidByAnother++;
        else if (item.series.isPut) mintFeesUsdg += BigInt(item.data.fee.raw);
        else {
          const asset = item.series.underlying.toLowerCase();
          const decimals = item.data.fee.decimals;
          const key = `${item.series.ticker}:${asset}:${decimals}`;
          const previous = stockMintFees.get(key);
          stockMintFees.set(key, { asset, ticker: item.series.ticker, decimals,
            raw: (previous?.raw ?? 0n) + BigInt(item.data.fee.raw) });
        }
      }
    }

    // amountInKind is collateral owed, even when conversion actually paid USDG. Only
    // the delivered asset/amount of a long-call redemption is a Stock Token payout.
    if (item.kind === "redemption" && item.data.side === "long" && !item.series.isPut &&
      BigInt(item.data.amount.raw) > 0n &&
      item.data.asset.toLowerCase() === item.series.underlying.toLowerCase()) {
      const asset = item.data.asset.toLowerCase();
      const decimals = item.data.amount.decimals;
      const key = `${item.series.ticker}:${asset}:${decimals}`;
      const previous = stockPayouts.get(key);
      stockPayouts.set(key, { asset, ticker: item.series.ticker, decimals,
        raw: (previous?.raw ?? 0n) + BigInt(item.data.amount.raw) });
    }
  }

  const byTickerAndAsset = (a: StockAmount, b: StockAmount) =>
    a.ticker.localeCompare(b.ticker) || a.asset.localeCompare(b.asset);
  return { realisedUsdg, fillFeesUsdg, mintFeesUsdg, feesPaidUsdg: fillFeesUsdg + mintFeesUsdg,
    fillRebatesUsdg, primaryMakerPremiumUsdg, mintFeesWithoutPayer, mintFeesPaidByAnother,
    stockPayouts: [...stockPayouts.values()].sort(byTickerAndAsset),
    stockMintFees: [...stockMintFees.values()].sort(byTickerAndAsset) };
}

/** Keep the writer's lifetime scan and Portfolio's loaded-page calculation on the same rule. */
export function primaryMakerPremium(items: readonly HistoryItem[], ticker?: string): bigint {
  return ticker === undefined ? summariseHistory(items).primaryMakerPremiumUsdg
    : summariseHistory(items.filter((item) => item.series?.ticker === ticker)).primaryMakerPremiumUsdg;
}

type HistoryReader = typeof v2Api.getHistory;

export async function lifetimePremium(address: string, ticker: string, signal: AbortSignal,
  readHistory: HistoryReader = (wallet, params, options) => v2Api.getHistory(wallet, params, options),
): Promise<{ amount: bigint; complete: boolean }> {
  let cursor: string | undefined;
  let amount = 0n;
  const seenCursors = new Set<string>();
  const seenRows = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const response = await readHistory(address, { limit: 200, ...(cursor ? { cursor } : {}) }, { signal });
    const fresh = response.items.filter((item) => !seenRows.has(item.id));
    for (const item of fresh) seenRows.add(item.id);
    amount += primaryMakerPremium(fresh, ticker);
    if (!response.nextCursor) return { amount, complete: true };
    if (seenCursors.has(response.nextCursor)) break;
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  return { amount, complete: false };
}
