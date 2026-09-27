"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Disclosure, ExternalLink, Field, InfoTip, Notice, PageHead, Panel, Row, Rows, Tabs, WarnIcon } from "@/components/ui";
import { PayoutTiming } from "@/components/ui/PayoutTiming";
import { Time } from "@/components/ui/Time";
import { earnVaultDepositTiming, earnVaultRedeemTiming, type EarnVaultInput } from "@/lib/v2/payoutTiming";
import { NO_CHART_YET } from "@/components/v2/NavHistoryChart";
import { LendApy, lendRateStat } from "@/components/v2/LendApy";
import { rateExceedsCeiling } from "@/components/v2/VaultCosts";
import { earnExitSteps } from "@/components/v2/VaultExitSteps";
import { NOT_READ } from "@/components/v2/VaultHero";
import type { ProofRow } from "@/components/v2/VaultProof";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { EarnCostsBlock, EarnExitBlock, EarnHistoryBlock, EarnProofBlock, EarnReturnBlock, EarnRisksBlock } from "@/components/v2/earn/EarnDetails";
import { EarnHeldPayments, EarnRequests } from "@/components/v2/earn/EarnRequests";
import { EarnStat, FactBox, labelledParts } from "@/components/v2/earn/EarnStats";
import { publicClient } from "@/lib/chain";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { fmtUsdg } from "@/lib/format";
import { displayQuantity } from "@/lib/numberFormat";
import type { ConfigResponse, EarnVault } from "@/lib/v2/api-types";
import type { EarnVaultReads, SplitterReads } from "@/lib/v2/chainReads";
import { v2AddressOverrideConflictNotices, v2AddressProvenanceNotices, v2ConfigWarnings } from "@/lib/v2/config";
import { earliestWithdrawalCopy } from "@/lib/v2/earliestWithdrawal";
import { explainEarnRedeemError } from "@/lib/v2/errors";
import { useConfig, useEarn, useEarnVaultReads, useMarkets, useSplitterReads } from "@/lib/v2/hooks";
import { depositDoor } from "@/lib/v2/upgradePause";
import {
  bpsPct, EARN_NO_SHARES_LABEL, EARN_NO_SHARES_VALUE, EARN_NO_VENUE, EARN_RISKS, earnSkimLine, feeRouteLine, NO_RATE_YET, VAULT_INDICATIVE_LABEL,
  type LabelledValue,
} from "@/lib/v2/vaultCopy";
import { approveExact, type WriteContext } from "@/lib/v2/tx";
import { cancelQueuedRequest, claimDeferredPayment, depositToVault, depositToVaultTracked, earnVaultAddress, lendRedeemInput, processVaultQueue, redeemFromVaultTracked } from "@/lib/v2/lendTx";
import { HELD_SECTION_TITLE, heldPaymentsView, useHeldPayments } from "@/lib/v2/earnDeferred";
import { lendQueueCards, redeemPreview } from "@/lib/v2/earnQueue";
import {
  CANNOT_PREVIEW, formatEarnDepositPreview, formatEarnQueuedPreview, formatEarnRedeemPreview,
  readEarnDepositPreview, readEarnQueuedPreview, readEarnRedeemPreview,
} from "@/lib/v2/moneyPreviews";
import { lendApyView } from "@/lib/v2/lendApy";

function parsePositive(raw: string, decimals: number) {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
}

/**
 * The interest figure /earn shows, and the three ways it refuses to show one.
 *
 * THE PAGE SHOWS AN INTEREST PERCENTAGE, and the rules for that number are explicit about what it must carry:
 * the percentage is "derived from realised accrual over the deposited balance for the period it
 * covers", the period is "labelled explicitly on the number", and the protocol skim is stated
 * BESIDE it "so the figure the depositor sees is the figure the depositor gets".
 *
 * WHY THIS IS A FUNCTION AND NOT JSX. Each refusal below is a case where rendering something would
 * be worse than rendering nothing, and a percentage is the specific figure that is unreadable
 * without its period -- "4%" is not a smaller version of "4% over the last 7 days", it is a
 * different and unfalsifiable claim. Keeping the decision out of the markup is what lets the test
 * break each refusal on its own.
 *
 * THE SKIM IS READ FROM THE CHAIN, NEVER FROM THE DESIGN DOC. The design says "~10%";
 * the plan forbids using it and names `earnVault.skimBps()` bounded by `SKIM_BPS_CEIL()` as the
 * source. A hardcoded 10% would render correctly on a vault configured at any other value, which is
 * the false-green shape: a number that looks right because nothing can see its subject.
 */
export type LendInterestView =
  | { kind: "unconfigured" }
  | { kind: "not-read" }
  | { kind: "no-interest-yet" }
  | { kind: "unlabelled-period" }
  | { kind: "skim-above-ceiling"; skimBps: number; ceilBps: number }
  | { kind: "figure"; percent: string; periodLabel: string; skimPercent: string };

