"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { ConversionFloor } from "@/components/v2/ConversionFloor";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { publicClient, txUrl } from "@/lib/chain";
import { clearinghouseAbi } from "@/lib/abi/v2/clearinghouse";
import { orderBookAbi } from "@/lib/abi/v2/orderBook";
import type { AccountOrder, ConfigResponse, HistoryItem, LongPosition, Market, ShortPosition } from "@/lib/v2/api-types";
import { v2Api } from "@/lib/v2/api";
import { V2_DEPLOYMENT, requireV2Address, v2ConfigWarnings } from "@/lib/v2/config";
import { assertPortfolioSeries, assertPayoutPrefsMatch, assertSeriesTermsMatch, readAccountOnChain, readOrderPreflight,
  readPayoutPrefs, readSeriesOnChain, type PayoutPrefs } from "@/lib/v2/chainReads";
import { useBook, useConfig, useFair, useMarkets, usePositions, v2Keys } from "@/lib/v2/hooks";
import { readWriterRent } from "@/lib/v2/earnTx";
import { shortIdOf } from "@/lib/v2/seriesId";
import { sharesToUnits, type TakerFeeParams } from "@/lib/v2/payoff";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";
import { expiryCountdown, orderIdentityMatches, payoffSentence, positionOutcome, quoteSell, splitResale, verifySellOrders,
  type SellQuote } from "@/lib/v2/portfolio";
import { safeBuyQuote, staleSelectedOrders } from "@/lib/v2/ticket";
import { approveExact, cancel, close, place, redeem, replace, setPayoutInKind, setTokenApproval,
  recheckTakeQuote, take, withdraw, type WriteContext } from "@/lib/v2/tx";
import { V2ConfirmedStepError } from "@/lib/v2/txStatus";

