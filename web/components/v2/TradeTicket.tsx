"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAddress, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { DEV_PREVIEW } from "@/lib/devPreview";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, Panel } from "@/components/ui";
import { ConversionFloor } from "@/components/v2/ConversionFloor";
import { PayoffExplainers } from "@/components/v2/PayoffExplainers";
import { PayoffReceipt } from "@/components/v2/PayoffReceipt";
import { CEILING_TERMS, PayoffSlider, type SliderScenario } from "@/components/v2/PayoffSlider";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { SettlementDisclosure } from "@/components/v2/SettlementDisclosure";
import { erc20Abi } from "@/lib/abi/erc20";
import { orderBookAbi } from "@/lib/abi/v2/orderBook";
import { publicClient, robinhoodChain } from "@/lib/chain";
import { USDG } from "@/lib/contracts";
import { BUY_BUDGET_PRESETS, DEFAULT_BUY_BUDGET, buyQuoteForBudget, maxBuyQuote, parseUsdgBudget } from "@/lib/v2/budget";
import { v2ConfigWarnings, V2_DEPLOYMENT, requireV2Address } from "@/lib/v2/config";
import { assertSeriesTermsMatch, readOrderPreflight, readSeriesOnChain } from "@/lib/v2/chainReads";
import { useConfig, v2Keys } from "@/lib/v2/hooks";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, collateralPerUnit, netPayoutUsdgPerUnit, premium, sharesToUnits, type ConversionTerms, type PayoffPosition, type TakerFeeParams } from "@/lib/v2/payoff";
import { formatShareQuantity, formatUsdg } from "@/lib/v2/payoffCard";
import type { GasEstimate } from "@/lib/v2/payoffReceipt";
import { bidSplit, completeBidAfterCrossing, crossingBidUnknownMessage, partialDepthMessage, safeBuyQuote, staleSelectedOrders, type BuyQuote } from "@/lib/v2/ticket";
import { approveExact, place, recheckTakeQuote, take, type TakeParams, type WriteContext } from "@/lib/v2/tx";
import { findV2ReceiptUnknown } from "@/lib/v2/txStatus";
import type { BookResponse, ConfigResponse, Market, SeriesDetailResponse } from "@/lib/v2/api-types";

function explain(error: unknown): string { return error instanceof Error ? error.message : "The trade could not be completed."; }

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