export function lendInterestView(input: {
  /** Vault address, or null when the registry has no earnVault key and no valid override. */
  vault: Address | null;
  /** USDG actually credited to this depositor over the period. Null when not read. */
  realisedUsdg: bigint | null;
  /** The depositor's balance the accrual is measured against. Null when not read. */
  balanceUsdg: bigint | null;
  /** "last 7 days", "since deposit". Never empty: a percentage without a period is the one form that is unreadable. */
  periodLabel: string;
  /** earnVault.skimBps(). Null when not read -- then no skim is stated, rather than a guessed one. */
  skimBps: number | null;
  /** earnVault.SKIM_BPS_CEIL(). Null when not read. */
  ceilBps: number | null;
}): LendInterestView {
  // The vault is not deployed. The plan: "Plan for it; do not fake it" -- and a page that says
  // nothing has been paid yet is stating a fact about an empty vault, not making a disclosure.
  if (input.vault === null) return { kind: "unconfigured" };
  // NOT READ is not NO INTEREST, and the page must not say the second when it means the first.
  // "The vault has paid nothing" is a claim about the vault; "we did not read it" is a claim about
  // this page. Collapsing them gives a depositor a confident answer sourced from an absent read --
  // the same false-green shape as a check that passes because it cannot see its subject.
  if (input.realisedUsdg === null || input.balanceUsdg === null) return { kind: "not-read" };
  if (input.realisedUsdg <= 0n || input.balanceUsdg <= 0n) return { kind: "no-interest-yet" };
  if (input.periodLabel.trim() === "") return { kind: "unlabelled-period" };
  // A skim above its own on-chain ceiling means the two reads disagree; say so rather than render a
  // net figure computed from a value the contract itself would not accept.
  if (input.skimBps !== null && input.ceilBps !== null && input.skimBps > input.ceilBps) {
    return { kind: "skim-above-ceiling", skimBps: input.skimBps, ceilBps: input.ceilBps };
  }
  // Same rule for the skim: an unread skim means the NET figure is unknown, not that it is zero.
  if (input.skimBps === null) return { kind: "not-read" };
  // Basis points of the balance, to two decimals, computed in integer arithmetic so the ratio never
  // goes through a float. 1e4 basis points = 100%.
  const bps = (input.realisedUsdg * 10_000n) / input.balanceUsdg;
  return {
    kind: "figure",
    percent: `${(Number(bps) / 100).toFixed(2)}%`,
    periodLabel: input.periodLabel.trim(),
    skimPercent: `${(input.skimBps / 100).toFixed(2)}%`,
  };
}

/**
 * The interest panel on /earn. Each branch states its own reason, because the reasons are not
 * interchangeable: an undeployed vault, an unread figure and a vault that has genuinely paid
 * nothing look identical to a depositor unless the page says which one it is.
 */
export function LendInterest({ view }: { view: LendInterestView }) {
  if (view.kind === "figure") {
    return <section aria-label="Interest" className="grid gap-2">
      <h3 className="flex items-center gap-1.5 font-display text-[15px] font-bold text-ink">
        Your interest
        <InfoTip label="About this figure" align="start" text={`Interest credited to your balance over the ${view.periodLabel}. It is not a forecast. Our cut is read from the vault.`} />
      </h3>
      <Rows>
        <Row k={`Earned · ${view.periodLabel}`} v={view.percent} />
        <Row k="Our cut of that" v={view.skimPercent} />
      </Rows>
    </section>;
  }
  const reason = view.kind === "unconfigured"
    ? "The lending vault is not live yet."
    : view.kind === "not-read"
      ? "Your interest could not be read right now."
      : view.kind === "unlabelled-period"
        ? "Your interest is hidden because the period it covers is unknown."
        : view.kind === "skim-above-ceiling"
          ? `The vault reports a ${(view.skimBps / 100).toFixed(2)}% cut, above its ${(view.ceilBps / 100).toFixed(2)}% limit, so no figure is shown.`
          : "No interest has been paid to this balance yet.";
  return <section aria-label="Interest" className="grid gap-1">
    <h3 className="font-display text-[15px] font-bold text-ink">Your interest</h3>
    <p>{reason}</p>
  </section>;
}

/**
 * What a share is worth, and which of the vault's two numbers to say.
 *
 * While the vault holds an option position, `convertToAssets` REVERTS `PositionOpen()` and the
 * only figure the vault will give is `indicativeAssetsPerShare()`: a conservative MARK -- locked collateral
 * less the option's intrinsic value at the oracle spot, floored at zero -- that the vault never pays anyone.
 * The label below says so in those words. When no position is
 * open the same view equals the flat NAV per share, and the label drops the mark caveat.
 *
 * Null rule (api-schema.ts:535): a null figure is "unavailable" -- no vault configured, the indexer could not
 * read the view, or the deployment predates it -- and is NEVER rendered as 0, which would be an observed zero.
 * The indexer reads the figure and the flag in one call, so they describe the same block; this page reads
 * neither `convertToShares` nor `convertToAssets`, and must not (they revert while open).
 */
export type LendValueView =
  | { kind: "unconfigured" }
  | { kind: "unavailable" }
  | { kind: "no-shares" }
  | { kind: "indicative"; perShare: string; total: string | null }
  | { kind: "flat"; perShare: string; total: string | null };

/**
 * (short cards, the detail behind a "?"). Each line is checked against EarnVault at the
 * launch source: the vault rests AskWrite orders on the book and parks idle USDG in a venue
 * (EarnVault.sol header); a USDG vault cannot write a covered call, whose collateral is the stock, so the
 * premium line says "options", not "covered calls"; a venue shortfall queues a redemption instead of reverting;
 * deposits and redemptions share one first-in, first-out line while an option is open.
 */
export const LEND_RISK_TIP =
  "A loss at the lending venue falls on every depositor, in proportion. If the venue can't pay a withdrawal right away, it waits in line and is paid in order.";
/**
 * The Earn vault is lending-only at launch, so the return is the venue's
 * interest. This line used to promise option premium and a maker rebate, which the vault does not earn at launch.
 */
export const LEND_PREMIUM_LINE = "At launch the vault only lends. Its return is the lending venue's interest, after our cut.";
export const LEND_QUEUE_OPEN = "While options are open, deposits and withdrawals wait in line.";
export const LEND_QUEUE_FLAT = "Deposits go in now. Withdrawals are paid now if the venue can pay, otherwise they wait in line.";
/** The vault prices nothing while it cannot read its lending venue, so both directions queue. */
export const LEND_QUEUE_VENUE_UNREADABLE =
  "The lending venue can't be read right now, so deposits and withdrawals wait in line until it can.";
