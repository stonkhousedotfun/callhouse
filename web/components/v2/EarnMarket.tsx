"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { PendingFeeNotice } from "@/components/v2/PendingFeeNotice";
import { USDG } from "@/lib/contracts";
import { v2Markets } from "@/lib/markets";
import { v2Api } from "@/lib/v2/api";
import type { MarketSeriesResponse, Strategy } from "@/lib/v2/api-types";
import { V2_DEPLOYMENT, requireV2Address, v2ConfigWarnings } from "@/lib/v2/config";
import { readPayoutPrefs } from "@/lib/v2/chainReads";
import { earnActionAvailability } from "@/lib/v2/earnAccess";
import { createSeries, nextAskExpiry, preflightAsk, readMintCutoff, readRollPosition, readRollState, readWriterBalance, readWriterFree, readWriterRent,
  setDelegate, setStrategy, stopStrategy } from "@/lib/v2/earnTx";
import { useConfig, useFair, useMarketSeries, useMarkets, usePositions, useStrategies, v2Keys } from "@/lib/v2/hooks";
import { collateralPerUnit, sharesToUnits, shortOutcome } from "@/lib/v2/payoff";
import { closestDelta, presetStrategy, retainedSharesAtExpiry, roundAskToTick, writerQuote, WRITER_PRESETS, type PresetId } from "@/lib/v2/presets";
import { nextRollStep, rollProgressFromChain, ROLL_STEPS, validateRollStrategy } from "@/lib/v2/rollSetup";
import { approveExact, deposit, place, setOperator, setPayoutToLedger, withdraw, type WriteContext } from "@/lib/v2/tx";

const assetAmount = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const money = (raw: bigint) => Number(formatUnits(raw, 6)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const stamp = (seconds: number) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(seconds * 1000));
const parsePositiveAsset = (raw: string, decimals: number): bigint | null => {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
};
const parseAskPrice = (raw: string): bigint | null => {
  try { const price = parseUnits(raw, 6); return price > 0n && price % 100n === 0n ? price : null; } catch { return null; }
};

const EMPTY_STRATEGY: Strategy = { active: true, weekly: true, smartPricing: true, otmBps: 500,
  askBps: 100, minAskBps: 50, maxAskBps: 200, maxUnits: "1" };

async function lifetimePremium(address: string, ticker: string, signal: AbortSignal): Promise<{ amount: bigint; complete: boolean }> {
  let cursor: string | undefined;
  let amount = 0n;
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const response = await v2Api.getHistory(address, { limit: 200, ...(cursor ? { cursor } : {}) }, { signal });
    for (const item of response.items) if (item.kind === "fill" && item.series.ticker === ticker &&
      item.data.role === "maker" && item.data.side === "sell" && item.data.primary) {
      amount += BigInt(item.data.premium.raw) - BigInt(item.data.fee.raw) + BigInt(item.data.rebate.raw);
    }
    if (!response.nextCursor) return { amount, complete: true };
    if (seen.has(response.nextCursor)) break;
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  return { amount, complete: false };
}

