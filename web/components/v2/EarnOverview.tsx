"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { Button, InfoTip, Notice, PageHead, Panel, Stat, TickerLogo } from "@/components/ui";
import { useViewerTimeZone } from "@/components/ui/Time";
import { useNow } from "@/lib/hooks";
import { v2Api } from "@/lib/v2/api";
import type { HistoryItem, HistoryResponse, Market } from "@/lib/v2/api-types";
import { useMarkets } from "@/lib/v2/hooks";
import { displaySourceLine, pickDisplaySpot, usdgDollars, useDisplaySpots, type DisplaySpot } from "@/lib/v2/displaySpot";
import { formatShares } from "@/lib/v2/payoffCard";
import { NEW_YORK_TIME_ZONE } from "@/lib/v2/time";
import { fmtUsdg } from "@/lib/format";

/**
 * "What have I actually made" for a writer.
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
export function EarnRealised({ summary, complete = true }: { summary: RealisedSummary; complete?: boolean }) {
  if (summary.kind === "empty") return null;
  if (summary.kind === "mixed-decimals" || summary.decimals !== 6) {
    return <Notice tone="info" title="Your realised figures">
      Hidden: your history mixes token decimals
      {summary.kind === "mixed-decimals" ? ` (${summary.saw.join(" and ")})` : ` (${summary.decimals})`}, so one total would be wrong.
    </Notice>;
  }
  const cell = "min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0";
  return <Panel as="section" aria-label="Your realised figures" pad="sm" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h2 className="flex items-center gap-1.5 text-[15px] font-bold">What you have made
        <InfoTip label="About these totals" align="start" text={summary.collateralDenominatedItems > 0
          ? `${summary.collateralDenominatedItems} mint or close fee${summary.collateralDenominatedItems === 1 ? " is" : "s are"} not counted: they are paid in the option's own collateral (Stock Tokens for a call), not USDG.`
          : "Mint and close fees are paid in the option's own collateral, so they are not in this USDG total."} /></h2>
      <p className="text-[12.5px] text-ink-3">
        {complete ? "Realised across your whole history, in USDG." : `Realised across your latest ${WHOLE_HISTORY_MAX_ROWS.toLocaleString("en-US")} history entries, in USDG.`}
      </p>
    </div>
    {/* The money rule (fmtUsdg), not payoffCard's exact six-decimal formatUsdg ("12.500000"). */}
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-line">
      <Stat className={cell} size="sm" label="Premium, net" value={fmtUsdg(summary.premiumRaw)} unit="USDG" />
      <Stat className={cell} size="sm" label="Profit or loss" value={fmtUsdg(summary.realisedRaw)} unit="USDG" />
      <Stat className={cell} size="sm" label="Fees paid" value={fmtUsdg(summary.feesRaw)} unit="USDG" />
      <Stat className={cell} size="sm" label="Rebates earned" value={fmtUsdg(summary.rebatesRaw)} unit="USDG" />
    </div>
  </Panel>;
}

/** The page size the whole-history walk asks for (the API's maximum) and how many pages it reads. */
export const WHOLE_HISTORY_PAGE = 200;
export const WHOLE_HISTORY_MAX_PAGES = 25;
export const WHOLE_HISTORY_MAX_ROWS = WHOLE_HISTORY_PAGE * WHOLE_HISTORY_MAX_PAGES;

/**
 * The realised block says "your whole history", so it must read the whole history: the default
 * history page is the newest 50 rows, and a writer past 50 events was shown a partial total under a whole-history
 * label. This walks the keyset cursor to the end. It stops after WHOLE_HISTORY_MAX_PAGES pages and then reports
 * `complete: false`, and the block says how many entries it counted instead of claiming all of them. A cursor the API
 * repeats is an error rather than a loop.
 */
export async function readWholeHistory(
  readPage: (cursor: string | undefined) => Promise<Pick<HistoryResponse, "items" | "nextCursor">>,
  maxPages = WHOLE_HISTORY_MAX_PAGES,
): Promise<{ items: HistoryItem[]; complete: boolean }> {
  const items: HistoryItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await readPage(cursor);
    items.push(...response.items);
    if (!response.nextCursor) return { items, complete: true };
    if (seen.has(response.nextCursor)) throw new Error("The history cursor repeated.");
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  return { items, complete: false };
}

/**
 * The page's lede and warning name puts only
 * when a live market's registry flag enables them. The check is `=== true`, so a missing or malformed flag never
 * shows put copy.
 */
export function writerCopy(live: readonly Pick<Market, "puts">[]): { hasPuts: boolean; lede: string; notice: string } {
  const hasPuts = live.some((market) => market.puts === true);
  return hasPuts ? {
    hasPuts,
    lede: "Deposit Stock Tokens for covered calls or USDG for cash-secured puts, then set the price a buyer pays.",
    notice: "A call caps your upside; a put can lose the difference below its strike from USDG collateral. Premium arrives only when a buyer fills your ask.",
  } : {
    hasPuts,
    lede: "Deposit Stock Tokens, choose an option, and set the price a buyer pays.",
    notice: "Writing a call caps your upside above its strike. Premium arrives only when a buyer fills your ask.",
  };
}