/** whether the vault can price was not read, so neither "now" nor "waits" is promised. */
export const LEND_QUEUE_PRICE_UNREAD =
  "Deposits and withdrawals go through now if the vault can price them; otherwise they wait in line.";

/**
 * The hero's queue line: options first (the contract checks them first), then the venue probe. Only an observed
 * `false` earns the flat "go in now" line; an unread probe says it may wait, as an unread position flag does.
 */
export function lendQueueState(open: boolean, venueUnreadable: boolean | null | undefined): string {
  if (open) return LEND_QUEUE_OPEN;
  if (venueUnreadable === true) return LEND_QUEUE_VENUE_UNREADABLE;
  return venueUnreadable === false ? LEND_QUEUE_FLAT : LEND_QUEUE_PRICE_UNREAD;
}

/** What a queued deposit is told it waits for: the open options, or the venue being read again. */
export function lendDepositQueuedMessage(id: bigint | number, open: boolean, venueUnreadable: boolean | null | undefined): string {
  return !open && venueUnreadable === true
    ? `Deposit queued as request #${id}. It goes in once the lending venue can be read again.`
    : `Deposit queued as request #${id}. It goes in once the open options settle.`;
}

/** What a queued card says instead of previewQueued's figure while the vault cannot read its venue. */
export const LEND_QUEUED_PREVIEW_VENUE_UNREADABLE = "No estimate while the vault can't read its lending venue.";

/**
 * The previewQueued line a queued card shows. While the venue cannot be priced, EarnVault.previewQueued
 * still quotes a figure at the last known venue value (headNow false), next to the card's "can't price"
 * reason, so no card shows it then, deposit or withdrawal. Only an observed
 * `false` shows a figure: an unread or failed venue read shows none (the failed-read rule).
 */
export function lendQueuedPreviewLine(venueUnreadable: boolean | null | undefined, previewFailed: boolean,
  line: string | null | undefined): string | null {
  if (venueUnreadable === true) return LEND_QUEUED_PREVIEW_VENUE_UNREADABLE;
  if (venueUnreadable !== false || previewFailed) return CANNOT_PREVIEW;
  return line ?? null;
}

/** The longer explanation lives in the heading's "?" tip; nothing below the figures. */
export const INDICATIVE_VALUE_LABEL =
  "An estimate: options the vault has sold are valued at today's stock price. Deposits and withdrawals wait for the exact price once they settle.";
export const FLAT_VALUE_LABEL = "The exact price deposits and withdrawals use right now.";

/**
 * `emptyVault` is the CHAIN's answer: true only when `totalSupply()` was read as 0. The hero keys on the
 * same read, so the two blocks cannot disagree about an empty vault -- one saying "no shares yet" while the other
 * prints a figure or calls the figure unreadable. An unread supply is false here: it never produces the empty state.
 */
export function lendValueView(vault: Address | null, row: EarnVault | null | undefined, emptyVault = false): LendValueView {
  if (!vault) return { kind: "unconfigured" };
  if (emptyVault) return { kind: "no-shares" };
  const perShare = row?.indicativeAssetsPerShare ?? null;
  if (perShare === null) return { kind: "unavailable" };
  // The mark is asset base units per 1e18 shares; the lending vault's asset on this page is USDG (6 dp).
  const view = {
    perShare: fmtUsdg(BigInt(perShare), 6),
    total: row?.indicativeTotalAssets == null ? null : fmtUsdg(BigInt(row.indicativeTotalAssets), 2),
  };
  // A null flag is "not read": the conservative reading is that a position MAY be open, so the mark
  // caveat stays on. Only an observed `false` earns the flat label.
  return row?.hasOpenPosition === false ? { kind: "flat", ...view } : { kind: "indicative", ...view };
}

export function LendValue({ view }: { view: LendValueView }) {
  if (view.kind === "unconfigured") return null;
  if (view.kind === "unavailable") {
    return <section aria-label="Value per share" className="grid gap-1">
      <h3 className="font-display text-[15px] font-bold text-ink">Value per share</h3>
      <p>The value per share is unavailable right now.</p>
    </section>;
  }
  if (view.kind === "no-shares") {
    return <section aria-label="Value per share" className="grid gap-1">
      <h3 className="font-display text-[15px] font-bold text-ink">Value per share</h3>
      <p>{EARN_NO_SHARES_LABEL}</p>
    </section>;
  }
  const label = view.kind === "indicative" ? INDICATIVE_VALUE_LABEL : FLAT_VALUE_LABEL;
  return <section aria-label="Value per share" className="grid gap-2">
    <h3 className="flex items-center gap-1.5 font-display text-[15px] font-bold text-ink">
      {view.kind === "indicative" ? "Estimated value" : "Value"}
      <InfoTip label="About this value" align="start" text={label} />
    </h3>
    <Rows>
      <Row k="USDG per share" v={view.perShare} />
      <Row k="Vault total" v={view.total ?? "unavailable"} />
    </Rows>
  </section>;
}

/**
 * One line per venue write-off the indexer reports for this vault (`venueWriteOffs`, newest first). The
 * amount is the event's own (VenueWrittenOff.lastKnown, USDG base units on this page), never worked out from a
 * share-price change. No row, no field (an older indexer) or [] is no notice.
 */
export type LendWriteOffLine = { at: number; amount: bigint; tx: string };

