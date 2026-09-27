"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type WalletClient } from "viem";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, FieldLabel, Field, InfoTip, inputClasses, Row, Rows } from "@/components/ui";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { FairProvenanceNote } from "@/components/v2/FairProvenanceNote";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { PendingOperationsNotice } from "@/components/v2/PendingOperationsNotice";
import { usd } from "@/components/v2/trade/price";
import { cn } from "@/lib/cn";
import { displayMoney, displayQuantity } from "@/lib/numberFormat";
import type { MarketSeriesResponse } from "@/lib/v2/api-types";
import { requireV2Address, V2_DEPLOYMENT } from "@/lib/v2/config";
import { createSeries, nextAskExpiry, preflightAsk, readMintCutoff, readWriterBalance, readWriterRent } from "@/lib/v2/earnTx";
import { useFair, v2Keys } from "@/lib/v2/hooks";
import { collateralPerUnit, sharesToUnits, shortOutcome } from "@/lib/v2/payoff";
import { restingOrderTiming } from "@/lib/v2/payoutTiming";
import { retainedSharesAtExpiry, roundAskToTick, writerQuote } from "@/lib/v2/presets";
import { TRADING_PAUSED_LINE, tradingOpen } from "@/lib/v2/tradingGate";
import { approveExact, deposit, place, setOperator, type WriteContext } from "@/lib/v2/tx";
import { depositDoor } from "@/lib/v2/upgradePause";

import { useWriteGate } from "./useWriteGate";

type SeriesItem = MarketSeriesResponse["items"][number];

const money = (raw: bigint) => displayMoney(raw, 6, { maxDecimals: 4 });
const parseAskPrice = (raw: string): bigint | null => {
  try { const price = parseUnits(raw, 6); return price > 0n && price % 100n === 0n ? price : null; } catch { return null; }
};

/** The ask the seller reviewed. Pressing "Review order" records it, and "Place ask" sends exactly this: an
 * untouched price follows the live fair value (refetched every 15 s), and strike, expiry, series and side come from the
 * parent, so any of them can move while the review is open. */
export type ReviewedAsk = { price: bigint; units: bigint; strike: bigint; expiry: number; isPut: boolean; longId: string | null };

export const ASK_CHANGED_LINE = "This order changed after you reviewed it, so it cannot be placed. Press Edit and review it again.";

/** Null while the live order still matches the reviewed one; otherwise why "Place ask" is blocked. A live
 * order that cannot be sent at all (`null`) is a change too. */
export function askDrift(reviewed: ReviewedAsk, live: ReviewedAsk | null): string | null {
  if (live === null || live.price !== reviewed.price || live.units !== reviewed.units || live.strike !== reviewed.strike
    || live.expiry !== reviewed.expiry || live.isPut !== reviewed.isPut || live.longId !== reviewed.longId) return ASK_CHANGED_LINE;
  return null;
}

const EXPIRY_DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
export function expiryDay(at: number): string {
  return EXPIRY_DAY.format(new Date(at * 1_000));
}

