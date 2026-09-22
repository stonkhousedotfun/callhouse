"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { FairProvenanceNote } from "@/components/v2/FairProvenanceNote";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel, Segments } from "@/components/ui";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { PendingOperationsNotice } from "@/components/v2/PendingOperationsNotice";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { v2Markets } from "@/lib/markets";
import { v2Api } from "@/lib/v2/api";
import type { MarketSeriesResponse, Strategy } from "@/lib/v2/api-types";
import { lifetimePremium } from "@/lib/v2/historySummary";
import { stamp } from "@/lib/v2/time";
import { V2_DEPLOYMENT, requireV2Address, v2AddressProvenanceNotices, v2ContractAddress,
  v2ConfigWarnings } from "@/lib/v2/config";
import { readPayoutPrefs } from "@/lib/v2/chainReads";
import { earnActionAvailability } from "@/lib/v2/earnAccess";
import { createSeries, nextAskExpiry, preflightAsk, readMintCutoff, readRollPosition, readRollState, readWriterBalance, readWriterFree, readWriterRent,
  setDelegate, setStrategy, stopStrategy } from "@/lib/v2/earnTx";
import { useAllMarketSeries, useConfig, useFair, useMarketSeries, useMarkets, usePositions, useStrategies, v2Keys } from "@/lib/v2/hooks";
import { collateralPerUnit, sharesToUnits, shortOutcome } from "@/lib/v2/payoff";
import { presetStrategy, resolvePresetPricing, retainedSharesAtExpiry, roundAskToTick, writerQuote,
  WRITER_PRESETS, type PresetId } from "@/lib/v2/presets";
import { nextRollStep, rollProgressFromChain, ROLL_STEPS, validateRollStrategy } from "@/lib/v2/rollSetup";
import { autoRollStartPrice, autoRollTargetStrike, fixedAskBpsFromReference, formatUsdgTick, parseUsdgTick,
  pricingRequestIsCurrent, pricingWriteState, proposedSmartPricingBand, refreshSmartPricingRows, selectSmartPricingReference,
  smartPricingCandidateState, smartPricingDraft, smartPricingPrices, snapStrategyPriceToBps,
  strategyPriceAtBps, SMART_PRICING_REVIEW_MS,
  type PricingRequestSnapshot, type ProposedSmartPricingBand, type SmartPricingPrices,
  smartPricingOffer, SMART_PRICING_PRICER_UNKNOWN, type SmartPricingOffer,
  type SmartPricingCandidateSnapshot, type StrategyPriceField } from "@/lib/v2/smartPricing";
import { selectTradeSpot } from "@/lib/v2/marketSpot";
import { approveExact, deposit, place, setOperator, setPayoutToLedger, withdraw, type WriteContext } from "@/lib/v2/tx";
import { exitZap, quoteExitZap, quoteWriteZap, writeZap, ZAP_SLIPPAGE_BPS_DEFAULT } from "@/lib/v2/zapTx";

const assetAmount = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const money = (raw: bigint) => Number(formatUnits(raw, 6)).toLocaleString("en-US", { maximumFractionDigits: 4 });

const parsePositiveAsset = (raw: string, decimals: number): bigint | null => {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
};
const parseAskPrice = (raw: string): bigint | null => {
  try { const price = parseUnits(raw, 6); return price > 0n && price % 100n === 0n ? price : null; } catch { return null; }
};

const EMPTY_STRATEGY: Strategy = { active: true, weekly: true, smartPricing: false, otmBps: 500,
  askBps: 100, minAskBps: 0, maxAskBps: 0, maxUnits: "1" };

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

export type EarnStage = "deposit" | "ask" | "automate";

/**
 * W3-301: whether the smart-pricing checkbox may be TICKED, and what to say when it may not.
 *
 * SEPARATED FROM THE COMPONENT so it can be asserted without a renderer — this package has no
 * render test, and the alternative is a `disabled={...}` expression inside JSX that nothing can
 * check. A gate nothing can test is the shape this row exists to remove, so it would be an odd
 * way to close it.
 *
 * `disabled` when the pricer is not known-healthy, but ONLY while the control is not already on.
 * Locking a user out of turning smart pricing OFF because the pricer died would be a worse trap
 * than the one this row removes, and AC5 is explicit that an already-live ask is not this row's
 * business: it stays live at its last price, and the user keeps the ability to stand it down.
 */
export function smartPricingControlState(
  offer: SmartPricingOffer, alreadyOn: boolean, busy: boolean,
): { disabled: boolean; note: string | null } {
  const blocked = !offer.offered && !alreadyOn;
  return { disabled: busy || blocked, note: offer.offered ? null : offer.note };
}

export function stageAfterEarnAction(stage: EarnStage, action: "deposit" | "ask", isPut: boolean): EarnStage {
  if (action === "deposit") return "ask";
  return isPut ? stage : "automate";
}

/** The Portfolio edit link is explicit; unrelated query values must not preload a strategy. */
export function portfolioStrategyEditRequested(search: string): boolean {
  return new URLSearchParams(search).get("edit") === "smart-pricing";
}