export function lendWriteOffLines(row: EarnVault | null | undefined): LendWriteOffLine[] {
  return (row?.venueWriteOffs ?? []).map((w) => ({ at: w.ts, amount: BigInt(w.amount), tx: w.tx }));
}

export const LEND_WRITE_OFF_TITLE = "Loss at a lending venue";

export function LendWriteOffs({ lines }: { lines: readonly LendWriteOffLine[] }) {
  if (lines.length === 0) return null;
  return <Notice tone="warn" className="mb-5" title={LEND_WRITE_OFF_TITLE}>
    {lines.map((line, i) => line.amount === 0n
      ? <p key={`${line.tx}-${i}`}>On <Time at={line.at} dateOnly /> the vault wrote off its balance at a lending venue that
        stopped responding. Its last known balance there was 0 USDG, so the share value did not change.</p>
      : <p key={`${line.tx}-${i}`}>On <Time at={line.at} dateOnly /> the vault wrote off {fmtUsdg(line.amount)} USDG left
        at a lending venue that stopped responding. The total value of the vault fell by that amount, and the value of each
        share fell in proportion.</p>)}
  </Notice>;
}

export function lendConfigBlockReason(mismatch: readonly string[] | null, requestFailed: boolean): string | null {
  if (requestFailed) return "Live deployment settings could not be loaded. New lending deposits are paused.";
  if (mismatch === null) return "Checking live deployment settings. New lending deposits are paused until they are available.";
  return mismatch.length > 0
    ? `App and indexer contract settings do not match. New lending deposits are paused. ${mismatch.join(" ")}`
    : null;
}

export async function submitLendDeposit(
  context: WriteContext,
  amount: bigint,
  vault: Address | null,
  mismatch: readonly string[] | null,
  requestFailed: boolean,
  dependencies: {
    approve?: typeof approveExact;
    deposit?: typeof depositToVault | typeof depositToVaultTracked;
  } = {},
) {
  const blocked = lendConfigBlockReason(mismatch, requestFailed);
  if (blocked) throw new Error(blocked);
  if (amount <= 0n) throw new Error("Enter a positive deposit.");
  if (!vault) throw new Error("The lending vault is not deployed in this build.");
  await (dependencies.approve ?? approveExact)(context, USDG, vault, amount);
  return (dependencies.deposit ?? depositToVault)(context, amount);
}

/*//////////////////////////////////////////////////////////////
        -- EARN VAULT PAGE VIEW MODELS
//////////////////////////////////////////////////////////////*/

const ZERO = "0x0000000000000000000000000000000000000000";
const usdgText = (raw: bigint, dp: number) => `${fmtUsdg(raw, dp)} USDG`;

/** True only when `totalSupply()` was READ as 0. Null (not read) is not empty: an unread supply never claims it. */
export function earnVaultEmpty(reads: EarnVaultReads | null): boolean {
  return reads?.totalSupply === 0n;
}

/**
 * Hero cells, keyed on `hasOpenPosition()`. An observed `false` earns the flat figures, labelled
 * "current"; `true` OR an unread flag gets the INDICATIVE mark, because the conservative reading of "not read" is
 * that a position may be open (same rule as {lendValueView}). The flat-path number is never shown while open.
 *
 * EMPTY VAULT FIRST. With no shares both per-share views return 0 on either path, a price nobody can
 * get, so the value cell states that the vault has no shares instead of "0.0000 USDG". The test is the supply READ,
 * not the value: a 0 with shares outstanding is a real zero (the vault holds nothing) and still renders as 0, and a
 * failed read still renders "not read". The TVL keeps its figure; the vault's total is a fact with or without shares.
 */
export function earnHeroModel(reads: EarnVaultReads | null): { open: boolean; value: LabelledValue; tvl: LabelledValue; positionAtMark: LabelledValue | null } {
  const open = reads?.hasOpenPosition !== false;
  const empty = earnVaultEmpty(reads);
  const perShare = open ? reads?.indicativeAssetsPerShare ?? null : reads?.assetsPerShare ?? null;
  const total = open ? reads?.indicativeTotalAssets ?? null : reads?.totalAssets ?? null;
  const label = open ? VAULT_INDICATIVE_LABEL : "current";
  const tone = open ? "caution" as const : "plain" as const;
  const balance = reads?.balance ?? null;
  return {
    open,
    value: empty ? { text: EARN_NO_SHARES_VALUE, label: EARN_NO_SHARES_LABEL, tone: "plain" }
      : { text: perShare === null ? null : usdgText(perShare, 4), label, tone },
    tvl: { text: total === null ? null : usdgText(total, 2), label, tone },
    // No shares exist, so no one's shares have a value to mark; the position cell keeps its share count only.
    // `perShare` is per WHOLE share, so the balance is divided by one whole share at the vault's decimals().
    positionAtMark: balance === null || empty ? null
      : { text: perShare === null || reads?.shareDecimals == null ? null
        : usdgText((balance * perShare) / 10n ** BigInt(reads.shareDecimals), 2), label: open ? "indicative" : "current", tone },
  };
}

/** Cost block inputs: skim from chain reads, protocol fees from /v2/config, route from burnBps. */
export function earnCostsModel(reads: EarnVaultReads | null, fees: ConfigResponse["fees"] | null, feeChangeDelayS: number | null, splitter: SplitterReads | null) {
  // The current mark, including a mint that blended it up. It is not a count of skims.
  const hwm = reads?.highWaterMark ?? null;
  return {
    vaultFeeLine: earnSkimLine(reads?.skimBps ?? null, reads?.skimCeilBps ?? null),
    rateBps: reads?.skimBps ?? null,
    ceilBps: reads?.skimCeilBps ?? null,
    highWaterMark: hwm === null ? null : `${usdgText(hwm, 4)} / share`,
    protocol: [
      { label: "Seller fee on premium", value: fees ? bpsPct(fees.premiumFeeBps) : null },
      { label: "Exercise fee", value: fees ? bpsPct(fees.exerciseFeeBps) : null },
      { label: "Maker rebate received", value: fees ? `${bpsPct(fees.makerRebateBps)} of the taker fee` : null },
    ],
    feeRoute: feeRouteLine(splitter?.burnBps ?? null),
    feeDelaySentence: feeChangeDelayS === null ? null : `Fee changes wait ${Math.round(feeChangeDelayS / 3600)} h after being scheduled.`,
  };
}

