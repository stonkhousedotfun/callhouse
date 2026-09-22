"use client";

import { useAccount } from "wagmi";

import { Button, Notice, PageHead, Panel } from "@/components/ui";
import type { HistoryItem } from "@/lib/v2/api-types";
import { useHistory, useMarkets } from "@/lib/v2/hooks";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";

/**
 * "What have I actually made" for a writer (W5, plan gap 9 and section 5.2).
 *
 * THE DATA IS ALREADY ON THE WIRE AND THROWN AWAY. `GET /v2/accounts/:address/history` returns
 * `fee`, `rebate` and `feeRefund` on the items that carry them, and the history table renders none
 * of them. Nothing here needs a new endpoint.
 *
 * WHAT IS DELIBERATELY NOT SUMMED, and this is the whole reason the function exists rather than a
 * `reduce` at the call site: `mint.fee` and `close.feeRefund` are denominated in the SERIES'
 * COLLATERAL -- Stock Tokens for a call, USDG for a put -- while `fill.fee`, `fill.rebate` and
 * `fill.premium` are USDG. Adding them produces one number out of two assets, which is wrong in a
 * way that looks right: it renders, it is plausible, and no test that only checks arithmetic would
 * catch it. Only the USDG-denominated fills are summed, and the mint/close fees are counted
 * separately so the omission is visible rather than silent.
 *
 * DECIMALS ARE CHECKED, NOT ASSUMED. Every `Money.raw` carries its own `decimals`. Summing raws
 * across two different scales is the same class of error one level down, so a disagreement refuses
 * instead of adding.
 */
export type RealisedSummary =
  | { kind: "empty" }
  | { kind: "mixed-decimals"; saw: readonly number[] }
  | {
      kind: "figures";
      decimals: number;
      /** USDG premium received on sells and paid on buys, netted. */
      premiumRaw: bigint;
      /** USDG taker/maker fees paid on fills. */
      feesRaw: bigint;
      /** USDG maker rebates earned on fills. */
      rebatesRaw: bigint;
      /** Realised P&L where the API reported one. */
      realisedRaw: bigint;
      /** Mint fees and close refunds NOT included above, because their asset varies by series. */
      collateralDenominatedItems: number;
    };

export function realisedSummary(items: readonly HistoryItem[]): RealisedSummary {
  const seen = new Set<number>();
  let premiumRaw = 0n;
  let feesRaw = 0n;
  let rebatesRaw = 0n;
  let realisedRaw = 0n;
  let collateralDenominatedItems = 0;
  let counted = 0;

  for (const item of items) {
    if (item.kind === "mint" || item.kind === "close") {
      collateralDenominatedItems += 1;
    }
    if (item.kind === "fill") {
      const { premium, fee, rebate, side } = item.data;
      seen.add(premium.decimals);
      seen.add(fee.decimals);
      seen.add(rebate.decimals);
      // A sell receives premium; a buy pays it. Netting is the only reading a writer can act on.
      premiumRaw += side === "sell" ? BigInt(premium.raw) : -BigInt(premium.raw);
      feesRaw += BigInt(fee.raw);
      rebatesRaw += BigInt(rebate.raw);
      counted += 1;
    }
    const realised = item.kind === "fill" || item.kind === "close" || item.kind === "redemption"
      ? item.data.realisedPnl
      : null;
    if (realised !== null) {
      seen.add(realised.decimals);
      realisedRaw += BigInt(realised.raw);
      counted += 1;
    }
  }

  if (counted === 0) return { kind: "empty" };
  if (seen.size > 1) return { kind: "mixed-decimals", saw: [...seen].sort((a, b) => a - b) };
  return {
    kind: "figures",
    decimals: [...seen][0]!,
    premiumRaw,
    feesRaw,
    rebatesRaw,
    realisedRaw,
    collateralDenominatedItems,
  };
}

/**
 * The realised block: what this writer has actually made, from history the page already fetches.
 *
 * `formatUsdg` is a SIX-DECIMAL formatter -- it divides by USDG_SCALE and pads the remainder to six
 * places. Handing it an 18-decimal raw would print a number a million million times too small and
 * would look entirely ordinary, so the decimals are checked here rather than assumed. That check is
 * the reason this renders nothing at all on a mixed-decimals summary.
 */