/**
 * DISPLAY ONLY: a writing card's price. The API spot when present (unchanged), else the server's fallback
 * with a plain source line, else "Price unavailable". The card's Write / View button still keys off the strict API
 * spot, never this. The line's time is in `timeZone`: the reader's, New York until it is known.
 */
export function earnCardPrice(market: Pick<Market, "spot" | "spotUpdatedAt">, fallback: DisplaySpot | undefined, now: number,
  timeZone: string):
  { price: string; line: string | null } {
  if (market.spot) return { price: `$${market.spot.formatted}`, line: null };
  const shown = pickDisplaySpot(null, null, fallback);
  if (!shown) return { price: "Price unavailable", line: null };
  const line = displaySourceLine(shown, now, timeZone);
  return { price: `$${usdgDollars(shown.raw)}`, line: `${line.charAt(0).toUpperCase()}${line.slice(1)}` };
}

export function EarnOverview() {
  const { address } = useAccount();
  const history = useQuery({
    queryKey: ["v2", "historyWhole", address?.toLowerCase()],
    enabled: Boolean(address),
    queryFn: ({ signal }) => readWholeHistory((cursor) =>
      v2Api.getHistory(address!, { limit: WHOLE_HISTORY_PAGE, ...(cursor ? { cursor } : {}) }, { signal })),
    staleTime: 60_000,
    retry: 0,
  });
  const realised = realisedSummary(history.data?.items ?? []);
  const markets = useMarkets();
  const displaySpots = useDisplaySpots();
  const zone = useViewerTimeZone() ?? NEW_YORK_TIME_ZONE;
  const now = useNow();
  const live = markets.isError ? [] : markets.data?.filter((market) => market.status === "live") ?? [];
  const copy = writerCopy(live);
  return <>
    <PageHead title="Sell options" lede={copy.lede} />
    <div className="flex flex-col gap-5 pb-6">
    <Notice tone="warn">{copy.notice}</Notice>
    {address ? <EarnRealised summary={realised} complete={history.data?.complete ?? true} /> : null}
    {markets.isError ? <Notice tone="warn" role="status" title="Writing markets are unavailable.">
      We couldn&apos;t load the markets. Your transactions are on the block explorer.
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void markets.refetch()}>Try again</Button>
    </Notice> : null}
    {markets.isPending && !markets.data ? <Panel role="status" className="text-sm text-ink-2">Loading writing markets…</Panel> : live.length ?
      <Panel as="section" pad="none" aria-labelledby="writing-markets-title" className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <h2 id="writing-markets-title" className="flex items-center gap-1.5 text-[15px] font-bold">Pick a market <InfoTip label="About writing markets"
            align="start">Each market lists daily call options. Choose one to deposit Stock Tokens and set the ask a buyer pays.</InfoTip></h2>
          <span className="text-[12.5px] text-ink-3">{live.length} live</span>
        </div>
        <ul className="divide-y divide-line">{live.map((market) => {
          const price = earnCardPrice(market, displaySpots.data?.get(market.ticker), now, zone);
          return <li key={market.ticker} data-slot="writing-market"
            className="grid grid-cols-2 items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_auto]">
            <div className="flex min-w-0 items-center gap-3">
              <TickerLogo ticker={market.ticker} className="text-[30px]" />
              <div className="min-w-0">
                <h3 className="flex items-baseline gap-2 text-[17px] font-extrabold tracking-[-0.01em]">{market.ticker}
                  <span className="num text-[14px] font-semibold text-ink-2">{price.price}</span>
                  {price.line !== null ? <InfoTip label={`About the ${market.ticker} price`} text={price.line} /> : null}</h3>
                <p className="truncate text-[12.5px] text-ink-3">{market.name}</p>
              </div>
            </div>
            <Button href={`/sell/${market.ticker.toLowerCase()}`} size="sm" className="justify-self-end lg:order-last">{market.spot ? `Write ${market.ticker}` : `View ${market.ticker}`}</Button>
            <dl className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:contents">
              <MarketFigure k="Premium · 7d" v={`${market.stats.premium7d.formatted}`} unit="USDG" />
              <MarketFigure k="Volume · 24h" v={`${market.stats.volume24h.formatted}`} unit="USDG" />
              <MarketFigure k="Open options" v={String(market.stats.seriesOpen)} />
              <MarketFigure k="Open interest" v={formatShares(BigInt(market.stats.openInterestUnits))} unit="sh" />
            </dl>
          </li>;
        })}</ul>
      </Panel> : !markets.isError ? <Panel className="text-sm text-ink-2">No writing markets are open yet.</Panel> : null}
    </div>
  </>;
}

function MarketFigure({ k, v, unit }: { k: string; v: string; unit?: string }) {
  return <div className="min-w-0">
    <dt className="truncate text-[11.5px] font-medium text-ink-3 sm:text-[12px]">{k}</dt>
    <dd className="num mt-0.5 truncate text-[14px] font-semibold">{v}{unit ? <small className="ml-1 text-[10.5px] font-medium text-ink-3">{unit}</small> : null}</dd>
  </div>;
}
