"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { expiryDayLabel } from "@/lib/ui/dayPicker";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Chip, Field, InfoTip, Notice, Panel, Row, Rows, TickerLogo, Tabs, type TabItem } from "@/components/ui";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { closePairTiming, ledgerWithdrawTiming, restingOrderTiming, selfRedeemTiming, sellCallTiming } from "@/lib/v2/payoutTiming";
import { ConversionFloor } from "@/components/v2/ConversionFloor";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { PendingOperationsNotice } from "@/components/v2/PendingOperationsNotice";
import { EarnQueueCards, HeldPayments } from "@/components/v2/EarnQueueCards";
import { OwedBanner } from "@/components/v2/OwedBanner";
import { WithdrawalTerms, type WithdrawalTiming } from "@/components/v2/WithdrawalTerms";
import { publicClient, txUrl } from "@/lib/chain";
import { fmtUsdg, shortAddress } from "@/lib/format";
import { displayPrice, displayQuantity, displayRatioPercent, withDollar } from "@/lib/numberFormat";
import { clearinghouseAbi } from "@/lib/abi/v2/clearinghouse";
import { orderBookAbi } from "@/lib/abi/v2/orderBook";
import type { AccountOrder, ConfigResponse, HistoryItem, LongPosition, Market, ShortPosition } from "@/lib/v2/api-types";
import { v2Api, writerStrategiesOptions } from "@/lib/v2/api";
import { V2_DEPLOYMENT, requireV2Address, v2ConfigWarnings } from "@/lib/v2/config";
import { assertPortfolioSeries, assertPayoutPrefsMatch, assertSeriesTermsMatch, readAccountOnChain, readOrderPreflight,
  readPayoutPrefs, readSeriesOnChain, type PayoutPrefs } from "@/lib/v2/chainReads";
import { useBook, useConfig, useEarn, useFair, useMarkets, useOrderBookOwed, usePositions, useSeries, useStrategies, v2Keys } from "@/lib/v2/hooks";
import { cancelQueuedRequest, claimDeferredPayment, earnVaultAddress } from "@/lib/v2/lendTx";
import { heldPaymentsView, useHeldPayments, type HeldPaymentCard, type HeldPaymentsView } from "@/lib/v2/earnDeferred";
import { claimOrderBookOwed, owedBanner } from "@/lib/v2/owed";
import { lendQueueCards, type QueuedRequestCard } from "@/lib/v2/earnQueue";
import { formatOptionRedeemPreview, readOptionRedeemPreview } from "@/lib/v2/moneyPreviews";
import { readWriterRent } from "@/lib/v2/earnTx";
import { onChainClock, useChainClockOffset } from "@/lib/v2/chainClock";
import { summariseHistory, type StockAmount } from "@/lib/v2/historySummary";
import { shortIdOf } from "@/lib/v2/seriesId";
import { sharesToUnits, type TakerFeeParams } from "@/lib/v2/payoff";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";
import { expiryCountdown, longPositionRow, orderIdentityMatches, payoffSentence, positionOutcome, quoteSell,
  readyToCollect, rollerPlacedAskIds, splitResale, tradeWindowOpen, verifySellOrders, type PnlPeriod, type SellQuote } from "@/lib/v2/portfolio";
import { assertTradingOpen, TRADING_PAUSED_LINE, tradingOpen } from "@/lib/v2/tradingGate";
import { PortfolioHero, PortfolioStatTiles } from "@/components/v2/PortfolioStats";
import { putTickers } from "@/components/v2/Marketplace";
import { safeBuyQuote, staleSelectedOrders } from "@/lib/v2/ticket";
import { closedStrategyPosition, portfolioPricingStatus, selectPortfolioSmartPricingStrategies, smartPricingOffer,
  type IndexedStrategy } from "@/lib/v2/smartPricing";
import { approveExact, cancel, chainNow, close, place, redeem, replace, restingValidUntil, setPayoutInKind, setTokenApproval,
  recheckTakeQuote, take, withdraw, type WriteContext } from "@/lib/v2/tx";
import { userErrorText } from "@/lib/v2/errors";
import { V2ConfirmedStepError } from "@/lib/v2/txStatus";
import { Time } from "@/components/ui/Time";

type Tab = "positions" | "selling" | "orders" | "history";
type Run = (id: string, title: string, work: (context: WriteContext) => Promise<void>, requireTrade?: boolean) => Promise<void>;
const label = (ticker: string, strike: string, put: boolean) => `${ticker} $${strike} ${put ? "put" : "call"}`;
/** An API amount by the shared display rules (lib/numberFormat.ts), USDG as money and any other asset as a
 *  quantity. The exact `formatted` string stays for inputs. */
const shown = (value: { raw: string; decimals: number }) => value.decimals === 6
  ? fmtUsdg(BigInt(value.raw)) : displayQuantity(BigInt(value.raw), value.decimals);
/** A USDG price per share to its 0.0001 tick, with no zero tail past the cents. */
const perShare = (value: { raw: string }) => fmtUsdg(BigInt(value.raw), 4);
/** A change in basis points: "+25%", "−3%", "0%". */
const changeText = (bps: number) => `${bps > 0 ? "+" : ""}${displayRatioPercent(BigInt(bps), 10_000n, { minus: "−" })}`;
const parsePrice = (value: string): bigint => {
  const price = parseUnits(value, 6);
  if (price <= 0n || price % 100n !== 0n) throw new Error("Price must be positive in 0.0001 USDG ticks.");
  return price;
};
const tryUnits = (value: string): bigint | null => { try { return sharesToUnits(value); } catch { return null; } };
const feesFrom = (config: ReturnType<typeof useConfig>["data"]): TakerFeeParams | null => config ? {
  takerFeeFlat: BigInt(config.fees.takerFeeFlat.raw), takerFeeCapBps: config.fees.takerFeeCapBps,
} : null;

async function executeSellQuote(context: WriteContext, quote: SellQuote, longId: bigint, underlying: Address) {
  if (!quote.limitPrice || quote.filled <= 0n) throw new Error("No live bids are selected.");
  const ids = quote.orderIds.map(BigInt);
  const current = await readOrderPreflight(ids, underlying);
  // An order's validUntil is judged against the chain's clock, not the browser's.
  if (!verifySellOrders(quote, current.map((row) => ({ orderId: row.orderId, ...row.order })),
    longId, await chainNow(context.client ?? publicClient)))
    throw new Error("A bid changed. Refresh the book and review the new proceeds.");
  const takeRequest = { longId, buying: false, orderIds: ids, units: quote.filled, minUnits: quote.filled,
    limitPrice: quote.limitPrice, writeToSell: false, recipient: context.account,
  };
  const params = await recheckTakeQuote(context, takeRequest,
    { filled: quote.filled, premium: quote.premium, takerFee: quote.fee, sellerFees: quote.sellerFee });
  await take(context, params);
}

/** Every write rechecks chain state, simulates, waits for a receipt and refreshes account data. */
function usePortfolioWrites(address: Address | undefined) {
  const wallet = useWalletClient();
  const config = useConfig();
  const client = useQueryClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const [busy, setBusy] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const matched = Boolean(config.data && v2ConfigWarnings(config.data).length === 0);
  const exitReady = Boolean(address && wallet.data && V2_DEPLOYMENT.contracts.orderBook &&
    V2_DEPLOYMENT.contracts.clearinghouse);
  const ready = exitReady && matched;
  const run: Run = async (id, title, work, requireTrade = true) => {
    if (!(requireTrade ? ready : exitReady) || !address || !wallet.data || busy) return;
    setBusy(id); setSuccess(null);
    const context: WriteContext = { account: address, wallet: wallet.data as WalletClient,
      onConfirmed: () => client.invalidateQueries({ queryKey: v2Keys.all }) };
    try {
      notice("pending", title, "Confirm each step in your wallet.");
      await work(context);
      setSuccess(title);
      notice("success", title, "Confirmed. Your portfolio updates shortly.");
      await client.invalidateQueries({ queryKey: v2Keys.all });
    } catch (error) {
      if (!unknownReceipt(error)) {
        console.error(`${title} stopped`, error); // The full detail stays available to support
        // A viem error is decoded to buyer copy, never printed raw.
        notice("error", `${title} stopped`, userErrorText(error, "The transaction could not be completed."));
      }
    } finally { setBusy(null); }
  };
  return { run, ready, exitReady, busy, success, config, fees: feesFrom(config.data) };
}

