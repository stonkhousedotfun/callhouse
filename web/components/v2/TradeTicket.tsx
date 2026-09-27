"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, getAddress, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, InfoTip, inputClasses, Notice, Panel } from "@/components/ui";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { ConversionFloor } from "@/components/v2/ConversionFloor";
import { PayoffExplainers } from "@/components/v2/PayoffExplainers";
import { PayoffReceipt } from "@/components/v2/PayoffReceipt";
import { CEILING_TERMS, PayoffSlider, type SliderScenario } from "@/components/v2/PayoffSlider";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { SettlementDisclosure } from "@/components/v2/SettlementDisclosure";
import { InputLabel, StepButton, SummaryBox, SummaryRow, TicketHead, TicketSection, TicketSections } from "@/components/v2/trade/TicketParts";
import { expiryName, signedUsd, usd } from "@/components/v2/trade/price";
import { cn } from "@/lib/cn";
import { erc20Abi } from "@/lib/abi/erc20";
import { orderBookAbi } from "@/lib/abi/v2/orderBook";
import { publicClient, robinhoodChain } from "@/lib/chain";
import { USDG } from "@/lib/contracts";
import { fmtUsdPrice } from "@/lib/format";
import { displayExact } from "@/lib/numberFormat";
import { DEFAULT_BUY_BUDGET, buyQuoteForBudget, parseUsdgBudget } from "@/lib/v2/budget";
import { v2ConfigWarnings, V2_DEPLOYMENT, requireV2Address } from "@/lib/v2/config";
import { assertSeriesTermsMatch, readOrderPreflight, readSeriesOnChain } from "@/lib/v2/chainReads";
import { useConfig, v2Keys } from "@/lib/v2/hooks";
import { onChainClock, useChainClockOffset } from "@/lib/v2/chainClock";
import { buyCallTiming } from "@/lib/v2/payoutTiming";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, PRICE_TICK, breakeven, collateralPerUnit, netPayoutUsdgPerUnit, payoutAt, premium, sharesToUnits, type BuyCost, type ConversionTerms, type PayoffPosition, type TakerFeeParams } from "@/lib/v2/payoff";
import { formatShareQuantity, formatShares, formatUsdg } from "@/lib/v2/payoffCard";
import type { GasEstimate } from "@/lib/v2/payoffReceipt";
import { bidSplit, completeBidAfterCrossing, crossingBidUnknownMessage, partialDepthMessage, staleSelectedOrders, stepShareInput, type BuyQuote } from "@/lib/v2/ticket";
import { approveExact, place, recheckTakeQuote, restingValidUntil, take, type TakeParams, type WriteContext } from "@/lib/v2/tx";
import { assertTradingOpen, TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";
import { userErrorText } from "@/lib/v2/errors";
import { findV2ReceiptUnknown } from "@/lib/v2/txStatus";
import type { BookResponse, ConfigResponse, Market, SeriesDetailResponse } from "@/lib/v2/api-types";

// A viem error is decoded to buyer copy (userErrorText), never printed raw.
function explain(error: unknown): string { return userErrorText(error, "The trade could not be completed."); }

// Mirrors TakeParams.maxTotalFee's uint128 width (V2Types.sol), as lib/v2/tx.ts does for the real quote.
const MAX_UINT128 = (1n << 128n) - 1n;
const GAS_QUOTE_LIFETIME_SECONDS = 300;

/** G7. The conversion terms the explorer prices a call's USDG band with: the indexed Clearinghouse
 * `maxPayoutSlippageBps` from /v2/config when the wire carries one, else the contract ceiling; the route fee is
 * always its ceiling, because the adapter's per-asset read is not on the wire. A wire value above the ceiling
 * cannot come from the contract (setPayoutAdapter reverts CeilingExceeded) and is treated as the ceiling. */
export function explorerTerms(config: ConfigResponse | undefined): ConversionTerms & { source: "wire" | "ceiling" } {
  const wire = config?.fees.maxPayoutSlippageBps;
  if (wire === undefined || wire === null || !Number.isInteger(wire) || wire < 0 || wire > MAX_PAYOUT_SLIPPAGE_CEIL_BPS) {
    return { ...CEILING_TERMS, source: "ceiling" };
  }
  return { slippageBps: wire, routeFeeBps: CEILING_TERMS.routeFeeBps, source: "wire" };
}

/** The share card's URL: every input the image route re-validates, nothing pre-rendered. */
export function scenarioImageHref(ticker: string, position: PayoffPosition, cost: bigint, expiry: number, scenario: SliderScenario,
  terms: ConversionTerms, format: "square" | "wide" = "square"): string {
  const query = new URLSearchParams({
    ticker, side: position.isPut ? "put" : "call", strike: position.strike.toString(), units: position.units.toString(),
    fee: String(position.exerciseFeeBps), cost: cost.toString(), price: scenario.price.toString(), expiry: String(expiry),
    slippage: String(terms.slippageBps), routeFee: String(terms.routeFeeBps), format,
  });
  return `/api/pnl/scenario/image?${query}`;
}

const UNPRICEABLE_REASON: Record<BuyCost["unpriceableAsks"][number]["reason"], string> = {
  maker: "seller unknown",
  rent: "series terms not loaded",
  collateral: "seller's collateral not reported",
};

/** `costToBuy` lists every write ask it could not price (payoff.ts `pricingStatus`); without this caption
 * those asks read as missing depth ("No fillable asks", the partial-depth notice), when the depth may be there.
 * `null` when every ask was priced. Reasons are listed once each, in the order the walk first met them. */
export function pricingStatusCaption(buy: Pick<BuyCost, "pricingStatus" | "unpriceableAsks">): string | null {
  if (buy.pricingStatus !== "unpriceable" || buy.unpriceableAsks.length === 0) return null;
  const count = buy.unpriceableAsks.length;
  const reasons = [...new Set(buy.unpriceableAsks.map((ask) => UNPRICEABLE_REASON[ask.reason]))];
  return `Estimate: ${count} ${count === 1 ? "ask" : "asks"} could not be priced (${reasons.join("; ")}), `
    + "so more may be available than shown.";
}

/** The shares-mode shortfall notice. The walk's unpriceable asks are passed to `partialDepthMessage`
 * without their count, a shortfall made of asks the ticket could not price reads as a book that ran out. */
export function partialDepthNotice(sizeMode: "budget" | "shares", quote: Pick<BuyQuote, "buy"> | null | undefined,
  units: bigint | null): string | null {
  if (sizeMode !== "shares" || !quote || units === null) return null;
  return partialDepthMessage(quote.buy.filledUnits, units, quote.buy.unpriceableAsks.length);
}

/** G5. What the buy costs in gas, from the chain's own estimate of THIS quote: one `take`, plus one `approve` when
 * the allowance is short. `take` cannot be estimated until the allowance exists (the USDG pull reverts), so the
 * estimate is null then and the receipt says the wallet will show it. Never a constant. */
async function estimateBuyGas(account: Address, quote: BuyQuote, longId: bigint, units: bigint, allowPartial: boolean): Promise<GasEstimate> {
  const orderBook = requireV2Address("orderBook");
  const required = quote.buy.premium + quote.buy.fee;
  const symbol = robinhoodChain.nativeCurrency.symbol;
  const allowance = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [account, orderBook] });
  // The pull would revert until an approval is mined, so the take cannot be estimated yet; the wallet shows the
  // take's own gas after it. Two transactions, no figure.
  if (allowance < required) return { transactions: 2, wei: null, symbol };
  try {
    const [gasPrice, block] = await Promise.all([publicClient.getGasPrice(), publicClient.getBlock({ blockTag: "latest" })]);
    const params = { ...paramsFor(quote, longId, account, units, allowPartial), deadline: Number(block.timestamp) + GAS_QUOTE_LIFETIME_SECONDS, maxTotalFee: MAX_UINT128 };
    const gas = await publicClient.estimateContractGas({ account, address: orderBook, abi: orderBookAbi, functionName: "take", args: [params] });
    return { transactions: 1, wei: gas * gasPrice, symbol };
  } catch {
    return { transactions: 1, wei: null, symbol };
  }
}

