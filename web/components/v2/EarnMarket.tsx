"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Disclosure, Field, InfoTip, Notice, PageHead, Panel, Row, Rows, Segments, SegmentedControl, SelectField, Stat, Tabs } from "@/components/ui";
import { cn } from "@/lib/cn";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { ledgerWithdrawTiming, zapTiming } from "@/lib/v2/payoutTiming";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { EarnFacts } from "@/components/v2/earn/EarnFacts";
import { expiryDay, SellTicket } from "@/components/v2/sell/SellTicket";
import { usd } from "@/components/v2/trade/price";
import { hasEarnPosition } from "@/components/v2/earn/position";
import { publicClient } from "@/lib/chain";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { v2Markets } from "@/lib/markets";
import { v2Api, writerStrategiesOptions } from "@/lib/v2/api";
import type { MarketSeriesResponse, Strategy } from "@/lib/v2/api-types";
import { lifetimePremium } from "@/lib/v2/historySummary";
import { Time, timeText, useViewerTimeZone } from "@/components/ui/Time";
import { V2_DEPLOYMENT, requireV2Address, v2AddressOverrideConflictNotices, v2AddressProvenanceNotices, v2ConfigWarnings, v2ContractAddress, v2StockZapMismatch } from "@/lib/v2/config";
import { readPayoutPrefs } from "@/lib/v2/chainReads";
import { earnActionAvailability } from "@/lib/v2/earnAccess";
import { depositDoor } from "@/lib/v2/upgradePause";
import { readRollPosition, readRollState, readWriterBalance, readWriterFree, setDelegate, setStrategy, stopStrategy } from "@/lib/v2/earnTx";
import { useAllMarketSeries, useConfig, useMarketSeries, useMarkets, usePositions, useStrategies, v2Keys } from "@/lib/v2/hooks";
import { sharesToUnits } from "@/lib/v2/payoff";
import { dailyOffered, presetStrategy, resolvePresetPricing, visiblePresets, weeklyOffered, WRITER_PRESETS, type PresetId } from "@/lib/v2/presets";
import { formatRollPreview, readRollPreview } from "@/lib/v2/moneyPreviews";
import { nextRollStep, rollProgressFromChain, rollStatusFromChain, ROLL_STEPS, validateRollStrategy } from "@/lib/v2/rollSetup";
import { autoRollStartPrice, autoRollTargetStrike, closedStrategyPosition, fixedAskBpsFromReference, formatUsdgTick, parseUsdgTick, pricingRequestIsCurrent, pricingWriteState, proposedSmartPricingBand, refreshSmartPricingRows, selectSmartPricingReference, smartPricingCandidateState, smartPricingDraft, smartPricingPrices, snapStrategyPriceToBps, strategyPriceAtBps, SMART_PRICING_REVIEW_MS, type PricingRequestSnapshot, type ProposedSmartPricingBand, type SmartPricingPrices, smartPricingOffer, SMART_PRICING_PRICER_UNKNOWN, type SmartPricingOffer, type SmartPricingCandidateSnapshot, type StrategyPriceField } from "@/lib/v2/smartPricing";
import { selectTradeSpot } from "@/lib/v2/marketSpot";
import { approveExact, deposit, place, setOperator, setPayoutToLedger, withdraw, type WriteContext } from "@/lib/v2/tx";
import { exitZap, quoteExitZap, quoteWriteZap, writeZap, ZAP_SLIPPAGE_BPS_DEFAULT } from "@/lib/v2/zapTx";
import { displayMoney, displayPercent, displayQuantity } from "@/lib/numberFormat";

// through rules (no zero tails, truncated, compact from 10,000), not a local toLocaleString.
const assetAmount = (raw: bigint, decimals: number) => displayQuantity(raw, decimals);
const money = (raw: bigint) => displayMoney(raw, 6, { maxDecimals: 4 });

const parsePositiveAsset = (raw: string, decimals: number): bigint | null => {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
};
const parseAskPrice = (raw: string): bigint | null => {
  try { const price = parseUnits(raw, 6); return price > 0n && price % 100n === 0n ? price : null; } catch { return null; }
};

/** A new strategy starts on the daily cycle unless the registry lists weeklies (presets.ts weeklyOffered). */
export const EMPTY_STRATEGY: Strategy = { active: true, weekly: weeklyOffered(), smartPricing: false, otmBps: 500,
  askBps: 100, minAskBps: 0, maxAskBps: 0, maxUnits: "1" };

/**
 * The blank form for one market. It starts on the daily cycle when the market lists dailies and on the weekly
 * cycle when it lists weeklies only (SPCX: Friday closes, no dailies), so the form never opens on a cycle
 * the market cannot roll into. A market listing both keeps EMPTY_STRATEGY's choice.
 */
export function emptyStrategyFor(weeklyOn: boolean, dailyOn: boolean): Strategy {
  return dailyOn ? EMPTY_STRATEGY : { ...EMPTY_STRATEGY, weekly: weeklyOn };
}

/**
 * The Cycle choices. Weekly is offered only when the market lists weeklies and daily only when it
 * lists dailies, EXCEPT that a saved strategy keeps its own value visible: hiding it would misstate the saved strategy
 * and leave the owner unable to see what they are about to stop or change.
 */
export function cycleOptions(weeklyOn: boolean, current: Pick<Strategy, "weekly">, dailyOn = true): readonly ("weekly" | "daily")[] {
  const options: ("weekly" | "daily")[] = [];
  if (weeklyOn || current.weekly) options.push("weekly");
  if (dailyOn || !current.weekly) options.push("daily");
  return options;
}

function matchedSeries(rows: MarketSeriesResponse["items"], expiry: number, isPut: boolean) {
  return rows.filter((row) => row.series.isPut === isPut && row.series.expiry === expiry && row.series.status === "open")
    .sort((a, b) => BigInt(a.series.strike.raw) < BigInt(b.series.strike.raw) ? -1 : 1);
}

function pricingReference(rows: MarketSeriesResponse["items"], weekly: boolean, targetStrike: bigint) {
  return selectSmartPricingReference(rows.filter((row) => row.series.tenor !== "special").map((row) => ({
    row, expiry: row.series.expiry, strike: BigInt(row.series.strike.raw),
    tenor: row.series.tenor as "daily" | "weekly", status: row.series.status,
  })), weekly, targetStrike)?.row ?? null;
}

type PricingInput = StrategyPriceField;
type PricingCandidate = SmartPricingCandidateSnapshot & {
  reference: MarketSeriesResponse["items"][number];
  referenceFair: bigint;
  band: ProposedSmartPricingBand;
  prices: SmartPricingPrices;
};

const PRICING_KEYS: Record<PricingInput, "askBps" | "minAskBps" | "maxAskBps"> = {
  start: "askBps", minimum: "minAskBps", maximum: "maxAskBps",
};
const PRICING_LABELS: Record<PricingInput, string> = {
  start: "Starting ask", minimum: "Minimum ask", maximum: "Maximum ask",
};

/**
 * whether the smart-pricing checkbox may be TICKED, and what to say when it may not.
 *
 * SEPARATED FROM THE COMPONENT so it can be asserted without a renderer — this package has no
 * render test, and the alternative is a `disabled={...}` expression inside JSX that nothing can
 * check. A gate nothing can test is the shape this code exists to remove, so it would be an odd
 * way to close it.
 *
 * `disabled` when the pricer is not known-healthy, but ONLY while the control is not already on.
 * Locking a user out of turning smart pricing OFF because the pricer died would be a worse trap
 * than the one this gate removes, and an already-live ask is deliberately not this gate's
 * business: it stays live at its last price, and the user keeps the ability to stand it down.
 */
export function smartPricingControlState(
  offer: SmartPricingOffer, alreadyOn: boolean, busy: boolean,
): { disabled: boolean; note: string | null } {
  const blocked = !offer.offered && !alreadyOn;
  return { disabled: busy || blocked, note: offer.offered ? null : offer.note };
}

/** The Portfolio edit link is explicit; unrelated query values must not preload a strategy. */
export function portfolioStrategyEditRequested(search: string): boolean {
  return new URLSearchParams(search).get("edit") === "smart-pricing";
}

/*
 * The edit request is read from the URL as an external store rather than inside an effect, which is what
 * react-hooks/set-state-in-effect flagged at the old EarnMarket.tsx:325. The URL does not change under a mounted page
 * (Portfolio's link is a navigation), so there is nothing to subscribe to; the server render and hydration read false.
 */
const subscribeToNothing = () => () => {};
const readEditRequest = () => portfolioStrategyEditRequested(window.location.search);
const serverEditRequest = () => false;

const SELL_TABS = ["auto", "once", "swap"] as const;
type SellTab = (typeof SELL_TABS)[number];
export function sellTabRequested(search: string): SellTab | null {
  const tab = new URLSearchParams(search).get("tab");
  return (SELL_TABS as readonly string[]).includes(tab ?? "") ? tab as SellTab : null;
}
const readTabRequest = () => sellTabRequested(window.location.search);
const serverTabRequest = () => null;
export function sellSeriesRequested(search: string): string | null {
  const id = new URLSearchParams(search).get("series");
  return id && /^\d{1,78}$/.test(id) ? id : null;
}
const readSeriesRequest = () => sellSeriesRequested(window.location.search);