export function AutoPricedAskCard({ row, pricerAvailable, dataUnavailable }: {
  row: IndexedStrategy; pricerAvailable: boolean; dataUnavailable: boolean;
}) {
  const status = portfolioPricingStatus(row);
  const closed = closedStrategyPosition(row);
  const pricing = row.pricing;
  const currentAsk = pricing?.currentAsk ?? null;
  const fair = pricing?.fair ?? null;
  const band = pricing?.band ?? null;
  const current = pricing !== undefined && row.orderId !== null && currentAsk !== null;
  const repricing = current && pricerAvailable && fair !== null && !dataUnavailable;
  const askLabel = repricing ? "Current live ask" : "Last indexed ask";
  const ask = currentAsk
    ? `${perShare(currentAsk)} USDG`
    : status.kind === "closed" ? "Closed"
      : status.kind === "withdrawn" ? "Withdrawn"
        : status.kind === "no-live-order" ? "No live order"
          : pricing === undefined ? "Not reported" : "Unavailable";
  const readiness: ReactNode = dataUnavailable
    ? "Pricing could not refresh. The last indexed ask is shown; this card is not currently tracking repricing."
    : pricing === undefined
      ? "This legacy strategy does not report pricing."
      // The AutoRoller closed the last position; nothing is live until the next roll opens a new one.
      : closed
        ? <>The last call closed on <Time at={closed.at} />. The next roll opens a new one.</>
        : row.orderId === null
          ? status.kind === "withdrawn"
            ? "There is no live order currently repricing."
            : "The strategy is active but has no live order."
          : !pricerAvailable
            ? "Live, but the pricer is unavailable, so it is not currently repricing."
            : fair === null
              ? "Live, but fair data is unavailable, so it is not currently repricing."
              : "Pricer and fair data are live.";

  return <Panel as="article" pad="sm" className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-bold"><TickerLogo ticker={row.ticker} className="text-[18px]" />{row.ticker}
        <span className="font-medium text-ink-3">Auto-priced ask</span><InfoTip
        label="About the band">The band limits repricing. It does not promise a fill or keep an unchanged ask safe as the market moves.</InfoTip></h3>
      <Chip tone="accent">{status.label}</Chip>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      <Fact k={askLabel} v={ask} />
      <Fact k="Current fair estimate" v={fair === null ? "Unavailable" : `${perShare(fair)} USDG`} />
      <Fact k="Band" v={band ? `${perShare(band.min)}–${perShare(band.max)} USDG` : "Unavailable"} />
      <Fact k="Last reprice" v={pricing?.lastRepricedAt
        ? <>{pricing.lastRepricedPrice ? `${perShare(pricing.lastRepricedPrice)} USDG` : "Price unavailable"} · <Time at={pricing.lastRepricedAt} /></>
        : "Not recorded"} />
      <Fact k="Reprice count" v={pricing ? pricing.repriceCount : "Unavailable"} />
      <Fact k="Order" v={row.orderId ?? "None"} className="break-all" />
    </dl>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <p role="status" className="min-w-0 flex-1 text-[13px] text-ink-2">{readiness}</p>
      <Button size="sm" variant="ghost"
        href={`/sell/${row.ticker.toLowerCase()}?edit=smart-pricing#auto-roll`}>Edit band in Auto-roll</Button>
    </div>
  </Panel>;
}

function Fact({ k, v, sub, className }: { k: ReactNode; v: ReactNode; sub?: ReactNode; className?: string }) {
  return <div className="min-w-0">
    <dt className="text-[12px] font-medium text-ink-3">{k}</dt>
    <dd className={`num mt-1 text-[14.5px] font-semibold text-ink ${className ?? ""}`.trim()}>{v}</dd>
    {sub ? <dd className="mt-0.5 text-[12px] text-ink-3">{sub}</dd> : null}
  </div>;
}

/** Clearinghouse.previewRedeem before Collect. A revert is "cannot preview", never a made-up amount. */
function OptionRedeemPreviewLine({ tokenId, holder }: { tokenId: bigint; holder: Address }) {
  const preview = useQuery({
    queryKey: ["v2", "option-redeem-preview", tokenId.toString(), holder],
    enabled: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    retry: false,
    queryFn: () => readOptionRedeemPreview(publicClient, requireV2Address("clearinghouse"), tokenId, holder, holder),
  });
  return <p data-slot="option-redeem-preview" className="mt-3 text-sm text-ink-2">
    {preview.isPending ? "Checking what collecting would pay…" : formatOptionRedeemPreview(preview.data ?? { ok: false })}
  </p>;
}

export function LongCard({ position, history, now, account, payoutPrefs, run, ready, exitReady, busy, fees, resaleFeeBps, pendingFees, withdrawalTiming, trading }: {
  position: LongPosition; history: HistoryItem[]; now: number; account: Address;
  /** This market's OrderBook brake is off (lib/v2/tradingGate.ts). Selling and listing revert while it is on. */
  trading: boolean;
  payoutPrefs: PayoutPrefs | null;
  run: Run; ready: boolean; exitReady: boolean; busy: string | null; fees: TakerFeeParams | null; resaleFeeBps: number;
  pendingFees: ConfigResponse["pendingFees"]; withdrawalTiming: WithdrawalTiming | null;
}) {
  const longId = position.series.longId;
  const [size, setSize] = useState(formatShares(BigInt(position.units)));
  const [listingPrice, setListingPrice] = useState("");
  const [listing, setListing] = useState(false);
  const walletBalance = useQuery({ queryKey: ["v2", "wallet-long", account.toLowerCase(), longId],
    enabled: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => publicClient.readContract({ address: requireV2Address("clearinghouse"),
      abi: clearinghouseAbi, functionName: "balanceOf", args: [account, BigInt(longId)] }),
    staleTime: 15_000, refetchInterval: 15_000 });
  const book = useBook(longId);
  const fair = useFair(longId);
  const detail = useSeries(longId);
  const outcome = positionOutcome(position, "long", history, now, walletBalance.data);
  const units = tryUnits(size);
  const available = walletBalance.data ?? 0n;
  // The chain's clock, as the order card uses; the page tick alone ran on the browser's.
  const chainNowS = onChainClock(now || null, useChainClockOffset());
  const tradeable = tradeWindowOpen(position.series, chainNowS);
  const quote = useMemo(() => book.data && units && fees ? quoteSell(book.data.bids, units, fees,
    resaleFeeBps, account) : null,
    [book.data, units, fees, account, resaleFeeBps]);
  const fairValue = fair.data?.fair ?? null;
  const fairPrice = fairValue ? fairValue.formatted : null;
  const split = useMemo(() => {
    if (!book.data || !units || !fees || !listingPrice) return null;
    try { return splitResale(book.data.bids, units, parsePrice(listingPrice), fees, resaleFeeBps, account); }
    catch { return null; }
  }, [book.data, units, fees, listingPrice, resaleFeeBps, account]);
  const key = `long-${longId}`;

  async function approval(context: WriteContext, amount: bigint) {
    const series = await readSeriesOnChain(BigInt(longId));
    if (!series.exists) throw new Error("This option is no longer on chain.");
    assertSeriesTermsMatch(position.series, series.series, position.series.ticker);
    const chain = await readAccountOnChain(account, getAddress(position.series.underlying),
      BigInt(longId), requireV2Address("orderBook"));
    if (chain.longBalance < amount) throw new Error("Your on-chain position is smaller than this amount. Refresh Portfolio.");
    if (!chain.approvedForAll) await setTokenApproval(context, requireV2Address("orderBook"), true);
  }

  async function sellNow(context: WriteContext) {
    if (!units || units > available || !quote || quote.filled !== units || !quote.limitPrice)
      throw new Error("Choose a size fully covered by live bids.");
    // Before the token approval, which is its own transaction.
    await assertTradingOpen(context.client ?? publicClient);
    await approval(context, units);
    await executeSellQuote(context, quote, BigInt(longId), getAddress(position.series.underlying));
  }

  async function list(context: WriteContext) {
    if (!units || units > available || !tradeable || !book.data || !fees) throw new Error("Choose an open position with a live book and a valid size.");
    const price = parsePrice(listingPrice);
    const crossing = splitResale(book.data.bids, units, price, fees, resaleFeeBps, account);
    await assertTradingOpen(context.client ?? publicClient); // Before the approval
    await approval(context, units);
    const expiry = await restingValidUntil(context.client ?? publicClient, position.series.expiry);
    if (expiry === null) throw new Error("This option is too close to expiry to list.");
    if (crossing.crossing.filled > 0n)
      await executeSellQuote(context, crossing.crossing, BigInt(longId), getAddress(position.series.underlying));
    if (crossing.restingUnits > 0n) {
      try { await place(context, BigInt(longId), 1, price, crossing.restingUnits, expiry); }
      catch (error) { throw crossing.crossing.filled > 0n
        ? new V2ConfirmedStepError(`The immediate sale confirmed, but the remaining ask was not listed. Review Portfolio before retrying. ${userErrorText(error, "")}`,
          "The immediate sale confirmed.", error)
        : error; }
    }
  }

  async function collect(context: WriteContext) {
    if (!payoutPrefs) throw new Error("Read your on-chain payout preference before collecting.");
    await assertPortfolioSeries(position.series);
    assertPayoutPrefsMatch(payoutPrefs, await readPayoutPrefs(account));
    const chain = await readAccountOnChain(account, getAddress(position.series.underlying), BigInt(longId), requireV2Address("orderBook"));
    if (chain.longBalance === 0n) throw new Error("The payout may already have been pushed. Refresh Portfolio.");
    await redeem(context, BigInt(longId));
  }

  const name = label(position.series.ticker, position.series.strike.formatted, position.series.isPut);
  const covered = Boolean(quote?.filled === units && units);
  return <article aria-label={`Manage ${name}`} className="flex min-w-0 flex-col">
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Fact k="Expires" className="font-body" v={<Time at={position.series.expiry} market />} sub={now ? expiryCountdown(position.series.expiry, now) : "Checking expiry…"} />
      <Fact k="Held or listed" v={`${formatShares(BigInt(position.units))} shares`}
        sub={walletBalance.data !== undefined && available < BigInt(position.units) ? `${formatShares(available)} in wallet, the rest listed` : undefined} />
      <Fact k="Unrealised P&L" v={position.unrealised ? `${shown(position.unrealised)} USDG` : "—"} />
    </dl>
    <div className="mt-4 flex items-start gap-1.5 text-sm font-semibold text-ink"><span>{outcome.label}</span><InfoTip label="How this option pays" align="start">
      <span className="block">{payoffSentence(position)}</span>
      {!position.series.isPut ? <ConversionFloor underlying={position.series.underlying} /> : null}</InfoTip></div>
    {walletBalance.isError ? <p role="status" className="mt-1 text-xs text-danger">Wallet balance unavailable. Actions are paused until it loads.</p> : null}
    {tradeable ? <div className="mt-4 flex flex-col rounded-md border border-line bg-surface-2 p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <div className="grid gap-1.5">
          <Field id={`sell-size-${longId}`} label="Size" tip="Shares of this option to sell, in 0.01-share steps."
            aside={walletBalance.data !== undefined ? `${formatShares(available)} in wallet` : undefined} suffix="shares"
            inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)} />
          {walletBalance.data !== undefined && (!units || units > available) ? <p role="alert" className="text-xs text-danger">Choose up to {formatShares(available)} wallet shares in 0.01 steps.</p> : null}
        </div>
        <Rows className="sm:pt-6">
          <Row k="Bids pay now" tip="What the live bids pay for this size, after fees." mono={covered}
            v={covered && quote ? `${formatUsdg(quote.net)} USDG` : book.isError ? "Bids unavailable" : "No bids cover this size"} />
        </Rows>
      </div>
      {pendingFees ? <PendingFeeNotice className="mt-4" effectiveAt={pendingFees.effectiveAt} nextFees={pendingFees}
        kind={listing ? "resale" : "resaleImmediate"} /> : null}
      <PendingOperationsNotice className="mt-4" />
      {/* selling held longs into bids pays in the same transaction. */}
      <PayoutTiming className="mt-4" of={(t) => sellCallTiming({ expiry: position.series.expiry, now: t, writes: false })} />
      {trading ? null : <p data-slot="trading-paused" role="status" className="mt-3 text-sm text-ink-2">{TRADING_PAUSED_LINE}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><Button disabled={!ready || !trading || Boolean(busy) || walletBalance.data === undefined || !units || units > available || quote?.filled !== units}
        onClick={() => void run(`${key}-sell`, "Sell confirmed", sellNow)}>Sell now</Button>
        <Button variant="ghost" aria-expanded={listing} disabled={!ready || !trading || Boolean(busy)} onClick={() => setListing((value) => !value)}>List for sale</Button></div>
      {listing ? <div className="mt-4 flex flex-col border-t border-line pt-4">
        <Field id={`list-price-${longId}`} label="Ask price per share" tip="Any part your price crosses sells into the bids now; the rest rests on the book as your ask."
          aside={fairValue ? `Fair ${perShare(fairValue)} USDG` : "Fair value unavailable"} suffix="USDG"
          inputMode="decimal" value={listingPrice} onChange={(event) => setListingPrice(event.target.value)} placeholder={fairPrice ?? "0.25"} />
        {split ? <Rows className="mt-3">
          <Row k="Sells into bids now" v={`${formatShares(split.crossing.filled)} shares`} />
          <Row k="Rests at your ask" v={`${formatShares(split.restingUnits)} shares`} />
        </Rows> : null}
        <PayoutTiming className="mt-4" of={(t) => restingOrderTiming({ kind: "ask", validUntil: Math.min(position.series.expiry - 1, t + 86_400), now: t })} />
        <Button className="mt-4 w-full" disabled={!ready || !trading || Boolean(busy) || !book.data || !split || walletBalance.data === undefined || !units || units > available}
          onClick={() => void run(`${key}-list`, "Resale order submitted", list)}>Sell crossing bids and list remainder</Button></div> : null}
    </div> : null}
    <WithdrawalTerms className="mt-4" surface="redemption" expiry={position.series.expiry}
      status={detail.data?.series.status ?? position.series.status} timing={withdrawalTiming}
      candidateFinalizableAt={detail.data?.settlement?.candidate?.finalizableAt ?? null}
      settledAt={detail.data?.settlement?.settledAt ?? null} now={now || null} />
    {outcome.collect ? <PayoutTiming className="mt-4" of={(t) => selfRedeemTiming({
      settled: (detail.data?.series.status ?? position.series.status) === "settled", expiry: position.series.expiry, now: t })} /> : null}
    {outcome.collect ? <OptionRedeemPreviewLine tokenId={BigInt(longId)} holder={account} /> : null}
    {outcome.collect ? <Button className="mt-4 w-full sm:w-auto sm:self-start" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !payoutPrefs}
      onClick={() => void run(`${key}-collect`, "Payout collected", collect, false)}>Collect</Button> : null}
    {outcome.withdraw ? <p className="mt-3 text-sm text-ink-2">Withdraw it from your Stonkhouse balance.</p> : null}
  </article>;
}