function tradePrice(raw: string): bigint | null {
  try { const value = parseUnits(raw, 6); return value > 0n && value % 100n === 0n ? value : null; }
  catch { return null; }
}

function paramsFor(quote: BuyQuote, longId: bigint, account: Address, units: bigint, allowPartial: boolean): Omit<TakeParams, "deadline" | "maxTotalFee"> {
  return { longId, buying: true, orderIds: quote.buy.orderIds.map(BigInt), units,
    minUnits: allowPartial ? 1n : units, limitPrice: quote.limitPrice!, writeToSell: false,
    recipient: account };
}

export function initialLimitPrice(fair: string | null | undefined, asks: readonly { price: { raw: string } }[] | undefined): string {
  const ask = asks?.reduce<bigint | null>((low, level) => {
    const at = BigInt(level.price.raw); return low === null || at < low ? at : low; }, null) ?? null;
  const pick = ask ?? (fair ? BigInt(fair) : null);
  if (pick === null || pick <= 0n) return "";
  const onTick = (pick / PRICE_TICK) * PRICE_TICK;
  return onTick > 0n ? formatUnits(onTick, 6) : "";
}

/** What the buyer reviewed. Pressing "Review order" records it, and signing sends exactly this order:
 * the mode (buy all now, or buy what crosses and rest the remainder as a bid), the size in units, the limit price,
 * and, for a buy, whether a partial fill is allowed (take's minUnits). A bid never sends a partial buy, so its
 * `allowPartial` is always false. */
export type ReviewedOrder = { mode: "buy" | "bid"; units: bigint; limitPrice: bigint; allowPartial: boolean };

export const BOOK_CHANGED_LINE = "The order book changed, so this order is no longer the one you reviewed. Edit your order and review it again.";

/** Null while the live order still matches the reviewed one; otherwise why signing is blocked. The book
 * refetches every 15 s and the mode is derived from it, so a refresh can turn a reviewed "Buy now" into "Place bid"
 * (or back). A live order that cannot be sent at all (`null`) is a change too. */
export function reviewDrift(reviewed: ReviewedOrder, live: ReviewedOrder | null): string | null {
  if (live === null || live.mode !== reviewed.mode || live.units !== reviewed.units || live.limitPrice !== reviewed.limitPrice
    || live.allowPartial !== reviewed.allowPartial) return BOOK_CHANGED_LINE;
  return null;
}

/** A per-share USDG price at its real 0.0001 precision ("$0.3989", "$0.40"), never rounded to cents. */
export function limitText(raw: bigint): string {
  return `$${displayExact(raw, 6, { minDecimals: 2 })}`;
}

