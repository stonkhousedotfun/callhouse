"use client";

/**
 * The House vault page for one market: deposit, request withdrawal, epoch countdown, past epochs,
 * in-kind preview, disclosures.
 *
 * This component ASSEMBLES. It authors no arithmetic and no disclosure copy: the figures come from
 * `web/lib/v2/houseRows.ts` (which in turn only routes `houseEpoch.ts`'s maths), the four disclosures
 * come from `web/lib/v2/houseCopy.ts`, and every write goes through `web/lib/v2/houseTx.ts`, which is
 * built on `simulatedWrite`/`approveExact` in `web/lib/v2/tx.ts:30-71`. Shape follows
 * `web/components/v2/LendVault.tsx` and `EarnMarket.tsx:92-120` — `useAccount`/`useWalletClient`,
 * `useNotice`/`useV2ReceiptNotice`, `Button/Notice/PageHead/Panel/Table` from `@/components/ui`, and
 * `useQueryClient` invalidating by the `v2Keys` prefix.
 *
 * NO LIVE SHARE PRICE ANYWHERE ON THIS PAGE. A NAV appears only as a boundary figure and is labelled
 * with the boundary it was struck at ({navCellLabel}); a running epoch shows the unavailable message.
 * There is no "you will receive N shares" estimate — a deposit states that it joins at the next
 * boundary and is valued there, which is {houseCountdown}'s `depositJoinsSentence`. The one exception
 * is v9's instant USDG deposit: the vault's own previewDepositNow picks that path, and
 * the share count is quoted only AFTER the transaction, from its DepositedNow log.
 *
 * PAST EPOCHS ARE FACTS, LOSING ONES INCLUDED. The table renders exactly what {pastEpochRows} returns,
 * in order, with no aggregate row, no average, no cumulative line and no streak. The sign lives in
 * `row.outcome`, and the "lost" case renders the same way every other case does.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import {
  Button, CardTitle, Chip, Eyebrow, Field, InfoTip, Notice, Panel, Row, Rows, SegmentedControl, Table, Tabs, TickerLogo,
} from "@/components/ui";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { houseDepositCancelTiming, houseDepositTiming, houseWithdrawTiming } from "@/lib/v2/payoutTiming";
import { HouseArmNotice } from "@/components/v2/LaunchCountdown";
import { NavHistoryChart, perShare } from "@/components/v2/NavHistoryChart";
import { rateExceedsCeiling } from "@/components/v2/VaultCosts";
import { houseExitSteps } from "@/components/v2/VaultExitSteps";
import { NOT_READ } from "@/components/v2/VaultHero";
import { BuyStockWidget } from "@/components/v2/BuyStockWidget";
import { EarliestWithdrawalLine } from "@/components/v2/EarliestWithdrawal";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { HouseCosts, HouseExit, HouseOnChain, HouseReturnSource, HouseRisks } from "@/components/v2/house/HouseDetails";
import { HouseStatStrip, LiveCountdown, type HouseStatCell } from "@/components/v2/house/HouseStats";
import { TIP_CONTAIN } from "@/components/v2/house/tipContain";
import { txUrl } from "@/lib/chain";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { fmtAsset, fmtShares, fmtUsdg } from "@/lib/format";
import { v2Markets } from "@/lib/markets";
import { dailyOffered } from "@/lib/v2/presets";
import type { HouseQueueItem } from "@/lib/v2/api-types";
import {
  boundaryState, cutoffSentences, formatNewYork, houseExposed, houseHeldUntil, NAV_NOT_AVAILABLE, STOCK_DECIMALS,
} from "@/lib/v2/houseEpoch";
import { houseClaimAmountLine, houseClaimDoneLine, houseClaimLine, houseClaimState } from "@/lib/v2/houseClaim";
import { onChainClock, useChainClockOffset } from "@/lib/v2/chainClock";
import {
  assertHouseGate, houseCancelDepositGate, houseCancelWithdrawGate, houseDepositGate, houseGateLine, houseWithdrawGate,
  readHouseGateState, type HouseGate, type HouseGateState,
} from "@/lib/v2/houseGates";
import { houseDepositsOpen } from "@/lib/v2/launchGates";
import { depositDoor } from "@/lib/v2/upgradePause";
import {
  cadenceFromKind, HOUSE_DEPOSIT_NOW_LABEL, HOUSE_DEPOSIT_QUEUE_LABEL, HOUSE_DEPOSIT_QUEUED_NOTICE, HOUSE_DISCLOSURE_CAN_LOSE,
  HOUSE_INSTANT_DEPOSIT_RULE, houseCadenceBadge, houseDepositedNowNotice, houseDepositRouteLine, houseDisclosures, houseExitLine,
  houseLede, housePerformanceFeeOwedLine,
} from "@/lib/v2/houseCopy";
import {
  houseCostsModel, houseCountdown, houseHeroModel, houseInKindPreview, houseProofRows, navCellLabel, navPoints, pastEpochRows,
} from "@/lib/v2/houseRows";
import {
  HOUSE_BOUNDARY_OVERDUE, HOUSE_BOUNDARY_WAITING, houseBoundaryHeld, HOUSE_NO_FILLS, HOUSE_NOT_LENT, HOUSE_RESULT_AT_BOUNDARY, houseInKindLine,
  houseRisks, houseYieldProse, NO_HISTORY, type LabelledValue,
} from "@/lib/v2/vaultCopy";
import {
  cancelHouseDepositRequest, cancelHouseWithdrawRequest, claimHouseWithdrawal, depositHouseNow, minSharesFor,
  parseHouseWithdrawShares, previewHouseDepositNow, requestHouseDeposit, requestHouseWithdraw, requireHouseVaultAddress,
} from "@/lib/v2/houseTx";
import { useConfig, useHouse, useHouseMarket, useHouseVaultReads, useMarkets, useSplitterReads, v2Keys } from "@/lib/v2/hooks";
import { HOUSE_WIND_DOWN_DETAIL, HOUSE_WIND_DOWN_UNREAD, houseWindDownHeadline, houseWindDownUnknown, houseWindingDown } from "@/lib/v2/houseWindDown";
import {
  HOUSE_SIBLING_CLOSED, HOUSE_VAULT_MISMATCH, houseSiblings, houseSiblingsHeading, houseVaultHref, houseVaultMismatch,
  houseVaultUnavailable,
} from "@/lib/v2/houseVaultSelect";
import type { WriteContext } from "@/lib/v2/tx";
import { Time } from "@/components/ui/Time";

// Display only, through the app's number rules (lib/numberFormat.ts): "12", "12.30", "12.5K", "<0.01".
const usdg = (raw: bigint) => fmtUsdg(raw);
const shares = (raw: bigint) => fmtShares(raw);

function queuedAmount(item: HouseQueueItem): string {
  if (item.kind === "withdraw") {
    // The API serves raw share base units (18 dp), so a queued 50-share withdrawal is
    // "50000000000000000000"; show it through the app's share formatter, as the "Your shares" line does.
    return item.shares === null ? "shares unavailable" : `${shares(BigInt(item.shares))} shares`;
  }

  const nonzero: string[] = [];
  if (item.assets !== null && BigInt(item.assets) !== 0n)
    nonzero.push(`${fmtUsdg(BigInt(item.assets))} USDG`);
  if (item.stockAmount !== null && item.stockAmount !== undefined && BigInt(item.stockAmount) !== 0n)
    nonzero.push(`${fmtAsset(BigInt(item.stockAmount))} Stock Tokens`);
  if (nonzero.length > 0) return nonzero.join(" and ");

  // A wire zero is an observed amount; null or an omitted legacy field is not. Preserve that
  // distinction even for a malformed all-zero deposit instead of inventing a missing leg.
  if (item.assets !== null) return `${fmtUsdg(BigInt(item.assets))} USDG`;
  if (item.stockAmount !== null && item.stockAmount !== undefined)
    return `${fmtAsset(BigInt(item.stockAmount))} Stock Tokens`;
  return "amount unavailable";
}

function parsePositive(raw: string, decimals: number): bigint | null {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
}

function markCell(label: string, mark: LabelledValue, sub: string | null): HouseStatCell {
  const figure = mark.text !== null && /\d/.test(mark.text);
  return { label, tip: mark.label, value: figure ? mark.text : "—", sub: figure ? sub : (mark.text ?? NOT_READ), caution: mark.tone === "caution" };
}

type HouseTab = "deposit" | "withdraw" | "requests";
type DepositAsset = "usdg" | "stock";

const NOTE = "rounded-md bg-warn-soft px-3.5 py-2.5 text-[13px] leading-snug text-ink-2";

/**
 * A deposit may be queued only when the vault is armed AND its cadence is known. A deposit locks until the
 * boundary, and a page that cannot say whether that is tonight's close or Friday's must not take one. Withdrawals and
 * claims are never gated on this: getting money out does not depend on the page knowing the cadence.
 */