export function ShortCard({ position, history, now, spot, account, usdg, payoutPrefs, run, ready, exitReady, busy, fees, trading }: {
  position: ShortPosition; history: HistoryItem[]; now: number; spot: Market["spot"] | null;
  /** This market's OrderBook brake is off. The buyback's take reverts while it is on; the matched close does not. */
  trading: boolean;
  account: Address; usdg: Address | null; payoutPrefs: PayoutPrefs | null;
  run: Run; ready: boolean; exitReady: boolean; busy: string | null; fees: TakerFeeParams | null;
}) {
  const longId = position.series.longId;
  const shortId = shortIdOf(BigInt(longId));
  const [size, setSize] = useState(formatShares(BigInt(position.units)));
  const walletBalance = useQuery({ queryKey: ["v2", "wallet-short", account.toLowerCase(), longId],
    enabled: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => publicClient.readContract({ address: requireV2Address("clearinghouse"),
      abi: clearinghouseAbi, functionName: "balanceOf", args: [account, shortId] }),
    staleTime: 15_000, refetchInterval: 15_000 });
  const units = tryUnits(size);
  const available = walletBalance.data ?? 0n;
  const book = useBook(longId);
  const quote = useMemo(() => book.data && units && fees ? safeBuyQuote(book.data.asks.map((level) => ({
    ...level, orders: level.orders.filter((order) => order.maker.toLowerCase() !== account.toLowerCase()),
  })), units, fees, 200, account, { collateralPerUnit: position.series.isPut ? BigInt(position.series.strike.raw) / 100n : 10n ** 16n,
    mintFeePpm: position.series.mintFeePpm, expiry: position.series.expiry, mintCutoff: position.series.mintCutoff,
    snapshotTimestamp: book.data.snapshotTimestamp }) : null, [book.data, units, fees, account, position.series]);
  const outcome = positionOutcome(position, "short", history, now, walletBalance.data);
  // The chain's clock, as LongCard.
  const chainNowS = onChainClock(now || null, useChainClockOffset());
  const open = tradeWindowOpen(position.series, chainNowS);
  const closeAllowed = position.series.status !== "settled";
  const strike = BigInt(position.series.strike.raw);
  const spotRaw = spot ? BigInt(spot.raw) : null;
  const inMoney = spotRaw === null ? null : position.series.isPut ? spotRaw < strike : spotRaw > strike;
  const key = `short-${longId}`;

  async function matchedBalance() {
    const state = await readAccountOnChain(account, getAddress(position.series.underlying),
      BigInt(longId), requireV2Address("orderBook"));
    if (!units || units > state.shortBalance) throw new Error("Your short balance changed. Refresh Portfolio.");
    return state.longBalance;
  }

  async function closeMatched(context: WriteContext) {
    if (!units || await matchedBalance() < units) throw new Error("Buy or receive matching long units before closing.");
    await close(context, BigInt(longId), units);
  }

  async function buyBack(context: WriteContext) {
    if (!units || units > available || !quote || quote.buy.filledUnits !== units || !quote.limitPrice || !usdg)
      throw new Error("Choose a size fully covered by live asks.");
    await assertTradingOpen(context.client ?? publicClient); // Before the USDG approval
    await matchedBalance();
    const ids = quote.buy.orderIds.map(BigInt);
    const series = await readSeriesOnChain(BigInt(longId));
    if (!series.exists) throw new Error("The series is no longer on chain.");
    assertSeriesTermsMatch(position.series, series.series, position.series.ticker);
    const collateralAsset = position.series.isPut ? usdg : getAddress(position.series.underlying);
    const orders = await readOrderPreflight(ids, collateralAsset, undefined, series.blockNumber);
    const changed = staleSelectedOrders(quote, orders.map(({ orderId, order, freeCollateral }) => ({
      orderId, maker: order.maker, longId: order.longId, kind: order.kind, price: order.price,
      units: order.units, filled: order.filled, validUntil: order.validUntil, cancelled: order.cancelled, freeCollateral,
    })), BigInt(longId), series.collateral, series.snapshotTimestamp, { collateralPerUnit: series.collateral, mintFeePpm: series.series.mintFeePpm,
      expiry: Number(series.series.expiry), mintCutoff: Number(series.cutoff), snapshotTimestamp: series.snapshotTimestamp });
    if (changed.length) throw new Error("An ask changed. Refresh the book and review the buyback cost.");
    const takeRequest = { longId: BigInt(longId), buying: true, orderIds: ids, units, minUnits: units,
      limitPrice: quote.limitPrice, writeToSell: false, recipient: account };
    const expected = { filled: units, premium: quote.buy.premium, takerFee: quote.buy.fee, sellerFees: 0n };
    await recheckTakeQuote(context, takeRequest, expected);
    await approveExact(context, usdg, requireV2Address("orderBook"), expected.premium + expected.takerFee);
    const params = await recheckTakeQuote(context, takeRequest, expected);
    await take(context, params);
    try { await close(context, BigInt(longId), units); }
    catch (error) { throw new V2ConfirmedStepError(`The buyback completed, but close did not. Your new long units remain in Portfolio; use Close matched units. ${userErrorText(error, "")}`,
      "The buyback confirmed.", error); }
  }

  async function collect(context: WriteContext) {
    if (!payoutPrefs) throw new Error("Read your on-chain payout preference before collecting.");
    await assertPortfolioSeries(position.series);
    assertPayoutPrefsMatch(payoutPrefs, await readPayoutPrefs(account));
    const chain = await readAccountOnChain(account, getAddress(position.series.underlying), BigInt(longId), requireV2Address("orderBook"));
    if (chain.shortBalance === 0n) throw new Error("The payout may already have been pushed. Refresh Portfolio.");
    await redeem(context, shortId);
  }

  const name = label(position.series.ticker, position.series.strike.formatted, position.series.isPut);
  const covered = Boolean(quote?.buy.filledUnits === units && units);
  return <article aria-label={`Manage ${name} (written)`} className="flex min-w-0 flex-col">
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Fact k="Expires" className="font-body" v={<Time at={position.series.expiry} market />} sub={now ? expiryCountdown(position.series.expiry, now) : "Checking expiry…"} />
      <Fact k="Written" v={`${formatShares(BigInt(position.units))} shares`} />
      <Fact k="Right now" v={inMoney === null ? "Price unavailable" : inMoney ? "In the money" : "Out of the money"} className="font-body" />
    </dl>
    <div className="mt-4 flex items-start gap-1.5 text-sm font-semibold text-ink"><span>{outcome.label}</span>
      <InfoTip label="About written options" align="start"><span className="block">Buying back and closing returns your collateral
        ({shown(position.collateralLocked)} {position.series.isPut ? "USDG" : position.series.ticker} locked now).</span>
        <span className="mt-1 block">Premium is shown after the seller fee, before gas. The buyback and the close are two separate
        transactions.</span></InfoTip></div>
    {/* As LongCard. An unread wallet balance is not 0 shares: say it is unavailable, and never ask for "up to 0". */}
    {walletBalance.isError ? <p role="status" className="mt-1 text-xs text-danger">Wallet balance unavailable. Actions are paused until it loads.</p> : null}
    {open || closeAllowed ? <div className="mt-4 flex flex-col rounded-md border border-line bg-surface-2 p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <div className="grid gap-1.5">
          <Field id={`buyback-size-${longId}`} label="Size to close" tip="Shares of this written option to close, in 0.01-share steps."
            aside={walletBalance.data !== undefined ? `${formatShares(available)} in wallet` : undefined} suffix="shares"
            inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)} />
          {walletBalance.data !== undefined && (!units || units > available) ? <p role="alert" className="text-xs text-danger">Choose up to {formatShares(available)} shares in 0.01 steps.</p> : null}
        </div>
        {open ? <Rows className="sm:pt-6">
          <Row k="Buyback costs" tip="The live asks for this size, with fees. If you hold matching longs, Close matched units needs no buyback." mono={covered}
            v={covered && quote ? `${formatUsdg(quote.buy.cost)} USDG` : book.isError ? "Asks unavailable" : "No asks cover this size"} />
        </Rows> : <p className="text-sm text-ink-2 sm:pt-7">Trading has ended. With matching long units you can still close before settlement.</p>}
      </div>
      {/* A buyback and a matched close both end in close(), which frees collateral to the Clearinghouse balance. */}
      <PayoutTiming className="mt-4" of={closePairTiming} />
      {open && !trading ? <p data-slot="trading-paused" role="status" className="mt-3 text-sm text-ink-2">{TRADING_PAUSED_LINE}</p> : null}
      <div className={`mt-4 grid gap-2 ${open ? "sm:grid-cols-2" : ""}`}>{open ? <Button disabled={!ready || !trading || Boolean(busy) || walletBalance.data === undefined || !units || units > available || quote?.buy.filledUnits !== units || !usdg}
        onClick={() => void run(`${key}-buyback`, "Buyback and close confirmed", buyBack)}>Buy back and close</Button> : null}
        <Button variant="ghost" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !units || units > available}
          onClick={() => void run(`${key}-close`, "Matched position closed", closeMatched, false)}>Close matched units</Button></div>
    </div> : null}
    {outcome.collect ? <PayoutTiming className="mt-4" of={(t) => selfRedeemTiming({
      settled: position.series.status === "settled", expiry: position.series.expiry, now: t })} /> : null}
    {outcome.collect ? <OptionRedeemPreviewLine tokenId={shortId} holder={account} /> : null}
    {outcome.collect ? <Button className="mt-4 w-full sm:w-auto sm:self-start" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !payoutPrefs}
      onClick={() => void run(`${key}-collect`, "Payout collected", collect, false)}>Collect</Button> : null}
  </article>;
}