/** The venue line: an unset or zero adapter is the true sentence "idle USDG earns nothing". */
export function earnVenueLine(reads: EarnVaultReads | null): string | null {
  if (!reads || reads.adapter === null) return null;
  return reads.adapter.toLowerCase() === ZERO ? EARN_NO_VENUE : "Idle USDG earns the lending venue's rate.";
}

/** State-aware button copy. Unread flag: say queued, the conservative reading. */
export function earnDepositLabel(open: boolean, venueUnreadable: boolean | null = false): string {
  if (open) return "Deposit (queued — priced when flat)";
  if (venueUnreadable === true) return "Deposit (queued until the venue can be read)";
  // P3: an unread venue probe is not a promise of "instant".
  return venueUnreadable === false ? "Deposit (instant)" : "Deposit (may queue)";
}

export function earnProofRows(vault: Address | null, reads: EarnVaultReads | null, splitter: SplitterReads | null): ProofRow[] {
  const burn = splitter?.burnBps ?? null;
  const adapter = reads?.adapter ?? null;
  return [
    { label: "Vault", kind: "address", value: vault },
    { label: "Shares (ERC-20)", kind: "token", value: vault },
    { label: "Fee splitter", kind: "address", value: reads?.splitter ?? null, note: burn === null ? null : `burnBps ${burn}` },
    { label: "Venue adapter", kind: "address", value: adapter === null || adapter.toLowerCase() === ZERO ? null : adapter,
      note: adapter !== null && adapter.toLowerCase() === ZERO ? "none attached" : null },
  ];
}