export function EarnMarket({ ticker }: { ticker: string }) {
  const { address } = useAccount();
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const queryClient = useQueryClient();
  const markets = useMarkets();
  const registryMarket = v2Markets().find((row) => row.ticker === ticker);
  const market = markets.data?.find((row) => row.ticker === ticker);
  const [type, setType] = useState<"call" | "put">("call");
  const [stage, setStage] = useState<EarnStage>("deposit");
  const isPut = type === "put";
  const activeType = type;
  const series = useMarketSeries(ticker, { type: activeType, limit: 200 });
  const allCallSeries = useAllMarketSeries(ticker, { type: "call", status: "open" }, { enabled: false });
  const config = useConfig();
  const positions = usePositions(address);
  const strategies = useStrategies({ active: true, limit: 200 });
  const underlying = registryMarket?.asset ?? null;
  const collateralAsset = isPut ? USDG : underlying;
  const collateralDecimals = isPut ? 6 : 18;
  const collateralLabel = isPut ? "USDG" : "Stock Tokens";
  const [expiryChoice, setExpiryChoice] = useState(0);
  const [seriesChoice, setSeriesChoice] = useState("");
  const [customStrike, setCustomStrike] = useState("");
  const [shares, setShares] = useState("0.01");
  const [askPrice, setAskPrice] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [zapUsdgAmount, setZapUsdgAmount] = useState("");
  const [exitZapAmount, setExitZapAmount] = useState("");
  const [strategy, setStrategyForm] = useState<Strategy>(EMPTY_STRATEGY);
  const [pricingInputs, setPricingInputs] = useState<Partial<Record<PricingInput, string>>>({});
  const [pricingCommitErrors, setPricingCommitErrors] = useState<Partial<Record<PricingInput, string>>>({});
  const [pricingCandidate, setPricingCandidate] = useState<PricingCandidate | null>(null);
  const [pricingReviewNow, setPricingReviewNow] = useState(() => Date.now());
  const [pricingRevisionValue, setPricingRevisionValue] = useState(0);
  const [portfolioEditMode, setPortfolioEditMode] = useState(false);
  const [maxShares, setMaxShares] = useState("0.01");
  const [formTouched, setFormTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rollStep, setRollStep] = useState<string | null>(null);
  const pricingRevision = useRef(0);
  const pricingAction = useRef(0);
  const portfolioEditLoaded = useRef(false);

  const expiry = expiryChoice || market?.expiries[0] || 0;
  const ladder = matchedSeries(series.data?.items ?? [], expiry, isPut);
  const chosen = seriesChoice && seriesChoice !== "custom" ? ladder.find((row) => row.series.longId === seriesChoice) : ladder[0];
  const selected = seriesChoice === "custom" ? null : chosen;
  const fairQuery = useFair(selected?.series.longId);
  const fair = fairQuery.data?.fair?.raw ? BigInt(fairQuery.data.fair.raw)
    : selected?.quote.fair?.raw ? BigInt(selected.quote.fair.raw) : null;
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
  const price = parseAskPrice(askPrice);
  const units = useMemo(() => { try { return sharesToUnits(shares); } catch { return null; } }, [shares]);
  const strike = selected ? BigInt(selected.series.strike.raw) : seriesChoice === "custom" ? parseAskPrice(customStrike) : null;
  const quote = price && units && config.data ? writerQuote(price, units, config.data.fees.premiumFeeBps, fair) : null;
  const requiredCollateral = strike && units ? collateralPerUnit(isPut, strike) * units : null;
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
  const mismatch = config.data ? [
    ...v2ConfigWarnings(config.data),
    ...(isPut && config.data.usdg.address.toLowerCase() !== USDG.toLowerCase() ? ["USDG address differs from this app."] : []),
  ] : [];
  const provenance = v2AddressProvenanceNotices();
  // W3-301: the pricer runs in the keeper, not here, so its readiness comes from the indexer's
  // /v2/services (T-424). `retry: false` is deliberate — a retrying query stays `pending` longer,
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
  // NOT `V2_DEPLOYMENT.contracts.stockZap`. That read is the registry alone, and no registry can
  // ever fill this key — its name is in neither generator's V2_CONTRACT_NAMES, and assertExactKeys
  // rejects an unknown key, so the value was null forever and this flag was false forever. A check
  // that reports "not configured" because it cannot see its subject is the false-green this row
  // exists to remove; `v2ContractAddress` consults the validated override as well.
  const zapConfigured = Boolean(v2ContractAddress("stockZap"));
  const zapUsdg = parsePositiveAsset(zapUsdgAmount, USDG_DECIMALS);
  const writeZapQuote = !isPut && zapUsdg ? quoteWriteZap(zapUsdg, spot, spotDecimals, 18) : null;
  const exitZapIn = parsePositiveAsset(exitZapAmount, 18);
  const exitZapQuote = !isPut && exitZapIn ? quoteExitZap(exitZapIn, spot, spotDecimals, 18) : null;

  const balance = useQuery({ queryKey: ["v2", "writerBalance", address, ticker, collateralAsset],
    enabled: Boolean(address && collateralAsset && V2_DEPLOYMENT.contracts.clearinghouse),
    queryFn: () => readWriterBalance(address!, collateralAsset!), staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const rentQuote = useQuery({ queryKey: ["v2", "writerRent", underlying, isPut, strike?.toString(), expiry, units?.toString(), address],
    enabled: Boolean(contractReady && underlying && strike && expiry && units),
    queryFn: () => readWriterRent(underlying!, isPut, strike!, expiry, units!, address),
    staleTime: 15_000, refetchInterval: 15_000, retry: 0 });
  const writerRent = !rentQuote.isError ? rentQuote.data?.rent ?? null : null;
  const totalCollateral = requiredCollateral !== null && writerRent !== null ? requiredCollateral + writerRent : null;
  const hasCollateral = totalCollateral !== null && rentQuote.data?.free !== null && rentQuote.data?.free !== undefined && rentQuote.data.free >= totalCollateral;
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
    operator: Boolean(balance.data?.rollerOperator), delegate: Boolean(roll.data?.delegate),
    strategy: Boolean(roll.data?.strategyActive) };

  useEffect(() => {
    if (!portfolioStrategyEditRequested(window.location.search)) return;
    setStage("automate");
    setPortfolioEditMode(true);
    if (portfolioEditLoaded.current || !indexedStrategy) return;
    portfolioEditLoaded.current = true;
    const revision = pricingRevision.current + 1;
    pricingRevision.current = revision;
    setPricingRevisionValue(revision);
    setStrategyForm(indexedStrategy.strategy);
    setPricingInputs({});
    setPricingCommitErrors({});
    setPricingCandidate(null);
    setMaxShares(indexedStrategy.strategy.maxUnits === "0" ? "" : formatUnits(BigInt(indexedStrategy.strategy.maxUnits), 2));
    setFormTouched(true);
  }, [indexedStrategy]);

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

  async function act(label: string, task: () => Promise<string>, walletAction = true, onSuccess?: () => void) {
    setBusy(label);
    try { if (walletAction) notice("pending", label, "Review each requested transaction in your wallet.");
      notice("success", label, await task());
      onSuccess?.();
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${label} stopped`, error instanceof Error ? error.message : "Try again after refreshing.");
    }
    finally { setBusy(null); setRollStep(null); }
  }

  async function moveBalance(direction: "deposit" | "withdraw") {
    await act(`${direction === "deposit" ? "Deposit" : "Withdraw"} ${collateralLabel}`, async () => {
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
    }, true, direction === "deposit" ? () => setStage((current) => stageAfterEarnAction(current, "deposit", isPut)) : undefined);
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
    }, true, () => setStage((current) => stageAfterEarnAction(current, "deposit", isPut)));
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

  async function listAsk() {
    await act("Place your ask", async () => {
      if (!canWrite || !underlying || !address || !config.data) throw new Error("Writing contracts are not ready in this build.");
      if (isPut) await checkPutMarket();
      if (!strike || !price || !units || !expiry) throw new Error("Choose an expiry, strike, size, and price on the 0.0001 USDG tick.");
      const fresh = await preflightAsk(address, underlying, isPut, strike, expiry, units, config.data.fees.premiumFeeBps);
      if (selected && fresh.longId !== BigInt(selected.series.longId)) throw new Error("The selected series changed. Refresh the ladder.");
      const ctx = context();
      if (!fresh.operator) await setOperator(ctx, requireV2Address("orderBook"), true);
      if (!fresh.exists) await createSeries(ctx, underlying, isPut, strike, expiry);
      const beforePlace = await preflightAsk(address, underlying, isPut, strike, expiry, units, config.data.fees.premiumFeeBps);
      const cutoff = beforePlace.mintCutoff ?? await readMintCutoff(fresh.longId);
      await place(ctx, fresh.longId, 2, price, units, nextAskExpiry(Math.floor(Date.now() / 1000), cutoff));
      return `Your ${ticker} ${activeType} ask is open at ${money(price)} USDG per share. Premium arrives only if a buyer fills.`;
    }, true, () => setStage((current) => stageAfterEarnAction(current, "ask", isPut)));
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
      setPricingCommitErrors((before) => ({ ...before, [field]: `${PRICING_LABELS[field]} is outside AutoRoller's 0.05%–10% contract range at the current spot.` }));
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
      const size = units ?? 1n;
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
      setMaxShares(formatUnits(size, 2));
      setFormTouched(true);
      setExpiryChoice(target.series.expiry);
      setSeriesChoice(target.series.longId);
      setAskPrice(formatUnits(roundAskToTick(targetFair ?? spot / 100n), 6));
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
      if (active && !formTouched) throw new Error("Load your saved strategy or choose a preset before updating it.");
      if (strategyError || !strategyToSave) throw new Error(strategyError || "Choose a strategy.");
      const requested = currentPricingRequest();
      if (!requested) throw new Error("Live market inputs changed. Refresh the form before enabling auto-roll.");
      const reviewedCandidate = currentCandidate;
      const ctx = context();
      const roller = requireV2Address("autoRoller");
      const freshBalance = await readWriterBalance(address, underlying);
      const freshRoll = await readRollState(address, underlying);
      const freshPrefs = await readPayoutPrefs(address);
      const steps = rollProgressFromChain({ payoutToLedger: freshPrefs.toLedger,
        rollerOperator: freshBalance.rollerOperator, delegate: freshRoll.delegate });
      for (let key = nextRollStep(steps); key !== null; key = nextRollStep(steps)) {
        setRollStep(key);
        if (key === "payout") await setPayoutToLedger(ctx, true);
        else if (key === "operator") await setOperator(ctx, roller, true);
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

  const active = roll.data ? roll.data.strategyActive : Boolean(accountStrategy?.strategy.active);
  const showPause = active || (availability.pauseReady && (roll.isPending || roll.isError));
  const nextTime = indexedStrategy?.expiry ? indexedStrategy.expiry + (config.data?.constants.settlementWindow ?? 1_800)
    + (config.data?.constants.finalizeDelay ?? 120) : null;

  return <>
    <PageHead eyebrow="Writers" title={`Write ${ticker} ${activeType}s`} lede={isPut
      ? "Deposit USDG to back a put, choose a strike and expiry, and set the premium a buyer must pay."
      : "Deposit Stock Tokens, choose a strike and expiry, and set the premium a buyer must pay."} />
    <Segments className="mb-5" label="Option type to write" selected={activeType} disabled={!!busy}
      options={[{ value: "call", label: "Calls" }, { value: "put", label: "Puts" }] as const}
      onSelect={(kind) => { advancePricingRevision(); pricingAction.current += 1; setPricingCandidate(null);
        setType(kind); setStage("deposit"); setSeriesChoice(""); setExpiryChoice(0); setDepositAmount(""); setWithdrawAmount("");
        setZapUsdgAmount(""); setExitZapAmount(""); }} />
    {isPut && market && !market.puts ? <Notice tone="info" className="mb-5">Put writing is unavailable for this market. You can still withdraw free USDG.</Notice> : null}
    <Notice tone="warn" className="mb-5">{isPut
      ? `A cash-secured put locks ${collateralLabel} equal to the strike value per share. You are paid the premium if filled; if ${ticker} ends below the strike, you lose the difference in USDG. Collateral stays locked until close or redemption.`
      : "A written call caps your upside above the strike. Premium is paid only if a buyer fills. Collateral stays locked until the option can be closed or redeemed."}</Notice>
    {markets.isError || series.isError ? <Notice tone="warn" role="status" className="mb-5">Market data is unavailable. Your on-chain balance is unaffected; refresh when the indexer recovers.</Notice> : null}
    {!isPut && allCallSeries.isError ? <Notice tone="warn" role="status" className="mb-5">The complete call list is unavailable. Select a preset or fill the proposed band to retry; the loaded ladder remains available for a manual ask.</Notice> : null}
    {market && !market.spot ? <Notice tone="warn" role="status" className="mb-5">Live {ticker} spot is unavailable. New deposits and writing are paused; you can still withdraw free collateral.</Notice> : null}
    {!contractReady ? <Notice tone="info" className="mb-5">New v2 writing is unavailable until its contracts are configured in this build.</Notice> : null}
    {mismatch.length ? <Notice tone="warn" className="mb-5">App and indexer contract settings differ. Writing is paused until they match.</Notice> : null}
    {/*
      Provenance, and deliberately NOT part of `mismatch` above. An address served from a
      build-time override must be visible — an override that is silently correct in dev is
      indistinguishable from one that is silently unreported — but it is not a reason to pause
      writing, which is what joining that array would have done.
    */}
    {provenance.length ? <Notice tone="info" className="mb-5">{provenance.join(" ")}</Notice> : null}
    {!address ? <Panel className="mb-5"><p className="mb-4 text-ink-2">Connect a wallet to see your free and locked {collateralLabel}.</p><ConnectButton /></Panel> : null}
    <nav aria-label="Earn flow" className="mb-5 rounded-lg border border-line bg-surface p-3">
      <ol className={`grid gap-2 ${isPut ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {([
          { id: "deposit", label: "Deposit", detail: `Fund or withdraw ${collateralLabel}` },
          { id: "ask", label: "Set one ask", detail: "Choose your first price" },
          ...(!isPut ? [{ id: "automate", label: "Automate", detail: "Optional · skip ahead anytime" }] : []),
        ] as { id: EarnStage; label: string; detail: string }[]).map((step, index) =>
          <li key={step.id}><button type="button" aria-current={stage === step.id ? "step" : undefined}
            aria-controls={`earn-stage-${step.id}`} aria-expanded={stage === step.id} onClick={() => setStage(step.id)}
            className={`w-full rounded-sm border px-3 py-3 text-left text-sm ${stage === step.id
              ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface-2 text-ink hover:border-accent"}`}>
            <span className="block font-semibold">{index + 1}. {step.label}</span>
            <span className="mt-1 block text-xs">{step.detail}</span>
          </button></li>)}</ol>
    </nav>
    <div id="earn-stage-deposit" className={stage === "deposit" ? "block" : "hidden"}>
      <Panel as="section" aria-label="Writer balance">
        <h2 className="font-display text-xl font-bold">Your {isPut ? "USDG" : ticker} balance</h2>
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div><p className="text-ink-3">In wallet</p><p className="num mt-1 font-semibold">{balance.data ? assetAmount(balance.data.wallet, collateralDecimals) : "—"}</p></div>
          <div><p className="text-ink-3">Free to write</p><p className="num mt-1 font-semibold">{balance.data ? assetAmount(balance.data.free, collateralDecimals) : "—"}</p></div>
          <div><p className="text-ink-3">Locked in shorts</p><p className="num mt-1 font-semibold">{locked !== null ? assetAmount(locked, collateralDecimals) : "—"}</p></div>
        </div>
        {balance.isError ? <Notice tone="warn" role="status" className="mt-4">The balance panel could not be read. A withdrawal can retry the free-balance check on chain before signing.</Notice> : null}
        <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <div><label htmlFor="writer-deposit" className="text-sm font-semibold">Deposit {collateralLabel}</label>
            <input id="writer-deposit" inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} placeholder={isPut ? "100" : "0.25"}
              className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
            <p className="mt-1 text-xs text-ink-3">Your wallet may request an exact token approval first.</p>
            <WithdrawalTerms className="mt-3" surface="writer" asset={collateralLabel}
              free={balance.data ? assetAmount(balance.data.free, collateralDecimals) : null}
              locked={locked !== null ? assetAmount(locked, collateralDecimals) : null}
              latestExpiry={latestLockedExpiry} timing={config.data?.constants ?? null} />
            <Button size="sm" className="mt-3 w-full" disabled={!canWrite || !balance.data || !!busy || !parsePositiveAsset(depositAmount, collateralDecimals)} onClick={() => void moveBalance("deposit")}>Deposit</Button></div>
          <div><label htmlFor="writer-withdraw" className="text-sm font-semibold">Withdraw free {collateralLabel}</label>
            <input id="writer-withdraw" inputMode="decimal" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder={isPut ? "100" : "0.25"}
              className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
            <p className="mt-1 text-xs text-ink-3">Locked collateral cannot be withdrawn.</p>
            <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!availability.exitReady || !!busy || !parsePositiveAsset(withdrawAmount, collateralDecimals)} onClick={() => void moveBalance("withdraw")}>Withdraw</Button></div>
        </div>
        {!isPut ? <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <div>
            <label htmlFor="writer-zap-in" className="text-sm font-semibold">Zap USDG to {ticker}</label>
            <input id="writer-zap-in" inputMode="decimal" value={zapUsdgAmount} onChange={(event) => setZapUsdgAmount(event.target.value)} placeholder="100"
              className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
            <p className="mt-1 text-xs text-ink-3">Minimum received: {writeZapQuote ? `${assetAmount(writeZapQuote.minOut, 18)} ${ticker}` : "—"}</p>
            <p className="mt-1 text-xs text-ink-3">Slippage tolerance: {(ZAP_SLIPPAGE_BPS_DEFAULT / 100).toFixed(2)}%</p>
            <Button size="sm" className="mt-3 w-full" disabled={!canWrite || !zapConfigured || !writeZapQuote || !!busy}
              onClick={() => void zapWrite()}>{zapConfigured ? "Zap in" : "Zap not configured"}</Button>
          </div>
          <div>
            <label htmlFor="writer-zap-out" className="text-sm font-semibold">Exit zap {ticker} to USDG</label>
            <input id="writer-zap-out" inputMode="decimal" value={exitZapAmount} onChange={(event) => setExitZapAmount(event.target.value)} placeholder="0.25"
              className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
            <p className="mt-1 text-xs text-ink-3">Minimum received: {exitZapQuote ? `${assetAmount(exitZapQuote.minOut, USDG_DECIMALS)} USDG` : "—"}</p>
            <p className="mt-1 text-xs text-ink-3">Slippage tolerance: {(ZAP_SLIPPAGE_BPS_DEFAULT / 100).toFixed(2)}%</p>
            <p className="mt-1 text-xs text-ink-3">Sells wallet-held tokens. Withdraw free collateral first if it is still in Stonkhouse.</p>
            <Button size="sm" variant="ghost" className="mt-3 w-full"
              disabled={!availability.exitReady || !zapConfigured || !exitZapQuote || spot === null || !!busy}
              onClick={() => void zapExit()}>{zapConfigured ? "Exit zap" : "Zap not configured"}</Button>
          </div>
        </div> : null}
      </Panel>
      <Button variant="ghost" className="mt-4" onClick={() => setStage("ask")}>Continue to Set one ask</Button>
    </div>
    <div id="earn-stage-ask" className={stage === "ask" ? "block" : "hidden"}>
      {!isPut ? <Panel as="section" aria-label="Writer presets" className="mb-5"><h2 className="font-display text-xl font-bold">Start with a preset</h2>
        <p className="mt-2 text-sm text-ink-2">A preset fills the ask and auto-roll forms. It does not place an order until you review and sign.</p>
        <div className="mt-4 grid gap-2">{WRITER_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={!!busy || allCallSeries.isFetching || !spot || !strikeTick}
          onClick={() => void applyPreset(preset.id)} className="rounded-sm border border-line-2 bg-surface-2 px-4 py-3 text-left hover:border-accent disabled:opacity-60">
          <span className="block font-semibold">{preset.label}</span><span className="mt-1 block text-xs text-ink-3">{preset.detail}</span>
        </button>)}</div>
      </Panel> : <Panel as="section" aria-label="Put collateral" className="mb-5"><h2 className="font-display text-xl font-bold">Cash-secured puts</h2>
        <p className="mt-2 text-sm text-ink-2">For each share you write, set aside the strike amount in USDG. The option buyer receives the in-the-money difference at expiry; your USDG collateral covers it.</p>
        <p className="mt-3 text-sm text-ink-2">Auto-roll presets currently write covered calls. Set each put ask manually below.</p>
      </Panel>}
      <Panel as="section" id="manual-ask" aria-label="Manual ask">
      <h2 className="font-display text-xl font-bold">Set your ask</h2>
      <p className="mt-2 text-sm text-ink-2">An AskWrite order uses free collateral only when a buyer fills. You set the price.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-semibold">Expiry<select value={expiry} onChange={(event) => { setExpiryChoice(Number(event.target.value)); setSeriesChoice(""); }}
          className="mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-sm text-ink">
          {(market?.expiries ?? []).map((time) => <option key={time} value={time}>{stamp(time)}</option>)}
        </select></label>
        <label className="text-sm font-semibold">Strike<select value={seriesChoice || chosen?.series.longId || ""} onChange={(event) => setSeriesChoice(event.target.value)}
          className="mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-sm text-ink">
          {ladder.map((row) => <option key={row.series.longId} value={row.series.longId}>${row.series.strike.formatted}</option>)}
          <option value="custom">Custom strike…</option>
        </select></label>
        <label className="text-sm font-semibold">Size in shares<input inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} placeholder="0.01"
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">0.01-share steps</span></label>
        <label className="text-sm font-semibold">Your price / share · USDG<input inputMode="decimal" value={askPrice} onChange={(event) => setAskPrice(event.target.value)} placeholder="1.15"
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">0.0001 USDG tick</span></label>
      </div>
      {seriesChoice === "custom" ? <div className="mt-4 max-w-xs"><label htmlFor="custom-strike" className="text-sm font-semibold">Custom strike · USDG</label>
        <input id="custom-strike" inputMode="decimal" value={customStrike} onChange={(event) => setCustomStrike(event.target.value)} placeholder="230.00"
          className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        <p className="mt-1 text-xs text-ink-3">Must be a calendar expiry and a multiple of the market strike tick ({market?.strikeTick.formatted ?? "—"} USDG). Creating a new series adds one transaction.</p>
      </div> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Notice tone="info" title="Fair-value guideline">
          {/* W3-303: the fair figure below is qualified by its source. `useFair` carries provenance
              on the /v2/fair payload; the per-series quote carries its own. Absent reads as unknown. */}
          <p className="mb-2 text-xs"><FairProvenanceNote provenance={fairQuery.data?.provenance ?? selected?.quote.fairProvenance} /></p>
          {fair !== null && price !== null ? <>
          Fair value ≈ {money(fair)} USDG. You are asking {money(price)} USDG — {quote?.comparison ?? "at fair value"}. This is guidance, never a block.
        </> : "Fair value is unavailable for this selection. You may still set your own price after checking the market."}</Notice>
        <div className="rounded-xl bg-surface-2 p-4 text-sm"><p>Gross premium if fully filled: <strong className="num">{quote ? money(quote.gross) : "—"} USDG</strong></p>
          <p className="mt-2">Seller fee ({config.data?.fees.premiumFeeBps ?? "—"} bps): <strong className="num">{quote ? money(quote.fee) : "—"} USDG</strong></p>
          <p className="mt-2 font-semibold">Premium you receive: <span className="num">{quote ? money(quote.net) : "—"} USDG</span>, only if filled.</p></div>
      </div>
      {config.data?.pendingFees ? <PendingFeeNotice className="mt-4" effectiveAt={config.data.pendingFees.effectiveAt}
        nextFees={config.data.pendingFees} kind="writer" /> : null}
      <PendingOperationsNotice className="mt-4" />
      {requiredCollateral !== null ? <p className="mt-4 text-sm font-semibold">Locked collateral for this size: <span className="num">{assetAmount(requiredCollateral, collateralDecimals)} {collateralLabel}</span>{totalCollateral !== null && rentQuote.data?.free !== null && !hasCollateral ? <span className="ml-2 text-warn">Deposit more before listing.</span> : null}</p> : null}
      {totalCollateral !== null ? <p className="mt-2 text-sm">Free balance required: <strong className="num">{formatUnits(totalCollateral, collateralDecimals)} {collateralLabel}</strong>.</p> : <p className="mt-2 text-sm text-ink-3">Waiting for the on-chain collateral estimate before listing.</p>}
      {strike && units && quote ? <div className="mt-5 overflow-x-auto"><h3 className="font-display text-lg font-bold">What happens at expiry</h3>
        <table className="mt-3 w-full text-left text-sm"><thead className="border-b border-line text-ink-3"><tr><th className="py-2">Outcome</th><th className="py-2">Your collateral and premium</th></tr></thead><tbody>
          {isPut ? <>
            <tr className="border-b border-line"><td className="py-3">{ticker} at or above ${money(strike)}</td><td className="py-3">Your {money(requiredCollateral!)} USDG collateral returns, plus {money(quote.net)} USDG net premium.</td></tr>
            <tr><td className="py-3">{ticker} at ${money(strike * 9n / 10n)}</td><td className="py-3">You pay {money(requiredCollateral! - shortOutcome(strike * 9n / 10n, { isPut: true, strike, units, exerciseFeeBps: 0 }, quote.net).collateralReturned)} USDG from collateral. The rest returns, plus {money(quote.net)} USDG net premium.</td></tr>
          </> : <>
            <tr className="border-b border-line"><td className="py-3">{ticker} below ${money(strike)}</td><td className="py-3">Keep {formatUnits(units, 2)} Stock Tokens, plus {money(quote.net)} USDG net premium.</td></tr>
            <tr><td className="py-3">{ticker} at ${money(strike * 11n / 10n)}</td><td className="py-3">Keep about {retainedSharesAtExpiry(strike, strike * 11n / 10n, units).toFixed(4)} Stock Tokens, worth the strike value per original share, plus {money(quote.net)} USDG net premium.</td></tr>
          </>}
        </tbody></table><p className="mt-2 text-xs text-ink-3">These outcomes show premium and collateral separately, before gas.</p><p className="mt-2 text-xs text-ink-3">{isPut
          ? `If ${ticker} ends below the strike, you lose the difference in USDG from your locked collateral. The net premium offsets some of that loss.`
          : "Above strike, net-share settlement transfers a fraction of shares to the buyer, rather than the whole share."}</p>
      </div> : null}
      <div className="mt-5"><Button disabled={!canWrite || !hasCollateral || !!busy || !strike || !price || !units || !expiry} onClick={() => void listAsk()}>{busy === "Place your ask" ? "Placing…" : "Place AskWrite order"}</Button>
        <p className="mt-2 text-xs text-ink-3">The chain rechecks free collateral, market state, fee, calendar, and cutoff before placement.</p></div>
      </Panel>
      {!isPut ? <Button variant="ghost" className="mt-4" onClick={() => setStage("automate")}>Continue to Automate</Button> : null}
    </div>

    {!isPut ? <div id="earn-stage-automate" className={stage === "automate" ? "block" : "hidden"}>
      <Panel as="section" id="auto-roll" aria-label="Auto-roll strategy">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-bold">Auto-roll</h2>
        <p className="mt-2 text-sm text-ink-2">The keeper can list the next covered call from your free balance during regular New York market hours.</p></div>
        {showPause ? <Button size="sm" variant="ghost" disabled={!availability.pauseReady || !!busy} onClick={() => void pauseRoll()}>Pause</Button> : null}</div>
      {portfolioEditMode ? <Notice tone="info" role="status" className="mt-4">{indexedStrategy
        ? "Your saved strategy is loaded into this form. Review the USDG band below; nothing changes on chain until Update strategy passes the current checks and you sign."
        : strategies.isError ? "The saved strategy could not be loaded. Return to Portfolio and retry when strategy data recovers."
          : "Loading the saved strategy for this wallet and underlying…"}</Notice> : null}
      {!rollerReady ? <Notice tone="info" className="mt-4">AutoRoller is not deployed in this build.</Notice> : null}
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><p className="text-ink-3">Status</p><p className="mt-1 font-semibold">{roll.isError ? "Status unavailable" : roll.isPending && !roll.data ? "Checking…" : active ? "Active" : "Paused / not set"}</p></div>
        <div><p className="text-ink-3">Current series / order</p><p className="mt-1 font-semibold">{accountStrategy?.currentSeries ? `${accountStrategy.currentSeries.ticker} $${accountStrategy.currentSeries.strike.formatted}` : "None"} · {accountStrategy?.orderId ?? "no order"}</p></div>
        <div><p className="text-ink-3">Last roll</p><p className="mt-1 font-semibold">{indexedStrategy?.lastRolledAt ? stamp(indexedStrategy.lastRolledAt) : "Not recorded"}</p></div>
        <div><p className="text-ink-3">Next possible roll</p><p className="mt-1 font-semibold">{nextTime ? stamp(nextTime) : "After the next expiry"}</p></div>
      </div>
      {indexedStrategy?.lastStaleCancelAt && indexedStrategy.currentLongId && !indexedStrategy.orderId ? <Notice tone="info" role="status" className="mt-3">Ask withdrawn at/past strike after spot reached ${indexedStrategy.staleSpot?.formatted ?? "—"} on {stamp(indexedStrategy.lastStaleCancelAt)}. The existing position remains; the next roll waits until after its expiry.</Notice> : null}
      <p className="mt-2 text-xs text-ink-3">Deposits must cover the collateral required by each order.</p>
      <p className="mt-2 text-xs text-ink-3">The exact next roll also waits for settlement and the next regular market session.</p>
      <p className="mt-3 text-sm">{earned.data ? <><strong>{earned.data.complete ? "Lifetime premium" : "Premium in loaded history"}: </strong><span className="num">{money(earned.data.amount)} USDG</span>{!earned.data.complete ? " (more pages remain)" : null}</>
        : earned.isError ? "Lifetime premium history is temporarily unavailable." : "Loading premium history…"}</p>
      {active && indexedStrategy ? <Button variant="ghost" size="sm" className="mt-4" disabled={!!busy} onClick={() => {
        advancePricingRevision();
        setStrategyForm(indexedStrategy.strategy);
        setPricingInputs({});
        setPricingCommitErrors({});
        setPricingCandidate(null);
        setMaxShares(indexedStrategy.strategy.maxUnits === "0" ? "" : formatUnits(BigInt(indexedStrategy.strategy.maxUnits), 2));
        setFormTouched(true);
      }}>Load saved strategy into form</Button> : null}
      <div className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-semibold">Cycle<select disabled={!!busy} value={strategy.weekly ? "weekly" : "daily"} onChange={(event) => { setStrategyForm((before) => ({ ...before, weekly: event.target.value === "weekly" })); markPricingEdited(); }}
          className="mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink"><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
        <label className="text-sm font-semibold">Strike above spot · bps<input disabled={!!busy} type="number" inputMode="numeric" min={100} max={2_500} step={1} value={strategy.otmBps} onChange={(event) => { setStrategyForm((before) => ({ ...before, otmBps: Number(event.target.value) })); markPricingEdited(); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" /></label>
        <label className="text-sm font-semibold">Starting ask · USDG / share<input disabled={!!busy} inputMode="decimal" maxLength={32} value={startInput}
          onChange={(event) => editPricingInput("start", event.target.value)} onBlur={() => commitPricingInput("start")}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Saved as {strategy.askBps} bps after you leave the field. Values between integer bps snap up to protect your ask; 0.0001 USDG tick.</span></label>
        <label className="text-sm font-semibold">Max size · shares<input disabled={!!busy} value={maxShares} onChange={(event) => { setMaxShares(event.target.value); setFormTouched(true); }} placeholder="All free"
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Blank means all free collateral.</span></label>
      </div>
      <div className="mt-4 rounded-sm border border-line bg-surface-2 p-4 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Proposed wide band</h3>
          {currentCandidate ? <p className="mt-1 text-ink-2">Reference: longest-dated open {currentCandidate.weekly ? "weekly" : "daily"} near the target strike — ${currentCandidate.reference.series.strike.formatted}, {stamp(currentCandidate.reference.series.expiry)}, estimated at ${money(currentCandidate.referenceFair)} USDG.</p>
            : <p className="mt-1 text-ink-2">Refresh the complete call list to calculate a current candidate.</p>}</div>
          <Button type="button" size="sm" variant="ghost" disabled={!!busy || allCallSeries.isFetching || !spot || !strikeTick} onClick={() => void fillProposedBand()}>Fill proposed band</Button></div>
        {currentCandidate ? <p className="mt-2 text-ink-2">In smart mode, this candidate starts at {money(currentCandidate.prices.start)} USDG and lets the pricer move between {money(currentCandidate.prices.min)} and {money(currentCandidate.prices.max)} USDG per share at the refreshed spot.</p>
          : <p className="mt-2 text-ink-2">A current reference estimate is required to calculate the candidate. You can still set contract-valid limits manually.</p>}
        <p className="mt-2 text-xs text-ink-3">Filling the candidate changes this form only. {strategy.smartPricing ? "Nothing changes on chain until you sign." : "Smart pricing remains off until you select it and sign."} Starting high reduces the initial underpricing window; it does not guarantee a fill or future value.</p>
      </div>
      {smartPricingControl.note
        ? <Notice tone="info" className="mt-4">{smartPricingControl.note}</Notice> : null}
      <label className="mt-4 flex items-center gap-2 text-sm font-semibold"><input disabled={smartPricingControl.disabled} type="checkbox" checked={strategy.smartPricing} onChange={(event) => {
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
      }} /> Smart pricing within my limits</label>
      {strategy.smartPricing ? <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Minimum ask · USDG / share<input disabled={!!busy} inputMode="decimal" maxLength={32} value={minimumInput}
          onChange={(event) => editPricingInput("minimum", event.target.value)} onBlur={() => commitPricingInput("minimum")}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Saved as {strategy.minAskBps} bps after you leave the field; 0.0001 USDG tick.</span></label>
        <label className="text-sm font-semibold">Maximum ask · USDG / share<input disabled={!!busy} inputMode="decimal" maxLength={32} value={maximumInput}
          onChange={(event) => editPricingInput("maximum", event.target.value)} onBlur={() => commitPricingInput("maximum")}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Saved as {strategy.maxAskBps} bps after you leave the field. Values between integer bps snap up; 0.0001 USDG tick.</span></label>
        <p className="sm:col-span-2 text-xs text-ink-3">These USDG prices convert at current spot; the contract stores bps, so their USDG values move with spot. During configured market sessions, the pricer checks on its cadence, targets its fair estimate plus its configured edge, rounds to the 0.0001 USDG tick, and clamps every move inside this band. It may leave the ask unchanged. If pricing stops, the last ask stays live at its last price.</p>
      </div> : <p className="mt-2 text-xs text-ink-3">The USDG input converts to bps at current spot. Auto-roll uses those bps with spot when each fixed ask starts. No service may move it while smart pricing is off; hidden minimum and maximum fields are saved as zero.</p>}
      {strategyError ? <p role="alert" className="mt-3 text-sm text-danger">{strategyError}</p> : null}
      <div className="mt-5"><h3 className="font-display text-lg font-bold">Setup checklist</h3><ol className="mt-3 grid gap-2 sm:grid-cols-2">{ROLL_STEPS.map((step, index) => <li key={step.key} className="rounded-sm border border-line p-3 text-sm">
        <span className="font-semibold">{index + 1}. {step.label}</span><span className="ml-2 text-xs text-ink-3">{progress[step.key] ? "Done" : rollStep === step.key ? "Confirming…" : "Needed"}</span>
      </li>)}</ol></div>
      {roll.isError ? <Notice tone="warn" className="mt-4">Auto-roll status could not be read. You can retry after the chain responds.</Notice> : null}
      <Button className="mt-5" disabled={!canWrite || !rollerReady || !balance.data || !roll.data || !!busy || !!strategyError || (active && !formTouched)} onClick={() => void enableRoll()}>
        {busy === "Enable auto-roll" ? "Confirming setup…" : active ? "Update strategy" : "Enable auto-roll"}</Button>
      {active && !formTouched ? <p className="mt-2 text-xs text-ink-3">Load the saved strategy or select a preset to update it.</p> : null}
      <p className="mt-2 text-xs text-ink-3">Setup may ask for up to four transactions. Confirmed steps stay on chain, so you can return and continue.</p>
      </Panel>
    </div> : null}
  </>;
}