/**
 * Cancel, and Edit only where the contract allows it. An ask the AutoRoller placed can be replaced only by the
 * roller (`OrderBook.replace`), so for those the writer gets a link to the strategy form instead of an Edit
 * that always reverts NotAuthorized. Cancel stays: the maker can always cancel.
 */
export function OrderActions({ ticker, rollerPlaced, cancelDisabled, editDisabled, onCancel, onEdit, editing = false }: {
  ticker: string; rollerPlaced: boolean; cancelDisabled: boolean; editDisabled: boolean;
  onCancel: () => void; onEdit: () => void;
  editing?: boolean;
}) {
  return <div className="flex flex-wrap items-center gap-2">
    {rollerPlaced
      ? <span className="inline-flex items-center gap-1.5"><Button size="sm" variant="ghost" href={`/sell/${ticker.toLowerCase()}?edit=smart-pricing#auto-roll`}>Edit strategy in Auto-roll</Button>
        <InfoTip label="Why this ask is edited in Auto-roll" align="end">Auto-roll placed this ask, so only Auto-roll can change it: change your strategy, or cancel the ask.</InfoTip></span>
      : <Button size="sm" variant="ghost" aria-expanded={editing} disabled={editDisabled} onClick={onEdit}>Edit price and size</Button>}
    <Button size="sm" variant="ghost" disabled={cancelDisabled} onClick={onCancel}>Cancel</Button>
  </div>;
}

