"use client";

import { useMemo, useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ASSET, ASSET_DECIMALS, MARKET, SHARE_TICKER, VAULT, stockTokenAbi, vaultAbi } from "@/lib/contracts";
import {
  depositState,
  fmtAsset,
  fmtEastern,
  fmtShares,
  fmtUsdg,
  fmtUtc,
  listedDepositRisk,
  multiplierIsActive,
  parseAmount,
  toStockEq,
  type DepositsClosedReason,
} from "@/lib/format";
import { useNow, type AccountPosition, type VaultSnapshot } from "@/lib/hooks";
import { Button, Card, CardHead, CardMeta, CardTitle, Field, Notice, Row, Rows, Unit } from "@/components/ui";
import { ConnectButton } from "./ConnectButton";
import { useTxRunner } from "./TxToast";

/**
 * Approve, then deposit.
 *
 * Two things this form refuses to do:
 *  - quote a return of any kind. It shows how many shares the amount buys at the current raw
 *    share price and stops there.
 *  - hide the cap. maxDeposit() is the vault's own headroom and a deposit past it reverts with
 *    DepositCapExceeded, so the number is on screen before the button is pressed.
 *
 * ONE GATE, AND A CAP THAT IS NOT A GATE. The vault has a single `DepositsClosed` error
 * (Vault._depositRefused): not Idle or Listed; Listed and past this week's exercise time, whether
 * or not anyone called lockBook (W-2); a contract assigned and its claim not yet redeemed; a
 * stranded claim; the reserve unbacked after an issuer burn; a dead book. `maxDeposit()` returns 0
 * on every one of those AND when `totalAssets() >= depositCap`, which is a full cap, not a closure
 * (a deposit then reverts `DepositCapExceeded`). With the cap deliberately small at launch a full
 * cap is the likely state of a healthy vault, so a zero is not read as "closed" on its own:
 * `depositState` (lib/format.ts) names the refusal when there is one, says "cap full" when the cap
 * is what has no room, and falls back to the chain's zero (for the connected account, or for
 * anyone through the snapshot's zero-address read) only when neither explains it.
 *
 * Deposits are allowed in Idle and Listed (decision D8). A deposit in Listed buys into the open
 * short: shares are priced on totalAssets(), which values the short call at zero, so if the week
 * ends assigned the loss reaches every share through the share price, a late one included, and
 * every later fill this week is sized against a balance that includes the new deposit. What a
 * late depositor does not get is premium indexed before their shares existed. The form says so on
 * screen whenever the vault is Listed (listedDepositRisk).
 *
 * The cap is measured on totalAssets() — idle plus collateral already locked in Valorem, minus
 * what settled redeemers are owed — not on the raw token balance. A balance-based cap would
 * quietly re-open the moment a fill wrote a call.
 */
