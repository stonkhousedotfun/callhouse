"use client";

import { useState } from "react";
import { parseUnits, type Address } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { fmtUsdg } from "@/lib/format";
import type { EarnVault } from "@/lib/v2/api-types";
import { v2AddressProvenanceNotices, v2ConfigWarnings } from "@/lib/v2/config";
import { useConfig, useEarn } from "@/lib/v2/hooks";
import { approveExact, type WriteContext } from "@/lib/v2/tx";
import { depositToVault, earnVaultAddress, processVaultQueue, redeemFromVault } from "@/lib/v2/lendTx";

function parsePositive(raw: string, decimals: number) {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
}

/**
 * The interest figure /lend shows, and the three ways it refuses to show one (W5, plan section 5.4 item 2-3).
 *
 * THE OWNER ASKED FOR AN INTEREST PERCENTAGE. The plan is equally explicit about what it must carry:
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
 * THE SKIM IS READ FROM THE CHAIN, NEVER FROM THE DESIGN DOC. `v8-plan/V8-DESIGN.md` says "~10%";
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
 * The interest panel on /lend. Each branch states its own reason, because the reasons are not
 * interchangeable: an undeployed vault, an unread figure and a vault that has genuinely paid
 * nothing look identical to a depositor unless the page says which one it is.
 */
export function LendInterest({ view }: { view: LendInterestView }) {
  if (view.kind === "figure") {
    return <Panel as="section" aria-label="Interest" className="mb-5">
      <h2 className="font-display text-xl font-bold">Interest</h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-ink-3 text-sm">Realised · {view.periodLabel}</dt>
          <dd className="num mt-1 text-2xl font-semibold">{view.percent}</dd>
        </div>
        <div>
          <dt className="text-ink-3 text-sm">Protocol skim, taken from that</dt>
          <dd className="num mt-1 text-2xl font-semibold">{view.skimPercent}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-ink-2">
        Realised over {view.periodLabel}, from interest actually credited against your deposited balance.
        It is not a rate and says nothing about any other period. The skim is read from the vault, not from a document.
      </p>
    </Panel>;
  }
  const reason = view.kind === "unconfigured"
    ? "The lending vault is not deployed, so there is no interest to report yet. That is not the same as zero."
    : view.kind === "not-read"
      ? "The interest figure could not be read from the vault, so it is not shown. That is not the same as zero."
      : view.kind === "unlabelled-period"
        ? "The interest figure is not shown because the period it covers is unknown, and a percentage without its period cannot be read."
        : view.kind === "skim-above-ceiling"
          ? `The vault reports a protocol skim of ${(view.skimBps / 100).toFixed(2)}%, above its own ceiling of ${(view.ceilBps / 100).toFixed(2)}%. No net figure is shown while those two disagree.`
          : "No interest has been credited to this balance yet.";
  return <Notice tone="info" className="mb-5" title="Interest">{reason}</Notice>;
}