function OrderCard({ order, rollerPlaced, usdg, account, fees, resaleFeeBps, pendingFees, now, run, ready, exitReady, busy, trading }: {
  order: AccountOrder; rollerPlaced: boolean; usdg: Address | null; account: Address; fees: TakerFeeParams | null;
  /** This market's OrderBook brake is off. `replace` reverts while it is on; `cancel` never reads it. */
  trading: boolean;
  resaleFeeBps: number; pendingFees: ConfigResponse["pendingFees"];
  now: number; run: Run; ready: boolean; exitReady: boolean; busy: string | null;
}) {
  const [editing, setEditing] = useState(false);
  // whether the order has expired is the chain's call (validUntil vs block.timestamp); the page tick is moved
  // onto the chain's clock. Null while unread, which shows no "Expired" and keeps Edit shut, as a missing tick does.
  const chainNowS = onChainClock(now || null, useChainClockOffset());
  const [price, setPrice] = useState(order.price.formatted);
  const [size, setSize] = useState(formatShares(BigInt(order.units) - BigInt(order.filled)));
  const book = useBook(order.series.longId);
  const remaining = BigInt(order.units) - BigInt(order.filled);
  const key = `order-${order.orderId}`;
  const split = useMemo(() => {
    if (order.kind !== "AskResale" || !book.data || !fees) return null;
    try { return splitResale(book.data.bids, sharesToUnits(size), parsePrice(price), fees, resaleFeeBps, account); }
    catch { return null; }
  }, [order.kind, book.data, fees, size, price, resaleFeeBps, account]);

  async function currentOrder(context: WriteContext) {
    const [current] = await publicClient.readContract({ address: requireV2Address("orderBook"),
      abi: orderBookAbi, functionName: "getOrders", args: [[BigInt(order.orderId)]] });
    if (!current || !orderIdentityMatches(order, current) || current.cancelled || current.maker.toLowerCase() !== context.account.toLowerCase() ||
      current.units <= current.filled) throw new Error("This order changed. Refresh Portfolio.");
    return current;
  }

  async function cancelOrder(context: WriteContext) {
    await currentOrder(context);
    await cancel(context, [BigInt(order.orderId)]);
  }

  async function editOrder(context: WriteContext) {
    // Before anything is sent. A resale edit that crosses bids CANCELS the old ask first, so a paused book
    // used to cancel it and then refuse the sale and the re-listing.
    await assertTradingOpen(context.client ?? publicClient);
    const current = await currentOrder(context);
    await assertPortfolioSeries(order.series);
    if (current.validUntil <= await chainNow(context.client ?? publicClient)) throw new Error("This order expired. Cancel it or place a new one.");
    if (current.price !== BigInt(order.price.raw) || current.units - current.filled !== remaining)
      throw new Error("The order changed. Refresh before editing it.");
    // tryUnits, not sharesToUnits: sharesToUnits throws a RangeError on 0 or a malformed size before this guard.
    const units = tryUnits(size);
    if (units === null || units <= 0n) throw new Error("Choose a positive size in 0.01-share steps.");
    const newPrice = parsePrice(price);
    if (current.kind === 1 && (!book.data || !fees)) throw new Error("Bid depth is unavailable. Refresh before replacing a resale ask.");
    const crossing = current.kind === 1 ? splitResale(book.data!.bids, units, newPrice, fees!, resaleFeeBps, account) : null;
    if (crossing && crossing.crossing.filled > 0n) {
      await cancel(context, [BigInt(order.orderId)]);
      let immediateSaleConfirmed = false;
      try {
        const chain = await readAccountOnChain(account, getAddress(order.series.underlying),
          BigInt(order.series.longId), requireV2Address("orderBook"));
        if (chain.longBalance < units) throw new Error("Your wallet does not hold the replacement size after cancellation.");
        if (!chain.approvedForAll) await setTokenApproval(context, requireV2Address("orderBook"), true);
        await executeSellQuote(context, crossing.crossing, BigInt(order.series.longId), getAddress(order.series.underlying));
        immediateSaleConfirmed = true;
        if (crossing.restingUnits > 0n)
          await place(context, BigInt(order.series.longId), 1, newPrice, crossing.restingUnits, current.validUntil);
      } catch (error) {
        throw new V2ConfirmedStepError(`The old order was cancelled; any confirmed sale remains final. Review Portfolio before retrying the rest. ${userErrorText(error, "")}`,
          immediateSaleConfirmed ? "The old order was cancelled, and the immediate sale confirmed." : "The old order was cancelled.", error);
      }
      return;
    }
    if (current.kind === 0) {
      if (!usdg) throw new Error("USDG address is unavailable.");
      const oldEscrow = current.price * remaining / 100n;
      const newEscrow = newPrice * units / 100n;
      if (newEscrow > oldEscrow) await approveExact(context, usdg, requireV2Address("orderBook"), newEscrow - oldEscrow);
    } else if (current.kind === 1) {
      const approval = await publicClient.readContract({ address: requireV2Address("clearinghouse"),
        abi: clearinghouseAbi, functionName: "isApprovedForAll", args: [context.account, requireV2Address("orderBook")] });
      if (!approval) await setTokenApproval(context, requireV2Address("orderBook"), true);
    }
    if (current.kind === 2) {
      const rent = await readWriterRent(getAddress(order.series.underlying), order.series.isPut, BigInt(order.series.strike.raw),
        order.series.expiry, units, context.account);
      const collateral = (order.series.isPut ? BigInt(order.series.strike.raw) / 100n : 10n ** 16n) * units;
      if (rent.free === null || rent.free < collateral + rent.rent) throw new Error("Deposit enough free collateral for the replacement size.");
    }
    await replace(context, BigInt(order.orderId), newPrice, units);
  }

  const expired = chainNowS !== null && order.validUntil <= chainNowS;
  return <article className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5">
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-[15px] font-bold"><TickerLogo ticker={order.series.ticker} className="text-[17px]" />{label(order.series.ticker, order.series.strike.formatted, order.series.isPut)}</h3>
        <p className={`mt-0.5 text-xs ${expired ? "font-semibold text-warn" : "text-ink-3"}`}>{order.kind === "Bid" ? "Bid" : order.kind === "AskResale" ? "Resale ask" : "Writer ask"} #{order.orderId} · {chainNowS !== null && order.validUntil <= chainNowS ? "Expired; cancel to recover escrow" : <>valid until <Time at={order.validUntil} /></>}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 md:block">
        <p className="num text-[15px] font-semibold">{formatShares(remaining)} sh <span className="text-ink-3">at</span> {perShare(order.price)} <small className="text-[11px] font-medium text-ink-3">USDG</small></p>
        <p className="num mt-0.5 text-xs text-ink-3">{formatShares(BigInt(order.filled))} sh filled</p>
      </div>
      <div className="md:justify-self-end">
        <OrderActions ticker={order.series.ticker} rollerPlaced={rollerPlaced} cancelDisabled={!exitReady || Boolean(busy)} editing={editing}
          editDisabled={!ready || !trading || Boolean(busy) || chainNowS === null || order.validUntil <= chainNowS}
          onCancel={() => void run(`${key}-cancel`, "Order cancelled", cancelOrder, false)} onEdit={() => setEditing((value) => !value)} />
      </div>
    </div>
    {editing && !rollerPlaced ? <div className="flex flex-col rounded-md border border-line bg-surface-2 p-4 sm:p-5">
      {order.kind === "AskResale" && pendingFees ? <PendingFeeNotice className="mb-4"
        effectiveAt={pendingFees.effectiveAt} nextFees={pendingFees} kind="resale" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`order-price-${order.orderId}`} label="Price per share" suffix="USDG" inputMode="decimal" value={price}
          onChange={(event) => setPrice(event.target.value)} />
        <Field id={`order-size-${order.orderId}`} label="Remaining size" suffix="shares" inputMode="decimal" value={size}
          onChange={(event) => setSize(event.target.value)} />
      </div>
      <PayoutTiming className="mt-4" of={(t) => restingOrderTiming({ kind: order.kind === "Bid" ? "bid" : "ask", validUntil: order.validUntil, now: t })} />
      <p className="mt-3 text-[13px] text-ink-2">{split?.crossing.filled
        ? `${formatShares(split.crossing.filled)} shares sell into bids now; ${formatShares(split.restingUnits)} rest. The old order is cancelled first.`
        : "Saving cancels this order and places a new one."}</p>
      <Button className="mt-4 w-full sm:w-auto sm:self-start" disabled={!ready || !trading || Boolean(busy)} onClick={() => void run(`${key}-edit`, "Order replaced", editOrder)}>Save replacement</Button>
    </div> : null}
  </article>;
}

function Ledger({ rows, run, exitReady, busy }: { rows: { asset: string; symbol: string; free: { raw: string; decimals: number; formatted: string } }[];
  run: Run; exitReady: boolean; busy: string | null }) {
  if (!rows.length) return null;
  return <Panel as="section" pad="sm" aria-labelledby="ledger-title" className="flex flex-col gap-3">
    <h2 id="ledger-title" className="flex items-center gap-1.5 text-[15px] font-bold">Stonkhouse balance <InfoTip label="About your Stonkhouse balance">
      Free funds held for you in the Clearinghouse: payouts sent to your balance and collateral freed by a close. You can withdraw them to your wallet.</InfoTip></h2>
    <PayoutTiming of={ledgerWithdrawTiming} />
    <ul className="grid">{rows.map((row) => <li key={row.asset} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2.5 last:pb-0">
      <span className="num text-[17px] font-semibold">{shown(row.free)} <small className="text-[12px] font-medium text-ink-3">{row.symbol}</small></span>
      <Button variant="secondary" size="sm" disabled={!exitReady || Boolean(busy) || BigInt(row.free.raw) === 0n}
        onClick={() => void run(`withdraw-${row.asset}`, "Balance withdrawn", async (context) => {
          const asset = getAddress(row.asset);
          const free = await publicClient.readContract({ address: requireV2Address("clearinghouse"),
            abi: clearinghouseAbi, functionName: "free", args: [context.account, asset] });
          if (free <= 0n) throw new Error("No free balance remains on chain. Refresh Portfolio.");
          await withdraw(context, asset, free);
        }, false)}>Withdraw</Button></li>)}</ul>
  </Panel>;
}

function historyAsset(item: HistoryItem, usdgAddress?: string | null): string {
  if (item.kind === "deposit" || item.kind === "withdrawal") return item.data.symbol;
  if (item.kind === "redemption") return item.data.asset.toLowerCase() === item.series.underlying.toLowerCase()
    ? `${item.series.ticker} Stock Tokens` : usdgAddress && item.data.asset.toLowerCase() === usdgAddress.toLowerCase()
      ? "USDG" : `token ${item.data.asset}`;
  return "USDG";
}

export function HistoryRows({ items, address, usdgAddress }: { items: HistoryItem[]; address?: string; usdgAddress?: string | null }) {
  if (!items.length) return <EmptyState title="No activity yet." />;
  return <ol className="divide-y divide-line">{items.map((item) => {
    const pnl = "realisedPnl" in item.data ? item.data.realisedPnl : null;
    const win = pnl && BigInt(pnl.raw) > 0n && item.longId;
    const amount = "amount" in item.data ? `${shown(item.data.amount)} ${historyAsset(item, usdgAddress)}`
      : item.kind === "fill" ? `${shown(item.data.premium)} USDG`
        : item.kind === "mint" ? `${shown(item.data.collateral)} ${item.series.isPut ? "USDG" : `${item.series.ticker} Stock Tokens`} collateral`
          : item.kind === "close" ? `${shown(item.data.collateralFreed)} ${item.series.isPut ? "USDG" : `${item.series.ticker} Stock Tokens`} collateral freed` : null;
    const fees = item.kind === "fill" ? <><span className="block">Fee paid: {shown(item.data.fee)} USDG</span>
      <span className="block">Rebate: {shown(item.data.rebate)} USDG</span></>
      : item.kind === "mint" ? <span className="block">{item.data.payer
        ? address ? item.data.payer.toLowerCase() === address.toLowerCase() ? "Mint fee paid by this wallet"
          : "Mint fee paid by the writer, not this wallet" : "Mint fee payer recorded"
        : "Mint fee payer unavailable"}: {shown(item.data.fee)} {item.series.isPut ? "USDG" : `${item.series.ticker} Stock Tokens`}</span>
        : item.kind === "close" ? <span className="block">Fee refund: {shown(item.data.feeRefund)} {item.series.isPut ? "USDG" : `${item.series.ticker} Stock Tokens`}</span>
          : item.kind === "redemption" ? <span className="block">Fee: not itemized</span>
            : item.kind === "deposit" || item.kind === "withdrawal" ? <span className="block">Fee: not reported</span> : null;
    return <li key={item.id} className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:px-5">
      <div className="min-w-0">
        <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14.5px] font-semibold"><span className="capitalize">{item.kind}</span>
          {item.series ? <span className="flex items-center gap-1.5 font-medium text-ink-2"><TickerLogo ticker={item.series.ticker} />{label(item.series.ticker, item.series.strike.formatted, item.series.isPut)}</span> : null}
          {item.kind === "redemption" ? <Chip tone={BigInt(item.data.amount.raw) > 0n ? "accent" : "neutral"} className="py-1 text-[11.5px]">
            {BigInt(item.data.amount.raw) > 0n ? "Paid" : "Expired without payout"}</Chip> : null}</h3>
        <p className="mt-0.5 text-xs text-ink-3"><Time at={item.ts} /></p>
      </div>
      <div className="min-w-0 text-right sm:text-left">
        <p className="num text-sm font-semibold">{amount ?? "—"}{fees ? <> <InfoTip label="Fees for this row" align="end">{fees}</InfoTip></> : null}</p>
        {pnl ? <p className={`num mt-0.5 text-xs font-semibold ${BigInt(pnl.raw) >= 0n ? "text-accent-text" : "text-danger-text"}`}>Realised P&amp;L {shown(pnl)} USDG</p> : null}
      </div>
      <div className="col-span-2 flex flex-wrap justify-end gap-2 sm:col-span-1">
        {win && address && item.longId ? <Button size="xs" variant="secondary" href={`/pnl/${item.longId}-${address.toLowerCase()}`}>Share win</Button> : null}
        <Button size="xs" variant="ghost" href={txUrl(item.data.tx)}>View transaction</Button></div>
    </li>;
  })}</ol>;
}