export function EarnRealised({ summary }: { summary: RealisedSummary }) {
  if (summary.kind === "empty") return null;
  if (summary.kind === "mixed-decimals" || summary.decimals !== 6) {
    return <Notice tone="info" className="mb-6" title="Your realised figures">
      These are not shown because the history mixes more than one decimal scale
      {summary.kind === "mixed-decimals" ? ` (${summary.saw.join(" and ")})` : ` (${summary.decimals})`}, and a single
      total built across scales would be wrong while looking ordinary.
    </Notice>;
  }
  return <Panel as="section" aria-label="Your realised figures" className="mb-6">
    <h2 className="font-display text-xl font-bold">What you have made</h2>
    <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div><dt className="text-ink-3 text-sm">Premium, net</dt><dd className="num mt-1 font-semibold">{formatUsdg(summary.premiumRaw)} USDG</dd></div>
      <div><dt className="text-ink-3 text-sm">Realised P&amp;L</dt><dd className="num mt-1 font-semibold">{formatUsdg(summary.realisedRaw)} USDG</dd></div>
      <div><dt className="text-ink-3 text-sm">Fees paid</dt><dd className="num mt-1 font-semibold">{formatUsdg(summary.feesRaw)} USDG</dd></div>
      <div><dt className="text-ink-3 text-sm">Rebates earned</dt><dd className="num mt-1 font-semibold">{formatUsdg(summary.rebatesRaw)} USDG</dd></div>
    </dl>
    <p className="mt-3 text-sm text-ink-2">
      Realised across your whole history, in USDG. {summary.collateralDenominatedItems > 0
        ? `${summary.collateralDenominatedItems} mint or close fee${summary.collateralDenominatedItems === 1 ? " is" : "s are"} not counted here: those are charged in the series' own collateral, which is Stock Tokens for a call, and adding them to a USDG total would mix two assets.`
        : "Mint and close fees are charged in the series' own collateral and are never folded into this total."}
    </p>
  </Panel>;
}

export function EarnOverview() {
  const { address } = useAccount();
  const history = useHistory(address);
  const realised = realisedSummary(history.data?.items ?? []);
  const markets = useMarkets();
  const live = markets.isError ? [] : markets.data?.filter((market) => market.status === "live") ?? [];
  const hasPuts = live.some((market) => market.puts);
  return <>
    <PageHead eyebrow="Writers" title="Set your ask." lede={hasPuts
      ? "Deposit Stock Tokens for covered calls or USDG for cash-secured puts, then name the premium a buyer must pay."
      : "Deposit Stock Tokens, choose an option, and name the premium a buyer must pay."} />
    <Notice tone="warn" className="mb-6">{hasPuts
      ? "A call caps your upside; a put can lose the difference below its strike from USDG collateral. Premium arrives only when a buyer fills your ask."
      : "Writing a call caps your upside above its strike. Premium arrives only when a buyer fills your ask."}</Notice>
    {address ? <EarnRealised summary={realised} /> : null}
    {markets.isError ? <Notice tone="warn" role="status" className="mb-5" title="Writing markets are unavailable.">
      The indexer could not answer. This page cannot verify current markets or balances until data returns. Check your transactions in a block explorer.
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void markets.refetch()}>Try again</Button>
    </Notice> : null}
    {markets.isPending && !markets.data ? <Panel role="status">Loading writing markets…</Panel> : live.length ?
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{live.map((market) => <Panel key={market.ticker} as="article" className="flex flex-col">
        <div className="flex items-baseline justify-between gap-3"><h2 className="font-display text-2xl font-bold">{market.ticker}</h2><span className="num text-sm text-ink-2">{market.spot ? `$${market.spot.formatted}` : "Spot unavailable"}</span></div>
        <p className="mt-1 text-sm text-ink-2">{market.name}</p>
        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
          <div><dt className="text-ink-3">Premium · 7 days</dt><dd className="num mt-1 font-semibold">{market.stats.premium7d.formatted} USDG</dd></div>
          <div><dt className="text-ink-3">Volume · 24 hours</dt><dd className="num mt-1 font-semibold">{market.stats.volume24h.formatted} USDG</dd></div>
          <div><dt className="text-ink-3">Open series</dt><dd className="num mt-1 font-semibold">{market.stats.seriesOpen}</dd></div>
          <div><dt className="text-ink-3">Open interest</dt><dd className="num mt-1 font-semibold">{formatShares(BigInt(market.stats.openInterestUnits))} shares</dd></div>
        </dl>
        <Button href={`/earn/${market.ticker.toLowerCase()}`} size="sm" className="mt-5 w-full">{market.spot ? `Write ${market.ticker}` : `View ${market.ticker}`}</Button>
      </Panel>)}</div> : !markets.isError ? <Panel>No writing markets are open yet.</Panel> : null}
  </>;
}
