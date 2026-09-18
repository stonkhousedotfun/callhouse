"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { DEV_PREVIEW } from "@/lib/devPreview";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, Panel } from "@/components/ui";
import { ConversionFloor } from "@/components/v2/ConversionFloor";
import { PayoffSlider } from "@/components/v2/PayoffSlider";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { v2ConfigWarnings, V2_DEPLOYMENT, requireV2Address } from "@/lib/v2/config";
import { assertSeriesTermsMatch, readOrderPreflight, readSeriesOnChain } from "@/lib/v2/chainReads";
import { useConfig, v2Keys } from "@/lib/v2/hooks";
import { collateralPerUnit, netPayoutUsdgPerUnit, premium, sharesToUnits, type TakerFeeParams } from "@/lib/v2/payoff";
import { formatShareQuantity, formatUsdg } from "@/lib/v2/payoffCard";
import { bidSplit, completeBidAfterCrossing, crossingBidUnknownMessage, partialDepthMessage, safeBuyQuote, staleSelectedOrders, type BuyQuote } from "@/lib/v2/ticket";
import { approveExact, place, recheckTakeQuote, take, type TakeParams, type WriteContext } from "@/lib/v2/tx";
import { findV2ReceiptUnknown } from "@/lib/v2/txStatus";
import type { BookResponse, SeriesDetailResponse } from "@/lib/v2/api-types";

function explain(error: unknown): string { return error instanceof Error ? error.message : "The trade could not be completed."; }

function tradePrice(raw: string): bigint | null {
  try { const value = parseUnits(raw, 6); return value > 0n && value % 100n === 0n ? value : null; }
  catch { return null; }
}

function paramsFor(quote: BuyQuote, longId: bigint, account: Address, units: bigint, allowPartial: boolean): Omit<TakeParams, "deadline"> {
  return { longId, buying: true, orderIds: quote.buy.orderIds.map(BigInt), units,
    minUnits: allowPartial ? 1n : units, limitPrice: quote.limitPrice!, writeToSell: false,
    recipient: account };
}