function EmptyState({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
    <p className="text-[15px] font-semibold text-ink-2">{title}</p>
    {action}
  </div>;
}

/**
 * The payout-preference help, in the card's "?" tip. The
 * put sentence shows only while a live market enables puts (`anyPuts`, from {putTickers}); today's text returns
 * unchanged the day one does.
 */
export function payoutPreferenceHelp(anyPuts: boolean): string {
  return anyPuts
    ? "Winning calls try USDG conversion and fall back to Stock Tokens. Puts pay USDG and short payouts return collateral. Applies to future redemptions."
    : "Winning calls try USDG conversion and fall back to Stock Tokens. Short payouts return collateral. Applies to future redemptions.";
}

export function HistorySummaryPanel({ summary, complete, stale, onHistory, anyPuts = false }: {
  summary: ReturnType<typeof summariseHistory>; complete: boolean; stale: boolean; onHistory: () => void; anyPuts?: boolean;
}) {
  const stock = (title: string, rows: readonly StockAmount[]) => rows.length ? <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
    <h3 className="font-semibold text-ink-2">{title}</h3>
    <ul className="flex flex-wrap gap-x-3 gap-y-1">{rows.map((row) => <li key={`${row.ticker}:${row.asset}:${row.decimals}`}
      className="num font-semibold text-ink">{displayQuantity(row.raw, row.decimals)} {row.ticker} Stock Tokens</li>)}</ul>
  </div> : null;
  return <section className="flex flex-col gap-4" aria-label="History summary">
    <PortfolioStatTiles summary={summary} anyPuts={anyPuts} />
    {stock("Call payouts in Stock Tokens", summary.stockPayouts)}
    {stock("Stock Token mint fees paid", summary.stockMintFees)}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12.5px] text-ink-3">
      <p>{complete ? "All activity loaded." : "Partial: older activity is not loaded."}{stale ? " Showing saved activity." : ""}</p>
      <Button size="xs" variant="ghost" onClick={onHistory}>See history rows</Button></div>
  </section>;
}

/**
 * A position row's meta line ("Fri 25 · 4.54 sh"): the expiry as its day
 * label, then the size. On the expiry day the countdown rides along ("Today, 1 hour left"), because
 * for a daily option the hours left are what the holder is deciding on; the exact New York time is in the card.
 */
export function rowMeta(expiry: number, units: string, now: number | null): string {
  const day = expiryDayLabel(expiry, now);
  const when = day === "Today" && now !== null ? `Today, ${expiryCountdown(expiry, now)}` : day;
  return `${when} · ${formatShares(BigInt(units))} sh`;
}

/**
 * One compact position row (spec s8: name, meta, paid, bid now, %, Sell or Collect). The action opens the full
 * card below the row, which keeps every sell, list, collect and withdrawal path the card already had.
 */
const ROW_GRID = "grid grid-cols-3 items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:grid-cols-[minmax(0,2.2fr)_repeat(3,minmax(0,1fr))_auto] sm:gap-x-4 sm:px-5";
const ROW_CELL = "order-3 flex min-w-0 flex-col gap-0.5 text-[15px] font-semibold sm:order-none";
const ROW_LABEL = "text-xs font-medium text-ink-3";

export function LongPositionRowView({ position, now, open, onToggle }: {
  position: LongPosition; now: number | null; open: boolean; onToggle: () => void;
}) {
  const row = longPositionRow(position);
  const change = row.changeBps;
  const name = label(position.series.ticker, position.series.strike.formatted, position.series.isPut);
  return <div data-slot="position-row" className={`${ROW_GRID} ${open ? "bg-row-selected" : ""}`}>
    <div className="order-1 col-span-2 flex min-w-0 flex-col gap-0.5 sm:order-none sm:col-span-1"><span className="flex min-w-0 items-center gap-2 text-[15px] font-bold"><TickerLogo ticker={position.series.ticker} className="text-[18px]" /><span className="truncate">{name}</span></span>
      <span className="text-xs text-ink-3">{rowMeta(position.series.expiry, position.units, now)}</span></div>
    <div className={ROW_CELL}><span className={ROW_LABEL}>Paid</span><span className="num">{perShare(position.avgCost)}</span></div>
    <div className={ROW_CELL}><span className={ROW_LABEL}>{row.nowLabel}</span><span className="num">{position.mark ? perShare(position.mark) : "—"}</span></div>
    <div className={ROW_CELL}><span className={ROW_LABEL}>Change</span><span className={`num font-bold ${change === null ? "text-ink-3" : change < 0 ? "text-danger-text" : "text-accent-text"}`}>
      {change === null ? "—" : changeText(change)}</span></div>
    <div className="order-2 justify-self-end sm:order-none"><Button size="sm" variant={row.action === "Collect" ? "primary" : "secondary"}
      aria-expanded={open} aria-label={`${row.action} ${name}`} onClick={onToggle}>{open ? "Close" : row.action}</Button></div>
  </div>;
}

function ShortPositionRowView({ position, now, open, onToggle }: {
  position: ShortPosition; now: number | null; open: boolean; onToggle: () => void;
}) {
  const option = label(position.series.ticker, position.series.strike.formatted, position.series.isPut);
  const name = `${option} (written)`;
  const collect = position.series.status === "settled" && position.claimable !== null && BigInt(position.claimable.raw) > 0n;
  return <div data-slot="position-row" className={`${ROW_GRID} ${open ? "bg-row-selected" : ""}`}>
    <div className="order-1 col-span-2 flex min-w-0 flex-col gap-0.5 sm:order-none sm:col-span-1"><span className="flex min-w-0 items-center gap-2 text-[15px] font-bold"><TickerLogo ticker={position.series.ticker} className="text-[18px]" /><span className="truncate">{option}</span></span>
      <span className="text-xs text-ink-3">{rowMeta(position.series.expiry, position.units, now)}</span></div>
    <div className={ROW_CELL}><span className={ROW_LABEL}>Premium</span><span className="num">{shown(position.premiumReceived)} <small className="text-[11px] font-medium text-ink-3">USDG</small></span></div>
    <div className={`${ROW_CELL} col-span-2`}><span className={ROW_LABEL}>Collateral locked</span><span className="num">{shown(position.collateralLocked)} <small
      className="text-[11px] font-medium text-ink-3">{position.series.isPut ? "USDG" : position.series.ticker}</small></span></div>
    <div className="order-2 justify-self-end sm:order-none"><Button size="sm" variant={collect ? "primary" : "secondary"} aria-expanded={open}
      aria-label={`${collect ? "Collect" : "Manage"} ${name}`} onClick={onToggle}>{open ? "Close" : collect ? "Collect" : "Manage"}</Button></div>
  </div>;
}

/** The accent "Ready to collect" card, shown while at least one settled position has a payout to collect. */
export function CollectPayoutCard({ collectable, onCollect }: {
  collectable: ReturnType<typeof readyToCollect>;
  onCollect: () => void;
}) {
  return <section aria-labelledby="ready-collect-title" className="flex flex-col gap-2 rounded-lg bg-accent p-[22px] text-accent-ink">
    <h2 id="ready-collect-title" className="text-[13px] font-bold">Ready to collect</h2>
    <p className="num text-[32px] font-extrabold leading-none tracking-[-0.04em] sm:text-[36px]">{fmtUsdg(collectable.usdgRaw)} USDG</p>
    <p className="text-[13px] font-semibold">{collectable.positions} settled position{collectable.positions === 1 ? "" : "s"}
      {collectable.otherAssets ? `, ${collectable.otherAssets} paid in Stock Tokens (not added to USDG)` : ""}.</p>
    {/* The global focus ring is --accent, which vanishes on this accent card (about 1:1). Ring it in
        --accent-ink instead, the card's own text colour (5.02:1 day, 17.80:1 night against --accent). */}
    <button type="button" className="mt-1.5 min-h-11 rounded-pill bg-accent-ink px-4 py-3 text-[15px] font-extrabold text-accent focus-visible:outline-accent-ink"
      onClick={onCollect}>Collect payout</button>
  </section>;
}