export function EarnMarket({ ticker }: { ticker: string }) {
  const zone = useViewerTimeZone();
  const { address } = useAccount();
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const queryClient = useQueryClient();
  const markets = useMarkets();
  const registryMarket = v2Markets().find((row) => row.ticker === ticker);
  const weeklyOn = weeklyOffered(registryMarket?.v2.overrides);
  const dailyOn = dailyOffered(registryMarket?.v2.overrides);
  const market = markets.data?.find((row) => row.ticker === ticker);
  // Put writing shows only on a market whose registry row enables puts. Until
  // then the page is calls only: no Calls/Puts switch, no put copy. The put path stays behind the flag, not deleted.
  const putsEnabled = market?.puts === true;
  const [typeChoice, setType] = useState<"call" | "put">("call");
  const type = putsEnabled ? typeChoice : "call";
  const isPut = type === "put";
  const activeType = type;
  // Only OPEN series, filtered by the indexer. The page is oldest-first and the ladder keeps only open
  // rows anyway, so an unfiltered 200-row page filled up with expired and settled series and emptied the strike list.
  const series = useMarketSeries(ticker, { type: activeType, status: "open", limit: 200 });
  const allCallSeries = useAllMarketSeries(ticker, { type: "call", status: "open" }, { enabled: false });
  const config = useConfig();
  const positions = usePositions(address);
  // This wallet's strategies, filtered by the indexer. The unfiltered 200-row page of EVERYONE's
  // strategies (ordered by id) never reached a writer whose row sorted past it, so the saved strategy went missing.
  const strategies = useStrategies(writerStrategiesOptions(address));
  const underlying = registryMarket?.asset ?? null;
  const collateralAsset = isPut ? USDG : underlying;
  const collateralDecimals = isPut ? 6 : 18;
  const collateralLabel = isPut ? "USDG" : "Stock Tokens";
  const [expiryChoice, setExpiryChoice] = useState(0);
  const [seriesPick, setSeriesChoice] = useState("");
  const [customStrike, setCustomStrike] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [zapUsdgAmount, setZapUsdgAmount] = useState("");
  const [exitZapAmount, setExitZapAmount] = useState("");
  const [strategy, setStrategyForm] = useState<Strategy>(() => emptyStrategyFor(weeklyOn, dailyOn));
  const [pricingInputs, setPricingInputs] = useState<Partial<Record<PricingInput, string>>>({});
  const [pricingCommitErrors, setPricingCommitErrors] = useState<Partial<Record<PricingInput, string>>>({});
  const [pricingCandidate, setPricingCandidate] = useState<PricingCandidate | null>(null);
  const [pricingReviewNow, setPricingReviewNow] = useState(() => Date.now());
  const [pricingRevisionValue, setPricingRevisionValue] = useState(0);
  const portfolioEditMode = useSyncExternalStore(subscribeToNothing, readEditRequest, serverEditRequest);
  const [portfolioEditLoaded, setPortfolioEditLoaded] = useState(false);
  // A plan's max size defaults to ALL FREE TOKENS. Blank saves maxUnits 0, which
  // AutoRoller reads as no cap (`if (s.maxUnits != 0 && units > s.maxUnits)`): each roll sizes to the writer's free
  // collateral at roll time. The field's placeholder and help text say so. The one-off "Size in shares" keeps 0.01.
  const [maxShares, setMaxShares] = useState("");
  const [formTouched, setFormTouched] = useState(false);
  const [sellTabChoice, setSellTab] = useState<SellTab | null>(null);
  const requestedTab = useSyncExternalStore(subscribeToNothing, readTabRequest, serverTabRequest);
  const requestedSeries = useSyncExternalStore(subscribeToNothing, readSeriesRequest, serverTabRequest);
  const sellTab: SellTab = sellTabChoice ?? (portfolioEditMode ? "auto" : requestedTab ?? (requestedSeries ? "once" : "auto"));
  const [balanceTab, setBalanceTab] = useState<"deposit" | "withdraw">("deposit");
  const [otmInput, setOtmInput] = useState<string | null>(null);
  const [presetChoice, setPresetChoice] = useState<PresetId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rollStep, setRollStep] = useState<string | null>(null);
  const pricingRevision = useRef(0);
  const pricingAction = useRef(0);

  const requestedRow = requestedSeries ? series.data?.items.find((row) => row.series.longId === requestedSeries && !row.series.isPut === !isPut) : undefined;
  const expiry = expiryChoice || requestedRow?.series.expiry || market?.expiries[0] || 0;
  const seriesChoice = seriesPick || (requestedRow && requestedRow.series.expiry === expiry ? requestedRow.series.longId : "");
  const ladder = matchedSeries(series.data?.items ?? [], expiry, isPut);
  const chosen = seriesChoice && seriesChoice !== "custom" ? ladder.find((row) => row.series.longId === seriesChoice) : ladder[0];
  const selected = seriesChoice === "custom" ? null : chosen;
  // The render-time clock is useNow(): whole SECONDS, ticking, and 0 until mounted. selectTradeSpot takes
  // MILLISECONDS, hence the explicit * 1000. Before mount there is no clock to judge a spot against, so the
  // spot fails closed (null) rather than being read at time 0.
  const nowSeconds = useNow();
  const spot = nowSeconds === 0 ? null
    : selectTradeSpot(market?.spot?.raw, markets.isError, 0, undefined, 0, true, nowSeconds * 1000);
  const spotDecimals = market?.spot?.decimals ?? USDG_DECIMALS;
  const strikeTick = market?.strikeTick.raw ? BigInt(market.strikeTick.raw) : null;
  const pricingState = useRef({ strategy, spot, strikeTick, ticker, underlying: market?.underlying ?? null });
  useEffect(() => {
    pricingState.current = { strategy, spot, strikeTick, ticker, underlying: market?.underlying ?? null };
  }, [strategy, spot, strikeTick, ticker, market?.underlying]);
  useEffect(() => {
    if (!pricingCandidate) return;
    const remaining = Math.max(0,
      pricingCandidate.reviewedAtMs + SMART_PRICING_REVIEW_MS - Date.now());
    const timer = window.setTimeout(() => setPricingReviewNow(Date.now()), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [pricingCandidate]);
  const candidateState = pricingCandidate && market && spot && strikeTick
    ? smartPricingCandidateState(pricingCandidate, {
      ticker, underlying: market.underlying, spot, strikeTick, weekly: strategy.weekly,
      otmBps: strategy.otmBps, revision: pricingRevisionValue,
    }, pricingReviewNow)
    : pricingCandidate ? "changed" as const : null;
  const currentCandidate = candidateState === "current" ? pricingCandidate : null;
  const candidateMessage = candidateState === "expired"
    ? "This proposed band expired after one minute. Refresh it before selecting smart pricing, or edit a USDG price to discard the candidate and use a manual band."
    : candidateState === "changed"
      ? "This proposed band no longer matches the current market or form. Refresh it, or edit a USDG price to discard the candidate and use a manual band."
      : null;
  const canonicalStart = spot ? autoRollStartPrice(spot, strategy.askBps) : null;
  const canonicalMinimum = spot ? strategyPriceAtBps(spot, strategy.minAskBps, "minimum") : null;
  const canonicalMaximum = spot ? strategyPriceAtBps(spot, strategy.maxAskBps, "maximum") : null;
  const startInput = pricingInputs.start ?? (canonicalStart ? formatUsdgTick(canonicalStart) : "");
  const minimumInput = pricingInputs.minimum ?? (canonicalMinimum ? formatUsdgTick(canonicalMinimum) : "");
  const maximumInput = pricingInputs.maximum ?? (canonicalMaximum ? formatUsdgTick(canonicalMaximum) : "");
  const relevantPricingInputs: PricingInput[] = strategy.smartPricing ? ["start", "minimum", "maximum"] : ["start"];
  const pendingPricingInput = relevantPricingInputs.find((field) => pricingInputs[field] !== undefined);
  const invalidPendingPricing = pendingPricingInput && parseUsdgTick(pricingInputs[pendingPricingInput] ?? "") === null
    ? pendingPricingInput : null;
  const pricingCommitError = relevantPricingInputs.map((field) => pricingCommitErrors[field]).find(Boolean) ?? null;
  const pricingError = !spot ? "Live spot is required to convert USDG prices to contract bps."
    : invalidPendingPricing ? `${PRICING_LABELS[invalidPendingPricing]} must be a positive USDG price in 0.0001 steps.`
    : pricingCommitError ? pricingCommitError
    : pendingPricingInput ? `${PRICING_LABELS[pendingPricingInput]} is not committed. Move out of the field or press Enter to convert it to contract bps.`
    : null;
  const strategySize = useMemo(() => {
    if (!maxShares.trim()) return "0";
    try { return sharesToUnits(maxShares).toString(); } catch { return null; }
  }, [maxShares]);
  const strategyToSave = strategySize === null ? null : { ...strategy,
    minAskBps: strategy.smartPricing ? strategy.minAskBps : 0,
    maxAskBps: strategy.smartPricing ? strategy.maxAskBps : 0,
    maxUnits: strategySize };
  const candidatePricingError = strategy.smartPricing && candidateMessage ? candidateMessage : null;
  const strategyError = pricingError ?? candidatePricingError ?? (strategySize === null
    ? "Choose a size in 0.01-share steps, or leave blank for all free collateral."
    : strategyToSave ? validateRollStrategy(strategyToSave, spot) : "Choose contract-representable USDG prices.");
  const contractReady = Boolean(V2_DEPLOYMENT.contracts.clearinghouse && V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.expiryCalendar);
  const rollerReady = Boolean(contractReady && V2_DEPLOYMENT.contracts.autoRoller);
  // What the next auto-roll would place, from AutoRoller.previewRoll. Not a local quote.
  const rollPreview = useQuery({
    queryKey: ["v2", "roll-preview", address, underlying],
    enabled: Boolean(address && underlying && V2_DEPLOYMENT.contracts.autoRoller),
    retry: false,
    queryFn: () => readRollPreview(publicClient, requireV2Address("autoRoller"), address!, underlying!),
  });
  const mismatch = config.data ? [
    ...v2ConfigWarnings(config.data),
    ...(isPut && config.data.usdg.address.toLowerCase() !== USDG.toLowerCase() ? ["USDG address differs from this app."] : []),
  ] : [];
  const provenance = v2AddressProvenanceNotices();
  const overrideConflicts = v2AddressOverrideConflictNotices();
  // The pricer runs in the keeper, not here, so its readiness comes from the indexer's
  // /v2/services. `retry: false` is deliberate — a retrying query stays `pending` longer,
  // and pending already means "not known", which is the fail-closed answer. The refetch cadence
  // matches the reading's own freshness bound rather than relying on focus alone.
  const services = useQuery({ queryKey: ["v2", "services"], queryFn: () => v2Api.getServices(),
    staleTime: 30_000, refetchInterval: 30_000, retry: false });
  // `undefined` while pending, `null` when the read failed. `smartPricingOffer` treats both as
  // not-known, and neither as healthy. It takes SECONDS, which is what useNow() returns. Before mount
  // (nowSeconds === 0) it would see a negative reading age and offer the control, so the gate fails closed
  // here instead: no clock means the reading's freshness is not known.
  const pricerOffer: SmartPricingOffer = nowSeconds === 0
    ? { offered: false, note: SMART_PRICING_PRICER_UNKNOWN }
    : smartPricingOffer(services.isError ? null : services.data?.pricer, nowSeconds);
  // The offer gate, resolved once here rather than inline in the JSX, so the decision has a name
  // and a test rather than living in a `disabled={...}` expression.
  const smartPricingControl = smartPricingControlState(pricerOffer, strategy.smartPricing, !!busy);
  const availability = earnActionAvailability({
    walletConnected: Boolean(address && wallet.data), assetConfigured: Boolean(collateralAsset),
    clearinghouseConfigured: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    orderBookConfigured: Boolean(V2_DEPLOYMENT.contracts.orderBook),
    calendarConfigured: Boolean(V2_DEPLOYMENT.contracts.expiryCalendar),
    autoRollerConfigured: Boolean(V2_DEPLOYMENT.contracts.autoRoller),
    marketLive: market?.status === "live",
    marketMatchesRegistry: Boolean(market && underlying && market.underlying.toLowerCase() === underlying.toLowerCase()),
    indexerConfigHealthy: Boolean(config.data && mismatch.length === 0),
  });
  const canWrite = availability.newWritesReady && !markets.isError && spot !== null && (!isPut || market?.puts === true);
  // The ledger deposit (Clearinghouse.deposit has no pause of its own) closes while the whole deployment is
  // paused for an upgrade. Asks already stop on chain; withdraw is never gated.
  const ledgerDeposit = depositDoor(canWrite, markets.isError ? null : markets.data);
  // `v2ContractAddress`, NOT `V2_DEPLOYMENT.contracts.stockZap`: that read is the registry alone, and
  // `v2ContractAddress` consults the validated override as well. Since the registry fills the key
  // (tier1.json `v2.contracts.stockZap`). An indexer that publishes a DIFFERENT StockZap disables only
  // the two Zap buttons, with the reason shown; it is never part of `mismatch`, which pauses everything.
  const zapConfigured = Boolean(v2ContractAddress("stockZap"));
  const zapMismatch = config.data ? v2StockZapMismatch(config.data) : null;
  const zapReady = zapConfigured && zapMismatch === null;
  const zapOffLabel = zapConfigured ? "Zap paused" : "Zap not configured";
  const zapUsdg = parsePositiveAsset(zapUsdgAmount, USDG_DECIMALS);
  const writeZapQuote = !isPut && zapUsdg ? quoteWriteZap(zapUsdg, spot, spotDecimals, 18) : null;
  const exitZapIn = parsePositiveAsset(exitZapAmount, 18);
  const exitZapQuote = !isPut && exitZapIn ? quoteExitZap(exitZapIn, spot, spotDecimals, 18) : null;

  const balance = useQuery({ queryKey: ["v2", "writerBalance", address, ticker, collateralAsset],
    enabled: Boolean(address && collateralAsset && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readWriterBalance(address!, collateralAsset!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const roll = useQuery({ queryKey: ["v2", "writerRoll", address, ticker],
    enabled: Boolean(address && underlying && V2_DEPLOYMENT.contracts.autoRoller),
    queryFn: () => readRollState(address!, underlying!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const payoutPrefs = useQuery({ queryKey: ["v2", "writerPayoutPrefs", address?.toLowerCase()],
    enabled: Boolean(address && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readPayoutPrefs(address!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const earned = useQuery({ queryKey: ["v2", "writerLifetimePremium", address, ticker], enabled: Boolean(address),
    queryFn: ({ signal }) => lifetimePremium(address!, ticker, signal), staleTime: 60_000, retry: 0 });
  const accountStrategy = positions.data?.strategies.find((row) => row.ticker === ticker);
  const indexedStrategy = address && underlying ? strategies.data?.items.find((row) =>
    row.ticker.toUpperCase() === ticker.toUpperCase() &&
    row.writer.toLowerCase() === address.toLowerCase() &&
    row.underlying.toLowerCase() === underlying.toLowerCase()) : undefined;
  const writerShorts = positions.data?.shorts.filter((row) => row.series.ticker === ticker && row.series.isPut === isPut) ?? null;
  const locked = writerShorts?.reduce((sum, row) => sum + BigInt(row.collateralLocked.raw), 0n) ?? null;
  const latestLockedExpiry = writerShorts?.reduce((latest, row) => BigInt(row.collateralLocked.raw) > 0n
    ? Math.max(latest, row.series.expiry) : latest, 0) || null;
  const progress = { payout: Boolean(payoutPrefs.data?.toLedger),
    operator: Boolean(balance.data?.rollerOperator), bookOperator: Boolean(balance.data?.orderBookOperator),
    delegate: Boolean(roll.data?.delegate), strategy: Boolean(roll.data?.strategyActive) };

  // The Portfolio edit link loads the saved strategy into the form once, as soon as it is indexed. This adjusts state
  // while rendering (guarded by portfolioEditLoaded, so it runs once) instead of in an effect. The revision bump
  // discards any in-flight preset or band load; the ref the async actions compare against is synced just below.
  if (portfolioEditMode && indexedStrategy && !portfolioEditLoaded) {
    setPortfolioEditLoaded(true);
    setPricingRevisionValue((revision) => revision + 1);
    setStrategyForm(indexedStrategy.strategy);
    setPricingInputs({});
    setPricingCommitErrors({});
    setPricingCandidate(null);
    setMaxShares(indexedStrategy.strategy.maxUnits === "0" ? "" : formatUnits(BigInt(indexedStrategy.strategy.maxUnits), 2));
    setFormTouched(true);
  }
  useEffect(() => {
    // advancePricingRevision moves the ref and the state together; only the render-time load above moves the state
    // alone, so the ref catches up here. Refs are written in effects, never during render.
    if (pricingRevision.current < pricingRevisionValue) pricingRevision.current = pricingRevisionValue;
  }, [pricingRevisionValue]);
  useEffect(() => {
    // The link lands on #auto-roll, which sits inside Advanced; the browser may try the anchor before Advanced opens.
    if (portfolioEditMode) document.getElementById("auto-roll")?.scrollIntoView({ block: "start" });
  }, [portfolioEditMode]);

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return { account: address, wallet: wallet.data as WalletClient,
      onConfirmed: async () => {
        await queryClient.invalidateQueries({ queryKey: v2Keys.all });
        await queryClient.invalidateQueries({ queryKey: ["v2", "writerBalance", address, ticker] });
        await queryClient.invalidateQueries({ queryKey: ["v2", "writerRoll", address, ticker] });
        await queryClient.invalidateQueries({ queryKey: ["v2", "writerLifetimePremium", address, ticker] });
      } };
  }

  async function act(label: string, task: () => Promise<string>, walletAction = true) {
    setBusy(label);
    try { if (walletAction) notice("pending", label, "Review each requested transaction in your wallet.");
      notice("success", label, await task());
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${label} stopped`, error instanceof Error ? error.message : "Try again after refreshing.");
    }
    finally { setBusy(null); setRollStep(null); }
  }

  async function moveBalance(direction: "deposit" | "withdraw") {
    await act(`${direction === "deposit" ? "Deposit" : "Withdraw"} ${collateralLabel}`, async () => {
      if (direction === "deposit" && ledgerDeposit.note) throw new Error(ledgerDeposit.note);
      if (direction === "deposit" && !canWrite) throw new Error("Deposits are unavailable until the market and indexer configuration are live.");
      if (direction === "deposit" && isPut) await checkPutMarket();
      if (!availability.exitReady || !collateralAsset || !address)
        throw new Error("Connect your wallet and check the configured Clearinghouse address.");
      const amount = parsePositiveAsset(direction === "deposit" ? depositAmount : withdrawAmount, collateralDecimals);
      if (!amount) throw new Error(`Enter a positive ${collateralLabel} amount, up to ${collateralDecimals} decimal places.`);
      const ctx = context();
      if (direction === "deposit") {
        const fresh = await readWriterBalance(address, collateralAsset);
        if (fresh.wallet < amount) throw new Error(`Your wallet does not hold that much ${collateralLabel}.`);
        await approveExact(ctx, collateralAsset, requireV2Address("clearinghouse"), amount);
        await deposit(ctx, collateralAsset, amount);
        setDepositAmount("");
        return `${assetAmount(amount, collateralDecimals)} ${collateralLabel} moved into your free Stonkhouse balance.`;
      }
      const free = await readWriterFree(address, collateralAsset);
      if (free < amount) throw new Error("Only free collateral can be withdrawn. Open asks and short positions may lock the rest.");
      await withdraw(ctx, collateralAsset, amount);
      setWithdrawAmount("");
      return `${assetAmount(amount, collateralDecimals)} ${collateralLabel} returned to your wallet.`;
    });
  }

  async function zapWrite() {
    await act("Zap USDG to Stock Tokens", async () => {
      if (!canWrite || !underlying || !address) throw new Error("Writing contracts are not ready in this build.");
      const amount = parsePositiveAsset(zapUsdgAmount, USDG_DECIMALS);
      if (!amount) throw new Error("Enter a positive USDG amount, up to 6 decimal places.");
      const quote = quoteWriteZap(amount, spot, spotDecimals, 18);
      if (!quote) throw new Error("Live spot is unavailable.");
      const ctx = context();
      const zap = requireV2Address("stockZap");
      await approveExact(ctx, USDG, zap, amount);
      await writeZap(ctx, underlying, amount, spot, spotDecimals, 18, quote.slippageBps);
      setZapUsdgAmount("");
      return `${assetAmount(amount, USDG_DECIMALS)} USDG swapped to Stock Tokens in your free Stonkhouse balance.`;
    });
  }

  async function zapExit() {
    await act("Exit zap Stock Tokens to USDG", async () => {
      if (!availability.exitReady || !underlying || !address)
        throw new Error("Connect your wallet and check the configured Clearinghouse address.");
      const amount = parsePositiveAsset(exitZapAmount, 18);
      if (!amount) throw new Error("Enter a positive Stock Token amount, up to 18 decimal places.");
      const quote = quoteExitZap(amount, spot, spotDecimals, 18);
      if (!quote) throw new Error("Live spot is unavailable.");
      const ctx = context();
      const zap = requireV2Address("stockZap");
      await approveExact(ctx, underlying, zap, amount);
      await exitZap(ctx, underlying, amount, spot, spotDecimals, 18, quote.slippageBps);
      setExitZapAmount("");
      return `${assetAmount(amount, 18)} Stock Tokens sold for USDG.`;
    });
  }

  async function checkPutMarket() {
    const refreshed = await markets.refetch();
    const current = refreshed.data?.find((row) => row.ticker === ticker);
    if (refreshed.isError || !current || current.status !== "live" || !current.spot || !current.puts ||
      !underlying || current.underlying.toLowerCase() !== underlying.toLowerCase())
      throw new Error("Put writing is unavailable for this market. Your free USDG can still be withdrawn.");
  }

  function advancePricingRevision(): number {
    const revision = pricingRevision.current + 1;
    pricingRevision.current = revision;
    setPricingRevisionValue(revision);
    return revision;
  }

  function markPricingEdited() {
    advancePricingRevision();
    setPricingCandidate(null);
    setFormTouched(true);
  }

  function editPricingInput(field: PricingInput, value: string) {
    setPricingInputs((before) => ({ ...before, [field]: value }));
    setPricingCommitErrors((before) => ({ ...before, [field]: undefined }));
    markPricingEdited();
  }

  function commitPricingInput(field: PricingInput) {
    const raw = pricingInputs[field];
    if (raw === undefined) return;
    const parsed = parseUsdgTick(raw);
    if (!spot || parsed === null) {
      setPricingCommitErrors((before) => ({ ...before, [field]: `${PRICING_LABELS[field]} must be a positive USDG price in 0.0001 steps.` }));
      return;
    }
    const snapped = snapStrategyPriceToBps(spot, parsed, field);
    if (!snapped) {
      setPricingCommitErrors((before) => ({ ...before, [field]: `${PRICING_LABELS[field]} is outside AutoRoller's 0.5%–10% contract range at the current spot.` }));
      return;
    }
    setStrategyForm((before) => ({ ...before, [PRICING_KEYS[field]]: snapped.bps }));
    setPricingInputs((before) => {
      const next = { ...before };
      delete next[field];
      return next;
    });
    setPricingCommitErrors((before) => ({ ...before, [field]: undefined }));
  }

  function currentPricingRequest(): PricingRequestSnapshot | null {
    const current = pricingState.current;
    if (!current.spot || !current.strikeTick || !current.underlying) return null;
    return { ticker: current.ticker, underlying: current.underlying,
      revision: pricingRevision.current, spot: current.spot, strikeTick: current.strikeTick,
      weekly: current.strategy.weekly, otmBps: current.strategy.otmBps,
      smartPricing: current.strategy.smartPricing };
  }

  function pricingRequestStayedCurrent(requested: PricingRequestSnapshot, actionId: number): boolean {
    const current = currentPricingRequest();
    return pricingAction.current === actionId && current !== null && pricingRequestIsCurrent(requested, current);
  }

  async function refreshCompleteCallList(): Promise<MarketSeriesResponse["items"]> {
    return refreshSmartPricingRows(async () => {
      const refreshed = await allCallSeries.refetch();
      return { items: refreshed.data?.items ?? null, error: refreshed.error };
    });
  }

  async function applyPreset(id: PresetId) {
    await act("Choose a preset", async () => {
      if (!market || !spot || !strikeTick) throw new Error("Market and ladder data are not ready.");
      const requested = currentPricingRequest();
      if (!requested) throw new Error("Market and ladder data are not ready.");
      const actionId = ++pricingAction.current;
      setPricingCandidate(null);
      const freshItems = await refreshCompleteCallList();
      const preset = WRITER_PRESETS.find((row) => row.id === id)!;
      const rows = freshItems.filter((row) => !row.series.isPut && row.series.status === "open" &&
        (row.series.tenor === (preset.weekly ? "weekly" : "daily")));
      if (!rows.length) throw new Error("No open series match that expiry type right now.");
      const resolved = await resolvePresetPricing(id, rows.map((row) => ({
        row, delta: row.quote.delta, fair: row.quote.fair ? BigInt(row.quote.fair.raw) : null,
        strike: BigInt(row.series.strike.raw), expiry: row.series.expiry, tenor: row.series.tenor,
        status: row.series.status,
      })), spot, strikeTick, async (row) => {
        const live = await v2Api.getFair(row.series.longId);
        return live.fair ? BigInt(live.fair.raw) : null;
      });
      const { target, targetStrike, targetFair, reference, referenceFair } = resolved;
      // A preset keeps the plan's own max size (blank = all free tokens) and never copies the one-off
      // "Size in shares" into it: that copy is how a preset plan came out "up to 0.01 shares". The saved maxUnits
      // comes from the Max size field (strategySize), so this value only fills the form's strategy object.
      const size = strategySize === null ? 0n : BigInt(strategySize);
      const filled = presetStrategy(id, spot, referenceFair, size, id === "weekly-delta-15" ? targetStrike : undefined);
      if (!pricingRequestStayedCurrent(requested, actionId))
        throw new Error("The strategy or market changed while the preset was loading. Review the form and try again.");
      const candidateBand = proposedSmartPricingBand(spot, referenceFair);
      const candidatePrices = candidateBand ? smartPricingPrices(spot, candidateBand) : null;
      const revision = advancePricingRevision();
      const reviewedAtMs = Date.now();
      setStrategyForm(filled);
      setPricingInputs({});
      setPricingCommitErrors({});
      setPricingCandidate(reference && referenceFair !== null && candidateBand && candidatePrices ? {
        ticker: requested.ticker, underlying: requested.underlying, spot, strikeTick,
        weekly: filled.weekly, otmBps: filled.otmBps, revision, reviewedAtMs, reference, referenceFair,
        band: candidateBand, prices: candidatePrices,
      } : null);
      setPricingReviewNow(reviewedAtMs);
      setFormTouched(true);
      setExpiryChoice(target.series.expiry);
      setSeriesChoice(target.series.longId);
      setPresetChoice(id);
      return `${preset.label} filled the ask and auto-roll form. Smart pricing stays off until you review and select it.`;
    }, false);
  }

  async function fillProposedBand() {
    await act("Fill proposed band", async () => {
      if (!spot || !strikeTick) throw new Error("Live spot and the market strike tick are required.");
      const requested = currentPricingRequest();
      if (!requested) throw new Error("Live spot and the market strike tick are required.");
      const actionId = ++pricingAction.current;
      setPricingCandidate(null);
      const targetStrike = autoRollTargetStrike(requested.spot, requested.otmBps, requested.strikeTick);
      if (targetStrike === null) throw new Error("Choose a contract-valid strike distance before calculating the band.");
      const freshItems = await refreshCompleteCallList();
      const reference = pricingReference(freshItems, requested.weekly, targetStrike);
      if (!reference) throw new Error(`No open ${requested.weekly ? "weekly" : "daily"} reference series is available. Manual asks remain available.`);
      let freshFair = reference.quote.fair ? BigInt(reference.quote.fair.raw) : null;
      try {
        const live = await v2Api.getFair(reference.series.longId);
        if (live.fair) freshFair = BigInt(live.fair.raw);
      } catch { /* The just-refreshed row remains usable when it includes a fair estimate. */ }
      const band = proposedSmartPricingBand(requested.spot, freshFair);
      const prices = band ? smartPricingPrices(requested.spot, band) : null;
      if (!band || !prices || freshFair === null)
        throw new Error("A current contract-representable reference estimate is unavailable. Manual asks remain available.");
      const fixedAskBps = fixedAskBpsFromReference(requested.spot, freshFair);
      if (!requested.smartPricing && fixedAskBps === null)
        throw new Error("The current reference is outside AutoRoller's contract range. Manual asks remain available.");
      if (!pricingRequestStayedCurrent(requested, actionId))
        throw new Error("The strategy or market changed while the band was loading. Review the form and try again.");
      const revision = advancePricingRevision();
      const reviewedAtMs = Date.now();
      setStrategyForm((before) => ({ ...before, askBps: requested.smartPricing ? band.askBps : fixedAskBps!,
        minAskBps: band.minAskBps, maxAskBps: band.maxAskBps }));
      setPricingInputs({});
      setPricingCommitErrors({});
      setPricingCandidate({ ticker: requested.ticker, underlying: requested.underlying,
        spot: requested.spot, strikeTick: requested.strikeTick, weekly: requested.weekly,
        otmBps: requested.otmBps, revision, reviewedAtMs, reference,
        referenceFair: freshFair, band, prices });
      setPricingReviewNow(reviewedAtMs);
      setFormTouched(true);
      return `Refreshed the complete call list and filled the proposed ${requested.weekly ? "weekly" : "daily"} band. ${requested.smartPricing
        ? "Smart pricing stays selected, but nothing changes on chain until you sign."
        : "Smart pricing remains off; the fixed ask uses the reference price, not the proposed ceiling."}`;
    }, false);
  }

  async function enableRoll() {
    await act("Enable auto-roll", async () => {
      if (!canWrite || !rollerReady || !underlying || !address) throw new Error("AutoRoller is not deployed in this build.");
      if (strategyOn && !formTouched) throw new Error("Load your saved strategy or choose a preset before updating it.");
      if (strategyError || !strategyToSave) throw new Error(strategyError || "Choose a strategy.");
      const requested = currentPricingRequest();
      if (!requested) throw new Error("Live market inputs changed. Refresh the form before enabling auto-roll.");
      const reviewedCandidate = currentCandidate;
      const ctx = context();
      const roller = requireV2Address("autoRoller");
      const freshBalance = await readWriterBalance(address, underlying);
      const freshRoll = await readRollState(address, underlying);
      const freshPrefs = await readPayoutPrefs(address);
      const steps = rollProgressFromChain({ payoutToLedger: freshPrefs.toLedger, rollerOperator: freshBalance.rollerOperator,
        orderBookOperator: freshBalance.orderBookOperator, delegate: freshRoll.delegate });
      for (let key = nextRollStep(steps); key !== null; key = nextRollStep(steps)) {
        setRollStep(key);
        if (key === "payout") await setPayoutToLedger(ctx, true);
        else if (key === "operator") await setOperator(ctx, roller, true);
        else if (key === "bookOperator") await setOperator(ctx, requireV2Address("orderBook"), true);
        else if (key === "delegate") await setDelegate(ctx, roller, true);
        else {
          const refreshed = await markets.refetch();
          const refreshedMarket = refreshed.data?.find((row) => row.ticker === requested.ticker);
          const latest = currentPricingRequest();
          if (refreshed.isError || !refreshedMarket?.spot || !refreshedMarket.strikeTick.raw || !latest)
            throw new Error("Live market inputs could not be refreshed before saving. Review the form and try again.");
          const writeState = pricingWriteState(requested, {
            ...latest,
            underlying: refreshedMarket.underlying,
            spot: BigInt(refreshedMarket.spot.raw),
            strikeTick: BigInt(refreshedMarket.strikeTick.raw),
          }, reviewedCandidate, Date.now(), refreshedMarket.status === "live");
          if (writeState !== "current")
            throw new Error(writeState === "expired"
              ? "The proposed band expired before the strategy write. Refresh and review it again."
              : "The strategy or market changed before the strategy write. Review the form and try again.");
          await setStrategy(ctx, underlying, strategyToSave);
        }
        steps[key] = true;
      }
      return "Auto-roll is on. The keeper can list the next ask from your free balance during a regular market session.";
    });
  }

  async function pauseRoll() {
    await act("Pause auto-roll", async () => {
      if (!availability.pauseReady || !underlying || !address) throw new Error("Connect your wallet and check the configured AutoRoller address.");
      const fresh = await readRollPosition(address, underlying);
      if (!fresh.strategyActive && fresh.orderId === 0n) return "Auto-roll is already paused and has no live roller ask.";
      await stopStrategy(context(), underlying);
      return "Auto-roll is paused. Its live ask was cancelled if one existed. Check Portfolio for separate manual orders.";
    });
  }

  // A saved strategy (what Pause stops and Update overwrites) is not the same as a working one:.
  const strategyOn = roll.data ? roll.data.strategyActive : Boolean(accountStrategy?.strategy.active);
  const rollState = roll.data && balance.data ? rollStatusFromChain({ strategyActive: roll.data.strategyActive,
    rollerOperator: balance.data.rollerOperator, orderBookOperator: balance.data.orderBookOperator,
    delegate: roll.data.delegate }) : null;
  const active = rollState === "active";
  const showPause = strategyOn || (availability.pauseReady && (roll.isPending || roll.isError));
  const nextTime = indexedStrategy?.expiry ? indexedStrategy.expiry + (config.data?.constants.settlementWindow ?? 1_800)
    + (config.data?.constants.finalizeDelay ?? 120) : null;
  // The AutoRoller closed the last position (PositionClosed) and has not rolled a new one yet.
  const closedCall = indexedStrategy ? closedStrategyPosition(indexedStrategy) : null;

  const free = balance.data?.free ?? null;
  const showPosition = Boolean(address) && hasEarnPosition({ free, locked, autoRollActive: strategyOn,
    lifetimePremium: earned.data?.amount ?? null, balanceUnreadable: balance.isError, rollUnreadable: roll.isError });
  const rollStatus = roll.isError ? "Status unavailable" : roll.isPending && !roll.data ? "Checking…"
    : rollState === "active" ? "Active" : rollState === "incomplete" ? "Setup incomplete"
      : strategyOn && balance.isError ? "Status unavailable" : strategyOn && !balance.data ? "Checking…" : "Paused / not set";
  const rollAction = !strategyOn ? "Enable auto-roll" : rollState === "incomplete" ? "Finish setup" : "Update strategy";
  const otmPercent = (strategy.otmBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const contractNotices = provenance.length + overrideConflicts.length > 0;

  const spotNumber = spot !== null ? Number(formatUnits(spot, spotDecimals)) : null;
  const vsSpot = (raw: string, decimals: number) => {
    if (spotNumber === null || spotNumber <= 0) return null;
    const pct = (Number(formatUnits(BigInt(raw), decimals)) / spotNumber - 1) * 100;
    return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  };
  const selectedStrikeId = seriesChoice === "custom" ? "custom" : seriesChoice || chosen?.series.longId || "";
  const shortAsset = isPut ? "USDG" : ticker;
  const walletBalance = balance.data ? assetAmount(balance.data.wallet, collateralDecimals) : null;

  const optionKind = isPut ? "Put" : "Call";
  const fairOf = (row: MarketSeriesResponse["items"][number]) => row.quote.fair ? BigInt(row.quote.fair.raw) : null;
  const spotRaw = spot;
  const firstAboveSpot = spotRaw === null ? -1 : ladder.findIndex((row) => BigInt(row.series.strike.raw) * 10n ** BigInt(spotDecimals) > spotRaw * 10n ** BigInt(row.series.strike.decimals));
  const pickRow = (row: MarketSeriesResponse["items"][number]) => {
    setSeriesChoice(row.series.longId);
  };
  const manualAsk = <section id="manual-ask" aria-label="Manual ask" className="grid gap-5">
    {isPut ? <div>
      <h3 className="flex items-center gap-2 font-display text-lg font-bold">Set your put ask
        <InfoTip label="About put collateral" text="If the stock ends below your strike, the buyer gets the difference from your USDG. Auto-roll only sells calls, so each put ask is set by hand." /></h3>
      <p className="mt-1 text-sm text-ink-2">Each share you sell needs the strike amount in USDG set aside.</p>
    </div> : <div>
      <h3 className="flex items-center gap-2 font-display text-lg font-bold">Sell one call at your own price
        <InfoTip label="About a one-off ask" text="You set the price. Your collateral is only used if a buyer fills. Nothing rolls afterwards: when this call settles, you choose again." /></h3>
      <p className="mt-1 text-sm text-ink-2">Pick an expiry and a strike, then set your price.</p>
    </div>}

    <div className="grid gap-2">
      {(market?.expiries ?? []).length ? <Segments label="Expiry" scroll selected={String(expiry)}
        options={(market?.expiries ?? []).map((time) => ({ value: String(time), label: expiryDay(time) }))}
        onSelect={(value) => { setExpiryChoice(Number(value)); setSeriesChoice(""); }} />
        : <p className="text-sm text-ink-3">No expiries are open right now.</p>}
      {expiry ? <p className="flex items-center gap-1.5 text-[12.5px] text-ink-3">Ends <Time at={expiry} market />
        <InfoTip label="About the expiry" text={`The option ends at this close. The ${isPut ? "USDG" : "Stock Tokens"} behind it stay locked until then and unlock once it settles.`} /></p> : null}
    </div>

    <div role="group" aria-label="Strike" className="min-w-0 overflow-hidden rounded-md border border-line-2 bg-surface-2">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[12px] font-medium text-ink-3">
        <span className="flex items-center gap-1.5">Strike
          <InfoTip label="About the strike" align="start" text={isPut
            ? "The price you agree to buy at. If the stock ends below it, you pay the difference from your USDG."
            : "The price you agree to sell at. Above it, the gain goes to the buyer; below it, you keep all your tokens."} /></span>
        <span className="flex items-center gap-1.5">Mark / share
          <InfoTip label="About the mark" align="end" text="The fair estimate of each call per share. You set your own price in the order below." /></span>
      </div>
      {ladder.map((row, index) => {
        const on = selectedStrikeId === row.series.longId;
        const away = vsSpot(row.series.strike.raw, row.series.strike.decimals);
        const shown = fairOf(row);
        return <div key={row.series.longId}>
          {index === firstAboveSpot && spotRaw !== null ? <SharePriceLine price={usd(spotRaw, spotDecimals)} /> : null}
          <button type="button" aria-pressed={on} onClick={() => pickRow(row)}
            className={cn("flex min-h-14 w-full items-center justify-between gap-4 border-b border-line px-4 py-2.5 text-left transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-accent/40",
              on ? "bg-accent-soft" : "hover:bg-field")}>
            <span className="min-w-0">
              <span className="block text-[15.5px] font-semibold text-ink"><span className="num">${row.series.strike.formatted}</span> {optionKind}</span>
              <span className="mt-0.5 block text-[12.5px] text-ink-3">{away ? `${away} vs share price` : "—"}</span>
            </span>
            <span className="grid shrink-0 justify-items-end gap-0.5">
              <span className={cn("num rounded-pill border px-3.5 py-1.5 text-[14px] font-semibold",
                on ? "border-accent bg-accent text-accent-ink" : "border-accent/50 text-accent-text")}>{shown !== null ? usd(shown) : "—"}</span>
              <span className="text-[11px] text-ink-3">Mark</span>
            </span>
          </button>
        </div>;
      })}
      {ladder.length && firstAboveSpot === -1 && spotRaw !== null ? <SharePriceLine price={usd(spotRaw, spotDecimals)} /> : null}
      {!ladder.length ? <p className="px-4 py-3 text-[13px] text-ink-3">No open strikes for this expiry yet. Use a custom strike to create one.</p> : null}
      <button type="button" aria-pressed={selectedStrikeId === "custom"} onClick={() => setSeriesChoice("custom")}
        className={cn("flex min-h-12 w-full items-center justify-between gap-3 border-t border-dashed border-line-2 px-4 py-2.5 text-left text-[14px] font-semibold transition-colors",
          selectedStrikeId === "custom" ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-field")}>
        Custom strike<span aria-hidden="true" className="text-ink-3">+</span>
      </button>
    </div>
    {seriesChoice === "custom" ? <Field id="custom-strike" className="max-w-xs" label="Custom strike" suffix="USDG" inputMode="decimal"
      value={customStrike} onChange={(event) => setCustomStrike(event.target.value)} placeholder="230.00"
      tip={`Strikes go in steps of ${market?.strikeTick.formatted ?? "—"} USDG. A new strike adds one transaction.`} /> : null}

    <SellTicket key={selectedStrikeId || "none"} ticker={ticker} typeChoice={type} row={selected ?? null}
      customStrike={seriesChoice === "custom" ? parseAskPrice(customStrike) : null} expiry={expiry} />
  </section>;

  const autoRoll = <section aria-label="Auto-roll strategy" className="grid gap-5">
    <div>
      <h3 className="flex items-center gap-2 font-display text-lg font-bold">Sell calls automatically
        <InfoTip label="About auto-roll" text={`Auto-roll sells a covered call from your free ${ticker} during market hours, then the next one after it settles. Deposits must cover the collateral each order needs.`} /></h3>
      <p className="mt-1 text-sm text-ink-2">Pick a plan, review it, and sign once. Pause it any time.</p>
    </div>
    {allCallSeries.isError ? <Notice tone="warn" role="status">The full call list is unavailable right now. You can still pick a plan or set an ask by hand.</Notice> : null}

    <div className="grid gap-2">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">Quick plans
        <InfoTip label="About quick plans" text="A plan fills the settings below from the live call list. Nothing is placed until you review and sign." /></p>
      <div className={cn("grid gap-2", visiblePresets(weeklyOn, dailyOn).length > 1 && "sm:grid-cols-2")} aria-label="Writer presets" role="group">{visiblePresets(weeklyOn, dailyOn).map((preset) => {
        const on = presetChoice === preset.id;
        return <button key={preset.id} type="button" aria-pressed={on} disabled={!!busy || allCallSeries.isFetching || !spot || !strikeTick}
          onClick={() => void applyPreset(preset.id)}
          className={cn("flex min-h-14 items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
            on ? "border-accent bg-accent-soft" : "border-line-2 bg-surface-2 hover:border-ink-3")}>
          <span className="min-w-0"><span className="block font-semibold text-ink">{preset.label}</span>
            <span className="mt-0.5 block text-[12.5px] text-ink-3">{preset.detail}</span></span>
          <span aria-hidden="true" className={cn("grid size-5 shrink-0 place-items-center rounded-pill border-2", on ? "border-accent" : "border-line-2")}>
            {on ? <span className="size-2.5 rounded-pill bg-accent" /> : null}</span>
        </button>;
      })}</div>
    </div>

    <div className="rounded-md border border-line bg-field p-4">
      <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Your plan</p>
      <p className="mt-1.5 text-[15px] leading-relaxed text-ink">Sell a {strategy.weekly ? "weekly" : "daily"} call <span className="font-semibold tabular-nums">{otmPercent}%</span> above the {ticker} price, starting at <span className="font-semibold tabular-nums">{startInput || "—"}</span> USDG per share{strategy.smartPricing
        ? `, with smart pricing between ${minimumInput || "—"} and ${maximumInput || "—"} USDG`
        : ""}, {maxShares.trim() ? `up to ${maxShares} shares` : "using all your free tokens"}.</p>
      {address && underlying && rollerReady ? <p data-slot="roll-preview" className="mt-2 border-t border-line pt-2 text-[13px] text-ink-2">
        {rollPreview.isPending ? "Checking what the next roll would place…"
          : formatRollPreview(rollPreview.data ?? { ok: false })}
      </p> : null}
    </div>
    {portfolioEditMode ? <Notice tone="info" role="status">{indexedStrategy
      ? "Your saved strategy is loaded into this form. Review the USDG band below; nothing changes on chain until Update strategy passes the current checks and you sign."
      : strategies.isError ? "The saved strategy could not be loaded. Return to Portfolio and retry when strategy data recovers."
        : "Loading the saved strategy for this wallet and underlying…"}</Notice> : null}

    <Disclosure title="Customize plan" summary="Cycle, strike distance, starting price, size and smart pricing" open={portfolioEditMode} className="bg-surface-2">
      <section id="auto-roll" aria-label="Auto-roll settings" className="grid gap-5">
        <p className="text-[13px] text-ink-3">These fill your plan above. Nothing changes on chain until you press {rollAction} and sign.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField id="roll-cycle" label="Cycle" disabled={!!busy} value={strategy.weekly ? "weekly" : "daily"}
            tip="Daily calls end at each market close. Weekly calls end at Friday's close."
            onChange={(event) => { setStrategyForm((before) => ({ ...before, weekly: event.target.value === "weekly" })); setPresetChoice(null); markPricingEdited(); }}>
            {cycleOptions(weeklyOn, strategy, dailyOn).map((cycle) => <option key={cycle} value={cycle}>{cycle === "weekly" ? "Weekly" : "Daily"}</option>)}</SelectField>
          <Field id="roll-otm" label="Strike above price" suffix="%" inputMode="decimal" disabled={!!busy}
            value={otmInput ?? String(strategy.otmBps / 100)}
            tip="How far above the current price each call's strike sits, from 1% to 25%. Saved in basis points (100 bps = 1%)."
            onChange={(event) => {
              setOtmInput(event.target.value);
              const bps = Math.round(Number(event.target.value) * 100);
              if (event.target.value.trim() !== "" && Number.isFinite(bps)) { setStrategyForm((before) => ({ ...before, otmBps: bps })); setPresetChoice(null); markPricingEdited(); }
            }} onBlur={() => setOtmInput(null)} />
          <Field id="roll-start" label="Starting ask" suffix="USDG / share" inputMode="decimal" maxLength={32} disabled={!!busy} value={startInput}
            tip={`Saved as ${strategy.askBps} bps of the price after you leave the field. Values between whole bps round up to protect your ask; 0.0001 USDG tick.`}
            onChange={(event) => editPricingInput("start", event.target.value)} onBlur={() => commitPricingInput("start")}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <Field id="roll-max" label="Max size" suffix="shares" disabled={!!busy} value={maxShares} placeholder="All free"
            tip="Blank means all free collateral." onChange={(event) => { setMaxShares(event.target.value); setFormTouched(true); }} />
        </div>

        <div className="grid gap-3 rounded-md border border-line bg-surface p-4">
          <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink"><input disabled={smartPricingControl.disabled} type="checkbox" className="size-4 shrink-0 accent-[var(--accent)]" checked={strategy.smartPricing} onChange={(event) => {
            const smartPricing = event.target.checked;
            const proposal = currentCandidate?.band ?? null;
            if (smartPricing) {
              const draft = spot ? smartPricingDraft(spot, strategy, proposal) : null;
              if (!draft) {
                setPricingCommitErrors((before) => ({ ...before, start: "A contract-valid smart-pricing band is unavailable at the current spot." }));
                return;
              }
              setStrategyForm((before) => ({ ...before, smartPricing: true, ...draft }));
            } else {
              const fixedAskBps = currentCandidate
                ? fixedAskBpsFromReference(currentCandidate.spot, currentCandidate.referenceFair) : null;
              setStrategyForm((before) => ({ ...before, smartPricing: false,
                askBps: fixedAskBps ?? before.askBps, minAskBps: 0, maxAskBps: 0 }));
            }
            const revision = advancePricingRevision();
            setPricingCandidate((before) => before && candidateState === "current"
              ? { ...before, revision } : before);
            setPricingInputs({});
            setPricingCommitErrors({});
            setFormTouched(true);
          }} /> Smart pricing within my limits
            <InfoTip label="About smart pricing" text={strategy.smartPricing
              ? "These USDG prices convert at current spot; the contract stores bps, so their USDG values move with spot. During configured market sessions, the pricer checks on its cadence, targets its fair estimate plus its configured edge, rounds to the 0.0001 USDG tick, and clamps every move inside this band. It may leave the ask unchanged. If pricing stops, the last ask stays live at its last price."
              : "The USDG input converts to bps at current spot. Auto-roll uses those bps with spot when each fixed ask starts. No service may move it while smart pricing is off; hidden minimum and maximum fields are saved as zero."} /></label>
          {smartPricingControl.note ? <Notice tone="info">{smartPricingControl.note}</Notice> : null}
          {strategy.smartPricing ? <div className="grid gap-4 sm:grid-cols-2">
            <Field id="roll-min" label="Minimum ask" suffix="USDG / share" inputMode="decimal" maxLength={32} disabled={!!busy} value={minimumInput}
              tip={`Saved as ${strategy.minAskBps} bps after you leave the field; 0.0001 USDG tick.`}
              onChange={(event) => editPricingInput("minimum", event.target.value)} onBlur={() => commitPricingInput("minimum")}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <Field id="roll-maxask" label="Maximum ask" suffix="USDG / share" inputMode="decimal" maxLength={32} disabled={!!busy} value={maximumInput}
              tip={`Saved as ${strategy.maxAskBps} bps after you leave the field. Values between whole bps round up; 0.0001 USDG tick.`}
              onChange={(event) => editPricingInput("maximum", event.target.value)} onBlur={() => commitPricingInput("maximum")}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          </div> : null}
          <div className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 font-semibold text-ink">Proposed wide band
                <InfoTip label="About the proposed band" text={<>Filling the candidate changes this form only. {strategy.smartPricing ? "Nothing changes on chain until you sign." : "Smart pricing remains off until you select it and sign."} Starting high reduces the initial underpricing window; it does not guarantee a fill or future value.</>} /></p>
              {currentCandidate ? <p className="mt-1 text-ink-2">From the {currentCandidate.weekly ? "weekly" : "daily"} ${currentCandidate.reference.series.strike.formatted} call ending <Time at={currentCandidate.reference.series.expiry} market />, estimated at ${money(currentCandidate.referenceFair)} USDG. In smart mode it starts at {money(currentCandidate.prices.start)} and moves between {money(currentCandidate.prices.min)} and {money(currentCandidate.prices.max)} USDG per share.</p>
                : <p className="mt-1 text-ink-3">Refresh the complete call list to calculate a current candidate. You can still set contract-valid limits by hand.</p>}
            </div>
            <Button type="button" size="sm" variant="secondary" disabled={!!busy || allCallSeries.isFetching || !spot || !strikeTick} onClick={() => void fillProposedBand()}>Fill proposed band</Button>
          </div>
        </div>
      </section>
    </Disclosure>

    {strategyError ? <p role="alert" className="text-sm text-danger">{strategyError}</p> : null}
    {!rollerReady ? <Notice tone="info">AutoRoller is not deployed in this build.</Notice> : null}
    {address && ROLL_STEPS.every((step) => progress[step.key]) ? <p className="flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-pill bg-accent text-[12px] font-bold text-accent-ink">✓</span>
      Setup complete: all five permissions are on chain.
      <InfoTip label="About the setup" text="Payouts to your balance, AutoRoller and order-book access, the delegate and your strategy are all in place. Pause auto-roll any time." />
    </p> : address ? <div className="grid gap-2">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">Setup, up to five transactions
        <InfoTip label="About the setup" text="Your wallet asks for each missing permission once. Confirmed setup steps stay on chain, so you can return and continue." /></p>
      <ol className="grid gap-1.5">{ROLL_STEPS.map((step, index) => {
        const done = progress[step.key];
        const confirming = rollStep === step.key;
        return <li key={step.key} className="flex items-center gap-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
          <span aria-hidden="true" className={cn("num grid size-6 shrink-0 place-items-center rounded-pill text-[12px] font-bold",
            done ? "bg-accent text-accent-ink" : confirming ? "bg-warn-soft text-warn" : "border border-line-2 text-ink-3")}>{done ? "✓" : index + 1}</span>
          <span className="min-w-0 flex-1 text-ink">{step.label}</span>
          <span className="shrink-0 text-xs text-ink-3">{done ? "Done" : confirming ? "Confirming…" : "Needed"}</span>
        </li>;
      })}</ol>
    </div> : null}
    <div className="flex flex-wrap gap-3">
      <Button disabled={!canWrite || !rollerReady || !balance.data || !roll.data || !!busy || !!strategyError || (strategyOn && !formTouched)} onClick={() => void enableRoll()}>
        {busy === "Enable auto-roll" ? "Confirming setup…" : rollAction}</Button>
      {strategyOn && indexedStrategy ? <Button variant="ghost" disabled={!!busy} onClick={() => {
        advancePricingRevision();
        setStrategyForm(indexedStrategy.strategy);
        setPricingInputs({});
        setPricingCommitErrors({});
        setPricingCandidate(null);
        setMaxShares(indexedStrategy.strategy.maxUnits === "0" ? "" : formatUnits(BigInt(indexedStrategy.strategy.maxUnits), 2));
        setFormTouched(true);
      }}>Load saved strategy into form</Button> : null}
    </div>
    {strategyOn && !formTouched ? <p className="text-[13px] text-ink-3">Load the saved strategy or select a preset to {rollState === "incomplete" ? "finish the setup" : "update it"}.</p> : null}
  </section>;

  const swap = <section aria-label="Swap USDG and Stock Tokens" className="grid gap-5">
    <div>
      <h3 className="flex items-center gap-2 font-display text-lg font-bold">Swap between USDG and {ticker}
        <InfoTip label="About the swap" text={`Buy ${ticker} Stock Tokens with USDG straight into your free StonkHouse balance, ready to sell calls on, or sell ${ticker} from your wallet for USDG.`} /></h3>
      <p className="mt-1 text-sm text-ink-2">No {ticker} yet? Buy it with USDG in one step.</p>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-3 rounded-md border border-line bg-surface-2 p-4">
        <p className="font-semibold text-ink">Buy {ticker}</p>
        <Field id="writer-zap-in" label="You pay" suffix="USDG" inputMode="decimal" value={zapUsdgAmount}
          onChange={(event) => setZapUsdgAmount(event.target.value)} placeholder="100"
          tip="Swaps into your free Stonkhouse balance, ready to sell calls on." />
        <Rows>
          <Row dense k="Minimum received" v={writeZapQuote ? `${assetAmount(writeZapQuote.minOut, 18)} ${ticker}` : "—"} />
          <Row dense k="Slippage tolerance" tip="The swap reverts if the price moves more than this before it lands." v={displayPercent(ZAP_SLIPPAGE_BPS_DEFAULT / 100)} />
        </Rows>
        <PayoutTiming of={zapTiming} />
        <Button disabled={!canWrite || !zapReady || !writeZapQuote || !!busy}
          onClick={() => void zapWrite()}>{zapReady ? "Zap in" : zapOffLabel}</Button>
      </div>
      <div className="grid content-start gap-3 rounded-md border border-line bg-surface-2 p-4">
        <p className="font-semibold text-ink">Sell {ticker}</p>
        <Field id="writer-zap-out" label="You sell" suffix={ticker} inputMode="decimal" value={exitZapAmount}
          onChange={(event) => setExitZapAmount(event.target.value)} placeholder="0.25"
          tip="Sells wallet-held tokens. Withdraw free collateral first if it is still in Stonkhouse." />
        <Rows>
          <Row dense k="Minimum received" v={exitZapQuote ? `${assetAmount(exitZapQuote.minOut, USDG_DECIMALS)} USDG` : "—"} />
          <Row dense k="Slippage tolerance" tip="The swap reverts if the price moves more than this before it lands." v={displayPercent(ZAP_SLIPPAGE_BPS_DEFAULT / 100)} />
        </Rows>
        <PayoutTiming of={zapTiming} />
        <Button variant="secondary"
          disabled={!availability.exitReady || !zapReady || !exitZapQuote || spot === null || !!busy}
          onClick={() => void zapExit()}>{zapReady ? "Exit zap" : zapOffLabel}</Button>
      </div>
    </div>
    {zapMismatch ? <Notice tone="warn" role="status">{zapMismatch}</Notice> : null}
  </section>;

  const contractDetails = contractNotices ? <Disclosure title="Contract details" summary="Where this build's contract addresses come from" className="mt-5">
    <section aria-label="Contract details" className="grid gap-3">
      {/*
        Provenance, and deliberately NOT part of `mismatch`. An address served from a
        build-time override must be visible — an override that is silently correct in dev is
        indistinguishable from one that is silently unreported — but it is not a reason to pause
        writing, which is what joining that array would have done.
      */}
      {provenance.length ? <Notice tone="info">{provenance.join(" ")}</Notice> : null}
      {/* An override the registry outranked: shown, and like provenance never part of `mismatch`. */}
      {overrideConflicts.length ? <Notice tone="warn">{overrideConflicts.join(" ")}</Notice> : null}
    </section>
  </Disclosure> : null;

  const depositForm = <section aria-label="Writer deposit" className="grid gap-3">
    <Field id="writer-deposit" label="Amount to deposit" suffix={shortAsset} inputMode="decimal" value={depositAmount}
      onChange={(event) => setDepositAmount(event.target.value)} placeholder={isPut ? "100" : "0.25"}
      tip="Your wallet may ask you to approve this exact amount first."
      aside={balance.data ? <span>Wallet {walletBalance} · <button type="button" className="font-semibold text-accent-text hover:underline"
        onClick={() => setDepositAmount(formatUnits(balance.data!.wallet, collateralDecimals))}>Max</button></span> : "Wallet —"} />
    <WithdrawalTerms className="mt-3" surface="writer" asset={shortAsset}
      free={balance.data ? assetAmount(balance.data.free, collateralDecimals) : null}
      locked={locked !== null ? assetAmount(locked, collateralDecimals) : null}
      latestExpiry={latestLockedExpiry} timing={config.data?.constants ?? null} />
    {ledgerDeposit.note ? <p data-slot="upgrade-paused" role="status" className="text-sm text-ink-2">{ledgerDeposit.note}</p> : null}
    <Button className="w-full" disabled={!ledgerDeposit.open || !balance.data || !!busy || !parsePositiveAsset(depositAmount, collateralDecimals)} onClick={() => void moveBalance("deposit")}>Deposit</Button>
    {!isPut ? <p className="text-center text-[13px] text-ink-3">No {ticker} yet? <button type="button" className="font-semibold text-accent-text hover:underline"
      onClick={() => setSellTab("swap")}>Buy it with USDG</button></p> : null}
  </section>;

  const withdrawForm = <section aria-label="Writer withdraw" className="grid gap-3">
    <Field id="writer-withdraw" label={`Withdraw free ${collateralLabel}`} suffix={shortAsset} inputMode="decimal" value={withdrawAmount}
      onChange={(event) => setWithdrawAmount(event.target.value)} placeholder={isPut ? "100" : "0.25"}
      tip="Locked collateral cannot be withdrawn."
      aside={free !== null ? <span>Free {assetAmount(free, collateralDecimals)} · <button type="button" className="font-semibold text-accent-text hover:underline"
        onClick={() => setWithdrawAmount(formatUnits(free, collateralDecimals))}>Max</button></span> : undefined} />
    <PayoutTiming of={ledgerWithdrawTiming} />
    <Button className="w-full" variant="secondary" disabled={!availability.exitReady || !!busy || !parsePositiveAsset(withdrawAmount, collateralDecimals)} onClick={() => void moveBalance("withdraw")}>Withdraw</Button>
  </section>;

  return <>
    <PageHead eyebrow="Sell options" title={isPut ? `Earn premium with USDG on ${ticker}` : `Earn premium on your ${ticker}`} lede={isPut
      ? `Sell cash-secured puts on ${ticker} with USDG and earn the premium buyers pay. You cover any fall below your strike.`
      : `Sell covered calls on your ${ticker} Stock Tokens and earn the premium buyers pay. You give up any gain above your strike.`} />
    {putsEnabled ? <SegmentedControl className="mb-5" label="Option type to write" selected={activeType} disabled={!!busy}
      options={[{ value: "call", label: "Calls" }, { value: "put", label: "Puts" }] as const}
      onSelect={(kind) => { advancePricingRevision(); pricingAction.current += 1; setPricingCandidate(null);
        setType(kind); setSeriesChoice(""); setExpiryChoice(0); setDepositAmount(""); setWithdrawAmount("");
        setZapUsdgAmount(""); setExitZapAmount(""); }} /> : null}
    <EarnFacts ticker={ticker} isPut={isPut} />
    {markets.isError || series.isError ? <Notice tone="warn" role="status" className="mb-5">Market data is unavailable right now. Your balance is unaffected.</Notice> : null}
    {market && !market.spot ? <Notice tone="warn" role="status" className="mb-5">The live {ticker} price is unavailable. New deposits and asks are paused; you can still withdraw.</Notice> : null}
    {!contractReady ? <Notice tone="info" className="mb-5">Selling options isn&apos;t available here yet.</Notice> : null}
    {mismatch.length ? <Notice tone="warn" className="mb-5">App and indexer contract settings differ. Writing is paused until they match.</Notice> : null}

    {showPosition ? <Panel as="section" aria-label="Your position" className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold tracking-[-0.01em]">Your position</h2>
        {showPause ? <Button size="sm" variant="ghost" disabled={!availability.pauseReady || !!busy} onClick={() => void pauseRoll()}>Pause auto-roll</Button> : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
        <Stat size="sm" label={<StatLabel tip="Yours to withdraw or sell.">Free</StatLabel>} value={free !== null ? assetAmount(free, collateralDecimals) : "—"} unit={isPut ? "USDG" : ticker} />
        <Stat size="sm" label={<StatLabel tip="Backs the options you sold. It unlocks after each one settles.">{isPut ? "Locked in sold puts" : "Locked in sold calls"}</StatLabel>} value={locked !== null ? assetAmount(locked, collateralDecimals) : "—"}
          unit={isPut ? "USDG" : ticker} sub={latestLockedExpiry ? <>Unlocks from {timeText({ at: latestLockedExpiry, market: true }, zone)}</> : undefined} />
        <Stat size="sm" label={<StatLabel tip={earned.data && !earned.data.complete ? "More history pages remain, so this is the premium in the history loaded so far." : "Premium paid to you so far."}>{earned.data ? (earned.data.complete ? "Lifetime premium" : "Premium in loaded history") : "Premium earned"}</StatLabel>}
          value={earned.data ? money(earned.data.amount) : "—"} unit="USDG"
          sub={earned.data ? undefined : earned.isError ? "Premium history is temporarily unavailable." : "Loading premium history…"} />
        {!isPut ? <Stat size="sm" mono={false} label="Auto-roll" value={rollStatus}
          sub={rollState === "incomplete" ? "A permission is missing, so nothing rolls: finish the setup below"
            : nextTime ? `Next possible roll ${timeText({ at: nextTime, market: true }, zone)}`
              : active && closedCall ? "Last call closed; the next roll opens a new one"
                : active ? "Next roll after the next expiry" : "Sell calls automatically below"} /> : null}
      </div>
      {!isPut && (strategyOn || accountStrategy) ? <p className="mt-4 flex flex-wrap items-center gap-x-1.5 border-t border-line pt-3 text-[13px] text-ink-2">
        <span>Current call: {accountStrategy?.currentSeries ? `${accountStrategy.currentSeries.ticker} $${accountStrategy.currentSeries.strike.formatted}`
          : closedCall ? <>none, the last one closed on <Time at={closedCall.at} /></> : "none"} · order {accountStrategy?.orderId ?? "none"} ·
        last roll {indexedStrategy?.lastRolledAt ? <Time at={indexedStrategy.lastRolledAt} /> : "not recorded"}.</span>
        <InfoTip label="About the next roll" text="The exact next roll also waits for settlement and the next regular market session." />
      </p> : null}
      {indexedStrategy?.lastStaleCancelAt && indexedStrategy.currentLongId && !indexedStrategy.orderId ? <Notice tone="info" role="status" className="mt-3">Ask withdrawn at/past strike after spot reached ${indexedStrategy.staleSpot?.formatted ?? "—"} on <Time at={indexedStrategy.lastStaleCancelAt} />. The existing position remains; the next roll waits until after its expiry.</Notice> : null}
      {balance.isError ? <Notice tone="warn" role="status" className="mt-4">Your balance could not be read. A withdrawal can retry the free-balance check on chain before signing.</Notice> : null}
      {roll.isError ? <Notice tone="warn" className="mt-4">Auto-roll status could not be read. You can retry after the chain responds.</Notice> : null}
    </Panel> : null}

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
      <Panel as="aside" aria-label="Writer balance" className="lg:sticky lg:top-6 lg:order-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">Your {shortAsset}
            <InfoTip label="About your balance" text={`Deposit ${collateralLabel} into your StonkHouse balance first. Free balance backs the ${isPut ? "puts" : "calls"} you sell and can be withdrawn any time; what backs a sold option stays locked until it settles.`} /></h2>
        </div>
        {!address ? <div className="mt-3 grid gap-3">
          <p className="text-sm text-ink-2">Connect a wallet to see your {collateralLabel} and deposit.</p>
          <ConnectButton />
        </div> : <div className="mt-4">{showPosition
          ? <Tabs label="Balance action" value={balanceTab} onChange={setBalanceTab}
            items={[{ value: "deposit", label: "Deposit", panel: depositForm }, { value: "withdraw", label: "Withdraw", panel: withdrawForm }]} />
          : depositForm}</div>}
      </Panel>

      <Panel as="section" aria-label="Start earning" className="lg:order-1">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold tracking-[-0.01em]">{showPosition ? "Earn more" : "Start earning"}
            <InfoTip label="How selling works" text={isPut
              ? "Two steps: deposit USDG, then set the price a buyer pays for your put."
              : `Two steps: deposit ${ticker}, then let auto-roll sell calls on it for you, or sell one call at your own price.`} /></h2>
        </div>
        {isPut ? manualAsk : <Tabs label="How to sell" value={sellTab} onChange={setSellTab} items={[
          { value: "auto", label: "Auto-roll", badge: "Simple", panel: autoRoll },
          { value: "once", label: "Sell once", panel: manualAsk },
          { value: "swap", label: `Get ${ticker}`, panel: swap },
        ]} />}
      </Panel>
    </div>
    {contractDetails}
  </>;
}

function TicketStep({ n, title, tip, children }: { n: number; title: string; tip?: ReactNode; children: ReactNode }) {
  return <div className="grid gap-3">
    <p className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
      <span aria-hidden="true" className="num grid size-6 shrink-0 place-items-center rounded-pill bg-accent-soft text-[12px] font-bold text-accent-text">{n}</span>
      {title}{tip ? <InfoTip label={`About ${title.toLowerCase()}`} text={tip} /> : null}
    </p>
    <div className="min-w-0">{children}</div>
  </div>;
}


function StatLabel({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{children}<InfoTip text={tip} /></span>;
}



function SharePriceLine({ price }: { price: string }) {
  return <div className="flex items-center gap-3 border-b border-line bg-field px-4 py-1.5 text-[12px] font-semibold text-ink-2">
    <span aria-hidden="true" className="h-px flex-1 bg-accent/50" />
    <span>Share price <span className="num text-ink">{price}</span></span>
    <span aria-hidden="true" className="h-px flex-1 bg-accent/50" />
  </div>;
}