export function SellTicket({ ticker, typeChoice = "call", row, customStrike = null, expiry, className }: {
  ticker: string;
  typeChoice?: "call" | "put";
  row: SeriesItem | null;
  customStrike?: bigint | null;
  expiry: number;
  className?: string;
}) {
  const gate = useWriteGate(ticker, typeChoice);
  const { address, wallet, markets, config, market, isPut, underlying, collateralAsset, collateralDecimals, collateralLabel,
    spot, spotDecimals, canWrite } = gate;
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const queryClient = useQueryClient();
  const [shares, setShares] = useState("0.01");
  const [askPrice, setAskPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // The ask recorded by "Review order"; "Place ask" sends this and nothing else.
  const [reviewed, setReviewed] = useState<ReviewedAsk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fairQuery = useFair(row?.series.longId);
  const fair = fairQuery.data?.fair?.raw ? BigInt(fairQuery.data.fair.raw)
    : row?.quote.fair?.raw ? BigInt(row.quote.fair.raw) : null;
  const askInput = priceTouched || fair === null ? askPrice : formatUnits(roundAskToTick(fair), 6);
  const price = parseAskPrice(askInput);
  const units = useMemo(() => { try { return sharesToUnits(shares); } catch { return null; } }, [shares]);
  const strike = row ? BigInt(row.series.strike.raw) : customStrike;
  const quote = price && units && config.data ? writerQuote(price, units, config.data.fees.premiumFeeBps, fair) : null;
  const requiredCollateral = strike && units ? collateralPerUnit(isPut, strike) * units : null;
  const contractReady = Boolean(V2_DEPLOYMENT.contracts.clearinghouse && V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.expiryCalendar);
  const ledgerDeposit = depositDoor(canWrite, markets.isError ? null : markets.data);
  const askTrading = tradingOpen(market);

  const balance = useQuery({ queryKey: ["v2", "writerBalance", address, ticker, collateralAsset],
    enabled: Boolean(address && collateralAsset && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readWriterBalance(address!, collateralAsset!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const rentQuote = useQuery({ queryKey: ["v2", "writerRent", underlying, isPut, strike?.toString(), expiry, units?.toString(), address],
    enabled: Boolean(contractReady && underlying && strike && expiry && units),
    queryFn: () => readWriterRent(underlying!, isPut, strike!, expiry, units!, address),
    staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const writerRent = !rentQuote.isError ? rentQuote.data?.rent ?? null : null;
  const totalCollateral = requiredCollateral !== null && writerRent !== null ? requiredCollateral + writerRent : null;
  const free = rentQuote.data?.free ?? null;
  const hasCollateral = totalCollateral !== null && free !== null && free >= totalCollateral;
  const shortfall = totalCollateral !== null && free !== null && free < totalCollateral ? totalCollateral - free : null;

  const shortAsset = isPut ? "USDG" : ticker;
  const optionKind = isPut ? "Put" : "Call";
  const spotNumber = spot !== null ? Number(formatUnits(spot, spotDecimals)) : null;
  const strikeAway = strike !== null && spotNumber !== null && spotNumber > 0 ? (() => {
    const pct = (Number(formatUnits(strike, 6)) / spotNumber - 1) * 100;
    return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  })() : null;
  const strikeText = strike !== null ? `$${money(strike)}` : "—";
  const orderTitle = `Sell ${ticker} ${strikeText} ${optionKind}`;
  const canReview = Boolean(strike && price && units && expiry);
  // The order the live values would send now, compared with the reviewed one on every render.
  const liveAsk: ReviewedAsk | null = strike && price && units && expiry
    ? { price, units, strike, expiry, isPut, longId: row?.series.longId ?? null } : null;
  const drift = reviewing && reviewed ? askDrift(reviewed, liveAsk) : null;
  // The review card's figures are the REVIEWED order's, the one "Place ask" sends. The live quote moves with
  // an untouched price's fair refresh, and used to show the new price's credit beside the reviewed-price sentence.
  const reviewedQuote = reviewed && config.data ? writerQuote(reviewed.price, reviewed.units, config.data.fees.premiumFeeBps, fair) : null;
  const reviewedCollateral = reviewed ? collateralPerUnit(reviewed.isPut, reviewed.strike) * reviewed.units : null;
  // The card also names the reviewed order's side and asset, at that asset's decimals (a call locks the stock
  // token at 18, a put USDG at 6, as in useWriteGate). EarnMarket keeps the ticket mounted when a custom strike's
  // call/put switch flips, so the live side can differ from the reviewed one while the review is open.
  const reviewedTitle = reviewed ? `Sell ${ticker} $${money(reviewed.strike)} ${reviewed.isPut ? "Put" : "Call"}` : orderTitle;
  const reviewedAsset = reviewed ? (reviewed.isPut ? "USDG" : ticker) : shortAsset;
  const reviewedDecimals = reviewed ? (reviewed.isPut ? 6 : 18) : collateralDecimals;
  const lowestAsk = row?.quote.bestAsk ? BigInt(row.quote.bestAsk.raw) : null;
  const fills: { label: string; value: bigint | null }[] = [{ label: "Mark", value: fair }, { label: "Lowest ask", value: lowestAsk }];
  const stepShares = (delta: number) => {
    const base = Number.isFinite(Number(shares)) ? Number(shares) : 0;
    setShares(Math.max(0.01, Math.round((base + delta) * 100) / 100).toFixed(2));
    setReviewing(false);
  };

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return { account: address, wallet: wallet.data as WalletClient,
      onConfirmed: async () => {
        await queryClient.invalidateQueries({ queryKey: v2Keys.all });
        await queryClient.invalidateQueries({ queryKey: ["v2", "writerBalance", address, ticker] });
      } };
  }

  async function act(label: string, task: () => Promise<string>) {
    setBusy(label);
    try {
      notice("pending", label, "Review each requested transaction in your wallet.");
      notice("success", label, await task());
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${label} stopped`, error instanceof Error ? error.message : "Try again after refreshing.");
    } finally { setBusy(null); }
  }

  async function checkPutMarket() {
    const refreshed = await markets.refetch();
    const current = refreshed.data?.find((item) => item.ticker === ticker);
    if (refreshed.isError || !current || current.status !== "live" || !current.spot || !current.puts ||
      !underlying || current.underlying.toLowerCase() !== underlying.toLowerCase())
      throw new Error("Put writing is unavailable for this market. Your free USDG can still be withdrawn.");
  }

  async function depositShortfall() {
    await act(`Deposit ${collateralLabel}`, async () => {
      if (ledgerDeposit.note) throw new Error(ledgerDeposit.note);
      if (!canWrite || !collateralAsset || !address) throw new Error("Deposits are unavailable until the market and indexer configuration are live.");
      if (isPut) await checkPutMarket();
      if (!shortfall) throw new Error("Your free balance already covers this ask.");
      const fresh = await readWriterBalance(address, collateralAsset);
      if (fresh.wallet < shortfall) throw new Error(`Your wallet does not hold that much ${collateralLabel}.`);
      const ctx = context();
      await approveExact(ctx, collateralAsset, requireV2Address("clearinghouse"), shortfall);
      await deposit(ctx, collateralAsset, shortfall);
      return `${displayQuantity(shortfall, collateralDecimals)} ${collateralLabel} moved into your free Stonkhouse balance.`;
    });
  }

  async function listAsk() {
    await act("Place your ask", async () => {
      // place exactly the reviewed ask. A live order that differs (a fair refresh moved an untouched price,
      // or the strike, expiry, series or size changed) is refused here as well as by the disabled button.
      const order = reviewed;
      if (!order || askDrift(order, liveAsk) !== null) throw new Error(ASK_CHANGED_LINE);
      if (!canWrite || !underlying || !address || !config.data) throw new Error("Writing contracts are not ready in this build.");
      if (order.isPut) await checkPutMarket();
      const fresh = await preflightAsk(address, underlying, order.isPut, order.strike, order.expiry, order.units, config.data.fees.premiumFeeBps);
      if (order.longId !== null && fresh.longId !== BigInt(order.longId)) throw new Error("The selected series changed. Refresh the ladder.");
      const ctx = context();
      if (!fresh.operator) await setOperator(ctx, requireV2Address("orderBook"), true);
      if (!fresh.exists) await createSeries(ctx, underlying, order.isPut, order.strike, order.expiry);
      const beforePlace = await preflightAsk(address, underlying, order.isPut, order.strike, order.expiry, order.units, config.data.fees.premiumFeeBps);
      const cutoff = beforePlace.mintCutoff ?? await readMintCutoff(fresh.longId);
      // validUntil from the chain's clock (the preflight block), not the browser's.
      await place(ctx, fresh.longId, 2, order.price, order.units, nextAskExpiry(beforePlace.now, cutoff));
      setReviewing(false);
      setReviewed(null);
      return `Your ${ticker} ${optionKind.toLowerCase()} ask is open at ${money(order.price)} USDG per share. Premium arrives only if a buyer fills.`;
    });
  }

  const outcomes = strike && units && quote ? <div className="grid gap-2">
    <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">At expiry
      <InfoTip label="About the outcomes" text={<>Before gas. {isPut
        ? `If ${ticker} ends below the strike, you lose the difference from your USDG. The premium covers part of it.`
        : "Above the strike, the buyer gets part of each share, not the whole share."}</>} /></p>
    <ul className="grid gap-2 sm:grid-cols-2">
      {isPut ? <>
        <Outcome when={`${ticker} at or above $${money(strike)}`}>Your {usd(requiredCollateral!)} collateral returns, plus {usd(quote.net)} premium.</Outcome>
        <Outcome when={`${ticker} at $${money(strike * 9n / 10n)}`} tone="warn">You pay {usd(requiredCollateral! - shortOutcome(strike * 9n / 10n, { isPut: true, strike, units, exerciseFeeBps: 0 }, quote.net).collateralReturned)} from collateral. The rest returns, plus {usd(quote.net)} premium.</Outcome>
      </> : <>
        <Outcome when={`${ticker} below $${money(strike)}`}>Keep your {displayQuantity(units, 2)} {ticker}, plus {usd(quote.net)} premium.</Outcome>
        <Outcome when={`${ticker} at $${money(strike * 11n / 10n)}`} tone="warn">Keep about {retainedSharesAtExpiry(strike, strike * 11n / 10n, units).toLocaleString("en-US", { maximumFractionDigits: 4 })} {ticker} (worth the strike per original share), plus {usd(quote.net)} premium.</Outcome>
      </>}
    </ul>
  </div> : null;

  const head = <div>
    <p className="font-display text-[18px] font-bold leading-snug text-ink">{orderTitle}</p>
    <p className="text-[13px] text-ink-3">{expiry ? `Expires ${expiryDay(expiry)}` : "Choose an expiry"}{strikeAway ? ` · ${strikeAway} vs share price` : ""}</p>
  </div>;

  if (!reviewing) return <div id="sell-ticket" data-slot="order-ticket" className={cn("grid gap-4 rounded-lg border border-line-2 bg-surface-2 p-4 sm:p-5", className)}>
    {head}
    <div className="grid gap-2">
      <Field id="ask-price" label="Limit price" suffix="$ / share" inputMode="decimal" value={askInput}
        onChange={(event) => { setAskPrice(event.target.value); setPriceTouched(true); setReviewing(false); }} placeholder={fair !== null ? formatUnits(roundAskToTick(fair), 6) : "0.35"}
        tip={<>The least you will take per share, paid in USDG, in 0.0001 steps. Your ask waits for a buyer until it fills or expires. The fair value is guidance, never a block.
          {/* The fair figure below is qualified by its source. `useFair` carries provenance
          on the /v2/fair payload; the per-series quote carries its own. Absent reads as unknown. */}
          <span className="mt-1.5 block"><FairProvenanceNote provenance={fairQuery.data?.provenance ?? row?.quote.fairProvenance} /></span></>} />
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Fill the limit price">
        {fills.map((fill) => <button key={fill.label} type="button" disabled={fill.value === null || fill.value <= 0n}
          onClick={() => { if (fill.value !== null) { setAskPrice(formatUnits(roundAskToTick(fill.value), 6)); setPriceTouched(true); setReviewing(false); } }}
          className="grid min-h-11 place-items-center rounded-md border border-line-2 bg-surface px-2 py-1.5 text-center transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50">
          <span className="text-[11.5px] font-medium text-ink-3">{fill.label}</span>
          <span className="num text-[13.5px] font-semibold text-ink">{fill.value !== null && fill.value > 0n ? usd(fill.value) : "—"}</span>
        </button>)}
      </div>
      {fair !== null && price !== null && quote ? <p className="text-[12.5px] text-ink-3">Your price is {quote.comparison ?? "at fair value"}.</p> : null}
    </div>
    <div className="grid gap-1.5">
      <FieldLabel htmlFor="ask-size" aside={balance.data ? `Available ${displayQuantity(balance.data.free, collateralDecimals)} ${shortAsset}` : `1 ${shortAsset} per share`}
        tip={isPut ? "How many shares the buyer may sell you, in 0.01-share steps. Each one needs the strike amount in USDG set aside."
          : `How many shares you sell the call on, in 0.01-share steps. Each share locks one ${ticker} Stock Token until expiry.`}>Shares</FieldLabel>
      <div className="flex items-stretch gap-2">
        <StepButton label="One hundredth of a share less" onClick={() => stepShares(-0.01)}>−</StepButton>
        <input id="ask-size" type="text" inputMode="decimal" value={shares} placeholder="0.01"
          onChange={(event) => { setShares(event.target.value); setReviewing(false); }}
          className={cn(inputClasses, "px-3.5 py-3 text-center text-[17px]")} />
        <StepButton label="One hundredth of a share more" onClick={() => stepShares(0.01)}>+</StepButton>
      </div>
    </div>
    <div className="rounded-md border border-line bg-field px-4 py-2">
      <Rows>
        <Row k="Estimated credit" tip="The premium you receive if a buyer fills your whole ask, after the seller fee, plus a small fee rebate. Paid in USDG at the fill."
          v={<strong className="text-[18px] text-ink">{quote ? usd(quote.net) : "—"}</strong>} />
        <Row dense k="Seller fee" tip={`${config.data?.fees.premiumFeeBps ?? "—"} bps of the premium, taken at the fill.`} v={quote ? usd(quote.fee) : "—"} />
        <Row dense k="Locked while open" tip={`The ${collateralLabel} this ask sets aside once it fills. It unlocks after expiry and settlement.`}
          v={requiredCollateral !== null ? `${displayQuantity(requiredCollateral, collateralDecimals)} ${shortAsset}` : "—"} />
        <Row dense k="Free balance needed" tip="The locked amount plus the order's on-chain cost, read from the contracts."
          v={totalCollateral !== null ? `${displayQuantity(totalCollateral, collateralDecimals)} ${shortAsset}`
            : <span className="font-body text-ink-3">{address ? "Checking…" : "—"}</span>} />
      </Rows>
    </div>
    {shortfall !== null && address ? <div data-slot="deposit-shortfall" className="grid gap-2 rounded-md border border-warn/40 bg-warn-soft px-4 py-3 text-[13.5px]">
      <p className="text-ink">Deposit <b className="num">{displayQuantity(shortfall, collateralDecimals)} {shortAsset}</b> into your StonkHouse balance to cover this ask.</p>
      {ledgerDeposit.note ? <p role="status" className="text-ink-2">{ledgerDeposit.note}</p> : null}
      <Button size="sm" variant="secondary" disabled={!ledgerDeposit.open || !balance.data || !!busy} onClick={() => void depositShortfall()}>
        {busy === `Deposit ${collateralLabel}` ? "Depositing…" : `Deposit ${displayQuantity(shortfall, collateralDecimals)} ${shortAsset}`}</Button>
    </div> : null}
    {outcomes}
    {address ? <Button className="w-full" disabled={!canReview || !!busy} onClick={() => { if (!liveAsk) return; setReviewed(liveAsk); setReviewing(true); }}>Review order</Button>
      : <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[13px] text-ink-3">Connect a wallet to sell.</p><ConnectButton /></div>}
  </div>;

  return <div id="sell-ticket" data-slot="order-review" className={cn("grid gap-4 rounded-lg border border-accent/60 bg-surface-2 p-4 sm:p-5", className)}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-text">Review order</p>
        <p className="mt-1 font-display text-[18px] font-bold leading-snug text-ink">{reviewedTitle}</p>
      </div>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setReviewed(null); setReviewing(false); }}>Edit</Button>
    </div>
    {/* The sentence states the REVIEWED order, the one "Place ask" sends. */}
    <p className="text-[14px] leading-relaxed text-ink-2">Sell {displayQuantity(reviewed?.units ?? units ?? 0n, 2)} {(reviewed?.units ?? units) === 100n ? "share" : "shares"} of the {ticker} {reviewed ? `$${money(reviewed.strike)}` : strikeText} {reviewed ? (reviewed.isPut ? "put" : "call") : optionKind.toLowerCase()} expiring {reviewed ? expiryDay(reviewed.expiry) : expiry ? expiryDay(expiry) : "—"}, at {reviewed ? `$${formatUnits(reviewed.price, 6)}` : price !== null ? `$${formatUnits(price, 6)}` : "—"} per share or more.</p>
    <div className="rounded-md border border-line bg-field px-4 py-2">
      <Rows>
        <Row k="Estimated credit" v={<strong className="text-[18px] text-ink">{reviewedQuote ? usd(reviewedQuote.net) : "—"}</strong>} />
        <Row dense k="Gross premium" v={reviewedQuote ? usd(reviewedQuote.gross) : "—"} />
        <Row dense k={`Seller fee (${config.data?.fees.premiumFeeBps ?? "—"} bps)`} v={reviewedQuote ? usd(reviewedQuote.fee) : "—"} />
        <Row dense k="Locked while open" v={reviewedCollateral !== null ? `${displayQuantity(reviewedCollateral, reviewedDecimals)} ${reviewedAsset}` : "—"} />
      </Rows>
    </div>
    <ul className="grid gap-1.5 text-[13px] text-ink-2">
      <ReviewNote>The first time, your wallet also asks you to let the order book use your free balance. A new strike adds one step.</ReviewNote>
      <ReviewNote>Your ask waits for a buyer for up to 7 days and ends 30 minutes before expiry.</ReviewNote>
      <ReviewNote>Keep your {reviewedAsset} deposited while the ask is open, or it is skipped.</ReviewNote>
    </ul>
    {config.data?.pendingFees ? <PendingFeeNotice effectiveAt={config.data.pendingFees.effectiveAt}
      nextFees={config.data.pendingFees} kind="writer" /> : null}
    <PendingOperationsNotice />
    {/* The ask's own validUntil, from the same nextAskExpiry listAsk sends (the series' cutoff, else expiry minus the
      settlement window, the contract's mint cutoff). A series too close to cutoff for an ask renders nothing. */}
    <PayoutTiming of={(t) => {
      const cutoff = row?.series.mintCutoff ?? (expiry && config.data ? expiry - config.data.constants.settlementWindow : null);
      if (cutoff === null) return null;
      try { return restingOrderTiming({ kind: "ask", validUntil: nextAskExpiry(t, cutoff), now: t }); } catch { return null; }
    }} />
    {askTrading ? null : <p data-slot="trading-paused" role="status" className="text-sm text-ink-2">{TRADING_PAUSED_LINE}</p>}
    {shortfall !== null ? <p role="status" className="text-sm text-warn">Deposit {displayQuantity(shortfall, collateralDecimals)} {shortAsset} first: press Edit.</p> : null}
    {drift ? <p data-slot="order-changed" role="alert" className="text-sm text-warn">{drift}</p> : null}
    <div className="grid">
      <Button disabled={!canWrite || !askTrading || !hasCollateral || !!busy || !strike || !price || !units || !expiry || !reviewed || drift !== null} onClick={() => void listAsk()}>{busy === "Place your ask" ? "Placing…" : "Place ask"}</Button>
    </div>
  </div>;
}

function ReviewNote({ children }: { children: ReactNode }) {
  return <li className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-pill bg-accent" />{children}</li>;
}

function Outcome({ when, tone, children }: { when: string; tone?: "warn"; children: ReactNode }) {
  return <li className="rounded-md border border-line bg-surface p-3 text-[13px] leading-snug">
    <p className={cn("font-semibold", tone === "warn" ? "text-warn" : "text-accent-text")}>{when}</p>
    <p className="mt-1 text-ink-2">{children}</p>
  </li>;
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} onClick={onClick}
    className="grid w-12 shrink-0 place-items-center rounded-md border border-line-2 bg-surface text-[20px] font-semibold text-ink transition-colors hover:border-ink-3 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40">{children}</button>;
}