/** The disconnected state (spec s8.1): the Connect button, plus what appears here once a wallet is connected. */
export function PortfolioDisconnected() {
  const preview = ["Realised P&L", "Ready to collect", "Options held", "Open orders"];
  return <Panel as="section" aria-labelledby="portfolio-connect-title" pad="lg"
    className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
    <div className="flex flex-col items-start gap-4">
      <h2 id="portfolio-connect-title" className="font-display text-[24px] font-bold leading-tight tracking-[-0.02em] sm:text-[28px]">Connect a wallet to see your portfolio</h2>
      <p className="text-[15px] text-ink-2">Your P&amp;L, positions, orders and payouts ready to collect.</p>
      <div className="pt-1"><ConnectButton /></div>
    </div>
    <div aria-hidden="true" className="grid grid-cols-2 gap-3">
      {preview.map((name) => <div key={name} className="flex flex-col gap-2 rounded-md border border-line bg-field p-4">
        <span className="text-[12.5px] font-medium text-ink-3">{name}</span>
        <span className="num text-[22px] font-semibold text-ink-3">—</span>
      </div>)}
    </div>
  </Panel>;
}

function PortfolioHeader({ address }: { address?: string }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-6 pt-6 sm:pb-8 sm:pt-10">
    <h1 className="text-[32px] font-extrabold leading-none tracking-[-0.035em] sm:text-[40px]">Portfolio</h1>
    {address ? <Chip dot tone="accent" className="num" title={address}>{shortAddress(address)}</Chip> : null}
  </div>;
}

/**
 * The lending vault on the portfolio: this wallet's open queued requests with Cancel, then the
 * payments the vault HELD for it with Claim, the same cards as /earn. Exported so the section renders in a test with
 * the portfolio's own wiring (Portfolio below passes it the writes and the chain read).
 */
export function PortfolioLendRequests({ queueCards, held, canAct, busy, onCancel, onClaim }: {
  queueCards: readonly QueuedRequestCard[];
  held: HeldPaymentsView;
  canAct: boolean;
  busy: boolean;
  onCancel: (card: QueuedRequestCard) => void;
  onClaim: (card: HeldPaymentCard, to: Address) => void;
}) {
  return <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere] empty:hidden">
    <EarnQueueCards cards={queueCards} canAct={canAct} busy={busy} onCancel={onCancel} />
    <HeldPayments view={held} canAct={canAct} busy={busy} onClaim={onClaim} />
  </div>;
}