/** The buy/bid notes on the review screen: they describe the order that will be sent. */
export function reviewNotesFor(order: Pick<ReviewedOrder, "mode" | "allowPartial">): string[] {
  return order.mode === "buy"
    ? [`Buys the lowest asks first, each at its own price, never above your limit. ${order.allowPartial
      ? "Partial fills are on: if part of the size is gone when your trade lands, it buys what is left at your limit."
      : "All or nothing."}`,
    "Two wallet steps: approve the USDG, then confirm."]
    : ["Any part at or below the asks buys now. The rest waits as a bid for 24 hours.",
      "Your USDG (price × shares) is held until it fills or you cancel. No fee on the part that waits."];
}

/** Options are paid in USDG from the wallet. The line under the cost when the wallet holds less than the order needs;
 * null while it covers the order or either figure is unknown (an unread balance never blocks: approveExact still checks). */
export function usdgShortfallLine(ticker: string, isPut: boolean, needed: bigint | null, wallet: bigint | null): string | null {
  if (needed === null || wallet === null || wallet >= needed) return null;
  return `You need ${usd(needed, 6, "up")} of USDG and your wallet has ${usd(wallet, 6, "down")}. `
    + `${isPut ? "Puts" : "Calls"} are paid in USDG, not ${ticker} Stock Tokens.`;
}

/** Where a buyer holding the Stock Token but no USDG can sell some for USDG: the sell page's swap tab. */
export function swapForUsdgHref(ticker: string): string {
  return `/sell/${ticker.toLowerCase()}?tab=swap`;
}

const DEFAULT_TICKET_SHARES = "0.10";
const PREVIEW_TOLERANCE_BPS = 200;

/** What the ticket is quoting right now, for the market page's chart and sticky bar. */
export type TicketQuote = { longId: string; units: bigint; cost: bigint; premium: bigint };

export type TradeTicketPrefill =
  | { kind: "budget"; amountUsdg: string }
  | { kind: "shares"; shares: string };