/** The share card's URL (design §2.8): every input the image route re-validates, nothing pre-rendered. */
export function scenarioImageHref(ticker: string, position: PayoffPosition, cost: bigint, expiry: number, scenario: SliderScenario,
  terms: ConversionTerms, format: "square" | "wide" = "square"): string {
  const query = new URLSearchParams({
    ticker, side: position.isPut ? "put" : "call", strike: position.strike.toString(), units: position.units.toString(),
    fee: String(position.exerciseFeeBps), cost: cost.toString(), price: scenario.price.toString(), expiry: String(expiry),
    slippage: String(terms.slippageBps), routeFee: String(terms.routeFeeBps), format,
  });
  return `/api/pnl/scenario/image?${query}`;
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

export type TradeTicketPrefill =
  | { kind: "budget"; amountUsdg: string }
  | { kind: "shares"; shares: string };

export function TradeTicket({ ticker, detail, book, target, spot, marketSettlement, initialPrefill, initialShares, bookDegraded = false, onRefresh }: {
  ticker: string;
  detail: SeriesDetailResponse;
  book: BookResponse | null;
  target: bigint;
  spot: bigint | null;
  marketSettlement: Market["settlement"];
  /** Stable W4 ladder contract: prefill either a USDG budget or an exact share quantity. */
  initialPrefill?: TradeTicketPrefill;
  /** Backward-compatible route prefill. New callers should use initialPrefill. */
  initialShares?: string;
  bookDegraded?: boolean;
  onRefresh: () => void | Promise<unknown>;
}) {
  const seededPrefill: TradeTicketPrefill = initialPrefill ?? (initialShares
    ? { kind: "shares", shares: initialShares }
    : { kind: "budget", amountUsdg: DEFAULT_BUY_BUDGET });
  const [sizeMode, setSizeMode] = useState<"budget" | "shares">(seededPrefill.kind);
  const [budget, setBudget] = useState(seededPrefill.kind === "budget" ? seededPrefill.amountUsdg : DEFAULT_BUY_BUDGET);
  const [maxBudget, setMaxBudget] = useState(false);
  const [shares, setShares] = useState(seededPrefill.kind === "shares" ? seededPrefill.shares : "0.01");
  const [tolerance, setTolerance] = useState("2");
  const [allowPartial, setAllowPartial] = useState(false);
  const [mode, setMode] = useState<"buy" | "bid">("buy");
  const [bidPrice, setBidPrice] = useState("");
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
  const budgetRaw = useMemo(() => maxBudget ? null : parseUsdgBudget(budget), [budget, maxBudget]);
  const toleranceBps = Number(tolerance) * 100;
  const fees: TakerFeeParams | null = useMemo(() => config.data ? {
    takerFeeFlat: BigInt(config.data.fees.takerFeeFlat.raw), takerFeeCapBps: config.data.fees.takerFeeCapBps,
  } : null, [config.data]);
  const rentTerms = useMemo(() => book ? { collateralPerUnit: collateralPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw)),
    mintFeePpm: detail.series.mintFeePpm, expiry: detail.series.expiry, mintCutoff: detail.series.mintCutoff,
    snapshotTimestamp: book.snapshotTimestamp } : undefined, [book, detail.series]);
  const budgetQuote = useMemo(() => {
    if (!book || !fees || !Number.isInteger(toleranceBps)) return null;
    return maxBudget
      ? maxBuyQuote(book.asks, fees, toleranceBps, address, rentTerms)
      : budgetRaw === null ? null : buyQuoteForBudget(book.asks, budgetRaw, fees, toleranceBps, address, rentTerms);
  }, [book, fees, toleranceBps, address, rentTerms, maxBudget, budgetRaw]);
  const units = sizeMode === "budget" ? budgetQuote?.buy.filledUnits ?? null : shareUnits;
  const quote = useMemo(() => {
    if (sizeMode === "budget") return budgetQuote;
    if (!book || !shareUnits || !fees || !Number.isInteger(toleranceBps)) return null;
    return safeBuyQuote(book.asks, shareUnits, fees, toleranceBps, address, rentTerms);
  }, [sizeMode, budgetQuote, book, shareUnits, fees, toleranceBps, address, rentTerms]);
  const defaultPreviewQuote = useMemo(() => {
    if (!book || !fees || !Number.isInteger(toleranceBps)) return null;
    const defaultBudget = parseUsdgBudget(DEFAULT_BUY_BUDGET);
    return defaultBudget === null ? null : buyQuoteForBudget(book.asks, defaultBudget, fees, toleranceBps, address, rentTerms);
  }, [book, fees, toleranceBps, address, rentTerms]);
  const payoffQuote = quote?.buy.filledUnits ? quote : defaultPreviewQuote;
  const terms = useMemo(() => explorerTerms(config.data), [config.data]);
  const gasQuoteKey = payoffQuote ? `${payoffQuote.buy.orderIds.join(",")}:${payoffQuote.buy.filledUnits}:${payoffQuote.buy.cost}` : null;
  const gasEstimate = useQuery({
    queryKey: ["v2", "buy-gas", address ?? null, detail.series.longId, gasQuoteKey, allowPartial],
    queryFn: () => estimateBuyGas(address!, payoffQuote!, BigInt(detail.series.longId), payoffQuote!.buy.filledUnits, allowPartial),
    enabled: Boolean(address && payoffQuote && payoffQuote.buy.filledUnits > 0n && V2_DEPLOYMENT.contracts.orderBook),
    staleTime: 15_000, retry: 0,
  });
  const partialDepth = sizeMode === "shares" && quote && units !== null ? partialDepthMessage(quote.buy.filledUnits, units) : null;
  const price = tradePrice(bidPrice);
  const split = useMemo(() => {
    if (!book || !units || !fees || price === null) return null;
    try { return bidSplit(book.asks, units, price, fees, address, rentTerms); } catch { return null; }
  }, [book, units, fees, price, address, rentTerms]);
  const mismatch = config.data ? v2ConfigWarnings(config.data) : [];
  const deployed = Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
  const expired = now === null || now >= detail.series.expiry || !["open", "cutoff"].includes(detail.series.status);
  const outcomeUnits = mode === "buy" ? quote?.buy.filledUnits ?? 0n : split?.crossing.buy.filledUnits ?? 0n;
  const payout = netPayoutUsdgPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw), target, detail.exerciseFeeBps) * outcomeUnits;
  const canBuy = mode === "buy" && Boolean(units && quote?.limitPrice && quote.buy.filledUnits > 0n &&
    (allowPartial || quote.buy.unfilledUnits === 0n));
  const canBid = mode === "bid" && Boolean(units && price && split);
  const writeReady = Boolean(address && wallet.data && deployed && config.data && mismatch.length === 0 && spot !== null && !expired && !pending);

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
    if (stale.length) throw new Error("An ask changed or lost collateral. Refresh the book and review your quote.");
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
    if (!writeReady || !address || !wallet.data || !units || !config.data) return;
    setPending(true); setSuccess(null);
    let confirmedBidFill = 0n;
    let placingBidRemainder = false;
    const context: WriteContext = { account: address, wallet: wallet.data as WalletClient,
      onConfirmed: () => queryClient.invalidateQueries({ queryKey: v2Keys.all }) };
    try {
      if (mode === "buy") {
        if (!canBuy || !quote) return;
        notice("pending", "Confirm your buy", "The wallet will show any required exact USDG approval, then the trade.");
        const filled = await executeCrossing(quote, units, allowPartial, context);
        setSuccess(filled === null ? "Buy confirmed. Check Portfolio for the filled size." :
          `Bought ${formatShareQuantity(filled)}.`);
        notice("success", "Buy confirmed", filled === null ? "The fill size could not be read from the receipt. Check Portfolio before another trade." :
          "Your position is in Portfolio.", [
          { label: "View Portfolio", href: "/portfolio" }, { label: "Turn on alerts", href: "/settings/notifications" },
        ]);
      } else {
        if (!canBid || !split || price === null) return;
        let filled = 0n;
        if (split.crossing.buy.filledUnits > 0n) {
          notice("pending", "Filling the crossing ask", "A bid that crosses an ask buys the available part first.");
          const actual = await executeCrossing(split.crossing, split.crossing.buy.filledUnits, false, context);
          if (actual === null || actual !== split.crossing.buy.filledUnits) {
            setSuccess("Crossing trade confirmed. Check Portfolio for the filled size before placing the remaining bid.");
            notice("success", "Crossing confirmed", "The fill size could not be verified from the receipt. Review Portfolio before placing the rest.");
            void onRefresh();
            return;
          }
          filled = actual;
        }
        confirmedBidFill = filled;
        placingBidRemainder = true;
        const completion = await completeBidAfterCrossing(units, filled, async (remaining) => {
          const chainSeries = await readSeriesOnChain(BigInt(detail.series.longId));
          if (!chainSeries.exists) throw new Error("This option is no longer on chain.");
          assertSeriesTermsMatch(detail.series, chainSeries.series, ticker, detail.exerciseFeeBps);
          const expiry = Math.min(detail.series.expiry - 1, Math.floor(Date.now() / 1000) + 86_400);
          if (expiry <= Math.floor(Date.now() / 1000)) throw new Error("This series is too close to expiry for a new bid.");
          await approveExact(context, getAddress(config.data.usdg.address), requireV2Address("orderBook"), premium(price, remaining));
          await place(context, BigInt(detail.series.longId), 0, price, remaining, expiry);
        });
        if (completion.kind === "partial") {
          const submitted = findV2ReceiptUnknown(completion.error);
          if (submitted) {
            unknownReceipt(completion.error);
            setSuccess(crossingBidUnknownMessage(filled, submitted.operation));
            void onRefresh();
            return;
          }
          const message = `Bought ${formatShareQuantity(filled)} now. The remaining bid could not be confirmed. Check Portfolio before retrying.`;
          setSuccess(message);
          notice("success", "Crossing buy confirmed", `${message} ${explain(completion.error)}`, [
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
      if (submitted && mode === "bid" && placingBidRemainder)
        setSuccess(crossingBidUnknownMessage(confirmedBidFill, submitted.operation));
      if (!unknownReceipt(error)) notice("error", "Trade stopped", explain(error));
      void onRefresh();
    } finally { setPending(false); }
  }

  return <Panel as="section" aria-label="Trade ticket" className="scroll-mt-5" id="ticket">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl font-bold">Trade ticket</h2>
      <div className="flex gap-1 rounded-sm bg-surface-2 p-1" role="group" aria-label="Trade type">
        {(["buy", "bid"] as const).map((value) => <button key={value} type="button" onClick={() => {
          setMode(value); if (value === "bid") setSizeMode("shares");
        }} aria-pressed={mode === value}
          className={`rounded-sm px-3 py-2 text-sm font-semibold ${mode === value ? "bg-surface text-accent-text shadow-soft" : "text-ink-2"}`}>
          {value === "buy" ? "Buy now" : "Place a bid"}</button>)}
      </div>
    </div>
    {DEV_PREVIEW ? <Notice tone="warn" className="mt-4">Development preview: trades may execute on Robinhood Chain mainnet and use real assets. Confirm the network and transaction in your wallet.</Notice> : null}
    {bookDegraded ? <Notice tone="warn" className="mt-4">Indexer book unavailable. This quote was rebuilt from on-chain orders; it will be rechecked before a trade.</Notice> : null}
    {mode === "buy" ? <div className="mt-5 flex gap-1 rounded-sm bg-surface-2 p-1" role="group" aria-label="Size in">
      {(["budget", "shares"] as const).map((value) => <button key={value} type="button" onClick={() => setSizeMode(value)}
        aria-pressed={sizeMode === value} className={`min-h-9 flex-1 rounded-sm px-3 text-sm font-semibold ${sizeMode === value
          ? "bg-surface text-accent-text shadow-soft" : "text-ink-2"}`}>{value === "budget" ? "USDG" : "Shares"}</button>)}
    </div> : <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-3">Bids are sized in shares</p>}

    {mode === "buy" && sizeMode === "budget" ? <>
      <label className="mt-4 block text-sm font-semibold" htmlFor="ticket-budget">Amount to spend</label>
      <div className="relative mt-2"><span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-semibold text-ink-3">$</span>
        <input id="ticket-budget" inputMode="decimal" value={budget} onChange={(event) => { setBudget(event.target.value); setMaxBudget(false); }}
          className="num min-h-12 w-full rounded-sm border border-line-2 bg-surface pl-7 pr-3 text-lg font-semibold text-ink"
          aria-describedby={!maxBudget && budgetRaw === null ? "ticket-size-help ticket-budget-error" : "ticket-size-help"}
          aria-invalid={!maxBudget && budgetRaw === null} /></div>
      <div className="mt-2 grid grid-cols-4 gap-2">{BUY_BUDGET_PRESETS.map((amount) => <button key={amount} type="button"
        onClick={() => { setBudget(amount); setMaxBudget(false); }} aria-pressed={!maxBudget && budget === amount}
        className={`num min-h-10 rounded-sm border px-2 text-sm ${!maxBudget && budget === amount
          ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface"}`}>${amount}</button>)}
        <button type="button" onClick={() => setMaxBudget(true)} aria-pressed={maxBudget}
          className={`min-h-10 rounded-sm border px-2 text-sm font-semibold ${maxBudget
            ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface"}`}>Max</button></div>
      <p id="ticket-size-help" className="mt-2 text-xs text-ink-3" aria-live="polite">{maxBudget
        ? "Max uses all currently fillable ask depth; your USDG balance is checked before the wallet opens."
        : quote ? `Current asks size this to ${formatShareQuantity(quote.buy.filledUnits)}.`
          : "Your budget includes premium and the taker fee."}</p>
      {!maxBudget && budgetRaw === null ? <p id="ticket-budget-error" role="alert" className="mt-2 text-sm text-danger">Enter a positive USDG amount with up to 6 decimals.</p> : null}
    </> : <>
      <label className="mt-4 block text-sm font-semibold" htmlFor="ticket-shares">Quantity in shares</label>
      <input id="ticket-shares" inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)}
        className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" aria-describedby="ticket-size-help" />
      <div className="mt-2 flex flex-wrap gap-2">{["0.01", "0.1", "1"].map((size) => <button key={size} type="button" onClick={() => setShares(size)} aria-pressed={shares === size}
        className={`num min-h-10 rounded-sm border px-3 text-sm ${shares === size ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface"}`}>{size}</button>)}</div>
      <p id="ticket-size-help" className="mt-1 text-xs text-ink-3">Sizes move in 0.01-share steps.</p>
      {shareUnits === null ? <p role="alert" className="mt-2 text-sm text-danger">Enter a positive quantity in 0.01-share steps.</p> : null}
    </>}

    {mode === "buy" ? <>
      {quote && quote.buy.filledUnits > 0n ? <div className="mt-5 border-t border-line pt-5">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-3">{detail.series.isPut ? "To win" : "Estimated settlement value"} if {detail.series.ticker} {detail.series.isPut ? "falls to" : "reaches"} ${formatUsdg(target)}</p>
        <p className="num mt-1 text-3xl font-bold tracking-tight text-accent-text">{formatUsdg(payout)} USDG</p>
        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-ink-3">Pay · max loss</p>
        <p className="num mt-1 text-3xl font-bold tracking-tight text-ink">{formatUsdg(quote.buy.cost)} USDG</p>
        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
          <div><p className="text-ink-3">Shares</p><p className="num font-semibold">{formatShareQuantity(quote.buy.filledUnits)}</p></div>
          <div><p className="text-ink-3">Average ask / share</p><p className="num font-semibold">{quote.buy.averagePrice === null ? "—" : `${formatUsdg(quote.buy.averagePrice)} USDG`}</p></div>
          <div><p className="text-ink-3">Premium</p><p className="num font-semibold">{formatUsdg(quote.buy.premium)} USDG</p></div>
          <div><p className="text-ink-3">Taker fee</p><p className="num font-semibold">{formatUsdg(quote.buy.fee)} USDG</p></div>
        </div>
        {sizeMode === "budget" && !maxBudget && budgetRaw !== null ? <p className="mt-3 text-xs text-ink-3">Budget not spent: <span className="num">{formatUsdg(budgetRaw - quote.buy.cost)} USDG</span>.</p> : null}
        {!detail.series.isPut ? <p className="mt-4 text-xs text-ink-3">Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens.</p> : null}
      </div> : <p className="mt-4 text-sm text-ink-2">{!book ? "The order book is unavailable. Refresh when it recovers."
        : !fees ? "Fee settings are unavailable. A cost cannot be quoted yet."
        : sizeMode === "budget" && !maxBudget && budgetRaw === null ? "Enter a valid budget to size this trade."
          : sizeMode === "budget" ? "No fully fillable size is available for this budget."
            : "No fillable asks are available for this size."}</p>}
      {partialDepth ? <Notice tone="warn" className="mt-4">{partialDepth}</Notice> : null}
      {quote ? <p className="mt-3 text-xs text-ink-3">Price guard: at most {quote.limitPrice ? `${formatUsdg(quote.limitPrice)} USDG/share` : "—"}. The transaction expires within 5 minutes and caps fees at the final on-chain quote.</p> : null}
      {payoffQuote && spot !== null && fees ? <><PayoffSlider className="mt-5" ticker={detail.series.ticker} spot={spot}
        position={{ isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw), units: payoffQuote.buy.filledUnits,
          exerciseFeeBps: detail.exerciseFeeBps }} cost={payoffQuote.buy.cost} terms={terms}
        renderScenario={(scenario) => {
          const position: PayoffPosition = { isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw),
            units: payoffQuote.buy.filledUnits, exerciseFeeBps: detail.exerciseFeeBps };
          const href = scenarioImageHref(detail.series.ticker, position, payoffQuote.buy.cost, detail.series.expiry, scenario, terms);
          return <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a className="inline-flex min-h-10 items-center rounded-md border border-line-2 bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                href={href} target="_blank" rel="noopener noreferrer">Share this scenario</a>
              <span className="text-xs text-ink-3">Opens a card that says “scenario, not a fill”.</span>
            </div>
            <PayoffReceipt className="mt-4" input={{ ticker: detail.series.ticker, position, cost: payoffQuote.buy, fees, price: scenario.price,
              terms, gas: gasEstimate.data ?? null }} />
          </>;
        }} />
        {terms.source === "ceiling" && !detail.series.isPut ? <p className="mt-2 text-xs text-ink-3">USDG band uses the contract’s worst-case conversion bound (3 %); the live bound was not available.</p> : null}
        {payoffQuote !== quote ? <p className="mt-2 text-xs text-ink-3">Payoff preview uses the default ${DEFAULT_BUY_BUDGET} size while your entry is incomplete.</p> : null}
        <PayoffExplainers className="mt-3" /></> : null}
      <details className="mt-5 rounded-sm border border-line-2 bg-surface-2 px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Advanced</summary>
        <div className="mt-4 border-t border-line pt-4">
          <label className="block text-sm font-semibold" htmlFor="ticket-slippage">Price tolerance</label>
          <select id="ticket-slippage" value={tolerance} onChange={(event) => setTolerance(event.target.value)}
            className="mt-2 min-h-10 rounded-sm border border-line-2 bg-surface px-3 text-sm text-ink">
            <option value="0">0%</option><option value="1">1%</option><option value="2">2% (default)</option><option value="5">5%</option>
          </select>
          <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={allowPartial} onChange={(event) => setAllowPartial(event.target.checked)} /> Allow a partial fill</label>
        </div>
      </details>
    </> : <>
      <label className="mt-5 block text-sm font-semibold" htmlFor="ticket-bid-price">Your bid price per share (USDG)</label>
      <input id="ticket-bid-price" inputMode="decimal" value={bidPrice} onChange={(event) => setBidPrice(event.target.value)} placeholder="0.60"
        className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
      {bidPrice && price === null ? <p role="alert" className="mt-2 text-sm text-danger">Use a positive price in 0.0001 USDG steps.</p> : null}
      {split ? <div className="mt-5 space-y-2 border-t border-line pt-4 text-sm">
        <p><span className="num font-semibold">{formatShareQuantity(split.crossing.buy.filledUnits)}</span> filled now across asks at or below your bid; cost including fee <span className="num">{formatUsdg(split.crossing.buy.cost)} USDG</span>.</p>
        <p><span className="num font-semibold">{formatShareQuantity(split.restingUnits)}</span> resting at <span className="num">{formatUsdg(price!)} USDG/share</span>; escrow <span className="num">{formatUsdg(split.escrow)} USDG</span>.</p>
        <p className="font-semibold">Max loss for fills now: {formatUsdg(split.crossing.buy.cost)} USDG. A resting bid reserves its escrow until filled or cancelled.</p>
      </div> : null}
    </>}
    <SettlementDisclosure settlement={marketSettlement} isPut={detail.series.isPut} ticker={ticker}
      className="mt-5 border-t border-line pt-4" />
    {!detail.series.isPut ? <ConversionFloor underlying={detail.series.underlying} /> : null}
    {config.data?.pendingFees ? <PendingFeeNotice className="mt-5" effectiveAt={config.data.pendingFees.effectiveAt}
      nextFees={config.data.pendingFees} kind={mode === "bid" ? "bid" : "buyer"} /> : null}
    {!deployed ? <Notice tone="warn" className="mt-5">V2 contracts are not deployed in this build. Quotes are visible, but trading is unavailable.</Notice> : null}
    {mismatch.length > 0 ? <Notice tone="warn" className="mt-5">App and indexer settings differ. Trading waits until they match.</Notice> : null}
    {spot === null ? <Notice tone="warn" className="mt-5">Live spot is unavailable for this market. New buys and bids are paused until the feed recovers.</Notice> : null}
    {expired ? <Notice tone="warn" className="mt-5">This series has expired or entered settlement.</Notice> : null}
    <div className="mt-5">{address ? <Button onClick={() => void submit()} disabled={!writeReady || !(canBuy || canBid)} className="w-full sm:w-auto">
      {pending ? "Confirming…" : mode === "buy" ? "Buy now" : "Place bid"}</Button> : <ConnectButton />}</div>
    {success ? <Notice tone="info" role="status" className="mt-5" title={success}>
      <div className="mt-2 flex flex-wrap gap-4"><Link className="link font-semibold" href="/portfolio">View Portfolio</Link>
        <Link className="link font-semibold" href="/settings/notifications">Turn on alerts</Link></div>
    </Notice> : null}
    <p className="mt-4 text-xs text-ink-3">Orders and collateral are rechecked on chain. Every transaction is simulated before it is sent.</p>
  </Panel>;
}