export function Portfolio() {
  const { address } = useAccount();
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const [period, setPeriod] = useState<PnlPeriod>("1M");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick();
    const timer = window.setInterval(tick, 30_000); return () => window.clearInterval(timer); }, []);
  const positions = usePositions(address);
  const markets = useMarkets();
  // Put copy only while a live market enables puts; the signal uses.
  const anyPuts = putTickers(markets.data).size > 0;
  // This wallet's strategies, filtered by the indexer, not one 200-row page of everyone's.
  const strategies = useStrategies(writerStrategiesOptions(address));
  const services = useQuery({ queryKey: ["v2", "services"], enabled: Boolean(address),
    queryFn: () => v2Api.getServices(), staleTime: 30_000, refetchInterval: 30_000, retry: false });
  const history = useInfiniteQuery({ queryKey: ["v2", "portfolio-history", address?.toLowerCase()], enabled: Boolean(address),
    queryFn: ({ pageParam, signal }) => v2Api.getHistory(address!, { limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000, refetchInterval: 15_000 });
  const historyItems = useMemo(() => history.data?.pages.flatMap((page) => page.items) ?? [], [history.data]);
  const summary = useMemo(() => summariseHistory(historyItems, address), [historyItems, address]);
  const writes = usePortfolioWrites(address);
  // USDG the order book holds for this wallet (read on chain; the credit has no log), and this wallet's
  // open lending-vault requests, with the same cards and Cancel as /earn.
  const owed = useOrderBookOwed(address);
  const earn = useEarn(address);
  const queueCards = now === null ? [] : lendQueueCards(earnVaultAddress(), earn.data, now);
  // payments the lending vault HELD for this wallet, read on chain (the indexer lists no served request).
  const heldRead = useHeldPayments(earnVaultAddress(), address);
  const held = heldPaymentsView(heldRead.data, address);
  const payoutPrefs = useQuery({ queryKey: ["v2", "payoutPrefs", address?.toLowerCase()],
    enabled: Boolean(address && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readPayoutPrefs(address!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const chainPrefs = payoutPrefs.isError ? null : payoutPrefs.data ?? null;
  const usdg = writes.config.data ? getAddress(writes.config.data.usdg.address) : null;
  const spots = new Map((markets.isError ? undefined : markets.data)?.map((market) => [market.ticker, market.spot]) ?? []);
  const mismatch = writes.config.data ? v2ConfigWarnings(writes.config.data) : [];
  const autoPriced = useMemo(() => address ? selectPortfolioSmartPricingStrategies(
    strategies.data?.items ?? [], address, markets.data ?? []) : [],
  [address, strategies.data, markets.data]);
  const pricerAvailable = now !== null && smartPricingOffer(
    services.isError ? null : services.data?.pricer, now).offered;
  const pricingDataUnavailable = strategies.isError || markets.isError;
  const pricingIdentityUnreadable = (strategies.isError && !strategies.data) || (markets.isError && !markets.data);
  const pricingIdentityLoading = (strategies.isPending && !strategies.data) || (markets.isPending && !markets.data);

  const tab: Tab = chosenTab ?? (positions.data && !positions.data.longs.length && positions.data.shorts.length ? "selling" : "positions");
  const collectable = positions.data ? readyToCollect(positions.data.longs) : null;
  const toggle = (key: string) => setExpanded((current) => current === key ? null : key);
  const cardProps = { run: writes.run, ready: writes.ready, exitReady: writes.exitReady, busy: writes.busy, fees: writes.fees };
  // Each card's market brake from /v2/markets. An unread list shuts nothing; every click re-reads the chain.
  const tradingFor = (ticker: string) => tradingOpen(markets.isError ? undefined : markets.data?.find((row) => row.ticker === ticker));
  const rollerAskIds = positions.data ? rollerPlacedAskIds(positions.data.orders, positions.data.strategies) : new Set<string>();
  const counts = positions.data ? { longs: positions.data.longs.length, shorts: positions.data.shorts.length, orders: positions.data.orders.length } : null;
  const badge = (count: number | undefined) => count ? count : undefined;

  if (!address) return <>
    <PortfolioHeader />
    <PortfolioDisconnected />
  </>;

  const payoutPreference = <Panel as="section" pad="sm" aria-labelledby="payout-pref-title" className="flex flex-col gap-3">
    <h2 id="payout-pref-title" className="flex items-center gap-1.5 text-[15px] font-bold">Payout preference <InfoTip
      label="About payout preference">{payoutPreferenceHelp(anyPuts)}</InfoTip></h2>
    {chainPrefs ? <>
      <div role="group" aria-label="Payout preference" className="flex rounded-pill border border-line-2 bg-field p-[3px]">
        <Button size="sm" className="flex-1 aria-pressed:disabled:cursor-default aria-pressed:disabled:opacity-100" variant={!chainPrefs.inKind ? "select" : "quiet"} aria-pressed={!chainPrefs.inKind}
          disabled={!writes.exitReady || Boolean(writes.busy) || !chainPrefs.inKind} onClick={() => void writes.run("payout-usdg", "USDG payout selected", async (ctx) => {
            assertPayoutPrefsMatch(chainPrefs, await readPayoutPrefs(ctx.account));
            await setPayoutInKind(ctx, false);
          }, false)}>USDG</Button>
        <Button size="sm" className="flex-1 aria-pressed:disabled:cursor-default aria-pressed:disabled:opacity-100" variant={chainPrefs.inKind ? "select" : "quiet"} aria-pressed={chainPrefs.inKind}
          disabled={!writes.exitReady || Boolean(writes.busy) || chainPrefs.inKind} onClick={() => void writes.run("payout-stock", "Stock Token payout selected", async (ctx) => {
            assertPayoutPrefsMatch(chainPrefs, await readPayoutPrefs(ctx.account));
            await setPayoutInKind(ctx, true);
          }, false)}>Stock Tokens</Button></div>
      <p className="text-[12.5px] text-ink-3">Paid to your {chainPrefs.toLedger ? "Stonkhouse balance" : "wallet"}.</p></>
      : <p role="status" className="text-sm text-ink-2">{payoutPrefs.isError
        ? "Payout choice unavailable. Collecting waits until it loads."
        : "Checking your payout choice…"}</p>}
  </Panel>;

  const collectCard = collectable && collectable.positions > 0
    ? <CollectPayoutCard collectable={collectable} onCollect={() => {
      setTab("positions");
      const first = positions.data?.longs.find((long) => longPositionRow(long).action === "Collect");
      if (first) setExpanded(`long-${first.series.longId}`);
    }} />
    : <Panel as="section" pad="sm" aria-labelledby="ready-collect-title" className="flex flex-col gap-1.5">
      <h2 id="ready-collect-title" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-3">Ready to collect <InfoTip
        label="About collecting">Settled options with a payout show here, with one button to collect them.</InfoTip></h2>
      <p className="num text-[26px] font-semibold leading-tight">0 <small className="text-[13px] font-medium text-ink-3">USDG</small></p>
      <p className="text-[13px] text-ink-3">{positions.data ? "Nothing to collect yet." : "Checking your settled positions…"}</p>
    </Panel>;

  const status = (text: string) => <Panel role="status" className="text-sm text-ink-2">{text}</Panel>;
  const expandedArea = "border-t border-line bg-field px-4 py-5 sm:px-5";

  const optionsPanel = !positions.data
    ? status(positions.isPending ? "Loading your positions…" : "Positions are unavailable right now.")
    : <div className="flex flex-col gap-4">
      {positions.isError ? <Notice tone="warn">Showing saved positions.</Notice> : null}
      <Panel pad="none" className="overflow-hidden">
        {positions.data.longs.length === 0
          ? <EmptyState title="No options held." action={<Button href="/" size="sm" variant="secondary">Explore options</Button>} />
          : <div className="divide-y divide-line">{positions.data.longs.map((item) => { const key = `long-${item.series.longId}`; return <div key={key}>
            <LongPositionRowView position={item} now={now} open={expanded === key} onToggle={() => toggle(key)} />
            {expanded === key ? <div className={expandedArea}><LongCard position={item} history={historyItems} now={now ?? 0} account={address} payoutPrefs={chainPrefs} trading={tradingFor(item.series.ticker)}
              {...cardProps} resaleFeeBps={writes.config.data?.fees.resaleFeeBps ?? 0}
              pendingFees={writes.config.data?.pendingFees ?? null} withdrawalTiming={writes.config.data?.constants ?? null} /></div> : null}
          </div>; })}</div>}
      </Panel>
    </div>;

  const withdrawnAsks = positions.data?.strategies.filter((row) => row.lastStaleCancelAt && row.currentSeries && !row.orderId) ?? [];
  const sellingPanel = !positions.data
    ? status(positions.isPending ? "Loading your positions…" : "Positions are unavailable right now.")
    : <div className="flex flex-col gap-5">
      {positions.isError ? <Notice tone="warn">Showing saved positions.</Notice> : null}
      {positions.data.shorts.length ? <Panel pad="none" className="overflow-hidden"><div className="divide-y divide-line">
        {positions.data.shorts.map((item) => { const key = `short-${item.series.longId}`; return <div key={key}>
          <ShortPositionRowView position={item} now={now} open={expanded === key} onToggle={() => toggle(key)} />
          {expanded === key ? <div className={expandedArea}><ShortCard position={item} history={historyItems} now={now ?? 0} payoutPrefs={chainPrefs} trading={tradingFor(item.series.ticker)}
            spot={spots.get(item.series.ticker) ?? null} account={address} usdg={usdg} {...cardProps} /></div> : null}
        </div>; })}</div></Panel>
        : !autoPriced.length && !pricingIdentityLoading ? <Panel pad="none"><EmptyState title="No options written yet."
          action={<Button href="/sell" size="sm" variant="secondary">Sell options</Button>} /></Panel> : null}
      {pricingIdentityLoading ? status("Loading auto-priced asks…")
        : pricingIdentityUnreadable ? <Notice tone="warn" role="status" title="Auto-priced asks unavailable">
          Strategy pricing could not be read. Try again shortly.
        </Notice>
          : autoPriced.length ? <section className="flex flex-col gap-3" aria-labelledby="auto-priced-asks-title">
            <h2 id="auto-priced-asks-title" className="flex items-center gap-1.5 text-[15px] font-bold">Auto-priced asks <InfoTip
              label="About auto-priced asks">The live price, fair estimate, band and repricing state of your auto-roll asks.</InfoTip></h2>
            {pricingDataUnavailable ? <Notice tone="warn" role="status">Showing saved strategy data.</Notice> : null}
            <div className="grid gap-4 xl:grid-cols-2">{autoPriced.map((row) => <AutoPricedAskCard
              key={`${row.writer}:${row.underlying}`} row={row} pricerAvailable={pricerAvailable}
              dataUnavailable={pricingDataUnavailable} />)}</div>
          </section> : null}
      {withdrawnAsks.map((row) => <Notice key={row.ticker} tone="info" role="status" title="Ask withdrawn">
        {row.ticker} ${row.currentSeries!.strike.formatted} ask was pulled when the price hit {row.staleSpot ? withDollar(displayPrice(BigInt(row.staleSpot.raw), row.staleSpot.decimals)) : "—"} on <Time at={row.lastStaleCancelAt!} />. The next roll is after <Time at={row.currentSeries!.expiry} market />.
      </Notice>)}
    </div>;

  const ordersPanel = !positions.data
    ? status(positions.isPending ? "Loading your orders…" : "Orders are unavailable right now.")
    : positions.data.orders.length ? <Panel pad="none" className="overflow-hidden"><div className="divide-y divide-line">{positions.data.orders.map((order) =>
      <OrderCard key={order.orderId} order={order} rollerPlaced={rollerAskIds.has(order.orderId)} usdg={usdg} account={address} fees={writes.fees} now={now ?? 0} trading={tradingFor(order.series.ticker)}
        resaleFeeBps={writes.config.data?.fees.resaleFeeBps ?? 0} run={writes.run} ready={writes.ready}
        exitReady={writes.exitReady} busy={writes.busy} pendingFees={writes.config.data?.pendingFees ?? null} />)}</div></Panel>
      : <Panel pad="none"><EmptyState title="No open orders." /></Panel>;

  const historyPanel = !history.data ? status(history.isPending ? "Loading your history…" : "History is unavailable right now.")
    : <div className="flex flex-col gap-4">
      {history.isError ? <Notice tone="warn">Showing saved activity.</Notice> : null}
      <Panel pad="none" className="overflow-hidden"><HistoryRows items={historyItems} address={address} usdgAddress={usdg} /></Panel>
      {history.hasNextPage ? <div className="text-center"><Button variant="ghost" disabled={history.isFetchingNextPage}
        onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading…" : "Load older activity"}</Button></div> : null}
    </div>;

  // Only the open tab mounts: order cards poll the book and chain clock.
  const views: TabItem<Tab>[] = [
    { value: "positions", label: "Options", badge: badge(counts?.longs), panel: tab === "positions" ? optionsPanel : null },
    { value: "selling", label: "Selling", badge: badge(counts?.shorts), panel: tab === "selling" ? sellingPanel : null },
    { value: "orders", label: "Orders", badge: badge(counts?.orders), panel: tab === "orders" ? ordersPanel : null },
    { value: "history", label: "History", panel: tab === "history" ? historyPanel : null },
  ];

  const notices = [
    !writes.ready ? <Notice key="ready" tone="info" role="status">{mismatch.length
      ? "Trading is paused: the app and indexer settings differ."
      : "Trading opens once your wallet and market data are ready."}</Notice> : null,
    writes.success ? <Notice key="success" tone="accent" role="status">{writes.success}. Your portfolio updates shortly.</Notice> : null,
  ];

  const hasNotices = notices.some(Boolean) || owedBanner(owed.data) !== null || queueCards.length > 0
    || held.cards.length > 0 || held.status !== null;
  return <div className="pb-6">
    <PortfolioHeader address={address} />
    <div className={`flex flex-col gap-4 ${hasNotices ? "mb-5" : ""}`}>
      {notices}
      <OwedBanner model={owedBanner(owed.data)} canAct={writes.exitReady} busy={Boolean(writes.busy)}
        onClaim={() => void writes.run("claim-owed", "Order book balance claimed", async (ctx) => { await claimOrderBookOwed(ctx); }, false)} />
      <PortfolioLendRequests queueCards={queueCards} held={held} canAct={writes.exitReady} busy={Boolean(writes.busy)}
        onCancel={(card) => void writes.run(`cancel-queued-${card.key}`,
          card.kind === "deposit" ? "Queued deposit cancelled" : "Queued withdrawal cancelled", async (ctx) => {
            if (card.cancelId === null) throw new Error("This request has no queue id to cancel.");
            await cancelQueuedRequest(ctx, card.cancelId);
          }, false)}
        onClaim={(card, to) => void writes.run(`claim-held-${card.key}`, `Held payment #${card.held.id} claimed`, async (ctx) => {
          await claimDeferredPayment(ctx, card.held.id, to);
        }, false)} />
    </div>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-6">
      <Panel as="section" aria-label="Performance" className="order-2 flex flex-col gap-5 lg:order-none lg:col-start-1 lg:row-start-1">
        <PortfolioHero items={historyItems} realisedUsdg={summary.realisedUsdg} period={period} onPeriod={setPeriod} now={now} />
        {history.data ? <HistorySummaryPanel summary={summary} complete={!history.hasNextPage} stale={history.isError}
          onHistory={() => setTab("history")} anyPuts={anyPuts} /> : <p role="status" className="border-t border-line pt-4 text-sm text-ink-3">{history.isPending
          ? "Loading your history…" : "History is unavailable right now."}</p>}
      </Panel>
      <div className="order-3 min-w-0 lg:order-none lg:col-start-1 lg:row-start-2">
        <Tabs label="Portfolio views" items={views} value={tab} onChange={setTab} className="max-sm:[&_[role=tab]]:px-1.5" />
      </div>
      <aside aria-label="Payouts" className={`${collectable && collectable.positions > 0 ? "order-1" : "order-4"} flex min-w-0 flex-col gap-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start`}>
        {collectCard}
        {positions.data ? <Ledger rows={positions.data.ledger} run={writes.run} exitReady={writes.exitReady} busy={writes.busy} /> : null}
        {payoutPreference}
      </aside>
    </div>
  </div>;
}
