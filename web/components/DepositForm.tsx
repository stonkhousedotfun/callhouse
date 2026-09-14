"use client";

import { useMemo, useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ASSET, ASSET_DECIMALS, MARKET, SHARE_TICKER, VAULT, stockTokenAbi, vaultAbi } from "@/lib/contracts";
import {
  depositsClosedReason,
  fmtAsset,
  fmtShares,
  fmtUsdg,
  fmtUtc,
  listedDepositRisk,
  multiplierIsActive,
  parseAmount,
  toNvdaEq,
  type DepositsClosedReason,
} from "@/lib/format";
import { useNow, type AccountPosition, type VaultSnapshot } from "@/lib/hooks";
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
 * ONE GATE. The vault has a single `DepositsClosed` error and `maxDeposit()` returns 0 on exactly
 * the same conditions (Vault._depositRefused): not Idle or Listed; Listed and past this week's
 * exercise time, whether or not anyone called lockBook (W-2); a contract assigned and its claim
 * not yet redeemed; a stranded claim; the reserve unbacked after an issuer burn; a dead book. So
 * `maxDeposit() == 0` is the chain's word that deposits are closed, and this form treats it as
 * such for the connected account and, through the snapshot's zero-address read, for everyone.
 * `depositsClosedReason` names the reason beside it from what the page has read.
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

  // Closed by the chain's own word (maxDeposit == 0 for the account, or for anyone), or by a
  // reason the snapshot can name. An unknown phase (no vault configured, or the read has not
  // landed) is not "closed": the button is disabled by other means, and a false "we are
  // settling" notice would be a lie.
  const reason = depositsClosedReason(snapshot, nowSeconds);
  const chainSaysClosed =
    snapshot.depositsOpen === false || (position.ready && headroom !== undefined && headroom === 0n && snapshot.phase !== undefined);
  const closed = reason !== undefined || chainSaysClosed;

  const risk = closed
    ? "none"
    : listedDepositRisk({
        phase: snapshot.phase,
        cycleStrikeUsdg: snapshot.cycleStrikeUsdg,
        spotUsdg: snapshot.spotUsdg,
        minOtmBps: snapshot.policy?.minOtmBps,
      });

  const disabled =
    busy || !isConnected || !VAULT || amount === null || amount === 0n || overBalance || overCap || closed;

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
    <div className="card">
      <div className="card-head">
        <span className="card-title">Deposit</span>
        <span className="tiny faint mono">
          {closed ? "closed" : `cap headroom ${headroom === undefined ? "—" : `${fmtAsset(headroom)} ${MARKET}`}`}
        </span>
      </div>

      <div className="field">
        <label htmlFor="deposit-amount">Amount</label>
        <div className="input-wrap">
          <input
            id="deposit-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={raw}
            autoComplete="off"
            onChange={(e) => setRaw(e.target.value)}
          />
          <span className="suffix">{MARKET}</span>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span className="k">Wallet balance</span>
          <span className="v">
            {fmtAsset(balance)} {MARKET}
            {balance !== undefined ? (
              <>
                {" "}
                <button
                  data-size="sm"
                  data-variant="ghost"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    const cap = headroom !== undefined && headroom < balance ? headroom : balance;
                    setRaw(fmtAssetExact(cap));
                  }}
                >
                  max
                </button>
              </>
            ) : null}
          </span>
        </div>
        <div className="row">
          <span className="k">You receive</span>
          <span className="v">
            {previewShares === undefined ? "—" : fmtShares(previewShares)} {SHARE_TICKER}
          </span>
        </div>
        {multiplierIsActive(snapshot.uiMultiplier) && amount !== null ? (
          <div className="row">
            <span className="k">
              {MARKET}-eq <span className="faint">(display only)</span>
            </span>
            <span className="v">{fmtAsset(toNvdaEq(amount, snapshot.uiMultiplier))}</span>
          </div>
        ) : null}
        <div className="row">
          <span className="k">Allowance</span>
          <span className="v">{fmtAsset(allowance)}</span>
        </div>
      </div>

      {closed ? (
        <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
          <strong>Deposits are closed right now.</strong> {closedCopy(reason, snapshot)}
        </div>
      ) : null}
      {risk !== "none" ? (
        <div className="notice" data-tone={risk === "near" ? "bad" : "warn"} style={{ marginTop: 12 }}>
          {risk === "near" ? (
            <>
              <strong>{MARKET} is at or near this week&apos;s strike.</strong> Spot is {fmtUsdg(snapshot.spotUsdg)} USDG
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
        </div>
      ) : null}
      {overBalance ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          That is more than the wallet holds.
        </div>
      ) : null}
      {overCap && !overBalance && !closed ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          That is past the vault&apos;s deposit cap. The cap is deliberately small at launch.
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        {!isConnected ? (
          <ConnectButton />
        ) : (
          <button data-variant="primary" style={{ width: "100%" }} disabled={disabled} onClick={submit}>
            {busy ? "Working…" : closed ? "Deposits closed" : needsApproval ? `Approve and deposit` : "Deposit"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The reason deposits are shut, in the vault's own terms (Vault._depositRefused). */
function closedCopy(reason: DepositsClosedReason | undefined, snapshot: VaultSnapshot): string {
  switch (reason) {
    case "phase":
      return "The vault is settling the week (past its sale window). Deposits reopen when it returns to Idle.";
    case "window":
      return `This week's sale window closed at ${fmtUtc(snapshot.cycleExerciseTs)}: the exercise window is open and assignment can take collateral at the strike, so no new shares are minted against it. Deposits reopen after the keeper closes the week.`;
    case "assignmentPending":
      return "Contracts have been assigned and the claim has not been redeemed yet, so the collateral has left while the strike USDG is still inside Valorem. Deposits reopen once the week is closed.";
    case "stranded":
      return "The last close could not redeem its Valorem claim (see the stranded-claim notice). Deposits reopen once the claim is redeemed with Retry claim.";
    case "reserveUnbacked":
      return "The vault's token balance is below what settled redeemers are owed, which only an issuer burn produces. Deposits reopen once the reserve is collected or refilled.";
    default:
      return "The vault's maxDeposit() is zero: it is past its sale window, settling, holding a stranded claim, its reserve is unbacked, or the book is worth too little per share to sell new shares. Deposits reopen by themselves when the reason clears.";
  }
}

/** Full-precision decimal string for the max button — never a rounded display value. */
function fmtAssetExact(value: bigint): string {
  const whole = value / 10n ** BigInt(ASSET_DECIMALS);
  const frac = (value % 10n ** BigInt(ASSET_DECIMALS)).toString().padStart(ASSET_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