export function DepositForm({
  snapshot,
  position,
  onDone,
}: {
  snapshot: VaultSnapshot;
  position: AccountPosition;
  onDone: () => void;
}) {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const nowSeconds = useNow();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);

  const amount = useMemo(() => parseAmount(raw, ASSET_DECIMALS), [raw]);
  const balance = position.assetBalance;
  const allowance = position.assetAllowance ?? 0n;
  const headroom = position.maxDeposit;

  const needsApproval = amount !== null && amount > 0n && allowance < amount;
  const overBalance = amount !== null && balance !== undefined && amount > balance;
  const overCap = amount !== null && headroom !== undefined && amount > headroom;

  const preview = useReadContract({
    address: VAULT,
    abi: vaultAbi as unknown as Abi,
    functionName: "previewDeposit",
    args: amount !== null && amount > 0n ? [amount] : undefined,
    query: { enabled: VAULT !== undefined && amount !== null && amount > 0n },
  });
  const previewShares = typeof preview.data === "bigint" ? preview.data : undefined;

  // A refusal the snapshot can name, a full cap, or the chain's own zero (for the account, or for
  // anyone) with neither to explain it. An unknown phase (no vault configured, or the read has not
  // landed) is neither open nor closed: the button is disabled by other means, and a false "we
  // are settling" notice would be a lie.
  const gate = depositState(snapshot, nowSeconds, position.ready ? headroom : undefined);
  const closed = gate.kind === "closed";
  const capFull = gate.kind === "capFull";

  const risk = closed || capFull
    ? "none"
    : listedDepositRisk({
        phase: snapshot.phase,
        cycleStrikeUsdg: snapshot.cycleStrikeUsdg,
        spotUsdg: snapshot.spotUsdg,
        minOtmBps: snapshot.policy?.minOtmBps,
      });

  const disabled =
    busy || !isConnected || !VAULT || amount === null || amount === 0n || overBalance || overCap || closed || capFull;

  async function submit() {
    if (!VAULT || !address || amount === null || amount === 0n) return;
    // `VAULT` is a module const typed `Address | undefined`; the guard above does not narrow it
    // inside the callbacks passed to run(). Bind it once.
    const vault = VAULT;
    setBusy(true);
    try {
      if (allowance < amount) {
        // Exact-amount approval, not unlimited: the vault is unaudited at launch and an
        // unlimited allowance on an unaudited contract is a gift to a future bug.
        const approved = await run(
          () =>
            writeContractAsync({
              address: ASSET,
              abi: stockTokenAbi as unknown as Abi,
              functionName: "approve",
              args: [vault, amount],
            }),
          { pending: `Approving ${MARKET}`, success: `${MARKET} approved` },
        );
        if (!approved) return;
      }
      const deposited = await run(
        () =>
          writeContractAsync({
            address: vault,
            abi: vaultAbi as unknown as Abi,
            functionName: "deposit",
            args: [amount, address],
          }),
        { pending: `Depositing ${MARKET}`, success: `Deposited — ${SHARE_TICKER} minted` },
      );
      if (deposited) {
        setRaw("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead>
        <CardTitle>Deposit</CardTitle>
        <CardMeta>
          {closed
            ? "closed"
            : capFull
              ? "cap full"
              : `cap headroom ${headroom === undefined ? "—" : `${fmtAsset(headroom)} ${MARKET}`}`}
        </CardMeta>
      </CardHead>

      <Field
        id="deposit-amount"
        label="Amount"
        suffix={MARKET}
        inputMode="decimal"
        placeholder="0.0"
        value={raw}
        autoComplete="off"
        onChange={(e) => setRaw(e.target.value)}
      />

      <Rows className="mt-3">
        <Row
          k="Wallet balance"
          v={
            <>
              {fmtAsset(balance)} <Unit>{MARKET}</Unit>
              {balance !== undefined ? (
                <>
                  {" "}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="align-baseline"
                    onClick={() => {
                      const cap = headroom !== undefined && headroom < balance ? headroom : balance;
                      setRaw(fmtAssetExact(cap));
                    }}
                  >
                    max
                  </Button>
                </>
              ) : null}
            </>
          }
        />
        <Row
          k="You receive"
          v={
            <>
              {previewShares === undefined ? "—" : fmtShares(previewShares)} <Unit>{SHARE_TICKER}</Unit>
            </>
          }
        />
        {multiplierIsActive(snapshot.uiMultiplier) && amount !== null ? (
          <Row
            k={
              <>
                {MARKET}-eq <span className="text-ink-3">(display only)</span>
              </>
            }
            v={fmtAsset(toStockEq(amount, snapshot.uiMultiplier))}
          />
        ) : null}
        <Row k="Allowance" v={fmtAsset(allowance)} />
      </Rows>

      <div className="mt-4 grid gap-3 empty:hidden">
        {gate.kind === "closed" ? (
          <Notice tone="warn" title="Deposits are closed right now.">
            {" "}
            {closedCopy(gate.reason, snapshot)}
          </Notice>
        ) : gate.kind === "capFull" ? (
          <Notice tone="info" title="The deposit cap is full.">
            {" "}
            {capFullCopy(gate.cap, gate.held)}
          </Notice>
        ) : null}
        {risk !== "none" ? (
          <Notice tone={risk === "near" ? "danger" : "warn"}>
            {risk === "near" ? (
              <>
                <strong className="block font-semibold text-ink">{MARKET} is at or near this week&apos;s strike.</strong> Spot is {fmtUsdg(snapshot.spotUsdg)} USDG
                against a strike of {fmtUsdg(snapshot.cycleStrikeUsdg)} USDG. If it finishes above the strike, the calls
                sold are exercised and part of the vault&apos;s {MARKET} is swapped for USDG at the strike. A deposit made
                now shares that outcome in full.{" "}
              </>
            ) : (
              <>
                A call is armed this week
                {snapshot.cycleStrikeUsdg ? <> at a strike of {fmtUsdg(snapshot.cycleStrikeUsdg)} USDG</> : null}
                {(snapshot.contractsWritten ?? 0n) > 0n ? <>, and {snapshot.contractsWritten!.toString()} contracts have been sold</> : null}. If{" "}
                {MARKET} finishes above the strike, part of the vault&apos;s {MARKET} is sold at the strike, and a deposit
                made now shares that outcome.{" "}
              </>
            )}
            Shares are priced as if the open call were worth nothing, so the loss is spread over every share, including
            new ones, and every later fill this week is sized against a balance that includes your deposit. Premium
            already paid into the vault before your deposit is not shared with you. A deposit made while the vault is
            Idle enters before the week&apos;s call is armed.
          </Notice>
        ) : null}
        {overBalance ? (
          <Notice tone="danger" role="status">
            That is more than the wallet holds.
          </Notice>
        ) : null}
        {overCap && !overBalance && gate.kind === "open" ? (
          <Notice tone="danger" role="status">
            That is past the vault&apos;s deposit cap. The cap is deliberately small at launch.
          </Notice>
        ) : null}
      </div>

      <div className="mt-5">
        {!isConnected ? (
          <ConnectButton block />
        ) : (
          <Button variant="primary" className="w-full" disabled={disabled} onClick={submit}>
            {busy
              ? "Working…"
              : closed
                ? "Deposits closed"
                : capFull
                  ? "Deposit cap reached"
                  : needsApproval
                    ? `Approve and deposit`
                    : "Deposit"}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** The reason deposits are shut, in the vault's own terms (Vault._depositRefused). */
function closedCopy(reason: DepositsClosedReason | undefined, snapshot: VaultSnapshot): string {
  switch (reason) {
    case "phase":
      return "The vault is settling the week (past its sale window). Deposits reopen when it returns to Idle.";
    case "window":
      return `This week's sale window closed at ${fmtUtc(snapshot.cycleExerciseTs)} · ${fmtEastern(snapshot.cycleExerciseTs)}: the exercise window is open and assignment can take collateral at the strike, so no new shares are minted against it. Deposits reopen after the keeper closes the week.`;
    case "assignmentPending":
      return "Contracts have been assigned and the claim has not been redeemed yet, so the collateral has left while the strike USDG is still inside Valorem. Deposits reopen once the week is closed.";
    case "stranded":
      return "The last close could not redeem its Valorem claim (see the stranded-claim notice). Deposits reopen once the claim is redeemed with Retry claim.";
    case "reserveUnbacked":
      return "The vault's token balance is below what settled redeemers are owed, which only an issuer burn produces. Deposits reopen once the reserve is collected or refilled.";
    case "deadBook":
      return "The book is worth less than a millionth of a token per share, so the vault will not sell new shares at that price. Deposits reopen once collateral or a redeemed claim comes back, or the outstanding shares redeem out.";
    default:
      return "The vault's maxDeposit() is zero and this page could not read which reason applies. The vault refuses deposits past its sale window, while settling, while holding a stranded claim, while its reserve is unbacked, or when the book is worth too little per share to sell new shares; a full deposit cap also reads as zero. Deposits reopen by themselves when the reason clears.";
  }
}

/** A full cap, said as a full cap: a healthy vault whose deliberately small launch cap has no room. */
function capFullCopy(cap: bigint, held: bigint): string {
  if (cap === 0n) return "The vault's deposit cap is set to zero, so it takes no new deposits until the admin raises it.";
  return `The vault holds ${fmtAsset(held)} ${MARKET} of collateral against a deposit cap of ${fmtAsset(cap)} ${MARKET}, so any deposit would take it past the cap. That is not a closure: room opens when collateral leaves (a redemption or an assignment) or the admin raises the cap.`;
}

/** Full-precision decimal string for the max button — never a rounded display value. */
function fmtAssetExact(value: bigint): string {
  const whole = value / 10n ** BigInt(ASSET_DECIMALS);
  const frac = (value % 10n ** BigInt(ASSET_DECIMALS)).toString().padStart(ASSET_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