export function houseDepositAllowed(depositsOpen: boolean, cadence: "weekly" | "daily" | null): boolean {
  return depositsOpen && cadence !== null;
}

/**
 * The arming of the vault the deposit writes to, from the page's own vault multicall. `undefined` while the
 * read is in flight, `null` when it failed (the whole query, or that one call), else the chain's answer. Only `true`
 * opens deposits (launchGates.houseDepositsOpen); a query error wins over stale data, so a refetch that fails shuts them.
 */
export function houseArming(reads: { data?: { protocolAccountsConfirmed?: boolean | null } | undefined; isError?: boolean }): boolean | null | undefined {
  if (reads.isError) return null;
  return reads.data === undefined ? undefined : (reads.data.protocolAccountsConfirmed ?? null);
}

/**
 * `vault` is the `?vault=` of /house/<ticker> (already address-checked by the page). It picks one exact vault of
 * the market; without it the indexer picks (daily first). Every write still goes to the vault NAMED IN THE RESPONSE, and
 * a response naming a different vault from the one asked for disables every write (houseVaultMismatch).
 */
export function HouseVault({ ticker, vault: requested }: { ticker: string; vault?: string }) {
  const { address } = useAccount();
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const queryClient = useQueryClient();
  const house = useHouseMarket(ticker, address, requested);
  const registryMarket = v2Markets().find((row) => row.ticker === ticker);
  // whether this market lists dailies (registry). SPCX does not, so its daily vault trades on Fridays
  // only and its copy says so (houseCopy.ts houseTradesFridaysOnly).
  const listsDailies = dailyOffered(registryMarket?.v2?.overrides);
  const underlying = (registryMarket?.asset ?? null) as Address | null;
  const vault = house.data?.vault ?? null;
  // chain facts for blocks A, C and H. Each field is null on its own failed read; the page never shows 0 for it.
  const reads = useHouseVaultReads((vault ?? undefined) as Address | undefined, address);
  // Deposits are shut until the vault is armed; withdrawals, claims and the roll are not.
  // The arming is read on THE VAULT THE DEPOSIT WRITES TO (`vault`, the /v2/house response's), in the same
  // multicall as its other facts -- not on the registry's per-market vault, which a daily vault can differ from.
  // Fail closed: unread (undefined), failed (null) and false all keep deposits shut (houseDepositsOpen).
  const armed = houseArming(reads);
  const depositsOpen = houseDepositsOpen(armed);
  const splitterReads = useSplitterReads(reads.data?.splitter ?? null);
  const config = useConfig();
  // The cadence is the /v2/house `kind` (the indexer decides it from the vault's factory; a launch-factory
  // vault has no weekly() view to read). Unknown or absent is null and is NEVER defaulted to weekly: the page then
  // names no cadence, shows the unknown-cadence terms, and keeps deposits shut. Withdrawals and claims stay open.
  const kind = house.data?.kind;
  const cadence = cadenceFromKind(kind);
  // A weekly vault winds down once the /v2/house list carries a daily vault (lib/v2/houseWindDown.ts). Its
  // deposit action goes; its withdrawal, cancel and claim actions stay. An unread list winds nothing down.
  const list = useHouse();
  // The guardian brakes of every market, to close deposits while the whole deployment is paused for an upgrade.
  const markets = useMarkets();
  const listed = list.isError ? [] : (list.data?.items ?? []);
  const listedKinds = listed.map((item) => item.kind);
  const windingDown = houseWindingDown(kind, listedKinds);
  // While that list is unread or failed a weekly vault's wind-down is unknown, and its deposit stays shut.
  const windDownUnread = houseWindDownUnknown(kind, !list.isError && list.data !== undefined);
  // The other vaults of this market, one click away. A weekly depositor must reach their own vault from any
  // page of the market, including the daily vault's.
  const siblings = houseSiblings(listed, ticker, vault ?? requested);
  // An indexer that predates `?vault=` answers with its first vault. Never write to a vault nobody picked.
  const mismatch = houseVaultMismatch(requested, vault);

  const [depositUsdg, setDepositUsdg] = useState("");
  const [depositStock, setDepositStock] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<HouseTab | null>(null);
  const [asset, setAsset] = useState<DepositAsset>("usdg");

  // The countdown ticks locally; the epoch boundary itself is the API's, never recomputed here.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The epoch cutoff is the chain's (HouseVault.sol PastCutoff; the queue's moved to
  // epochEnd - SETTLEMENT_WINDOW), so the gates below read the page tick moved onto the chain's clock. Null until
  // measured, which shuts nothing by cutoff.
  const chainNowS = onChainClock(now, useChainClockOffset());

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return {
      account: address,
      wallet: wallet.data,
      onConfirmed: async () => {
        await queryClient.invalidateQueries({ queryKey: v2Keys.houseMarket(ticker, address, requested) });
        // The claim button follows the vault's own request reads, so a claim or a request refreshes them too.
        await queryClient.invalidateQueries({ queryKey: v2Keys.vaultReads("house", vault ?? undefined, address) });
      },
    };
  }

  /** re-read the vault at one block, on the chain's clock, and refuse by the gate's own line before any write. */
  async function checkGate(gate: (state: HouseGateState) => HouseGate) {
    if (!address) throw new Error("Connect your wallet first.");
    assertHouseGate(gate(await readHouseGateState(requireHouseVaultAddress(vault), address)));
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

  const current = house.data?.currentEpoch ?? null;
  const countdown = current?.end !== null && current?.end !== undefined ? houseCountdown(now, current) : null;
  const rows = pastEpochRows(house.data?.epochs ?? []);
  const held = house.data?.shares?.shares ?? null;
  const queued = house.data?.shares?.queued ?? [];
  const epochs = house.data?.epochs ?? [];
  const end = current?.end ?? null;
  const hero = houseHeroModel(reads.data ?? null, epochs, end);
  const costs = houseCostsModel(reads.data ?? null, config.data?.fees ?? null, config.data?.constants?.feeChangeDelay ?? null, splitterReads.data ?? null);
  // The chain's SETTLEMENT_WINDOW() from the vault multicall; the queue cutoff is epochEnd minus it. Unread:
  // the cutoff sentences wait for it, and the gates and timing lines know only the close.
  const settlementWindow = reads.data?.settlementWindow ?? null;
  const cut = end === null || cadence === null || settlementWindow === null ? null : cutoffSentences(cadence, end, settlementWindow);
  // A close the vault did not lock is held a week by rollEpoch; unread reads hold nothing.
  const lock = { pinnedBoundary: reads.data?.pinnedBoundary ?? null, exposed: houseExposed(reads.data?.totalSupply, reads.data?.pendingDeposit) };
  const state = end === null ? null : boundaryState(now, end, lock);
  const exit = cadence === null ? null : houseExitSteps(cadence, settlementWindow);
  // HouseVault.requestDeposit has no pause of its own, so an upgrade pause also shuts both deposit buttons (and
  // the instant-deposit preview). Withdrawals, cancels and claims below are not gated by it.
  const houseDeposit = depositDoor(houseDepositAllowed(depositsOpen, cadence) && !windingDown && !windDownUnread && !mismatch,
    markets.isError ? null : markets.data);
  const canDeposit = houseDeposit.open;
  // Which path a USDG deposit of the amount entered takes is the VAULT's answer (previewDepositNow), never a
  // guess from the fields above. Unknown (unread, failed, nothing entered) keeps the queued label; the click asks again.
  const usdgAmount = parsePositive(depositUsdg, USDG_DECIMALS);
  const route = useQuery({
    queryKey: ["v2", "house-deposit-route", vault, usdgAmount?.toString() ?? null],
    queryFn: () => previewHouseDepositNow(vault, usdgAmount!),
    enabled: !!vault && usdgAmount !== null && canDeposit,
    retry: false,
    staleTime: 15_000,
  });
  // The vault's preview is the only route. A refusal (including the not-exact NoSource / StaleSpot)
  // is not "now" and carries no share count; the refusal name stays on the route line for the tests.
  const depositRoute = route.isError || !route.data ? null : route.data;
  const instant = depositRoute === null ? null : depositRoute.instant;
  // What claim() would do for this wallet, from the same vault multicall. Unread and failed reads keep it shut.
  const claim = houseClaimState(address ? reads.data : null);
  const claimLine = houseClaimLine(claim, end, now);
  // What that claim pays, from the vault's own claimable(account) in the same multicall. Shown beside the
  // button, never gating it: a matured request can quote (0, 0, 0) and still has to be claimed (houseClaim.ts). Both
  // readers below show it only for a READY claim, which `claim` above already confines to a connected wallet.
  const claimable = reads.data?.claimable ?? null;
  // whether the close refused the matured deposit (epochRates); then the claim returns it.
  const depositRefused = reads.data?.depositRefused ?? null;
  const claimAmountLine = houseClaimAmountLine(claim, claimable, depositRefused);
  const preview = house.data ? houseInKindPreview(house.data, claim, claimable) : null;
  // Each deposit/withdrawal button follows the vault's own rules for it (lib/v2/houseGates.ts), from the same
  // multicall; the cutoff is the epoch end the page already shows. The click re-checks on the chain (checkGate).
  const gateReads = address ? reads.data : undefined;
  const gates: HouseGateState = { epochId: gateReads?.epochId, withdrawRequest: gateReads?.withdrawRequest,
    depositRequest: gateReads?.depositRequest, balance: gateReads?.balance, epochEnd: end, now: chainNowS, settlementWindow };
  const usdgDepositGate = houseDepositGate(gates, instant === true);
  const stockDepositGate = houseDepositGate(gates, false);
  const cancelDepositGate = houseCancelDepositGate(gates);
  const withdrawGate = houseWithdrawGate(gates, parseHouseWithdrawShares(withdrawShares), shares);
  const cancelWithdrawGate = houseCancelWithdrawGate(gates);
  const gateLine = (gate: HouseGate, slot: string) => {
    const line = address ? houseGateLine(gate) : null;
    return line === null ? null : <p className="text-[13px] leading-snug text-ink-2" data-slot={slot}>{line}</p>;
  };
  // One line when both deposit buttons are shut for the same reason (the cutoff).
  const depositLinesMatch = houseGateLine(stockDepositGate) === houseGateLine(usdgDepositGate);
  const usdgGateLine = gateLine(usdgDepositGate, "house-deposit-gate");
  const stockGateLine = depositLinesMatch ? null : gateLine(stockDepositGate, "house-stock-deposit-gate");
  const showCancelDeposit = cancelDepositGate.open || houseGateLine(cancelDepositGate) !== null;
  const showCancelWithdraw = cancelWithdrawGate.open || houseGateLine(cancelWithdrawGate) !== null;
  // The performance fee charged but not yet paid, read from the vault; shown only when it is non-zero.
  const owedFee = reads.data?.performanceFeeOwed ?? null;
  const terms = (className: string) => cadence === null
    ? <aside aria-label="Withdrawal terms" className={`rounded-md border border-line bg-field px-3.5 py-3 text-[13px] leading-snug text-ink-2 ${className}`.trim()}>{houseExitLine(kind, listsDailies)}</aside>
    : <WithdrawalTerms className={className} surface="house" boundaryAt={current?.end ?? null} now={now} cadence={cadence} marketListsDailies={listsDailies} settlementWindow={settlementWindow} />;

  const shownTab: HouseTab = tab ?? (claim.kind === "ready" ? "requests" : windingDown ? "withdraw" : "deposit");
  const lastClose = epochs.some((e) => e.nav !== null) ? "At the last close" : null;
  const points = navPoints(epochs);
  const chartable = points.length > 0 && points.every((point) => perShare(point) !== null);

  const stats: HouseStatCell[] = [
    markCell("Value per share", hero.value, lastClose),
    markCell("Vault total", hero.tvl, lastClose),
    address ? {
      label: "Your position",
      value: held === null ? "—" : `${shares(BigInt(held))} shares`,
      sub: <>
        {held === null ? <span className="block">{NOT_READ}</span> : null}
        {hero.positionAtMark ? <span className="block">≈ {hero.positionAtMark.text ?? NOT_READ} {hero.positionAtMark.label}</span> : null}
        {queued.length ? <span className="block font-medium text-accent-text">{queued.length} request{queued.length === 1 ? "" : "s"} queued ({queued.map((q) => q.kind).join(", ")})</span> : null}
      </>,
    } : { label: "Your position", value: "—", sub: "Connect a wallet to see your position." },
    countdown && end !== null ? {
      label: "Next close",
      tip: <>{[countdown.depositJoinsSentence, cut ? `${cut.deposit} ${cut.withdraw}` : null, "Share price: set at the close."]
        .filter((line) => line !== null).map((line) => <span key={line} className="mb-1.5 block last:mb-0">{line}</span>)}</>,
      value: <LiveCountdown to={end} now={now} className="whitespace-nowrap max-sm:text-[15px]" />,
      sub: countdown.boundaryLabel,
      slot: "house-next-close",
    } : { label: "Next close", value: "—", sub: "The next close is unavailable.", slot: "house-next-close" },
  ];

  const depositPanel = <section aria-label="Deposit" className="grid gap-4">
    {/* A winding-down weekly vault offers no deposit at all -- not a disabled button -- and says why. A
        deposit already queued can still be cancelled below. */}
    {windingDown ? <p className="rounded-md bg-field px-3.5 py-3 text-[14px] leading-snug text-ink-2">{houseWindDownHeadline(end)}</p> : <>
    {houseDeposit.note ? <p data-slot="upgrade-paused" role="status" className={NOTE}>{houseDeposit.note}</p> : null}
    {windDownUnread && list.isError ? <p data-slot="wind-down-unread" role="status" className={NOTE}>{HOUSE_WIND_DOWN_UNREAD}</p> : null}
    <div className="grid gap-2">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">Deposit with
        <InfoTip label="About the two deposit routes" align="start"
          text={<span data-slot="house-instant-deposit-rule">{HOUSE_INSTANT_DEPOSIT_RULE}</span>} /></p>
      <SegmentedControl label="Deposit with" selected={asset} onSelect={setAsset} className="w-full! [&>button]:flex-1"
        options={[{ value: "usdg", label: "USDG" }, { value: "stock", label: "Stock Tokens" }]} />
    </div>
    <div hidden={asset !== "usdg"}>
      <Field id="house-deposit-usdg" label="Amount" suffix="USDG" inputMode="decimal" autoComplete="off" placeholder="100"
        value={depositUsdg} onChange={(event) => setDepositUsdg(event.target.value)} />
      {houseDepositRouteLine(instant) ? <p className={`mt-2 text-[13px] font-medium ${instant ? "text-accent-text" : "text-ink-2"}`} data-slot="house-deposit-route" data-refusal={depositRoute && depositRoute.instant === false ? depositRoute.refusal : undefined}>{houseDepositRouteLine(instant)}</p> : null}
    </div>
    <div hidden={asset !== "stock"}>
      <Field id="house-deposit-stock" label="Amount" suffix={ticker} inputMode="decimal" autoComplete="off" placeholder="1"
        value={depositStock} onChange={(event) => setDepositStock(event.target.value)} />
    </div>
    {terms("")}
    {/* When the deposit is served, above both deposit buttons (USDG and Stock Token join at the same boundary). */}
    <PayoutTiming now={now} of={(t) => cadence === null || end === null ? null : houseDepositTiming({ cadence, epochEnd: end, now: t, settlementWindow })} />
    <div hidden={asset !== "usdg"}>
      <Button className="w-full" hidden={!address} disabled={mismatch || !canDeposit || !vault || !address || !!busy || !parsePositive(depositUsdg, USDG_DECIMALS) || !usdgDepositGate.open}
        onClick={() => void act("Deposit USDG into the house vault", async () => {
          const amount = parsePositive(depositUsdg, USDG_DECIMALS);
          if (!amount) throw new Error("Enter a positive deposit.");
          // Asked again at the click: the label may be a few seconds old. The vault's answer picks the path.
          const answer = await previewHouseDepositNow(vault, amount);
          await checkGate((state) => houseDepositGate(state, answer.instant));
          if (answer.instant) {
            const minted = await depositHouseNow(context(), vault, USDG, amount, minSharesFor(answer.shares));
            setDepositUsdg("");
            return houseDepositedNowNotice(minted.shares === null ? null : shares(minted.shares));
          }
          await requestHouseDeposit(context(), vault, USDG, amount);
          setDepositUsdg("");
          return HOUSE_DEPOSIT_QUEUED_NOTICE;
        })}>{instant === true ? HOUSE_DEPOSIT_NOW_LABEL : HOUSE_DEPOSIT_QUEUE_LABEL}</Button>
    </div>
    <div hidden={asset !== "stock"}>
      <Button className="w-full" hidden={!address}
        disabled={mismatch || !canDeposit || !vault || !address || !underlying || !!busy || !parsePositive(depositStock, STOCK_DECIMALS) || !stockDepositGate.open}
        onClick={() => void act("Deposit Stock Tokens into the house vault", async () => {
          const amount = parsePositive(depositStock, STOCK_DECIMALS);
          if (!amount) throw new Error("Enter a positive deposit.");
          if (!underlying) throw new Error("This market has no Stock Token address in the registry.");
          await checkGate((state) => houseDepositGate(state, false));
          await requestHouseDeposit(context(), vault, underlying, amount);
          setDepositStock("");
          return HOUSE_DEPOSIT_QUEUED_NOTICE;
        })}>Queue Stock Token deposit</Button>
    </div>
    {usdgGateLine ? <div hidden={asset !== "usdg" && !depositLinesMatch}>{usdgGateLine}</div> : null}
    {stockGateLine ? <div hidden={asset !== "stock"}>{stockGateLine}</div> : null}
    </>}
  </section>;

  const withdrawPanel = <section aria-label="Withdraw" className="grid gap-4">
    <Field id="house-withdraw" label="Shares" suffix="shares" inputMode="decimal" autoComplete="off" placeholder="1"
      aside={held !== null ? <>Your shares: <span className="num">{shares(BigInt(held))}</span></> : null}
      value={withdrawShares} onChange={(event) => setWithdrawShares(event.target.value)} />
    <Rows>
      <Row k="You receive" v={`USDG + ${ticker} stock`} mono={false}
        tip={<>{houseInKindLine(ticker)} {preview !== null && preview.available ? null : <>The exact amounts are {preview === null ? NAV_NOT_AVAILABLE : preview.message}.</>}</>} />
    </Rows>
    {cadence === null || windingDown ? terms("") : null}
    <PayoutTiming now={now} of={(t) => cadence === null || end === null ? null : houseWithdrawTiming({ cadence, epochEnd: end, now: t, settlementWindow })} />
    <Button className="w-full" hidden={!address} disabled={mismatch || !vault || !address || !!busy || !parseHouseWithdrawShares(withdrawShares) || !withdrawGate.open}
      onClick={() => void act("Request a house vault withdrawal", async () => {
        const amount = parseHouseWithdrawShares(withdrawShares);
        if (!amount) throw new Error("Enter a positive share amount.");
        await checkGate((state) => houseWithdrawGate(state, amount, shares));
        await requestHouseWithdraw(context(), vault, amount);
        setWithdrawShares("");
        return "Withdrawal queued until the next close.";
      })}>Request withdrawal</Button>
    {gateLine(withdrawGate, "house-withdraw-gate")}
    {/* The indexer's earliestWithdrawal for this vault, with its reason and the FAQ answer. */}
    {vault ? <EarliestWithdrawalLine value={house.data?.earliestWithdrawal} surface="house" now={now} /> : null}
  </section>;

  const requestsPanel = <section aria-label="Your requests" className="grid gap-4">
    {queued.length ? <ul className="grid rounded-md border border-line px-3.5" data-slot="house-queued">
      {/* The API says where each request stands by HouseVault.claim's own rule (the vault rolled past its
          epoch). A claimable one is collected by the Claim button below and can no longer be cancelled; the Cancel
          and Claim buttons still decide from the live chain read (houseGates.ts, houseClaim.ts). */}
      {queued.map((item, index) => <li key={`${item.kind}-${item.requestedAt}-${item.account}-${index}`}
        className="flex items-start justify-between gap-3 border-b border-line py-3 last:border-b-0"
        data-slot={`house-queued-${item.status ?? "unknown"}`}>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink">{item.kind === "withdraw" ? "Withdrawal" : "Deposit"}{" "}
            <span className="num font-medium" data-slot="house-queued-amount">{queuedAmount(item)}</span></p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Requested <Time at={item.requestedAt} />
            {item.status === "pending" && item.maturesAt != null ? <> · Priced at the close after <Time at={item.maturesAt} /></> : null}</p>
        </div>
        {item.status === "claimable"
          ? <span className="flex shrink-0 items-center gap-1.5"><Chip tone="accent" dot>Ready to claim</Chip>
            <InfoTip label="About this request" align="end" text="It was priced at the close. Collect it with Claim below; it can no longer be cancelled." /></span>
          : <Chip className="shrink-0">Queued</Chip>}
      </li>)}
    </ul> : null}

    {!address ? <p className="rounded-md border border-dashed border-line-2 px-4 py-8 text-center text-[13.5px] text-ink-3">Your requests and claims show here once a wallet is connected.</p> : null}
    <div className="grid gap-3 rounded-md border border-line bg-field p-3.5" hidden={!address} data-slot="house-claim">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">Claim
          {preview !== null && preview.available
            ? <InfoTip label="What the claim pays" align="start" text={<p data-slot="house-in-kind">Your claim pays <span className="num">{usdg(preview.usdgOut)}</span> USDG and <span className="num">{fmtAsset(preview.stockOut)}</span> Stock Tokens{preview.sharesOut !== 0n ? <>, and <span className="num">{shares(preview.sharesOut)}</span> shares</> : null}: the vault&apos;s own figure {depositRefused === true ? <>for your requests. It includes your refused deposit, returned as you queued it.</> : <>for your priced request.</>}</p>} />
            : null}
        </div>
        {claim.kind === "ready" ? <Chip tone="accent" dot>Ready</Chip> : null}
      </div>
      {claimAmountLine !== null ? <p className="text-[14px] font-medium leading-snug text-ink" data-slot="house-claim-amount">{claimAmountLine}</p> : null}
      {claimLine !== null && address ? <p className="text-[13px] leading-snug text-ink-2" data-slot="house-claim-state">{claimLine}</p> : null}
      {/* Enabled only when claim() has a matured request to retire (houseClaim.ts). A request queued in this
          epoch is pending, not claimable, and the line says when it will be. */}
      <Button variant={claim.kind === "ready" ? "primary" : "secondary"} className="w-full" hidden={!address}
        disabled={mismatch || !vault || !address || !!busy || claim.kind !== "ready"}
        onClick={() => void act("Claim a settled withdrawal", async () =>
          houseClaimDoneLine(await claimHouseWithdrawal(context(), vault)))}>Claim settled withdrawal</Button>
      {/* There is deliberately NO "claim what is still owed" action here. HouseVault.claimOwed() is
          `restricted` to QUOTER (callhouse-contracts HouseVault.claimOwed, roles.v8.json HouseVault
          "claimOwed()": "QUOTER"), so it reverted for every depositor; and it pulls what the order book owes the
          VAULT, not a payout to anyone. The permissionless rollEpoch already pulls it (its best-effort orderBook.claimOwed) and the
          keeper's QUOTER sends it (keeper/src/v2/mm/planner.ts:774, quoter.ts:1220). A depositor's money arrives
          through "Claim settled withdrawal" above. */}
    </div>

    <div className="grid gap-3" hidden={!showCancelDeposit} data-slot="house-cancel-deposit">
      <PayoutTiming now={now} of={(t) => cadence === null || end === null ? null : houseDepositCancelTiming({ cadence, epochEnd: end, now: t, settlementWindow })} />
      <Button variant="ghost" className="w-full" disabled={mismatch || !vault || !address || !!busy || !cancelDepositGate.open}
        onClick={() => void act("Cancel queued deposit", async () => {
          await checkGate(houseCancelDepositGate);
          await cancelHouseDepositRequest(context(), vault);
          return "Queued deposit cancelled.";
        })}>Cancel queued deposit</Button>
      {gateLine(cancelDepositGate, "house-cancel-deposit-gate")}
    </div>
    <div className="grid gap-3" hidden={!showCancelWithdraw} data-slot="house-cancel-withdraw">
      <Button variant="ghost" className="w-full" disabled={mismatch || !vault || !address || !!busy || !cancelWithdrawGate.open}
        onClick={() => void act("Cancel queued withdrawal", async () => {
          await checkGate(houseCancelWithdrawGate);
          await cancelHouseWithdrawRequest(context(), vault);
          return "Queued withdrawal cancelled.";
        })}>Cancel queued withdrawal</Button>
      {gateLine(cancelWithdrawGate, "house-cancel-withdraw-gate")}
    </div>
  </section>;

  return <div className={`relative min-w-0 ${TIP_CONTAIN}`}>
    <header className="grid gap-x-10 gap-y-4 pb-6 pt-6 sm:pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:pt-10">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <TickerLogo ticker={ticker} className="text-[20px]" />
          <Eyebrow>{`${ticker} house vault`}</Eyebrow>
          {house.data ? <Chip className="border border-line-2" data-slot="house-cadence">{houseCadenceBadge(kind, listsDailies)}</Chip> : null}
        </div>
        <h1 className="mt-3.5 text-[length:clamp(28px,3.6vw,40px)] font-extrabold leading-[1.08] tracking-[-0.03em]">
          {windingDown ? "This house vault is winding down." : "Deposit into the house vault."}
        </h1>
        <p className="mt-2.5 max-w-[62em] text-[15px] leading-relaxed text-ink-2 sm:text-[15.5px]">{houseLede(cadence, listsDailies)}</p>
      </div>
      {/* The four required disclosures, rendered from houseCopy.ts and never retyped here; the withdrawal one follows the
          cadence. (short cards, detail behind a "?"): the notice leads with the one line that must
          be seen, and the four sit in its tip, which is in the page markup at all times (aria-describedby). */}
      <Notice tone="warn" className="w-fit">
        <p className="flex items-center gap-2 font-semibold text-ink">You can lose money.
          <InfoTip label="About the risks" align="end" text={<>{houseDisclosures(cadence, listsDailies).map((line) => <span key={line} className="mb-2 block last:mb-0">{line}</span>)}</>} />
        </p>
      </Notice>
      {siblings.length ? <nav aria-label={houseSiblingsHeading(ticker)} data-slot="house-sibling-vaults"
        className="flex min-w-0 flex-wrap items-center gap-2 lg:col-span-2">
        <p className="text-[13px] font-semibold text-ink-3">{houseSiblingsHeading(ticker)}</p>
        <ul className="flex min-w-0 flex-wrap gap-2">
          {siblings.map((item) => <li key={item.vault!} className="min-w-0">
            <a href={houseVaultHref(ticker, item.vault!)} data-sibling-vault={item.vault!}
              className="inline-block max-w-full rounded-pill border border-line-2 bg-surface-2 px-3.5 py-2 text-[13px] font-semibold leading-tight text-ink transition-colors hover:border-ink-3">{houseCadenceBadge(item.kind, listsDailies)} house vault <span className="num font-normal text-ink-3">{item.vault!.slice(0, 6)}…{item.vault!.slice(-4)}</span>
              {houseWindingDown(item.kind, listedKinds) ? <span className="font-normal text-ink-3" data-slot="house-sibling-closed">, {HOUSE_SIBLING_CLOSED}</span> : null}
              <span aria-hidden="true" className="ml-1.5 text-ink-3">→</span>
            </a>
          </li>)}
        </ul>
      </nav> : null}
    </header>

    <div className="mb-5 grid gap-3 empty:hidden [&>section]:mb-0">
      {/* "not deployed yet" is true only when no particular vault was asked for. A vault named in the link that
          cannot be read is a different fact, and the page says so and links back to the market's default vault. */}
      {vault ? <HouseArmNotice ticker={ticker} armed={armed} isError={reads.isError} />
        : requested === undefined ? <Notice tone="info">The house vault for {ticker} is not deployed yet. Deposits open when it is.</Notice>
        : house.isError ? <Notice tone="warn" role="alert">
            {houseVaultUnavailable(ticker)} <a href={`/house/${ticker.toLowerCase()}`} className="underline">Open the {ticker} house vault page</a>.
          </Notice>
        : null}
      {mismatch ? <Notice tone="warn" role="alert">{HOUSE_VAULT_MISMATCH}</Notice> : null}
      {windingDown ? <Notice tone="warn" role="status" title={houseWindDownHeadline(end)}>{HOUSE_WIND_DOWN_DETAIL}</Notice> : null}
      {house.isError ? <Notice tone="warn">The house vault figures are unavailable right now. Nothing below is current.</Notice> : null}
      {state === "waiting" ? <Notice tone="info">{HOUSE_BOUNDARY_WAITING}</Notice> : null}
      {state === "held" && end !== null ? <Notice tone="warn">{houseBoundaryHeld(formatNewYork(houseHeldUntil(end)))}</Notice> : null}
      {state === "overdue" ? <Notice tone="warn" role="alert">{HOUSE_BOUNDARY_OVERDUE}</Notice> : null}
      {rateExceedsCeiling(costs.rateBps, costs.ceilBps) ? <Notice tone="danger" role="alert">
        The vault reports a fee above its own limit. Don&apos;t rely on either number until that is fixed.
      </Notice> : null}
    </div>

    {/* A. Hero. Value and TVL are nav() marks, labelled with their boundary (houseRows.houseHeroModel). */}
    <HouseStatStrip label={`${ticker} house vault summary`} cells={stats} />
    {owedFee !== null && owedFee > 0n
      ? <p className="mt-3 text-[13px] leading-snug text-ink-2" data-slot="house-performance-fee-owed">{housePerformanceFeeOwedLine(usdg(owedFee))}</p>
      : null}

    <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_440px]">
      <div className="grid min-w-0 gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <Panel as="section" aria-label="Vault actions" pad="sm" lift>
          <Tabs label={`${ticker} house vault action`} value={shownTab} onChange={setTab} items={[
            { value: "deposit", label: "Deposit", panel: depositPanel },
            { value: "withdraw", label: "Withdraw", panel: withdrawPanel },
            { value: "requests", label: "Requests", panel: requestsPanel,
              badge: queued.length ? String(queued.length) : claim.kind === "ready" ? "1" : undefined },
          ]} />
          {!address ? <div className="mt-4 grid gap-2">
            <ConnectButton block />
            <p className="text-center text-[12.5px] text-ink-3">Connect a wallet to deposit or request a withdrawal.</p>
          </div> : null}
        </Panel>
        {/* renders only for a connected wallet that holds none of this stock. */}
        {!windingDown ? <div hidden={shownTab !== "deposit" || asset !== "stock"}><BuyStockWidget ticker={ticker} stock={underlying} /></div> : null}
      </div>

      {/* G. Share price per boundary. */}
      {chartable ? <Panel as="section" aria-label="Share price" pad="sm" className="lg:col-start-1 lg:row-start-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <CardTitle>Share price</CardTitle>
          <span className="text-[12.5px] text-ink-3">After each close</span>
        </div>
        <div className="mt-3 text-accent-text"><NavHistoryChart points={points} tableId="house-epochs" /></div>
      </Panel> : null}

      <Panel as="section" aria-label="Past closes" pad="sm" className="lg:col-span-2 lg:row-start-3">
        <CardTitle>Past closes</CardTitle>
        {rows.length === 0
          ? <div className="mt-4 grid place-items-center gap-1.5 rounded-md border border-dashed border-line-2 px-4 py-10 text-center">
              <p className="font-semibold text-ink">No close has settled yet.</p>
              {countdown ? <p className="text-[13px] text-ink-3">The first one is {countdown.boundaryLabel}.</p> : null}
            </div>
          : <>
            <div id="house-epochs"><Table label={`${ticker} house vault closes`} className="mt-4">
              <thead><tr>
                <th className="!text-left">#</th><th className="!text-left">Started · ended</th><th>Value (USDG)</th><th>Closing price</th><th>Result (USDG)</th><th>Fee (USDG)</th><th>Close tx</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => <tr key={row.id} data-outcome={row.outcome}>
                  <td className="!text-left align-top">{row.id}</td>
                  <td className="!text-left"><span className="block">{row.startLabel}</span><span className="block text-ink-3">{row.endLabel}</span></td>
                  <td className="num">{row.nav.available
                    ? <><span className="block">{usdg(row.nav.navUsdg)}</span><span className="block font-body text-[12px] text-ink-3">{navCellLabel(row)}</span></>
                    : <span className="font-body text-ink-3">{NAV_NOT_AVAILABLE}</span>}</td>
                  <td className="num">{row.settlementPrice ?? "—"}</td>
                  <td className="num">{row.resultUsdg === null ? <span className="font-body text-ink-3">not reported</span> : usdg(row.resultUsdg)}</td>
                  <td className="num">{row.feeTakenUsdg === null ? <span className="font-body text-ink-3">not reported</span> : usdg(row.feeTakenUsdg)}</td>
                  <td>{row.tx === null ? <span className="font-body text-ink-3">not reported</span> : <a href={txUrl(row.tx)} target="_blank" rel="noreferrer" className="font-body underline underline-offset-2">view</a>}</td>
                </tr>)}
              </tbody>
            </Table></div>
          </>}
      </Panel>

      <section aria-label="About this vault" className={`grid min-w-0 gap-2.5 lg:col-start-1 ${chartable ? "lg:row-start-2" : "lg:row-start-1 lg:row-span-2"}`}>
        <h2 className="px-1 text-[12.5px] font-bold uppercase tracking-[0.08em] text-ink-3">About this vault</h2>
        {/* B. Where the return comes from. The live per-epoch lines need more indexer data; until then the prose and a no-fills state. */}
        <HouseReturnSource prose={houseYieldProse(ticker)} tip={`${HOUSE_NOT_LENT} ${HOUSE_RESULT_AT_BOUNDARY}`}
          status={epochs.some((e) => e.nav !== null) ? HOUSE_NO_FILLS : NO_HISTORY} />
        {/* C. What it costs. */}
        <HouseCosts {...costs} />
        <HouseExit exit={exit} line={houseExitLine(kind, listsDailies)} />
        <HouseRisks risks={cadence === null ? null : houseRisks(cadence, ticker)}
          fallback={[HOUSE_DISCLOSURE_CAN_LOSE, houseExitLine(kind, listsDailies)]} />
        {/* H. On chain. */}
        <HouseOnChain rows={houseProofRows(vault, reads.data ?? null, underlying, splitterReads.data ?? null, epochs)} />
      </section>
    </div>
  </div>;
}