/** A minute clock for "today's close" wording; started from the render time like EarliestWithdrawalLine's. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function LendVault() {
  const { address } = useAccount();
  const wallet = useWalletClient();
  const config = useConfig();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const vault = earnVaultAddress();
  const earn = useEarn(address);
  const earnRow = vault ? earn.data?.vaults?.find((row) => row.vault.toLowerCase() === vault.toLowerCase()) ?? null : null;
  // chain facts for blocks A, C and H; each field null on its own failed read.
  const reads = useEarnVaultReads(vault ?? undefined, address);
  /** The payout-timing facts, conservative where unread. An unread position flag reads as open (as the hero
   *  does); the queue depth is the indexer's; the open series' expiry is not on the wire, so the module says "when the
   *  queue reaches it" rather than guessing a time (the Earliest withdrawal line above carries the indexer's time). */
  const earnTimingInput = (now: number): EarnVaultInput => ({
    now, positionOpen: reads.data?.hasOpenPosition !== false, queueOpen: (earnRow?.queue?.depth ?? 0) > 0, openExpiry: null,
  });
  const splitterReads = useSplitterReads(reads.data?.splitter ?? null);
  const hero = earnHeroModel(reads.data ?? null);
  const costs = earnCostsModel(reads.data ?? null, config.data?.fees ?? null, config.data?.constants?.feeChangeDelay ?? null, splitterReads.data ?? null);
  const venue = earnVenueLine(reads.data ?? null);
  const mismatch = config.data ? v2ConfigWarnings(config.data) : null;
  // Provenance, and deliberately NOT part of `mismatch`. `lendConfigBlockReason` pauses deposits on
  // any non-empty mismatch array, so routing this into it would mean the override announces itself
  // by disabling the deposit it was set to enable. An override must be visible and must not block.
  const provenance = v2AddressProvenanceNotices();
  // Same channel rule: an override the registry outranked is shown, and never pauses deposits.
  const overrideConflicts = v2AddressOverrideConflictNotices();
  const configRequestFailed = config.isError || config.isRefetchError;
  const configBlockReason = lendConfigBlockReason(mismatch, configRequestFailed);
  const exitReady = Boolean(vault && address && wallet.data);
  // EarnVault.deposit has no pause of its own, so the deposit closes while the whole deployment is paused for
  // an upgrade (every market's guardian brakes on). Redeem, cancel and claim are not gated by it.
  const markets = useMarkets();
  const lendDeposit = depositDoor(Boolean(exitReady && !configBlockReason), markets.isError ? null : markets.data);
  const depositReady = lendDeposit.open;
  const [depositAmount, setDepositAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const now = useMinuteClock();
  const queueCards = lendQueueCards(vault, earn.data, now);
  // payments the vault HELD for this wallet (read on chain: the indexer does not list served requests).
  const heldRead = useHeldPayments(vault, address);
  const held = heldPaymentsView(heldRead.data, address);
  // Shares are typed in whole shares at the vault's own decimals(); unread decimals means no redeem.
  // redeem takes the shares from the wallet, so more than it holds reverts; the cap reads the same decimals.
  const shareDecimals = reads.data?.shareDecimals ?? null;
  const { shares: redeemShares, over: redeemOver } = lendRedeemInput(redeemAmount, shareDecimals, address ? reads.data?.balance : null);
  // The figure before the button is EarnVault.previewDeposit / previewRedeem, not a local price.
  const depositAssets = parsePositive(depositAmount, USDG_DECIMALS);
  const depositPreview = useQuery({
    queryKey: ["v2", "earn-deposit-preview", vault, depositAssets?.toString() ?? null],
    queryFn: () => readEarnDepositPreview(publicClient, vault!, depositAssets!),
    enabled: Boolean(vault && depositAssets !== null),
    retry: false,
  });
  const redeemContractPreview = useQuery({
    queryKey: ["v2", "earn-redeem-preview", vault, redeemShares?.toString() ?? null],
    queryFn: () => readEarnRedeemPreview(publicClient, vault!, redeemShares!),
    enabled: Boolean(vault && redeemShares !== null),
    retry: false,
  });
  // The indexer's paid-now line stands only when previewRedeem answered for THIS amount and pays it now. Pending, a
  // revert, a queue or needsVenue hide the cash amount (fail closed). Nothing typed: nothing to ask, the line stands.
  const redeemContract = redeemShares === null ? undefined
    : redeemContractPreview.data?.ok !== true ? "unread"
    : redeemContractPreview.data.queued ? "queues"
    : redeemContractPreview.data.needsVenue ? "needs-venue"
    : "pays";
  const queueIds = queueCards.flatMap((card) => card.cancelId === null ? [] : [card.cancelId.toString()]);
  const queuedContractPreviews = useQuery({
    queryKey: ["v2", "earn-queued-preview", vault, queueIds.join(","), shareDecimals],
    queryFn: async () => {
      const lines: Record<string, string> = {};
      for (const card of queueCards) {
        if (card.cancelId === null || !vault) continue;
        lines[card.cancelId.toString()] = formatEarnQueuedPreview(
          await readEarnQueuedPreview(publicClient, vault, card.cancelId), shareDecimals);
      }
      return lines;
    },
    enabled: Boolean(vault && queueIds.length > 0),
    retry: false,
  });
  const shownQueue = queueCards.map((card) => ({
    ...card,
    contractPreview: card.cancelId === null ? null
      // A failed refetch keeps the last answer in `data`: the venue flag is then unknown, not the old `false`.
      : lendQueuedPreviewLine(reads.isError ? null : reads.data?.venueUnreadable, queuedContractPreviews.isError,
        queuedContractPreviews.data?.[card.cancelId.toString()]),
  }));
  // The flat share price only: `convertToAssets` reverts while a position is open, and the preview then queues anyway.
  const flatAssetsPerShare = reads.data?.hasOpenPosition === false ? reads.data.assetsPerShare : null;

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return { account: address, wallet: wallet.data };
  }

  async function act(label: string, task: () => Promise<string>, explain?: (error: unknown) => string) {
    setBusy(label);
    try {
      notice("pending", label, "Review each requested transaction in your wallet.");
      notice("success", label, await task());
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${label} stopped`, explain ? explain(error)
          : error instanceof Error ? error.message : "Try again after refreshing.");
    } finally { setBusy(null); }
  }

  const apyView = lendApyView({ vault, row: earnRow, skimBps: reads.data?.skimBps ?? null, ceilBps: reads.data?.skimCeilBps ?? null });
  const rate = lendRateStat(apyView);
  const shareValue = labelledParts(hero.value);
  const tvlValue = labelledParts(hero.tvl);
  const walletShares = address && reads.data?.balance != null && shareDecimals !== null ? reads.data.balance : null;
  const positionShares = reads.data?.balance == null || shareDecimals === null ? null
    : displayQuantity(reads.data.balance, shareDecimals, { maxDecimals: 4 });
  const positionQueued = queueCards.length ? `${queueCards.length} request${queueCards.length === 1 ? "" : "s"} waiting in the queue, below.` : null;
  const queueState = lendQueueState(hero.open, reads.data?.venueUnreadable);
  const queueTone = hero.open || reads.data?.venueUnreadable === true ? "bg-warn" : reads.data?.venueUnreadable === false ? "bg-accent" : "bg-ink-3";
  const withdrawal = earliestWithdrawalCopy(earnRow?.earliestWithdrawal, "earn", now);
  const redeemLine = redeemPreview({ ew: earnRow?.earliestWithdrawal, shares: redeemShares, assetsPerShare: flatAssetsPerShare,
    shareDecimals, queueDepth: earnRow?.queue?.depth ?? null, now, contract: redeemContract });
  const feeAboveLimit = rateExceedsCeiling(costs.rateBps, costs.ceilBps);
  const exit = earnExitSteps();
  const writeOffLines = lendWriteOffLines(earnRow);
  const hasNews = shownQueue.length > 0 || held.cards.length > 0;

  const depositPanel = <div className="grid gap-4">
    <Field id="lend-deposit" label="Amount" inputMode="decimal" suffix="USDG" placeholder="100" autoComplete="off"
      tip="The USDG to lend. The vault gives you shares for it; what a share is worth moves with the vault."
      value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} />
    {depositAssets !== null ? <p data-slot="earn-deposit-preview" className={PREVIEW_LINE}>
      {depositPreview.isPending ? "Checking what this deposit would do…"
        : formatEarnDepositPreview(depositPreview.data ?? { ok: false }, shareDecimals)}
    </p> : null}
    <WithdrawalTerms surface="lending" />
    <PayoutTiming of={(t) => vault ? earnVaultDepositTiming(earnTimingInput(t)) : null} />
    {lendDeposit.note ? <p data-slot="upgrade-paused" role="status" className="text-[13px] font-medium text-warn">{lendDeposit.note}</p> : null}
    {!address ? <ConnectButton block /> : <Button className="w-full" disabled={!depositReady || !!busy || !parsePositive(depositAmount, USDG_DECIMALS)}
      onClick={() => void act("Deposit into the lending vault", async () => {
        const amount = parsePositive(depositAmount, USDG_DECIMALS);
        if (!amount) throw new Error("Enter a positive deposit.");
        const result = await submitLendDeposit(context(), amount, vault, mismatch, configRequestFailed, { deposit: depositToVaultTracked });
        setDepositAmount("");
        return typeof result === "object" && result.queuedId !== null
          ? lendDepositQueuedMessage(result.queuedId, hero.open, reads.data?.venueUnreadable)
          : "Deposit submitted.";
      })}>{earnDepositLabel(hero.open, reads.data?.venueUnreadable ?? null)}</Button>}
  </div>;

  const redeemPanel = <div className="grid gap-4">
    <Field id="lend-redeem" label="Shares" inputMode="decimal" suffix="shares" placeholder="1" autoComplete="off"
      tip="Vault shares to turn back into USDG."
      aside={walletShares !== null && shareDecimals !== null ? <span className="inline-flex items-center gap-2">
        <span>You hold <span className="num text-ink-2">{displayQuantity(walletShares, shareDecimals, { maxDecimals: 4 })}</span></span>
        <Button size="xs" variant="ghost" onClick={() => setRedeemAmount(formatUnits(walletShares, shareDecimals))}>Max</Button>
      </span> : null}
      value={redeemAmount} onChange={(event) => setRedeemAmount(event.target.value)} />
    {redeemOver ? <p className="-mt-2 text-[13px] font-medium text-danger-text" data-slot="redeem-over-balance">{redeemOver}</p> : null}
    {redeemShares !== null ? <p data-slot="earn-redeem-preview" className={PREVIEW_LINE}>
      {redeemContractPreview.isPending ? "Checking what this withdrawal would pay…"
        : formatEarnRedeemPreview(redeemContractPreview.data ?? { ok: false })}
    </p> : null}
    {vault ? <FactBox facts={[
      { key: "earliest", label: "Earliest withdrawal", tip: withdrawal.tooltip,
        value: <span data-earliest-withdrawal={earnRow?.earliestWithdrawal?.reason ?? "not-sent"}>{withdrawal.line}</span> },
      { key: "if-now", label: "If you redeem now", tip: redeemLine.tooltip,
        value: <span data-redeem-preview={redeemLine.outcome}>{redeemLine.line}</span> },
    ]} /> : null}
    <PayoutTiming of={(t) => vault ? earnVaultRedeemTiming(earnTimingInput(t)) : null} />
    {!address ? <ConnectButton block /> : <Button className="w-full" disabled={!exitReady || !!busy || !redeemShares || redeemOver !== null}
      onClick={() => void act("Redeem lending-vault shares", async () => {
        if (shareDecimals === null) throw new Error("The vault's share decimals could not be read. Refresh and try again.");
        const amount = lendRedeemInput(redeemAmount, shareDecimals, null).shares;
        if (!amount) throw new Error("Enter a positive share amount.");
        const result = await redeemFromVaultTracked(context(), amount);
        setRedeemAmount("");
        return result.queuedId !== null
          ? `Queued as request #${result.queuedId}. It's paid automatically when it clears; you can cancel until then. If it can't be delivered, it's held for you under "${HELD_SECTION_TITLE}".`
          : "Redeem confirmed. If it was queued, it shows under your queued requests shortly.";
      }, explainEarnRedeemError)}>Redeem</Button>}
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <span className="inline-flex items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={!exitReady || !!busy}
          onClick={() => void act("Process withdrawal queue", async () => {
            await processVaultQueue(context(), 8n);
            return "Queue processing submitted.";
          })}>Process queue</Button>
        <InfoTip label="About processing the queue" align="start"
          text="Pays waiting deposits and withdrawals in order, up to 8 per press, when the vault can. Anyone can press it." />
      </span>
      <ExternalLink href={withdrawal.faqHref} className="text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink">How withdrawals work</ExternalLink>
    </div>
  </div>;

  return <>
    {/* This page is Earn, at /earn. It lends USDG for interest and, at launch, only lends. */}
    <PageHead eyebrow="Earn" title="Earn interest on USDG."
      lede={<>
        <p>Deposit USDG. The vault lends it out and you earn the interest.</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-pill bg-warn-soft py-1.5 pl-3 pr-2 text-[13px] font-semibold text-ink">
          <WarnIcon className="shrink-0 text-warn" />You can lose money.
          <InfoTip label="About the risk" align="start" text={LEND_RISK_TIP} />
        </p>
      </>} />

    <div className="grid gap-3 empty:hidden [&:not(:empty)]:mb-5">
      {configBlockReason ? <Notice tone="warn">{configBlockReason}</Notice> : null}
      {!vault ? <Notice tone="info">The Earn vault opens when it is deployed.</Notice> : null}
      {provenance.length ? <Notice tone="info">{provenance.join(" ")}</Notice> : null}
      {overrideConflicts.length ? <Notice tone="warn">{overrideConflicts.join(" ")}</Notice> : null}
      {feeAboveLimit ? <Notice tone="danger" role="alert">
        The vault reports a fee above its own limit. Don&apos;t rely on either number until that is fixed.
      </Notice> : null}
    </div>

    <section aria-label="USDG lending vault summary" className="mb-6">
      <h2 className="sr-only">USDG lending vault summary</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EarnStat id="net-apy" label="Net APY" text={rate.value ?? "—"} tone={rate.value ? "accent" : "ink"}
          sub="Estimate" tip={rate.tip} />
        <EarnStat id="vault-total" label="Vault total" align="end" text={hero.tvl.text ?? NOT_READ} sub={tvlValue.sub}
          tip={tvlValue.tip ? `The vault's total value in USDG. ${tvlValue.tip}` : "The vault's total value in USDG."} />
        <EarnStat id="share-price" label="Share price" text={hero.value.text ?? NOT_READ} sub={shareValue.sub}
          tip={shareValue.tip ? `What one vault share is worth in USDG. ${shareValue.tip}` : "What one vault share is worth in USDG."} />
        <EarnStat id="your-position" label="Your position" align="end"
          text={!address ? "—" : positionShares === null ? NOT_READ : `${positionShares} shares`}
          sub={!address ? "Connect a wallet" : <>
            {hero.positionAtMark ? <span className="block">≈ {hero.positionAtMark.text ?? NOT_READ}{" "}
              <span className={hero.positionAtMark.tone === "caution" ? "text-warn" : ""}>{hero.positionAtMark.label}</span></span> : null}
            {positionQueued ? <span className="block">{positionQueued}</span> : null}
          </>} />
      </div>
    </section>

    {/* A venue write-off lowered the share value; say so beside the value it lowered. */}
    {writeOffLines.length ? <div className="mb-6"><LendWriteOffs lines={writeOffLines} /></div> : null}

    <div className={`grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] xl:gap-8 ${hasNews ? "lg:grid-rows-[auto_1fr]" : ""}`}>
      <Panel as="section" aria-label="Deposit or redeem" pad="sm"
        className={`grid gap-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1 lg:self-start ${hasNews ? "lg:row-span-2" : ""}`}>
        <h2 className="sr-only">Deposit or redeem</h2>
        <Tabs label="Earn vault action" items={[
          { value: "deposit", label: "Deposit", panel: depositPanel },
          { value: "redeem", label: "Redeem", panel: redeemPanel },
        ]} />
        {!held.cards.length && held.status ? <p role="status" className="text-[13px] text-ink-3">{held.status}</p> : null}
        <p className="flex items-start gap-2.5 border-t border-line pt-4 text-[13px] leading-snug text-ink-2">
          <span aria-hidden="true" className={`mt-[5px] size-2 shrink-0 rounded-pill ${queueTone}`} />{queueState}
        </p>
      </Panel>

      {hasNews ? <div className="grid min-w-0 gap-6 lg:col-start-1 lg:row-start-1">
        {/* Every open request of this wallet in this vault -- place in line, what is held, why, when -- and Cancel. */}
        <EarnRequests cards={shownQueue} canAct={exitReady} busy={!!busy}
          onCancel={(card) => void act(card.kind === "deposit" ? "Cancel queued deposit" : "Cancel queued withdrawal", async () => {
            if (card.cancelId === null) throw new Error("This request has no queue id to cancel.");
            await cancelQueuedRequest(context(), card.cancelId);
            return card.kind === "deposit" ? "Cancelled. The USDG it held is back in your wallet."
              : "Cancelled. The shares it held are back in your wallet.";
          })} />
        {/* A payment the vault could not deliver, held for this wallet, with a Claim to a receiver it may change. */}
        <EarnHeldPayments view={held} canAct={exitReady} busy={!!busy}
          onClaim={(card, to) => void act(`Claim held payment #${card.held.id}`, async () => {
            await claimDeferredPayment(context(), card.held.id, to);
            void heldRead.refetch();
            return `Claimed. ${card.amount} was sent to ${to}.`;
          })} />
      </div> : null}

      <section aria-label="About this vault" className={`grid min-w-0 content-start gap-3 lg:col-start-1 ${hasNews ? "lg:row-start-2" : "lg:row-start-1"}`}>
        <h2 className="font-display text-lg font-bold text-ink">About this vault</h2>
        <Disclosure title="Rate details" summary="Measured rates, your interest, share value">
          {/* The public rate -- realised (net of the cut), the venue's own, and the net estimate from skimBps read on chain. */}
          <LendApy view={apyView} />
          {/* The accrual read is not wired (realised needs indexer), so the interest figure still says "not read";
              the skim and its ceiling ARE read now (they were hard-coded nulls here). */}
          <LendInterest view={lendInterestView({ vault, realisedUsdg: null, balanceUsdg: null, periodLabel: "last 7 days",
            skimBps: reads.data?.skimBps ?? null, ceilBps: reads.data?.skimCeilBps ?? null })} />
          <LendValue view={lendValueView(vault, earnRow, earnVaultEmpty(reads.data ?? null))} />
          {/* G. History: no Earn share-price series exists on the wire yet (indexer). */}
          <EarnHistoryBlock text={NO_CHART_YET} />
        </Disclosure>
        <Disclosure title="Where the return comes from" summary="Lending interest, after our cut">
          <EarnReturnBlock premiumLine={LEND_PREMIUM_LINE} venueLine={venue} noRateYet={NO_RATE_YET} />
        </Disclosure>
        <Disclosure title="What it costs" summary="No deposit, withdrawal or management fee">
          <EarnCostsBlock {...costs} />
        </Disclosure>
        <Disclosure title="How to exit" summary="Paid right away when the vault can; otherwise in line, in order">
          <EarnExitBlock {...exit} />
        </Disclosure>
        <Disclosure title="What can go wrong" summary={`${EARN_RISKS.length} risks, each with its limit`}>
          <EarnRisksBlock risks={EARN_RISKS} />
        </Disclosure>
        <Disclosure title="On chain" summary="The vault, its share token, fee splitter and venue">
          <EarnProofBlock rows={earnProofRows(vault, reads.data ?? null, splitterReads.data ?? null)} />
        </Disclosure>
      </section>
    </div>
  </>;
}

const PREVIEW_LINE = "rounded-md border border-line bg-field px-3.5 py-2.5 text-[14px] font-semibold text-ink";