export function TradeTicket({ ticker, detail, book, target, spot, marketSettlement, initialPrefill, initialShares, bookDegraded = false, onRefresh, atPrice = null, onQuote, tradingPaused = false }: {
  ticker: string;
  detail: SeriesDetailResponse;
  book: BookResponse | null;
  target: bigint;
  spot: bigint | null;
  marketSettlement: Market["settlement"];
  /** Stable ladder contract: prefill either a USDG budget or an exact share quantity. */
  initialPrefill?: TradeTicketPrefill;
  /** Backward-compatible route prefill. New callers should use initialPrefill. */
  initialShares?: string;
  bookDegraded?: boolean;
  onRefresh: () => void | Promise<unknown>;
  /** The price under the market page's chart handle. The ticket shows its P&L there ("At $X"). */
  atPrice?: bigint | null;
  /** told the size, cost and premium the ticket is quoting (null when it cannot quote). */
  onQuote?: (quote: TicketQuote | null) => void;
  /** The market's OrderBook brake as /v2/markets serves it (lib/v2/tradingGate.ts). Take and place revert while it is on. */
  tradingPaused?: boolean;
}) {
  const seededShares = initialPrefill?.kind === "shares" ? initialPrefill.shares : initialShares ?? DEFAULT_TICKET_SHARES;
  const sizeMode = "shares" as const;
  const [shares, setShares] = useState(seededShares);
  const [allowPartial, setAllowPartial] = useState(false);
  const [bidInput, setBidPrice] = useState<string | null>(null);
  const bidPrice = bidInput ?? initialLimitPrice(detail.quote.fair?.raw, book?.asks);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick();
    const timer = window.setInterval(tick, 1_000); return () => window.clearInterval(timer); }, []);
  const { address } = useAccount();
  const wallet = useWalletClient();
  const config = useConfig();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const shareUnits = useMemo(() => { try { return sharesToUnits(shares); } catch { return null; } }, [shares]);
  const toleranceBps = PREVIEW_TOLERANCE_BPS;
  const fees: TakerFeeParams | null = useMemo(() => config.data ? {
    takerFeeFlat: BigInt(config.data.fees.takerFeeFlat.raw), takerFeeCapBps: config.data.fees.takerFeeCapBps,
  } : null, [config.data]);
  const rentTerms = useMemo(() => book ? { collateralPerUnit: collateralPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw)),
    mintFeePpm: detail.series.mintFeePpm, expiry: detail.series.expiry, mintCutoff: detail.series.mintCutoff,
    snapshotTimestamp: book.snapshotTimestamp } : undefined, [book, detail.series]);
  const units = shareUnits;
  const price = tradePrice(bidPrice);
  const split = useMemo(() => {
    if (!book || !units || !fees || price === null) return null;
    try { return bidSplit(book.asks, units, price, fees, address, rentTerms); } catch { return null; }
  }, [book, units, fees, price, address, rentTerms]);
  const mode: "buy" | "bid" = split && price !== null && split.crossing.buy.filledUnits > 0n && split.restingUnits === 0n ? "buy" : "bid";
  const quote = useMemo(() => mode === "buy" && split && price !== null ? { ...split.crossing, limitPrice: price } : null,
    [mode, split, price]);
  const defaultPreviewQuote = useMemo(() => {
    if (!book || !fees || !Number.isInteger(toleranceBps)) return null;
    const defaultBudget = parseUsdgBudget(DEFAULT_BUY_BUDGET);
    return defaultBudget === null ? null : buyQuoteForBudget(book.asks, defaultBudget, fees, toleranceBps, address, rentTerms);
  }, [book, fees, toleranceBps, address, rentTerms]);
  const payoffQuote = quote?.buy.filledUnits ? quote : defaultPreviewQuote;
  const quoted = mode === "buy" && quote && quote.buy.filledUnits > 0n
    ? { longId: detail.series.longId, units: quote.buy.filledUnits, cost: quote.buy.cost, premium: quote.buy.premium }
    : split && units ? { longId: detail.series.longId, units, cost: split.crossing.buy.cost + split.escrow, premium: split.crossing.buy.premium + split.escrow }
      : null;
  const quotedKey = quoted ? `${quoted.longId}:${quoted.units}:${quoted.cost}:${quoted.premium}` : "";
  // Reported by value, not identity: payoffQuote is a fresh object each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onQuote?.(quoted); }, [quotedKey, onQuote]);
  const terms = useMemo(() => explorerTerms(config.data), [config.data]);
  const gasQuoteKey = payoffQuote ? `${payoffQuote.buy.orderIds.join(",")}:${payoffQuote.buy.filledUnits}:${payoffQuote.buy.cost}` : null;
  const gasEstimate = useQuery({
    queryKey: ["v2", "buy-gas", address ?? null, detail.series.longId, gasQuoteKey, allowPartial],
    queryFn: () => estimateBuyGas(address!, payoffQuote!, BigInt(detail.series.longId), payoffQuote!.buy.filledUnits, allowPartial),
    enabled: Boolean(address && payoffQuote && payoffQuote.buy.filledUnits > 0n && V2_DEPLOYMENT.contracts.orderBook),
    staleTime: 15_000, retry: 0,
  });
  // The wallet's USDG, the only thing a buy or bid spends. Under the "v2" key so a confirmed trade refreshes it.
  const usdgToken = useMemo(() => { try { return config.data ? getAddress(config.data.usdg.address) : null; } catch { return null; } },
    [config.data]);
  const walletUsdgQuery = useQuery({
    queryKey: ["v2", "wallet-usdg", address ?? null, usdgToken],
    queryFn: () => publicClient.readContract({ address: usdgToken!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
    enabled: Boolean(address && usdgToken),
    staleTime: 15_000, refetchInterval: 15_000, retry: 0,
  });
  const walletUsdg = typeof walletUsdgQuery.data === "bigint" ? walletUsdgQuery.data : null;
  const partialDepth = partialDepthNotice(sizeMode, quote, units);
  const pricingCaption = quote ? pricingStatusCaption(quote.buy) : null;
  const mismatch = config.data ? v2ConfigWarnings(config.data) : [];
  const deployed = Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
  // expiry is judged on the chain's clock (the page tick plus the measured chain offset), not the browser's.
  const chainNowS = onChainClock(now, useChainClockOffset());
  const expired = chainNowS === null || chainNowS >= detail.series.expiry || !["open", "cutoff"].includes(detail.series.status);
  const outcomeUnits = mode === "buy" ? quote?.buy.filledUnits ?? 0n : split?.crossing.buy.filledUnits ?? 0n;
  const payout = netPayoutUsdgPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw), target, detail.exerciseFeeBps) * outcomeUnits;
  const canBuy = mode === "buy" && Boolean(units && quote?.limitPrice && quote.buy.filledUnits > 0n &&
    (allowPartial || quote.buy.unfilledUnits === 0n));
  const canBid = mode === "bid" && Boolean(units && price && split);
  const writeReady = Boolean(address && wallet.data && deployed && config.data && mismatch.length === 0 && spot !== null && !expired && !tradingPaused && !pending);
  // The order the live book would send now, compared with the reviewed one on every render.
  const liveOrder: ReviewedOrder | null = (canBuy || canBid) && units && price !== null
    ? { mode, units, limitPrice: price, allowPartial: mode === "buy" && allowPartial } : null;
  const [reviewed, setReviewed] = useState<ReviewedOrder | null>(null);

  async function executeCrossing(selected: BuyQuote, requested: bigint, partial: boolean, context: WriteContext): Promise<bigint | null> {
    if (!selected.limitPrice || selected.buy.filledUnits === 0n) return 0n;
    const ids = selected.buy.orderIds.map(BigInt);
    const collateralAsset = detail.series.isPut ? getAddress(config.data!.usdg.address) : getAddress(detail.series.underlying);
    const series = await readSeriesOnChain(BigInt(detail.series.longId));
    const orders = await readOrderPreflight(ids, collateralAsset, undefined, series.blockNumber);
    if (!series.exists) throw new Error("This option is no longer on chain.");
    assertSeriesTermsMatch(detail.series, series.series, ticker, detail.exerciseFeeBps);
    const stale = staleSelectedOrders(selected, orders.map(({ orderId, order, freeCollateral }) => ({
      orderId, maker: order.maker, longId: order.longId, kind: order.kind, price: order.price,
      units: order.units, filled: order.filled, validUntil: order.validUntil,
      cancelled: order.cancelled, freeCollateral,
    })), BigInt(detail.series.longId), series.collateral, series.snapshotTimestamp, { collateralPerUnit: series.collateral, mintFeePpm: series.series.mintFeePpm,
      expiry: Number(series.series.expiry), mintCutoff: Number(series.cutoff), snapshotTimestamp: series.snapshotTimestamp });
    if (stale.length) throw new Error("An ask changed. Refresh and review your quote.");
    const takeRequest = paramsFor(selected, BigInt(detail.series.longId), context.account, requested, partial);
    const expected = { filled: selected.buy.filledUnits, premium: selected.buy.premium,
      takerFee: selected.buy.fee, sellerFees: 0n };
    await recheckTakeQuote(context, takeRequest, expected);
    await approveExact(context, getAddress(config.data!.usdg.address), requireV2Address("orderBook"), expected.premium + expected.takerFee);
    const params = await recheckTakeQuote(context, takeRequest, expected);
    const result = await take(context, params);
    return result.unitsFilled;
  }

  async function submit() {
    // sign exactly the reviewed order. A live order that differs (a book refresh flipped buy and bid, or the
    // size or limit moved) is refused here as well as by the disabled button.
    const order = reviewed;
    if (!writeReady || !address || !wallet.data || !config.data || !order || reviewDrift(order, liveOrder) !== null
      || shortfall !== null) return;
    setPending(true); setSuccess(null);
    let confirmedBidFill = 0n;
    let placingBidRemainder = false;
    const context: WriteContext = { account: address, wallet: wallet.data as WalletClient,
      onConfirmed: () => queryClient.invalidateQueries({ queryKey: v2Keys.all }) };
    try {
      // Before the first write of either path. The bid path approves USDG before it places, so without this
      // a paused book took the approval's gas and then refused the place.
      await assertTradingOpen(context.client ?? publicClient);
      if (order.mode === "buy") {
        if (!canBuy || !quote) return;
        notice("pending", "Confirm your buy", "Approve USDG if asked, then confirm the trade.");
        const filled = await executeCrossing(quote, order.units, order.allowPartial, context);
        setSuccess(filled === null ? "Buy confirmed. Check Portfolio for the filled size." :
          `Bought ${formatShareQuantity(filled)}.`);
        notice("success", "Buy confirmed", filled === null ? "Couldn't read the fill size. Check Portfolio before trading again." :
          "Your position is in Portfolio.", [
          { label: "View Portfolio", href: "/portfolio" }, { label: "Turn on alerts", href: "/settings/notifications" },
        ]);
      } else {
        if (!canBid || !split) return;
        let filled = 0n;
        if (split.crossing.buy.filledUnits > 0n) {
          notice("pending", "Buying at the ask first", "Your bid meets an ask, so that part buys now.");
          const actual = await executeCrossing(split.crossing, split.crossing.buy.filledUnits, false, context);
          if (actual === null || actual !== split.crossing.buy.filledUnits) {
            setSuccess("Bought at the ask. Check Portfolio before placing the rest of your bid.");
            notice("success", "Bought at the ask", "Couldn't verify the fill size. Check Portfolio before placing the rest.");
            void onRefresh();
            return;
          }
          filled = actual;
        }
        confirmedBidFill = filled;
        placingBidRemainder = true;
        const completion = await completeBidAfterCrossing(order.units, filled, async (remaining) => {
          const chainSeries = await readSeriesOnChain(BigInt(detail.series.longId));
          if (!chainSeries.exists) throw new Error("This option is no longer on chain.");
          assertSeriesTermsMatch(detail.series, chainSeries.series, ticker, detail.exerciseFeeBps);
          const expiry = await restingValidUntil(context.client ?? publicClient, detail.series.expiry);
          if (expiry === null) throw new Error("This series is too close to expiry for a new bid.");
          await approveExact(context, getAddress(config.data.usdg.address), requireV2Address("orderBook"), premium(order.limitPrice, remaining));
          await place(context, BigInt(detail.series.longId), 0, order.limitPrice, remaining, expiry);
        });
        if (completion.kind === "partial") {
          const submitted = findV2ReceiptUnknown(completion.error);
          if (submitted) {
            unknownReceipt(completion.error);
            setSuccess(crossingBidUnknownMessage(filled, submitted.operation));
            void onRefresh();
            return;
          }
          const message = `Bought ${formatShareQuantity(filled)} now. The rest of your bid could not be confirmed. Check Portfolio before retrying.`;
          setSuccess(message);
          notice("success", "Bought at the ask", `${message} ${explain(completion.error)}`, [
            { label: "View Portfolio", href: "/portfolio" },
          ]);
          void onRefresh();
          return;
        }
        const { restingUnits } = completion;
        setSuccess(`${filled > 0n ? `${formatShareQuantity(filled)} bought now. ` : ""}${restingUnits > 0n ? `${formatShareQuantity(restingUnits)} resting as a bid.` : ""}`);
        notice("success", "Bid confirmed", "Your fills and open orders are in Portfolio.", [
          { label: "View Portfolio", href: "/portfolio" }, { label: "Turn on alerts", href: "/settings/notifications" },
        ]);
      }
      void onRefresh();
    } catch (error) {
      const submitted = findV2ReceiptUnknown(error);
      if (submitted && order.mode === "bid" && placingBidRemainder)
        setSuccess(crossingBidUnknownMessage(confirmedBidFill, submitted.operation));
      if (!unknownReceipt(error)) {
        console.error("Trade stopped", error); // The full detail stays available to support
        notice("error", "Trade stopped", explain(error));
      }
      void onRefresh();
    } finally { setPending(false); }
  }

  const atPnl = atPrice !== null && quote && quote.buy.filledUnits > 0n
    ? payoutAt(atPrice, { isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw), units: quote.buy.filledUnits,
      exerciseFeeBps: detail.exerciseFeeBps }) - quote.buy.cost : null;


  const [step, setStep] = useState<"edit" | "review">("edit");
  const reviewing = step === "review" && success === null;
  // What the review screen shows and the signing button sends: the reviewed order, never a re-derived one.
  const drift = reviewing && reviewed ? reviewDrift(reviewed, liveOrder) : null;
  const shown = reviewing && reviewed ? reviewed : liveOrder;
  const isPut = detail.series.isPut;
  const contract = `$${detail.series.strike.formatted} ${isPut ? "Put" : "Call"}`;
  const pct = (bps: number) => `${displayExact(BigInt(Math.round(bps)), 2, { minDecimals: 0 })}%`;
  const feeTip = fees ? `One fee per order: ${usd(fees.takerFeeFlat)} or ${pct(fees.takerFeeCapBps)} of the premium, whichever is less. Paid in USDG.`
    : "One capped fee per order, paid in USDG.";
  const expiryText = expiryName(detail.series.expiry);
  const bestAsk = book?.asks.reduce<bigint | null>((low, level) => {
    const at = BigInt(level.price.raw); return low === null || at < low ? at : low; }, null) ?? null;
  const bestBid = book?.bids.reduce<bigint | null>((high, level) => {
    const at = BigInt(level.price.raw); return high === null || at > high ? at : high; }, null) ?? null;
  const mark = detail.quote.fair ? BigInt(detail.quote.fair.raw) : null;
  const available = book ? book.asks.reduce((sum, level) => sum + BigInt(level.units), 0n) : null;
  const onTick = (value: bigint) => formatUnits((value / PRICE_TICK) * PRICE_TICK, 6);
  const strikeRaw = BigInt(detail.series.strike.raw);
  const estimated = mode === "buy" ? quote?.buy.cost ?? null : split ? split.crossing.buy.cost + split.escrow : null;
  // The same USDG the order approves: premium plus fee for what buys now, plus the bid's escrow for what waits.
  const shortfall = address ? usdgShortfallLine(ticker, isPut, estimated, walletUsdg) : null;
  const walletRow = address ? <SummaryRow slot="wallet-usdg" k="Your USDG" tipLabel="About your USDG"
    tip={`${isPut ? "Puts" : "Calls"} are paid in USDG from your wallet. ${ticker} Stock Tokens, and USDG deposited in StonkHouse, do not count.`}
    tone={shortfall ? "danger" : "ink"} v={walletUsdg === null ? "—" : usd(walletUsdg, 6, "down")} /> : null;
  const shortfallNotice = shortfall ? <Notice tone="warn" role="alert">
    <span data-slot="usdg-shortfall">{shortfall}</span>{" "}
    <Link className="link font-semibold" href={swapForUsdgHref(ticker)}>Swap {ticker} for USDG</Link>
  </Notice> : null;
  const orderBreakEven = estimated !== null && units ? breakeven({ isPut, strike: strikeRaw, units, exerciseFeeBps: detail.exerciseFeeBps }, estimated) : null;
  const orderPayout = units ? netPayoutUsdgPerUnit(isPut, strikeRaw, target, detail.exerciseFeeBps) * units : null;
  const multiple = orderPayout !== null && estimated ? `${(Number((orderPayout * 10n) / estimated) / 10).toFixed(1)}×` : null;
  const sentence = shown
    ? `Buy ${(Number(shown.units) / 100).toFixed(2)} sh of the ${ticker} ${contract} expiring ${expiryText} at ${limitText(shown.limitPrice)} per share or less.`
    : `Buy the ${ticker} ${contract} expiring ${expiryText}.`;
  const reviewNotes = reviewNotesFor(shown ?? { mode, allowPartial: mode === "buy" && allowPartial });
  const pressed = (value: bigint | null) => value !== null && price !== null && price === (value / PRICE_TICK) * PRICE_TICK;

  return <Panel as="section" aria-label="Trade ticket" pad="sm" className="grid scroll-mt-20 gap-4" id="ticket">
    <TicketHead title={`Buy ${ticker} ${contract}`} sub={`Expires ${expiryText} · 4:00 PM ET`} />
    {bookDegraded ? <Notice tone="warn">Quote built from on-chain orders. It is rechecked before you trade.</Notice> : null}

    {!reviewing ? <>
      <div className="grid gap-2">
        <InputLabel htmlFor="ticket-bid-price" label="Limit price" tipLabel="About the limit price"
          tip="The most you pay per share, in USDG. At or above the lowest ask it buys now; below it, your order waits as a bid."
          aside={<span className="text-[12.5px] text-ink-3">per share</span>} />
        <div className="relative">
          <input id="ticket-bid-price" inputMode="decimal" value={bidPrice} onChange={(event) => setBidPrice(event.target.value)} placeholder="0.35"
            className={`${inputClasses} py-3 pl-3.5 pr-16 text-[18px] font-semibold`} aria-invalid={Boolean(bidPrice) && price === null} />
          <span aria-hidden="true" className="num pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] font-medium text-ink-3">USDG</span>
        </div>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Fill the limit price">
          {([["Bid", bestBid], ["Mark", mark], ["Ask", bestAsk]] as const).map(([name, value]) => <button key={name} type="button"
            disabled={value === null} onClick={() => { if (value !== null) setBidPrice(onTick(value)); }} aria-pressed={pressed(value)}
            className={cn("grid min-h-11 content-center gap-0.5 rounded-sm border px-2 py-1.5 text-center transition-colors disabled:opacity-40 sm:min-h-12",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
              pressed(value) ? "border-accent bg-accent-soft" : "border-line-2 bg-surface-2 hover:border-ink-3")}>
            <span className="text-[11.5px] font-medium text-ink-3">{name}</span>
            <span className="num text-[14px] font-semibold text-ink">{value === null ? "—" : limitText((value / PRICE_TICK) * PRICE_TICK)}</span>
          </button>)}
        </div>
        {bidPrice && price === null ? <p role="alert" className="text-sm text-danger">Use a positive price in 0.0001 USDG steps.</p> : null}
      </div>

      <div className="grid gap-2">
        <InputLabel htmlFor="ticket-shares" label="Shares" tipLabel="About the quantity"
          tip={`How many shares of ${ticker} this call covers. The smallest size is 0.01 share.`}
          aside={<span className="text-[12.5px] text-ink-3">{available === null ? null : available > 0n ? `${formatShares(available)} sh for sale` : "No sellers yet"}</span>} />
        <div className="grid grid-cols-[48px_minmax(0,1fr)_48px] gap-2">
          <StepButton label="Decrease size" onClick={() => setShares(stepShareInput(shares, -1))}>−</StepButton>
          <input id="ticket-shares" inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)}
            className={`${inputClasses} px-3 py-2.5 text-center text-[18px] font-semibold`} aria-describedby="ticket-size-help" />
          <StepButton label="Increase size" onClick={() => setShares(stepShareInput(shares, 1))}>+</StepButton>
        </div>
        <p id="ticket-size-help" className="sr-only">Sizes move in 0.01-share steps.</p>
        {shareUnits === null ? <p role="alert" className="text-sm text-danger">Enter a positive quantity in 0.01-share steps.</p> : null}
      </div>

      {estimated !== null ? <SummaryBox>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2.5">
          <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink">Estimated cost <InfoTip align="start" label="About the estimated cost"
            text={mode === "buy" ? "Premium plus one fee per order. This is the most you can lose. Gas is extra."
              : "What buys now, fee included, plus the USDG held for the bid. This is the most you can lose if it all fills."} /></span>
          <span data-slot="max-loss" className="num ml-auto text-[20px] font-semibold text-ink">{usd(estimated, 6, "up")}</span>
        </div>
        {walletRow}
        <SummaryRow k="Order" tipLabel="About the order" tip={mode === "buy" ? "Your limit meets enough asks to fill the whole size now."
          : "Not enough is for sale at your limit, so the rest waits on the book as a bid for 24 hours. Its USDG is held until the bid fills or you cancel it."}
          mono={false} v={mode === "buy" ? "Buys now" : split && split.crossing.buy.filledUnits > 0n ? `${formatShares(split.crossing.buy.filledUnits)} sh now, rest as a bid` : "Waits as a bid"} />
        <SummaryRow k="Breakeven" tip={`${detail.series.ticker} has to end ${isPut ? "below" : "above"} this at expiry for the ${isPut ? "put" : "call"} to pay back its cost, after the ${pct(detail.exerciseFeeBps)} exercise fee.`}
          v={orderBreakEven === null ? "—" : fmtUsdPrice(orderBreakEven)} />
        <SummaryRow k={`If ${detail.series.ticker} ${isPut ? "falls to" : "reaches"} $${formatUsdg(target)}`} tipLabel="About the payoff" tone="accent"
          tip={`What this size pays if ${detail.series.ticker} ends at $${formatUsdg(target)}, after the ${pct(detail.exerciseFeeBps)} exercise fee.${isPut ? "" : ` A winning call is owed ${detail.series.ticker} Stock Tokens; this is their value.`}`}
          v={orderPayout === null ? "—" : `${usd(orderPayout, 6, "down")}${multiple ? ` · ${multiple}` : ""}`} />
        {atPrice !== null && atPnl !== null ? <SummaryRow slot="at-price" k={`At ${fmtUsdPrice(atPrice)}`} tone={atPnl >= 0n ? "accent" : "danger"}
          tipLabel="About the chart price" tip={`Profit or loss at expiry if ${detail.series.ticker} ends at the price under the chart handle, after the exercise fee.`}
          v={signedUsd(atPnl)} /> : null}
      </SummaryBox> : <p className="rounded-md border border-dashed border-line-2 px-4 py-3 text-sm text-ink-2">{!book ? "Order book unavailable. Refresh in a moment."
        : !fees ? "Fees are unavailable, so there is no quote yet."
        : price === null ? "Enter a limit price."
          : "Enter a size."}</p>}
      {shortfallNotice}
      {partialDepth ? <Notice tone="warn">{partialDepth}</Notice> : null}
      {pricingCaption ? <p data-slot="pricing-status" className="text-xs text-ink-3">{pricingCaption}</p> : null}
    </> : <div data-slot="order-review" className="grid gap-4">
      <div className="grid gap-1.5">
        <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-accent-text">Review order</p>
        <p className="text-[15.5px] leading-normal text-ink">{sentence}</p>
      </div>
      <SummaryBox>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2.5">
          <span className="text-[14px] font-semibold text-ink">Estimated cost</span>
          <span className="num ml-auto text-[20px] font-semibold text-ink">{estimated === null ? "—" : usd(estimated, 6, "up")}</span>
        </div>
        {mode === "buy" && quote ? <>
          <SummaryRow k="Premium" v={usd(quote.buy.premium, 6, "up")} />
          <SummaryRow k="Fee" tipLabel="About the fee" tip={feeTip} v={usd(quote.buy.fee, 6, "up")} />
        </> : split ? <>
          <SummaryRow k="Buys now" v={`${formatShares(split.crossing.buy.filledUnits)} sh · ${usd(split.crossing.buy.cost, 6, "up")}`} />
          <SummaryRow k="Waits as a bid" v={`${formatShares(split.restingUnits)} sh · ${usd(split.escrow, 6, "up")} held`} />
        </> : null}
        <SummaryRow k="Max loss" v={estimated === null ? "—" : usd(estimated, 6, "up")} />
        {walletRow}
      </SummaryBox>
      {shortfallNotice}
      <ul className="grid gap-2">{reviewNotes.map((line) => <li key={line} className="flex items-start gap-2 text-[13px] text-ink-2">
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-pill bg-accent" />{line}</li>)}</ul>
      {drift ? <Notice tone="warn" role="alert">{drift}</Notice> : null}
    </div>}

    {config.data?.pendingFees ? <PendingFeeNotice effectiveAt={config.data.pendingFees.effectiveAt}
      nextFees={config.data.pendingFees} kind={mode === "bid" ? "bid" : "buyer"} /> : null}
    {!deployed ? <Notice tone="warn">Trading is unavailable in this build.</Notice> : null}
    {mismatch.length > 0 ? <Notice tone="warn">Trading is paused while app settings are out of sync.</Notice> : null}
    {spot === null ? <Notice tone="warn">Live price unavailable. Trading is paused until it returns.</Notice> : null}
    {expired ? <Notice tone="warn">This series has expired or entered settlement.</Notice> : null}
    {tradingPaused ? <Notice tone="warn">{TRADING_PAUSED_LINE}</Notice> : null}
    {/* When the user gets paid, above the button that signs: the call's payout date, bought now or by a bid. */}
    <PayoutTiming of={(t) => buyCallTiming({ expiry: detail.series.expiry, now: t, uncorroboratedDelayS: marketSettlement?.uncorroboratedDelayS })} />
    {reviewing ? <div className="grid gap-2">
      {address ? <Button onClick={() => void submit()} disabled={!writeReady || !(canBuy || canBid) || !reviewed || drift !== null || shortfall !== null} className="w-full">
        {pending ? "Confirming…" : reviewed?.mode === "bid" ? "Place bid" : "Buy now"}</Button> : <ConnectButton block />}
      <Button variant="ghost" size="sm" className="justify-self-center" disabled={pending} onClick={() => { setReviewed(null); setStep("edit"); }}>Edit order</Button>
    </div> : <div className="grid">{address ? <Button className="w-full" disabled={!liveOrder || shortfall !== null}
      onClick={() => { if (!liveOrder || shortfall !== null) return; setSuccess(null); setBidPrice(bidPrice); setReviewed(liveOrder); setStep("review"); }}>Review order</Button> : <ConnectButton block />}</div>}
    {success ? <Notice tone="info" role="status" title={success}>
      <div className="mt-2 flex flex-wrap gap-4"><Link className="link font-semibold" href="/portfolio">View Portfolio</Link>
        <Link className="link font-semibold" href="/settings/notifications">Turn on alerts</Link></div>
    </Notice> : null}

    {!reviewing ? <TicketSections>
      {mode === "buy" && payoffQuote && spot !== null && fees ? <TicketSection slot="payoff-explorer" title="Payoff and receipt"
        summary="What-ifs by price, and every fee line">
        <PayoffSlider bare ticker={detail.series.ticker} spot={spot}
          position={{ isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw), units: payoffQuote.buy.filledUnits,
            exerciseFeeBps: detail.exerciseFeeBps }} cost={payoffQuote.buy.cost} terms={terms}
          premium={payoffQuote.buy.premium} expiry={detail.series.expiry} now={now}
          renderScenario={(scenario) => {
            const position: PayoffPosition = { isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw),
              units: payoffQuote.buy.filledUnits, exerciseFeeBps: detail.exerciseFeeBps };
            const href = scenarioImageHref(detail.series.ticker, position, payoffQuote.buy.cost, detail.series.expiry, scenario, terms);
            return <>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a className="inline-flex min-h-10 items-center rounded-pill border border-line-2 bg-surface-2 px-4 text-sm font-semibold text-ink hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  href={href} target="_blank" rel="noopener noreferrer">Share this scenario</a>
              </div>
              <PayoffReceipt className="mt-4" input={{ ticker: detail.series.ticker, position, cost: payoffQuote.buy, fees, price: scenario.price,
                terms, gas: gasEstimate.data ?? null }} />
            </>;
          }} />
        {terms.source === "ceiling" && !detail.series.isPut ? <p className="text-xs text-ink-3">USDG range assumes the worst-case conversion (3 % under).</p> : null}
        <PayoffExplainers />
      </TicketSection> : null}
      {mode === "buy" ? <TicketSection slot="ticket-advanced" title="Advanced" summary={`Partial fills ${allowPartial ? "on" : "off"}`}>
        <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink"><input type="checkbox" className="size-4 accent-accent" checked={allowPartial}
          onChange={(event) => setAllowPartial(event.target.checked)} /> Allow a partial fill
          <InfoTip align="start" label="About partial fills" text="Buy what is still for sale at your limit if the whole size is gone by the time your trade lands." /></label>
      </TicketSection> : null}
      <TicketSection slot="ticket-settlement" title="Settlement and payout"
        summary={detail.series.isPut ? "Winning puts pay USDG" : `Winning calls are owed ${ticker.toUpperCase()} Stock Tokens`}>
        <SettlementDisclosure heading={false} settlement={marketSettlement} isPut={detail.series.isPut} ticker={ticker} />
        {!detail.series.isPut ? <ConversionFloor underlying={detail.series.underlying} /> : null}
      </TicketSection>
    </TicketSections> : null}
  </Panel>;
}