/**
 * T-OP-086 (SEC-19, T-OP-065). What a share is worth, and which of the vault's two numbers to say.
 *
 * While the vault holds an option position, `convertToAssets` REVERTS `PositionOpen()` (T-OP-065) and the
 * only figure the vault will give is `indicativeAssetsPerShare()`: a conservative MARK -- locked collateral
 * less the option's intrinsic value at the oracle spot, floored at zero -- that the vault never pays anyone.
 * The label below says so in those words (ops/audit/V8-EARNVAULT-VIEW-READERS.md §3). When no position is
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
  | { kind: "indicative"; perShare: string; total: string | null }
  | { kind: "flat"; perShare: string; total: string | null };

export const INDICATIVE_VALUE_LABEL =
  "Indicative value per share — marks written options at the oracle spot; the vault prices deposits and redemptions only at the flat boundary.";
export const FLAT_VALUE_LABEL = "Value per share at the flat boundary, the price deposits and redemptions are settled at.";

export function lendValueView(vault: Address | null, row: EarnVault | null | undefined): LendValueView {
  if (!vault) return { kind: "unconfigured" };
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
    return <Notice tone="info" className="mb-5" title="Value per share">
      The value per share is unavailable: the vault&apos;s indicative view could not be read. That is not the same as zero.
    </Notice>;
  }
  const label = view.kind === "indicative" ? INDICATIVE_VALUE_LABEL : FLAT_VALUE_LABEL;
  return <Panel as="section" aria-label="Value per share" className="mb-5">
    <h2 className="font-display text-xl font-bold">{view.kind === "indicative" ? "Indicative value" : "Value"}</h2>
    <dl className="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <dt className="text-ink-3 text-sm">USDG per share</dt>
        <dd className="num mt-1 text-2xl font-semibold">{view.perShare}</dd>
      </div>
      <div>
        <dt className="text-ink-3 text-sm">Vault total{view.kind === "indicative" ? " (indicative)" : ""}</dt>
        <dd className="num mt-1 text-2xl font-semibold">{view.total ?? "unavailable"}</dd>
      </div>
    </dl>
    <p className="mt-3 text-sm text-ink-2">{label}</p>
  </Panel>;
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
    deposit?: typeof depositToVault;
  } = {},
) {
  const blocked = lendConfigBlockReason(mismatch, requestFailed);
  if (blocked) throw new Error(blocked);
  if (amount <= 0n) throw new Error("Enter a positive deposit.");
  if (!vault) throw new Error("The lending vault is not deployed in this build.");
  await (dependencies.approve ?? approveExact)(context, USDG, vault, amount);
  return (dependencies.deposit ?? depositToVault)(context, amount);
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
  const mismatch = config.data ? v2ConfigWarnings(config.data) : null;
  // Provenance, and deliberately NOT part of `mismatch`. `lendConfigBlockReason` pauses deposits on
  // any non-empty mismatch array, so routing this into it would mean the override announces itself
  // by disabling the deposit it was set to enable. An override must be visible and must not block.
  const provenance = v2AddressProvenanceNotices();
  const configRequestFailed = config.isError || config.isRefetchError;
  const configBlockReason = lendConfigBlockReason(mismatch, configRequestFailed);
  const exitReady = Boolean(vault && address && wallet.data);
  const depositReady = Boolean(exitReady && !configBlockReason);
  const [depositAmount, setDepositAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return { account: address, wallet: wallet.data };
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

  return <>
    <PageHead eyebrow="Lending vault" title="Deposit into the lending vault."
      lede="This is the lending vault, not covered-call writing. Writing still lives at /earn." />
    <Notice tone="warn" className="mb-5">
      A venue loss falls on depositors pro rata and nowhere else. A withdrawal can queue when the venue is illiquid,
      and is then paid in order rather than reverting. Supplied stock earns nothing until borrowers exist.
      Observed yield is unavailable on this page until the vault is deployed — that is not the same as zero.
    </Notice>
    {configBlockReason ? <Notice tone="warn" className="mb-5">{configBlockReason}</Notice> : null}
    {!vault ? <Notice tone="info" className="mb-5">The lending vault opens when the vault is deployed.</Notice> : null}
    {provenance.length ? <Notice tone="info" className="mb-5">{provenance.join(" ")}</Notice> : null}
    {/* The accrual and skim reads are NOT wired yet, so every input below the vault address is null
        and this renders "could not be read" rather than a figure. That is deliberate and is the
        honest state: see the T-407 evidence for what remains. */}
    <LendInterest view={lendInterestView({ vault, realisedUsdg: null, balanceUsdg: null, periodLabel: "last 7 days", skimBps: null, ceilBps: null })} />
    <LendValue view={lendValueView(vault, earnRow)} />
    {!address ? <Panel className="mb-5"><p className="mb-4 text-ink-2">Connect a wallet to deposit or redeem.</p><ConnectButton /></Panel> : null}
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel as="section" aria-label="Deposit">
        <h2 className="font-display text-xl font-bold">Deposit USDG</h2>
        <label htmlFor="lend-deposit" className="mt-4 block text-sm font-semibold">Amount</label>
        <input id="lend-deposit" inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)}
          placeholder="100" className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        <WithdrawalTerms className="mt-3" surface="lending" />
        <Button size="sm" className="mt-3 w-full" disabled={!depositReady || !!busy || !parsePositive(depositAmount, USDG_DECIMALS)}
          onClick={() => void act("Deposit into the lending vault", async () => {
            const amount = parsePositive(depositAmount, USDG_DECIMALS);
            if (!amount) throw new Error("Enter a positive deposit.");
            await submitLendDeposit(context(), amount, vault, mismatch, configRequestFailed);
            setDepositAmount("");
            return "Deposit submitted.";
          })}>Deposit</Button>
      </Panel>
      <Panel as="section" aria-label="Redeem">
        <h2 className="font-display text-xl font-bold">Redeem shares</h2>
        <label htmlFor="lend-redeem" className="mt-4 block text-sm font-semibold">Shares</label>
        <input id="lend-redeem" inputMode="decimal" value={redeemAmount} onChange={(event) => setRedeemAmount(event.target.value)}
          placeholder="1" className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        {/* The queue caveat belongs where the request is MADE, not only where the deposit is: this is the
            button a depositor presses expecting an instant withdrawal (plan 2026-09-20 section 5.5). */}
        <WithdrawalTerms className="mt-3" surface="lending" />
        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!exitReady || !!busy || !parsePositive(redeemAmount, 18)}
          onClick={() => void act("Redeem lending-vault shares", async () => {
            const amount = parsePositive(redeemAmount, 18);
            if (!amount) throw new Error("Enter a positive share amount.");
            await redeemFromVault(context(), amount);
            setRedeemAmount("");
            return "Redeem submitted. If the venue cannot pay now, the exit is queued.";
          })}>Redeem</Button>
        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!exitReady || !!busy}
          onClick={() => void act("Process withdrawal queue", async () => {
            await processVaultQueue(context(), 8n);
            return "Queue processing submitted.";
          })}>Process queue</Button>
      </Panel>
    </div>
  </>;
}