type Tab = "positions" | "orders" | "history";
type Run = (id: string, title: string, work: (context: WriteContext) => Promise<void>, requireTrade?: boolean) => Promise<void>;
const tabs: readonly { id: Tab; label: string }[] = [
  { id: "positions", label: "Positions" }, { id: "orders", label: "Orders" }, { id: "history", label: "History" },
];
const date = (unix: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
  .format(new Date(unix * 1000));
const label = (ticker: string, strike: string, put: boolean) => `${ticker} $${strike} ${put ? "put" : "call"}`;
const parsePrice = (value: string): bigint => {
  const price = parseUnits(value, 6);
  if (price <= 0n || price % 100n !== 0n) throw new Error("Price must be positive in 0.0001 USDG ticks.");
  return price;
};
const tryUnits = (value: string): bigint | null => { try { return sharesToUnits(value); } catch { return null; } };
const feesFrom = (config: ReturnType<typeof useConfig>["data"]): TakerFeeParams | null => config ? {
  takerFeeFlat: BigInt(config.fees.takerFeeFlat.raw), takerFeeCapBps: config.fees.takerFeeCapBps,
} : null;

async function executeSellQuote(context: WriteContext, quote: SellQuote, longId: bigint, underlying: Address, resaleFeeBps: number) {
  if (!quote.limitPrice || quote.filled <= 0n) throw new Error("No live bids are selected.");
  const ids = quote.orderIds.map(BigInt);
  const current = await readOrderPreflight(ids, underlying);
  if (!verifySellOrders(quote, current.map((row) => ({ orderId: row.orderId, ...row.order })),
    longId, Math.floor(Date.now() / 1000)))
    throw new Error("A bid changed. Refresh the book and review the new proceeds.");
  const takeRequest = { longId, buying: false, orderIds: ids, units: quote.filled, minUnits: quote.filled,
    limitPrice: quote.limitPrice, writeToSell: false, recipient: context.account,
  };
  const params = await recheckTakeQuote(context, takeRequest,
    { filled: quote.filled, premium: quote.premium, fee: quote.fee, resaleFeeBps });
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
      notice("pending", title, "Review each transaction in your wallet. The chain is rechecked before sending.");
      await work(context);
      setSuccess(title);
      notice("success", title, "Confirmed on chain. Your portfolio will refresh shortly.");
      await client.invalidateQueries({ queryKey: v2Keys.all });
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${title} stopped`, error instanceof Error ? error.message : "The transaction could not be completed.");
    } finally { setBusy(null); }
  };
  return { run, ready, exitReady, busy, success, config, fees: feesFrom(config.data) };
}

function LongCard({ position, history, now, account, payoutPrefs, run, ready, exitReady, busy, fees, resaleFeeBps, pendingFees }: {
  position: LongPosition; history: HistoryItem[]; now: number; account: Address;
  payoutPrefs: PayoutPrefs | null;
  run: Run; ready: boolean; exitReady: boolean; busy: string | null; fees: TakerFeeParams | null; resaleFeeBps: number;
  pendingFees: ConfigResponse["pendingFees"];
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
  const outcome = positionOutcome(position, "long", history, now, walletBalance.data);
  const units = tryUnits(size);
  const available = walletBalance.data ?? 0n;
  const tradeable = ["open", "cutoff"].includes(position.series.status) && now < position.series.expiry;
  const quote = useMemo(() => book.data && units && fees ? quoteSell(book.data.bids, units, fees,
    resaleFeeBps, account) : null,
    [book.data, units, fees, account, resaleFeeBps]);
  const fairPrice = fair.data?.fair ? fair.data.fair.formatted : null;
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
    await approval(context, units);
    await executeSellQuote(context, quote, BigInt(longId), getAddress(position.series.underlying), resaleFeeBps);
  }

  async function list(context: WriteContext) {
    if (!units || units > available || !tradeable || !book.data || !fees) throw new Error("Choose an open position with a live book and a valid size.");
    const price = parsePrice(listingPrice);
    const crossing = splitResale(book.data.bids, units, price, fees, resaleFeeBps, account);
    await approval(context, units);
    const expiry = Math.min(position.series.expiry - 1, Math.floor(Date.now() / 1000) + 86_400);
    if (expiry <= Math.floor(Date.now() / 1000)) throw new Error("This option is too close to expiry to list.");
    if (crossing.crossing.filled > 0n)
      await executeSellQuote(context, crossing.crossing, BigInt(longId), getAddress(position.series.underlying), resaleFeeBps);
    if (crossing.restingUnits > 0n) {
      try { await place(context, BigInt(longId), 1, price, crossing.restingUnits, expiry); }
      catch (error) { throw crossing.crossing.filled > 0n
        ? new V2ConfirmedStepError(`The immediate sale confirmed, but the remaining ask was not listed. Review Portfolio before retrying. ${error instanceof Error ? error.message : ""}`,
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

  return <Panel as="article" className="min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-ink-2">Long position</p>
      <h3 className="mt-1 font-display text-xl font-bold">{label(position.series.ticker, position.series.strike.formatted, position.series.isPut)}</h3>
      <p className="mt-1 text-sm text-ink-2">{date(position.series.expiry)} · {now ? expiryCountdown(position.series.expiry, now) : "Checking expiry…"}</p></div>
      <span className="num rounded-sm bg-accent-soft px-3 py-1.5 font-bold text-accent-text">{formatShares(BigInt(position.units))} shares held or listed</span></div>
    <p className="mt-4 text-sm">{payoffSentence(position)}</p>
    {!position.series.isPut ? <ConversionFloor underlying={position.series.underlying} /> : null}
    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-ink-3">Average cost</dt><dd className="num font-semibold">{position.avgCost.formatted} USDG</dd></div>
      <div><dt className="text-ink-3">Mark (best bid / fair)</dt><dd className="num font-semibold">{position.mark?.formatted ?? "—"} {position.mark ? "USDG" : ""}</dd></div>
      <div><dt className="text-ink-3">Unrealised P&amp;L</dt><dd className="num font-semibold">{position.unrealised?.formatted ?? "—"} {position.unrealised ? "USDG" : ""}</dd></div>
    </dl>
    <p className="mt-4 text-sm font-semibold">{outcome.label}</p>
    {walletBalance.data !== undefined && available < BigInt(position.units) ? <p className="mt-1 text-xs text-ink-2">{formatShares(available)} shares are available in your wallet; listed shares are in the OrderBook until filled or cancelled.</p> : null}
    {walletBalance.isError ? <p role="status" className="mt-1 text-xs text-danger">Wallet balance is unavailable. Actions are paused until the chain responds.</p> : null}
    {tradeable ? <div className="mt-5 border-t border-line pt-4">
      <label className="block text-sm font-semibold" htmlFor={`sell-size-${longId}`}>Size in shares</label>
      <input id={`sell-size-${longId}`} inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)}
        className="num mt-2 min-h-11 w-full max-w-44 rounded-sm border border-line-2 bg-surface px-3" />
      {walletBalance.data !== undefined && (!units || units > available) ? <p role="alert" className="mt-1 text-xs text-danger">Choose up to {formatShares(available)} wallet shares in 0.01 steps.</p> : null}
      <p className="mt-2 text-sm text-ink-2">{quote?.filled === units && units ? `Current bid estimate: ${formatUsdg(quote.net)} USDG after taker and resale fees.`
        : book.isError ? "Bid depth is unavailable. Try again when the book recovers." : "No bids cover this size; you can list at your price."}</p>
      {pendingFees ? <PendingFeeNotice className="mt-3" effectiveAt={pendingFees.effectiveAt} nextFees={pendingFees}
        kind={listing ? "resale" : "resaleImmediate"} /> : null}
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!ready || Boolean(busy) || walletBalance.data === undefined || !units || units > available || quote?.filled !== units}
        onClick={() => void run(`${key}-sell`, "Sell confirmed", sellNow)}>Sell now</Button>
        <Button size="sm" variant="ghost" disabled={!ready || Boolean(busy)} onClick={() => setListing((value) => !value)}>List for sale</Button></div>
      {listing ? <div className="mt-4 rounded-sm bg-surface-2 p-4"><label htmlFor={`list-price-${longId}`} className="block text-sm font-semibold">Ask price per share (USDG)</label>
        <input id={`list-price-${longId}`} inputMode="decimal" value={listingPrice} onChange={(event) => setListingPrice(event.target.value)} placeholder={fairPrice ?? "0.25"}
          className="num mt-2 min-h-11 w-full max-w-44 rounded-sm border border-line-2 bg-surface px-3" />
        <p className="mt-1 text-xs text-ink-3">{fairPrice ? `Fair-value guideline: ${fairPrice} USDG. ` : "Fair value is unavailable. "}An ask may not fill; options can expire worthless.</p>
        {split ? <p className="mt-2 text-xs text-ink-2">{formatShares(split.crossing.filled)} shares may sell immediately into bids; {formatShares(split.restingUnits)} shares will rest at your ask. Each step needs a wallet confirmation.</p> : null}
        <Button className="mt-3" size="sm" disabled={!ready || Boolean(busy) || !book.data || !split || walletBalance.data === undefined || !units || units > available}
          onClick={() => void run(`${key}-list`, "Resale order submitted", list)}>Sell crossing bids and list remainder</Button></div> : null}
    </div> : null}
    {outcome.collect ? <Button className="mt-4" size="sm" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !payoutPrefs}
      onClick={() => void run(`${key}-collect`, "Payout collected", collect, false)}>Collect</Button> : null}
    {outcome.withdraw ? <p className="mt-2 text-sm text-ink-2">Withdraw from the Stonkhouse balance below.</p> : null}
  </Panel>;
}

function ShortCard({ position, history, now, spot, account, usdg, payoutPrefs, run, ready, exitReady, busy, fees }: {
  position: ShortPosition; history: HistoryItem[]; now: number; spot: Market["spot"] | null;
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
  const open = ["open", "cutoff"].includes(position.series.status) && now < position.series.expiry;
  const closeAllowed = position.series.status !== "settled";
  const closeRefund = useQuery({ queryKey: ["v2", "close-refund", longId, units?.toString()],
    enabled: Boolean(units && closeAllowed && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => publicClient.readContract({ address: requireV2Address("clearinghouse"), abi: clearinghouseAbi,
      functionName: "closeRefund", args: [BigInt(longId), units!] }), staleTime: 10_000, refetchInterval: 10_000 });
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
    const expected = { filled: units, premium: quote.buy.premium, fee: quote.buy.fee };
    await recheckTakeQuote(context, takeRequest, expected);
    await approveExact(context, usdg, requireV2Address("orderBook"), expected.premium + expected.fee);
    const params = await recheckTakeQuote(context, takeRequest, expected);
    await take(context, params);
    try { await close(context, BigInt(longId), units); }
    catch (error) { throw new V2ConfirmedStepError(`The buyback completed, but close did not. Your new long units remain in Portfolio; use Close matched units. ${error instanceof Error ? error.message : ""}`,
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

  return <Panel as="article">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-ink-2">Written option · short note</p>
      <h3 className="mt-1 font-display text-xl font-bold">{label(position.series.ticker, position.series.strike.formatted, position.series.isPut)}</h3>
      <p className="mt-1 text-sm text-ink-2">{date(position.series.expiry)} · {now ? expiryCountdown(position.series.expiry, now) : "Checking expiry…"}</p></div>
      <span className="num rounded-sm bg-surface-2 px-3 py-1.5 font-semibold">{formatShares(BigInt(position.units))} shares</span></div>
    <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-ink-3">Premium received</dt><dd className="num font-semibold">{position.premiumReceived.formatted} USDG</dd></div>
      <div><dt className="text-ink-3">Collateral locked</dt><dd className="num font-semibold">{position.collateralLocked.formatted} {position.series.isPut ? "USDG" : position.series.ticker}</dd></div>
      <div><dt className="text-ink-3">Moneyness now</dt><dd className="font-semibold">{inMoney === null ? "Spot unavailable" : inMoney ? "In the money" : "Out of the money"}</dd></div>
    </dl>
    <p className="mt-3 text-xs text-ink-3">Premium is shown in USDG before writer rent and gas. This series pins writer rent at {position.series.mintFeePpm} ppm per week, charged in {position.series.isPut ? "USDG" : position.series.ticker + " Stock Tokens"}. Rent is shown separately in activity.</p>
    <p className="mt-4 text-sm text-ink-2">This note can be transferred. Buying back matching long units and closing returns collateral and unused rent to whoever closes before expiry; the buy and close are two separate transactions.</p>
    <p className="mt-3 text-sm font-semibold">{outcome.label}</p>
    {open || closeAllowed ? <div className="mt-5 border-t border-line pt-4"><label htmlFor={`buyback-size-${longId}`} className="block text-sm font-semibold">Size to close in shares</label>
      <input id={`buyback-size-${longId}`} inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)}
        className="num mt-2 min-h-11 w-full max-w-44 rounded-sm border border-line-2 bg-surface px-3" />
      {!units || units > available ? <p role="alert" className="mt-1 text-xs text-danger">Choose up to {formatShares(available)} shares in 0.01 steps.</p> : null}
      {open ? <p className="mt-2 text-sm text-ink-2">{quote?.buy.filledUnits === units && units
        ? `Buyback estimate: ${formatUsdg(quote.buy.cost)} USDG including taker fee.`
        : book.isError ? "Ask depth is unavailable right now." : "No asks cover this size. You can close if you already hold matching longs."}</p>
        : <p className="mt-2 text-sm text-ink-2">Trading ended at expiry. If you already hold matching long units, you can still close before settlement.</p>}
      <p className="mt-2 text-xs text-ink-3">Unused rent refund if closed now: {closeRefund.data !== undefined && !closeRefund.isError ? `${formatUnits(closeRefund.data, position.series.isPut ? 6 : 18)} ${position.series.isPut ? "USDG" : position.series.ticker}` : "unavailable"}. The refund decreases with time and credits your free Stonkhouse balance. No rent is refunded at or after expiry.</p>
      <div className="mt-3 flex flex-wrap gap-2">{open ? <Button size="sm" disabled={!ready || Boolean(busy) || walletBalance.data === undefined || !units || units > available || quote?.buy.filledUnits !== units || !usdg}
        onClick={() => void run(`${key}-buyback`, "Buyback and close confirmed", buyBack)}>Buy back and close</Button> : null}
        <Button size="sm" variant="ghost" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !units || units > available}
          onClick={() => void run(`${key}-close`, "Matched position closed", closeMatched, false)}>Close matched units</Button></div>
    </div> : null}
    {outcome.collect ? <Button size="sm" className="mt-4" disabled={!exitReady || Boolean(busy) || walletBalance.data === undefined || !payoutPrefs}
      onClick={() => void run(`${key}-collect`, "Payout collected", collect, false)}>Collect</Button> : null}
  </Panel>;
}

function OrderCard({ order, usdg, account, fees, resaleFeeBps, pendingFees, now, run, ready, exitReady, busy }: {
  order: AccountOrder; usdg: Address | null; account: Address; fees: TakerFeeParams | null;
  resaleFeeBps: number; pendingFees: ConfigResponse["pendingFees"];
  now: number; run: Run; ready: boolean; exitReady: boolean; busy: string | null;
}) {
  const [editing, setEditing] = useState(false);
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
    const current = await currentOrder(context);
    await assertPortfolioSeries(order.series);
    if (current.validUntil <= Math.floor(Date.now() / 1000)) throw new Error("This order expired. Cancel it or place a new one.");
    if (current.price !== BigInt(order.price.raw) || current.units - current.filled !== remaining)
      throw new Error("The order changed. Refresh before editing it.");
    const units = sharesToUnits(size);
    if (units <= 0n) throw new Error("Choose a positive size in 0.01-share steps.");
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
        await executeSellQuote(context, crossing.crossing, BigInt(order.series.longId), getAddress(order.series.underlying), resaleFeeBps);
        immediateSaleConfirmed = true;
        if (crossing.restingUnits > 0n)
          await place(context, BigInt(order.series.longId), 1, newPrice, crossing.restingUnits, current.validUntil);
      } catch (error) {
        throw new V2ConfirmedStepError(`The old order was cancelled; any confirmed sale remains final. Review Portfolio before retrying the rest. ${error instanceof Error ? error.message : ""}`,
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
      if (rent.free === null || rent.free < collateral + rent.rent) throw new Error("Deposit enough free collateral for the replacement size and writer rent.");
    }
    await replace(context, BigInt(order.orderId), newPrice, units);
  }

  return <Panel as="article">
    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-display text-lg font-bold">{label(order.series.ticker, order.series.strike.formatted, order.series.isPut)}</h3>
      <p className="mt-1 text-sm text-ink-2">{order.kind === "Bid" ? "Bid" : order.kind === "AskResale" ? "Resale ask" : "Writer ask"} #{order.orderId} · {now && order.validUntil <= now ? "Expired; cancel to recover escrow" : `valid until ${date(order.validUntil)}`}</p></div>
      <p className="num font-semibold">{formatShares(remaining)} shares at {order.price.formatted} USDG</p></div>
    <p className="mt-2 text-sm text-ink-2">{formatShares(BigInt(order.filled))} shares filled.</p>
    <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={!exitReady || Boolean(busy)} onClick={() => void run(`${key}-cancel`, "Order cancelled", cancelOrder, false)}>Cancel</Button>
      <Button size="sm" variant="ghost" disabled={!ready || Boolean(busy) || !now || order.validUntil <= now} onClick={() => setEditing((value) => !value)}>Edit price and size</Button></div>
    {editing ? <div className="mt-4 flex flex-wrap items-end gap-3 rounded-sm bg-surface-2 p-4">
      {order.kind === "AskResale" && pendingFees ? <PendingFeeNotice className="w-full"
        effectiveAt={pendingFees.effectiveAt} nextFees={pendingFees} kind="resale" /> : null}
      <label className="text-sm font-semibold">Price per share (USDG)<input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)}
        className="num mt-2 block min-h-11 w-36 rounded-sm border border-line-2 bg-surface px-3" /></label>
      <label className="text-sm font-semibold">Remaining size (shares)<input inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)}
        className="num mt-2 block min-h-11 w-36 rounded-sm border border-line-2 bg-surface px-3" /></label>
      <Button size="sm" disabled={!ready || Boolean(busy)} onClick={() => void run(`${key}-edit`, "Order replaced", editOrder)}>Save replacement</Button>
      <p className="w-full text-xs text-ink-3">{split?.crossing.filled
        ? `${formatShares(split.crossing.filled)} shares may sell into bids now; ${formatShares(split.restingUnits)} will rest. This cancels the old order first and may require multiple confirmations.`
        : "A replacement cancels the old order and receives a new ID."}</p>
    </div> : null}
  </Panel>;
}

function Ledger({ rows, run, exitReady, busy }: { rows: { asset: string; symbol: string; free: { raw: string; formatted: string } }[];
  run: Run; exitReady: boolean; busy: string | null }) {
  if (!rows.length) return null;
  return <Panel as="section" className="mt-5"><h2 className="font-display text-xl font-bold">Stonkhouse balances</h2>
    <p className="mt-1 text-sm text-ink-2">Free assets held in your Clearinghouse balance. Withdraw sends the on-chain free amount to your wallet.</p>
    <ul className="mt-4 space-y-3">{rows.map((row) => <li key={row.asset} className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <span className="num font-semibold">{row.free.formatted} {row.symbol}</span>
      <Button variant="ghost" size="sm" disabled={!exitReady || Boolean(busy) || BigInt(row.free.raw) === 0n}
        onClick={() => void run(`withdraw-${row.asset}`, "Balance withdrawn", async (context) => {
          const asset = getAddress(row.asset);
          const free = await publicClient.readContract({ address: requireV2Address("clearinghouse"),
            abi: clearinghouseAbi, functionName: "free", args: [context.account, asset] });
          if (free <= 0n) throw new Error("No free balance remains on chain. Refresh Portfolio.");
          await withdraw(context, asset, free);
        }, false)}>Withdraw</Button></li>)}</ul>
  </Panel>;
}

function HistoryRows({ items }: { items: HistoryItem[] }) {
  const { address } = useAccount();
  if (!items.length) return <Panel><p className="text-ink-2">No activity has been recorded for this wallet yet.</p></Panel>;
  return <ol className="space-y-3">{items.map((item) => {
    const pnl = "realisedPnl" in item.data ? item.data.realisedPnl : null;
    const win = pnl && BigInt(pnl.raw) > 0n && item.longId;
    const amount = "amount" in item.data ? item.data.amount.formatted : "premium" in item.data ? item.data.premium.formatted : null;
    return <li key={item.id}><Panel as="article" pad="sm" className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs text-ink-3">{date(item.ts)}</p><h3 className="mt-1 font-semibold capitalize">{item.kind}</h3>
        {item.kind === "redemption" ? <p className="mt-1 text-xs font-bold text-accent-text">
          {BigInt(item.data.amount.raw) > 0n ? "Paid" : "Expired without payout"}</p> : null}
        {item.series ? <p className="mt-1 text-sm text-ink-2">{label(item.series.ticker, item.series.strike.formatted, item.series.isPut)}</p> : null}
        {item.kind === "mint" ? <p className="mt-1 text-sm text-ink-2">Writer rent charged on this mint: {item.data.fee.formatted} {item.data.fee.decimals === 6 ? "USDG" : item.series?.ticker ?? "Stock Tokens"}</p> : null}
        {item.kind === "close" ? <p className="mt-1 text-sm text-ink-2">Unused rent refunded: {item.data.feeRefund.formatted} {item.series?.isPut ? "USDG" : item.series?.ticker ?? "Stock Tokens"}</p> : null}
        {pnl ? <p className={`num mt-2 text-sm font-semibold ${BigInt(pnl.raw) >= 0n ? "text-accent-text" : "text-danger"}`}>{item.kind === "redemption" && item.data.side === "short" ? "Realised P&L before writer rent" : "Realised P&L"}: {pnl.formatted} USDG</p> : null}</div>
      <div className="text-right"><p className="num text-sm font-semibold">{amount ? `${amount} ${item.kind === "redemption" && item.data.amount.decimals !== 6 ? item.series?.ticker ?? "tokens" : "USDG"}` : ""}</p>
        <div className="mt-2 flex flex-wrap justify-end gap-2"><Button size="xs" variant="ghost" href={txUrl(item.data.tx)}>View transaction</Button>
          {win && address && item.longId ? <Button size="xs" variant="ghost" href={`/pnl/${item.longId}-${address.toLowerCase()}`}>Share win</Button> : null}</div></div>
    </Panel></li>;
  })}</ol>;
}

export function Portfolio() {
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("positions");
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick();
    const timer = window.setInterval(tick, 30_000); return () => window.clearInterval(timer); }, []);
  const positions = usePositions(address);
  const markets = useMarkets();
  const history = useInfiniteQuery({ queryKey: ["v2", "portfolio-history", address?.toLowerCase()], enabled: Boolean(address),
    queryFn: ({ pageParam, signal }) => v2Api.getHistory(address!, { limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000, refetchInterval: 15_000 });
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? [];
  const writes = usePortfolioWrites(address);
  const payoutPrefs = useQuery({ queryKey: ["v2", "payoutPrefs", address?.toLowerCase()],
    enabled: Boolean(address && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readPayoutPrefs(address!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const chainPrefs = payoutPrefs.isError ? null : payoutPrefs.data ?? null;
  const usdg = writes.config.data ? getAddress(writes.config.data.usdg.address) : null;
  const spots = new Map((markets.isError ? undefined : markets.data)?.map((market) => [market.ticker, market.spot]) ?? []);
  const mismatch = writes.config.data ? v2ConfigWarnings(writes.config.data) : [];

  return <>
    <PageHead eyebrow="Your account" title="Portfolio" lede="Hold or sell a position, manage orders, and collect settled payouts." />
    {!address ? <Panel><p className="mb-4 text-ink-2">Connect a wallet to see your positions.</p><ConnectButton /></Panel> : <>
      {!writes.ready ? <Notice tone="info" role="status" className="mb-5">{mismatch.length
        ? "App and indexer deployment settings differ. Trading is paused until they match."
        : "Trading opens when the v2 indexer, contracts and wallet are ready. Payout choices, claims and withdrawals only need the wallet and contracts."}</Notice> : null}
      {writes.success ? <Notice tone="accent" role="status" className="mb-5">{writes.success}. Portfolio data refreshes after the indexer catches up.</Notice> : null}
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Portfolio views">
        {tabs.map(({ id, label: text }) => <Button key={id} variant={tab === id ? "primary" : "ghost"} size="sm"
          aria-pressed={tab === id} onClick={() => setTab(id)}>{text}</Button>)}
      </div>
      <div id={`portfolio-${tab}`}>
        {tab === "positions" ? <>
            <Panel as="section" className="mb-5"><h2 className="font-display text-lg font-bold">Payout preference</h2>
              <p className="mt-1 text-sm text-ink-2">For winning long calls, USDG is the default where conversion is available; otherwise Stock Tokens are paid. Puts pay USDG and short payouts return collateral. This changes future long-call redemptions.</p>
              {chainPrefs ? <><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant={!chainPrefs.inKind ? "primary" : "ghost"} aria-pressed={!chainPrefs.inKind}
                disabled={!writes.exitReady || Boolean(writes.busy) || !chainPrefs.inKind} onClick={() => void writes.run("payout-usdg", "USDG payout selected", async (ctx) => {
                  assertPayoutPrefsMatch(chainPrefs, await readPayoutPrefs(ctx.account));
                  await setPayoutInKind(ctx, false);
                }, false)}>USDG (default)</Button>
                <Button size="sm" variant={chainPrefs.inKind ? "primary" : "ghost"} aria-pressed={chainPrefs.inKind}
                  disabled={!writes.exitReady || Boolean(writes.busy) || chainPrefs.inKind} onClick={() => void writes.run("payout-stock", "Stock Token payout selected", async (ctx) => {
                    assertPayoutPrefsMatch(chainPrefs, await readPayoutPrefs(ctx.account));
                    await setPayoutInKind(ctx, true);
                  }, false)}>Stock Tokens</Button></div>
                <p className="mt-2 text-xs text-ink-2">Current destination: {chainPrefs.toLedger ? "Stonkhouse balance; withdraw below" : "wallet"}.</p></>
                : <p role="status" className="mt-3 text-sm text-ink-2">{payoutPrefs.isError
                  ? "On-chain payout choices are unavailable. Collection waits until the chain connection recovers."
                  : "Checking your on-chain payout choice. Collection waits until this read succeeds."}</p>}
            </Panel>
            {!positions.data
              ? <Panel role="status">{positions.isPending ? "Loading your positions…" : "Positions are unavailable. Try refreshing when the indexer recovers."}</Panel>
              : <>
                {positions.isError ? <Notice tone="warn" className="mb-4">Showing saved positions while the indexer recovers.</Notice> : null}
                {positions.data.longs.length + positions.data.shorts.length === 0 ? <Panel><p className="text-ink-2">No open positions for this wallet. <Button href="/" size="sm" variant="ghost">Explore options</Button></p></Panel> : <div className="grid gap-4 lg:grid-cols-2">
                  {positions.data.longs.map((item) => <LongCard key={`long-${item.series.longId}`} position={item} history={historyItems} now={now ?? 0} account={address} payoutPrefs={chainPrefs}
                    run={writes.run} ready={writes.ready} exitReady={writes.exitReady} busy={writes.busy} fees={writes.fees} resaleFeeBps={writes.config.data?.fees.resaleFeeBps ?? 0}
                    pendingFees={writes.config.data?.pendingFees ?? null} />)}
                  {positions.data.shorts.map((item) => <ShortCard key={`short-${item.series.longId}`} position={item} history={historyItems} now={now ?? 0} payoutPrefs={chainPrefs}
                    spot={spots.get(item.series.ticker) ?? null} account={address} usdg={usdg} run={writes.run} ready={writes.ready} exitReady={writes.exitReady} busy={writes.busy} fees={writes.fees} />)}
                </div>}
                {positions.data.strategies.filter((row) => row.lastStaleCancelAt && row.currentSeries && !row.orderId).map((row) => <Notice key={row.ticker} tone="info" role="status" className="mt-4" title="Ask withdrawn">
                  {row.ticker} auto-roll ask at ${row.currentSeries!.strike.formatted} was withdrawn after spot reached ${row.staleSpot?.formatted ?? "—"} on {date(row.lastStaleCancelAt!)}. Filled positions remain. The next roll waits until after {date(row.currentSeries!.expiry)}.
                </Notice>)}
                <Ledger rows={positions.data.ledger} run={writes.run} exitReady={writes.exitReady} busy={writes.busy} />
              </>}
          </>
          : tab === "orders" ? !positions.data
            ? <Panel role="status">{positions.isPending ? "Loading your orders…" : "Orders are unavailable while the indexer recovers."}</Panel>
            : positions.data.orders.length ? <div className="grid gap-4 md:grid-cols-2">{positions.data.orders.map((order) =>
              <OrderCard key={order.orderId} order={order} usdg={usdg} account={address} fees={writes.fees} now={now ?? 0}
                resaleFeeBps={writes.config.data?.fees.resaleFeeBps ?? 0} run={writes.run} ready={writes.ready}
                exitReady={writes.exitReady} busy={writes.busy} pendingFees={writes.config.data?.pendingFees ?? null} />)}</div>
              : <Panel><p className="text-ink-2">No open orders. Resting bids and asks will appear here.</p></Panel>
            : !history.data ? <Panel role="status">{history.isPending ? "Loading your history…" : "History is unavailable. Try again when the indexer recovers."}</Panel>
              : <>{history.isError ? <Notice tone="warn" className="mb-4">Showing saved activity while the indexer recovers.</Notice> : null}
                <HistoryRows items={historyItems} />
                {history.hasNextPage ? <div className="mt-5 text-center"><Button variant="ghost" disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading…" : "Load older activity"}</Button></div> : null}</>}
      </div>
    </>}
  </>;
}