export function TradeTicket({ ticker, detail, book, target, spot, initialShares = "0.01", bookDegraded = false, onRefresh }: {
  ticker: string;
  detail: SeriesDetailResponse;
  book: BookResponse | null;
  target: bigint;
  spot: bigint | null;
  initialShares?: string;
  bookDegraded?: boolean;
  onRefresh: () => void | Promise<unknown>;
}) {
  const [shares, setShares] = useState(initialShares);
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
  const units = useMemo(() => { try { return sharesToUnits(shares); } catch { return null; } }, [shares]);
  const toleranceBps = Number(tolerance) * 100;
  const fees: TakerFeeParams | null = useMemo(() => config.data ? {
    takerFeeFlat: BigInt(config.data.fees.takerFeeFlat.raw), takerFeeCapBps: config.data.fees.takerFeeCapBps,
  } : null, [config.data]);
  const rentTerms = useMemo(() => book ? { collateralPerUnit: collateralPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw)),
    mintFeePpm: detail.series.mintFeePpm, expiry: detail.series.expiry, mintCutoff: detail.series.mintCutoff,
    snapshotTimestamp: book.snapshotTimestamp } : undefined, [book, detail.series]);
  const quote = useMemo(() => {
    if (!book || !units || !fees || !Number.isInteger(toleranceBps)) return null;
    return safeBuyQuote(book.asks, units, fees, toleranceBps, address, rentTerms);
  }, [book, units, fees, toleranceBps, address, rentTerms]);
  const partialDepth = quote && units !== null ? partialDepthMessage(quote.buy.filledUnits, units) : null;
  const price = tradePrice(bidPrice);
  const split = useMemo(() => {
    if (!book || !units || !fees || price === null) return null;
    try { return bidSplit(book.asks, units, price, fees, address, rentTerms); } catch { return null; }
  }, [book, units, fees, price, address, rentTerms]);
  const mismatch = config.data ? v2ConfigWarnings(config.data) : [];
  const deployed = Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
  const expired = now === null || now >= detail.series.expiry || !["open", "cutoff"].includes(detail.series.status);
  const payout = units ? netPayoutUsdgPerUnit(detail.series.isPut, BigInt(detail.series.strike.raw), target, detail.exerciseFeeBps)
    * (mode === "buy" ? quote?.buy.filledUnits ?? 0n : split?.crossing.buy.filledUnits ?? 0n) : 0n;
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
    const expected = { filled: selected.buy.filledUnits, premium: selected.buy.premium, fee: selected.buy.fee };
    await recheckTakeQuote(context, takeRequest, expected);
    await approveExact(context, getAddress(config.data!.usdg.address), requireV2Address("orderBook"), expected.premium + expected.fee);
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
        {(["buy", "bid"] as const).map((value) => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}
          className={`rounded-sm px-3 py-2 text-sm font-semibold ${mode === value ? "bg-surface text-accent-text shadow-soft" : "text-ink-2"}`}>
          {value === "buy" ? "Buy now" : "Place a bid"}</button>)}
      </div>
    </div>
    {DEV_PREVIEW ? <Notice tone="warn" className="mt-4">Development preview: trades may execute on Robinhood Chain mainnet and use real assets. Confirm the network and transaction in your wallet.</Notice> : null}
    {bookDegraded ? <Notice tone="warn" className="mt-4">Indexer book unavailable. This quote was rebuilt from on-chain orders; it will be rechecked before a trade.</Notice> : null}
    <label className="mt-5 block text-sm font-semibold" htmlFor="ticket-shares">Quantity in shares</label>
    <input id="ticket-shares" inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)}
      className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" aria-describedby="ticket-size-help" />
    <div className="mt-2 flex flex-wrap gap-2">{["0.01", "0.1", "1"].map((size) => <button key={size} type="button" onClick={() => setShares(size)} aria-pressed={shares === size}
      className={`num min-h-10 rounded-sm border px-3 text-sm ${shares === size ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface"}`}>{size}</button>)}</div>
    <p id="ticket-size-help" className="mt-1 text-xs text-ink-3">Sizes move in 0.01-share steps.</p>
    {units === null ? <p role="alert" className="mt-2 text-sm text-danger">Enter a positive quantity in 0.01-share steps.</p> : null}

    {mode === "buy" ? <>
      <label className="mt-5 block text-sm font-semibold" htmlFor="ticket-slippage">Price tolerance</label>
      <select id="ticket-slippage" value={tolerance} onChange={(event) => setTolerance(event.target.value)}
        className="mt-2 min-h-10 rounded-sm border border-line-2 bg-surface px-3 text-sm text-ink">
        <option value="0">0%</option><option value="1">1%</option><option value="2">2% (default)</option><option value="5">5%</option>
      </select>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={allowPartial} onChange={(event) => setAllowPartial(event.target.checked)} /> Allow a partial fill</label>
      {quote && quote.buy.filledUnits > 0n ? <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
        <div><p className="text-ink-3">Available now</p><p className="num font-semibold">{formatShareQuantity(quote.buy.filledUnits)}</p></div>
        <div><p className="text-ink-3">Average ask / share</p><p className="num font-semibold">{quote.buy.averagePrice === null ? "—" : `${formatUsdg(quote.buy.averagePrice)} USDG`}</p></div>
        <div><p className="text-ink-3">Premium</p><p className="num font-semibold">{formatUsdg(quote.buy.premium)} USDG</p></div>
        <div><p className="text-ink-3">Taker fee</p><p className="num font-semibold">{formatUsdg(quote.buy.fee)} USDG</p></div>
        <div><p className="text-ink-3">Pay · max loss</p><p className="num font-bold">{formatUsdg(quote.buy.cost)} USDG</p></div>
        <div><p className="text-ink-3">{detail.series.isPut ? "Payout" : "Estimated settlement value"} if {detail.series.ticker} {detail.series.isPut ? "falls to" : "reaches"} ${formatUsdg(target)}</p>
          <p className="num font-semibold">{formatUsdg(payout)} USDG</p></div>
        {!detail.series.isPut ? <p className="col-span-2 text-xs text-ink-3">Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens.</p> : null}
        <div className="col-span-2 text-xs text-ink-3">Price guard: at most {quote.limitPrice ? `${formatUsdg(quote.limitPrice)} USDG/share` : "—"}. The on-chain quote expires within 5 minutes of the final check, or before a scheduled fee change.</div>
      </div> : <p className="mt-4 text-sm text-ink-2">{!book ? "The order book is unavailable. Refresh when it recovers."
        : !fees ? "Fee settings are unavailable. A cost cannot be quoted yet."
        : "No fillable asks are available for this size."}</p>}
      {partialDepth ? <Notice tone="warn" className="mt-4">{partialDepth}</Notice> : null}
      {quote && quote.buy.filledUnits > 0n && spot !== null ? <PayoffSlider className="mt-5" ticker={detail.series.ticker} spot={spot}
        position={{ isPut: detail.series.isPut, strike: BigInt(detail.series.strike.raw), units: quote.buy.filledUnits,
          exerciseFeeBps: detail.exerciseFeeBps }} cost={quote.buy.cost} /> : null}
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
