"use client";

import { useMemo, useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ASSET, ASSET_DECIMALS, MARKET, SHARE_TICKER, VAULT, stockTokenAbi, vaultAbi } from "@/lib/contracts";
import { fmtAsset, fmtShares, multiplierIsActive, parseAmount, toNvdaEq } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
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
 * Deposits are allowed in Idle and Listed. New money lands in idle collateral and is NOT added
 * to a call that is already open, so a late depositor cannot be assigned against a week they had
 * no part in writing.
 *
 * The window closes at the cycle's exerciseTimestamp — Friday book close — whether or not anyone
 * has called lockBook. That was a security fix: once the exercise window opens, assignment can
 * take collateral at the strike, and minting fresh shares against a crashed NAV must be
 * impossible. maxDeposit() therefore returns 0 from that instant, and this form must show the
 * closed window honestly instead of quoting headroom that would only revert.
 *
 * The cap is measured on totalAssets() — idle plus collateral already locked in Valorem, minus
 * what settled redeemers are owed — not on the raw token balance. A balance-based cap would
 * quietly re-open the moment the keeper wrote a call.
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

  // Deposits are blocked in Exercisable and Settling: the vault is mid-settlement and a new
  // share issued against a half-reclaimed balance would price wrong.
  // Unknown phase (no vault configured, or the read has not landed) is not "closed" — the
  //  button is disabled by other means, and a false "we are settling" notice would be a lie.
  const phaseAllows = snapshot.phase === undefined || snapshot.phase === 0 || snapshot.phase === 1;

  const disabled =
    busy || !isConnected || !VAULT || amount === null || amount === 0n || overBalance || overCap || !phaseAllows;

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
          cap headroom {headroom === undefined ? "—" : `${fmtAsset(headroom)} ${MARKET}`}
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

      {!phaseAllows ? (
        <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
          Deposits are closed while the vault settles the week. They reopen when the vault returns
          to Idle.
        </div>
      ) : null}
      {overBalance ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          That is more than the wallet holds.
        </div>
      ) : null}
      {overCap && !overBalance ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          That is past the vault&apos;s deposit cap. The cap is deliberately small at launch.
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        {!isConnected ? (
          <ConnectButton />
        ) : (
          <button data-variant="primary" style={{ width: "100%" }} disabled={disabled} onClick={submit}>
            {busy ? "Working…" : needsApproval ? `Approve and deposit` : "Deposit"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Full-precision decimal string for the max button — never a rounded display value. */
function fmtAssetExact(value: bigint): string {
  const whole = value / 10n ** BigInt(ASSET_DECIMALS);
  const frac = (value % 10n ** BigInt(ASSET_DECIMALS)).toString().padStart(ASSET_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