function matchedSeries(rows: MarketSeriesResponse["items"], expiry: number, isPut: boolean) {
  return rows.filter((row) => row.series.isPut === isPut && row.series.expiry === expiry && row.series.status === "open")
    .sort((a, b) => BigInt(a.series.strike.raw) < BigInt(b.series.strike.raw) ? -1 : 1);
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
  const isPut = type === "put";
  const activeType = type;
  const series = useMarketSeries(ticker, { type: activeType, limit: 200 });
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
  const [strategy, setStrategyForm] = useState<Strategy>(EMPTY_STRATEGY);
  const [maxShares, setMaxShares] = useState("0.01");
  const [formTouched, setFormTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rollStep, setRollStep] = useState<string | null>(null);

  const expiry = expiryChoice || market?.expiries[0] || 0;
  const ladder = matchedSeries(series.data?.items ?? [], expiry, isPut);
  const chosen = seriesChoice && seriesChoice !== "custom" ? ladder.find((row) => row.series.longId === seriesChoice) : ladder[0];
  const selected = seriesChoice === "custom" ? null : chosen;
  const fairQuery = useFair(selected?.series.longId);
  const fair = fairQuery.data?.fair?.raw ? BigInt(fairQuery.data.fair.raw)
    : selected?.quote.fair?.raw ? BigInt(selected.quote.fair.raw) : null;
  const spot = !markets.isError && market?.spot ? BigInt(market.spot.raw) : null;
  const price = parseAskPrice(askPrice);
  const units = useMemo(() => { try { return sharesToUnits(shares); } catch { return null; } }, [shares]);
  const strike = selected ? BigInt(selected.series.strike.raw) : seriesChoice === "custom" ? parseAskPrice(customStrike) : null;
  const quote = price && units && config.data ? writerQuote(price, units, config.data.fees.premiumFeeBps, fair) : null;
  const requiredCollateral = strike && units ? collateralPerUnit(isPut, strike) * units : null;
  const strategySize = useMemo(() => {
    if (!maxShares.trim()) return "0";
    try { return sharesToUnits(maxShares).toString(); } catch { return null; }
  }, [maxShares]);
  const strategyToSave = strategySize === null ? null : { ...strategy, maxUnits: strategySize };
  const strategyError = strategyToSave ? validateRollStrategy(strategyToSave) : "Choose a size in 0.01-share steps, or leave blank for all free collateral.";
  const contractReady = Boolean(V2_DEPLOYMENT.contracts.clearinghouse && V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.expiryCalendar);
  const rollerReady = Boolean(contractReady && V2_DEPLOYMENT.contracts.autoRoller);
  const mismatch = config.data ? [
    ...v2ConfigWarnings(config.data),
    ...(isPut && config.data.usdg.address.toLowerCase() !== USDG.toLowerCase() ? ["USDG address differs from this app."] : []),
  ] : [];
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
  const indexedStrategy = strategies.data?.items.find((row) => row.ticker === ticker && row.writer.toLowerCase() === address?.toLowerCase());
  const locked = positions.data?.shorts.filter((row) => row.series.ticker === ticker && row.series.isPut === isPut)
    .reduce((sum, row) => sum + BigInt(row.collateralLocked.raw), 0n) ?? null;
  const progress = { payout: Boolean(payoutPrefs.data?.toLedger),
    operator: Boolean(balance.data?.rollerOperator), delegate: Boolean(roll.data?.delegate),
    strategy: Boolean(roll.data?.strategyActive) };

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
    });
  }

  async function checkPutMarket() {
    const refreshed = await markets.refetch();
    const current = refreshed.data?.find((row) => row.ticker === ticker);
    if (refreshed.isError || !current || current.status !== "live" || !current.spot || !current.puts ||
      !underlying || current.underlying.toLowerCase() !== underlying.toLowerCase())
      throw new Error("Put writing is unavailable for this market. Your free USDG can still be withdrawn.");
  }

  async function applyPreset(id: PresetId) {
    await act("Choose a preset", async () => {
      if (!market || !series.data || !spot) throw new Error("Market and ladder data are not ready.");
      const preset = WRITER_PRESETS.find((row) => row.id === id)!;
      const rows = series.data.items.filter((row) => !row.series.isPut && row.series.status === "open" &&
        (row.series.tenor === (preset.weekly ? "weekly" : "daily")));
      if (!rows.length) throw new Error("No open series match that expiry type right now.");
      let target: (typeof rows)[number];
      let fairValue: bigint | null;
      if (id === "weekly-delta-15") {
        const priced = await Promise.all(rows.map(async (row) => {
          try { const live = await v2Api.getFair(row.series.longId); return { row, delta: live.fair ? live.delta : null,
            fair: live.fair ? BigInt(live.fair.raw) : null, strike: BigInt(row.series.strike.raw) }; }
          catch { return { row, delta: null, fair: null, strike: BigInt(row.series.strike.raw) }; }
        }));
        const best = closestDelta(priced, spot);
        if (!best) throw new Error("Live weekly delta is unavailable. Choose another preset.");
        target = best.row; fairValue = best.fair;
      } else {
        const desired = spot * BigInt(10_000 + preset.otmBps) / 10_000n;
        target = [...rows].sort((a, b) => {
          const da = BigInt(a.series.strike.raw) > desired ? BigInt(a.series.strike.raw) - desired : desired - BigInt(a.series.strike.raw);
          const db = BigInt(b.series.strike.raw) > desired ? BigInt(b.series.strike.raw) - desired : desired - BigInt(b.series.strike.raw);
          return da < db ? -1 : da > db ? 1 : a.series.expiry - b.series.expiry;
        })[0];
        fairValue = target.quote.fair ? BigInt(target.quote.fair.raw) : null;
      }
      const size = units ?? 1n;
      const filled = presetStrategy(id, spot, fairValue, size, id === "weekly-delta-15" ? BigInt(target.series.strike.raw) : undefined);
      setStrategyForm(filled);
      setMaxShares(formatUnits(size, 2));
      setFormTouched(true);
      setExpiryChoice(target.series.expiry);
      setSeriesChoice(target.series.longId);
      setAskPrice(formatUnits(roundAskToTick(fairValue ?? spot * BigInt(filled.askBps) / 10_000n), 6));
      return `${preset.label} filled the ask and auto-roll form. Review the price, size, and strike before signing.`;
    }, false);
  }

  async function enableRoll() {
    await act("Enable auto-roll", async () => {
      if (!canWrite || !rollerReady || !underlying || !address) throw new Error("AutoRoller is not deployed in this build.");
      if (active && !formTouched) throw new Error("Load your saved strategy or choose a preset before updating it.");
      if (strategyError || !strategyToSave) throw new Error(strategyError || "Choose a strategy.");
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
        else await setStrategy(ctx, underlying, strategyToSave);
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
    <div className="mb-5 flex gap-2" role="group" aria-label="Option type to write">
      {(["call", "put"] as const).map((kind) => <button key={kind} type="button" aria-pressed={activeType === kind}
        onClick={() => { setType(kind); setSeriesChoice(""); setExpiryChoice(0); setDepositAmount(""); setWithdrawAmount(""); }}
        className={`min-h-10 rounded-sm border px-4 text-sm font-semibold ${activeType === kind ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink hover:bg-surface-2"}`}>
        {kind === "call" ? "Calls" : "Puts"}</button>)}
    </div>
    {isPut && market && !market.puts ? <Notice tone="info" className="mb-5">Put writing is unavailable for this market. You can still withdraw free USDG.</Notice> : null}
    <Notice tone="warn" className="mb-5">{isPut
      ? `A cash-secured put locks ${collateralLabel} equal to the strike value per share. You are paid the premium if filled; if ${ticker} ends below the strike, you lose the difference in USDG. Collateral stays locked until close or redemption.`
      : "A written call caps your upside above the strike. Premium is paid only if a buyer fills. Collateral stays locked until the option can be closed or redeemed."}</Notice>
    {markets.isError || series.isError ? <Notice tone="warn" role="status" className="mb-5">Market data is unavailable. Your on-chain balance is unaffected; refresh when the indexer recovers.</Notice> : null}
    {market && !market.spot ? <Notice tone="warn" role="status" className="mb-5">Live {ticker} spot is unavailable. New deposits and writing are paused; you can still withdraw free collateral.</Notice> : null}
    {!contractReady ? <Notice tone="info" className="mb-5">New v2 writing is unavailable until its contracts are configured in this build.</Notice> : null}
    {mismatch.length ? <Notice tone="warn" className="mb-5">App and indexer contract settings differ. Writing is paused until they match.</Notice> : null}
    {!address ? <Panel className="mb-5"><p className="mb-4 text-ink-2">Connect a wallet to see your free and locked {collateralLabel}.</p><ConnectButton /></Panel> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
            <Button size="sm" className="mt-3 w-full" disabled={!canWrite || !balance.data || !!busy || !parsePositiveAsset(depositAmount, collateralDecimals)} onClick={() => void moveBalance("deposit")}>Deposit</Button></div>
          <div><label htmlFor="writer-withdraw" className="text-sm font-semibold">Withdraw free {collateralLabel}</label>
            <input id="writer-withdraw" inputMode="decimal" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder={isPut ? "100" : "0.25"}
              className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
            <p className="mt-1 text-xs text-ink-3">Locked collateral cannot be withdrawn.</p>
            <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!availability.exitReady || !!busy || !parsePositiveAsset(withdrawAmount, collateralDecimals)} onClick={() => void moveBalance("withdraw")}>Withdraw</Button></div>
        </div>
      </Panel>
      {!isPut ? <Panel as="section" aria-label="Writer presets"><h2 className="font-display text-xl font-bold">Start with a preset</h2>
        <p className="mt-2 text-sm text-ink-2">A preset fills the ask and auto-roll forms. It does not place an order until you review and sign.</p>
        <div className="mt-4 grid gap-2">{WRITER_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={!!busy || !series.data || !spot}
          onClick={() => void applyPreset(preset.id)} className="rounded-sm border border-line-2 bg-surface-2 px-4 py-3 text-left hover:border-accent disabled:opacity-60">
          <span className="block font-semibold">{preset.label}</span><span className="mt-1 block text-xs text-ink-3">{preset.detail}</span>
        </button>)}</div>
      </Panel> : <Panel as="section" aria-label="Put collateral"><h2 className="font-display text-xl font-bold">Cash-secured puts</h2>
        <p className="mt-2 text-sm text-ink-2">For each share you write, set aside the strike amount in USDG. The option buyer receives the in-the-money difference at expiry; your USDG collateral covers it.</p>
        <p className="mt-3 text-sm text-ink-2">Auto-roll presets currently write covered calls. Set each put ask manually below.</p>
      </Panel>}
    </div>

    <Panel as="section" id="manual-ask" aria-label="Manual ask" className="mt-5">
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
        <Notice tone="info" title="Fair-value guideline">{fair !== null && price !== null ? <>
          Fair value ≈ {money(fair)} USDG. You are asking {money(price)} USDG — {quote?.comparison ?? "at fair value"}. This is guidance, never a block.
        </> : "Fair value is unavailable for this selection. You may still set your own price after checking the market."}</Notice>
        <div className="rounded-xl bg-surface-2 p-4 text-sm"><p>Gross premium if fully filled: <strong className="num">{quote ? money(quote.gross) : "—"} USDG</strong></p>
          <p className="mt-2">Seller fee ({config.data?.fees.premiumFeeBps ?? "—"} bps): <strong className="num">{quote ? money(quote.fee) : "—"} USDG</strong></p>
          <p className="mt-2">Writer rent if fully filled now: <strong className="num">{writerRent !== null ? formatUnits(writerRent, collateralDecimals) : "—"} {collateralLabel}</strong></p>
          <p className="mt-2 text-xs text-ink-3">The series rate is {rentQuote.data ? `${rentQuote.data.mintFeePpm} ppm per week` : "unavailable"}. Rent is charged from free collateral on each fill; separate fills round separately. Unfilled asks pay no rent. Maker rebates, when earned, are separate.</p>
          <p className="mt-2 font-semibold">Premium you receive: <span className="num">{quote ? money(quote.net) : "—"} USDG</span>, only if filled.</p></div>
      </div>
      {config.data?.pendingFees ? <PendingFeeNotice className="mt-4" effectiveAt={config.data.pendingFees.effectiveAt}
        nextFees={config.data.pendingFees} kind="writer" /> : null}
      {requiredCollateral !== null ? <p className="mt-4 text-sm font-semibold">Locked collateral for this size: <span className="num">{assetAmount(requiredCollateral, collateralDecimals)} {collateralLabel}</span>{totalCollateral !== null && rentQuote.data?.free !== null && !hasCollateral ? <span className="ml-2 text-warn">Deposit more before listing.</span> : null}</p> : null}
      {totalCollateral !== null ? <p className="mt-2 text-sm">Free balance required including rent: <strong className="num">{formatUnits(totalCollateral, collateralDecimals)} {collateralLabel}</strong>.</p> : <p className="mt-2 text-sm text-ink-3">Waiting for the on-chain rent estimate before listing.</p>}
      {strike && units && quote ? <div className="mt-5 overflow-x-auto"><h3 className="font-display text-lg font-bold">What happens at expiry</h3>
        <table className="mt-3 w-full text-left text-sm"><thead className="border-b border-line text-ink-3"><tr><th className="py-2">Outcome</th><th className="py-2">Your collateral and premium</th></tr></thead><tbody>
          {isPut ? <>
            <tr className="border-b border-line"><td className="py-3">{ticker} at or above ${money(strike)}</td><td className="py-3">Your {money(requiredCollateral!)} USDG collateral returns, plus {money(quote.net)} USDG net premium.</td></tr>
            <tr><td className="py-3">{ticker} at ${money(strike * 9n / 10n)}</td><td className="py-3">You pay {money(requiredCollateral! - shortOutcome(strike * 9n / 10n, { isPut: true, strike, units, exerciseFeeBps: 0 }, quote.net).collateralReturned)} USDG from collateral. The rest returns, plus {money(quote.net)} USDG net premium.</td></tr>
          </> : <>
            <tr className="border-b border-line"><td className="py-3">{ticker} below ${money(strike)}</td><td className="py-3">Keep {formatUnits(units, 2)} Stock Tokens, plus {money(quote.net)} USDG net premium.</td></tr>
            <tr><td className="py-3">{ticker} at ${money(strike * 11n / 10n)}</td><td className="py-3">Keep about {retainedSharesAtExpiry(strike, strike * 11n / 10n, units).toFixed(4)} Stock Tokens, worth the strike value per original share, plus {money(quote.net)} USDG net premium.</td></tr>
          </>}
        </tbody></table><p className="mt-2 text-xs text-ink-3">These outcomes show premium and collateral separately, before writer rent and gas. Closing matching long and short units before expiry returns unused rent to whoever closes; refunds shrink with time and rounding. No rent refund is available at or after expiry.</p><p className="mt-2 text-xs text-ink-3">{isPut
          ? `If ${ticker} ends below the strike, you lose the difference in USDG from your locked collateral. The net premium offsets some of that loss.`
          : "Above strike, net-share settlement transfers a fraction of shares to the buyer, rather than the whole share."}</p>
      </div> : null}
      <div className="mt-5"><Button disabled={!canWrite || !hasCollateral || !!busy || !strike || !price || !units || !expiry} onClick={() => void listAsk()}>{busy === "Place your ask" ? "Placing…" : "Place AskWrite order"}</Button>
        <p className="mt-2 text-xs text-ink-3">The chain rechecks free collateral, market state, fee, calendar, and cutoff before placement.</p></div>
    </Panel>

    {!isPut ? <Panel as="section" id="auto-roll" aria-label="Auto-roll strategy" className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-bold">Auto-roll</h2>
        <p className="mt-2 text-sm text-ink-2">The keeper can list the next covered call from your free balance during regular New York market hours.</p></div>
        {showPause ? <Button size="sm" variant="ghost" disabled={!availability.pauseReady || !!busy} onClick={() => void pauseRoll()}>Pause</Button> : null}</div>
      {!rollerReady ? <Notice tone="info" className="mt-4">AutoRoller is not deployed in this build.</Notice> : null}
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><p className="text-ink-3">Status</p><p className="mt-1 font-semibold">{roll.isError ? "Status unavailable" : roll.isPending && !roll.data ? "Checking…" : active ? "Active" : "Paused / not set"}</p></div>
        <div><p className="text-ink-3">Current series / order</p><p className="mt-1 font-semibold">{accountStrategy?.currentSeries ? `${accountStrategy.currentSeries.ticker} $${accountStrategy.currentSeries.strike.formatted}` : "None"} · {accountStrategy?.orderId ?? "no order"}</p></div>
        <div><p className="text-ink-3">Last roll</p><p className="mt-1 font-semibold">{indexedStrategy?.lastRolledAt ? stamp(indexedStrategy.lastRolledAt) : "Not recorded"}</p></div>
        <div><p className="text-ink-3">Next possible roll</p><p className="mt-1 font-semibold">{nextTime ? stamp(nextTime) : "After the next expiry"}</p></div>
      </div>
      {indexedStrategy?.lastStaleCancelAt && indexedStrategy.currentLongId && !indexedStrategy.orderId ? <Notice tone="info" role="status" className="mt-3">Ask withdrawn at/past strike after spot reached ${indexedStrategy.staleSpot?.formatted ?? "—"} on {stamp(indexedStrategy.lastStaleCancelAt)}. The existing position remains; the next roll waits until after its expiry.</Notice> : null}
      <p className="mt-2 text-xs text-ink-3">Deposits must cover collateral plus writer rent. Depositing exactly N Stock Tokens usually writes fewer than N shares. Each future series pins its market rent rate when created.</p>
      <p className="mt-2 text-xs text-ink-3">The exact next roll also waits for settlement and the next regular market session.</p>
      <p className="mt-3 text-sm">{earned.data ? <><strong>{earned.data.complete ? "Lifetime premium" : "Premium in loaded history"}: </strong><span className="num">{money(earned.data.amount)} USDG</span>{!earned.data.complete ? " (more pages remain)" : null}</>
        : earned.isError ? "Lifetime premium history is temporarily unavailable." : "Loading premium history…"}</p>
      {active && accountStrategy ? <Button variant="ghost" size="sm" className="mt-4" onClick={() => {
        setStrategyForm(accountStrategy.strategy);
        setMaxShares(accountStrategy.strategy.maxUnits === "0" ? "" : formatUnits(BigInt(accountStrategy.strategy.maxUnits), 2));
        setFormTouched(true);
      }}>Load saved strategy into form</Button> : null}
      <div className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-semibold">Cycle<select value={strategy.weekly ? "weekly" : "daily"} onChange={(event) => { setStrategyForm((before) => ({ ...before, weekly: event.target.value === "weekly" })); setFormTouched(true); }}
          className="mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink"><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
        <label className="text-sm font-semibold">Strike above spot · bps<input inputMode="numeric" value={strategy.otmBps} onChange={(event) => { setStrategyForm((before) => ({ ...before, otmBps: Number(event.target.value) })); setFormTouched(true); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" /></label>
        <label className="text-sm font-semibold">Ask · bps of spot<input inputMode="numeric" value={strategy.askBps} onChange={(event) => { setStrategyForm((before) => ({ ...before, askBps: Number(event.target.value) })); setFormTouched(true); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" /></label>
        <label className="text-sm font-semibold">Max size · shares<input value={maxShares} onChange={(event) => { setMaxShares(event.target.value); setFormTouched(true); }} placeholder="All free"
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Blank means all free collateral.</span></label>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={strategy.smartPricing} onChange={(event) => { setStrategyForm((before) => ({ ...before, smartPricing: event.target.checked })); setFormTouched(true); }} /> Smart pricing within my limits</label>
      {strategy.smartPricing ? <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Minimum ask · bps<input inputMode="numeric" value={strategy.minAskBps} onChange={(event) => { setStrategyForm((before) => ({ ...before, minAskBps: Number(event.target.value) })); setFormTouched(true); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" /></label>
        <label className="text-sm font-semibold">Maximum ask · bps<input inputMode="numeric" value={strategy.maxAskBps} onChange={(event) => { setStrategyForm((before) => ({ ...before, maxAskBps: Number(event.target.value) })); setFormTouched(true); }}
          className="num mt-2 block min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" /></label>
      </div> : null}
      {strategyError ? <p role="alert" className="mt-3 text-sm text-danger">{strategyError}</p> : null}
      <div className="mt-5"><h3 className="font-display text-lg font-bold">Setup checklist</h3><ol className="mt-3 grid gap-2 sm:grid-cols-2">{ROLL_STEPS.map((step, index) => <li key={step.key} className="rounded-sm border border-line p-3 text-sm">
        <span className="font-semibold">{index + 1}. {step.label}</span><span className="ml-2 text-xs text-ink-3">{progress[step.key] ? "Done" : rollStep === step.key ? "Confirming…" : "Needed"}</span>
      </li>)}</ol></div>
      {roll.isError ? <Notice tone="warn" className="mt-4">Auto-roll status could not be read. You can retry after the chain responds.</Notice> : null}
      <Button className="mt-5" disabled={!canWrite || !rollerReady || !balance.data || !roll.data || !!busy || !!strategyError || (active && !formTouched)} onClick={() => void enableRoll()}>
        {busy === "Enable auto-roll" ? "Confirming setup…" : active ? "Update strategy" : "Enable auto-roll"}</Button>
      {active && !formTouched ? <p className="mt-2 text-xs text-ink-3">Load the saved strategy or select a preset to update it.</p> : null}
      <p className="mt-2 text-xs text-ink-3">Setup may ask for up to four transactions. Confirmed steps stay on chain, so you can return and continue.</p>
    </Panel> : null}
  </>;
}
