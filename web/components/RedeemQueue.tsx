"use client";

import { useMemo, useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { MARKET, SHARE_DECIMALS, SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { fmtAsset, fmtShares, fmtUsdg, parseAmount } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { ConnectButton } from "./ConnectButton";
import { useTxRunner } from "./TxToast";

/**
 * Withdrawals.
 *
 * There are two paths and the contract, not this form, decides which one is open:
 *
 *  - INSTANT, only while `canRedeemInstantly()` — phase Idle and nothing written. The shares burn
 *    and the tokens come straight back.
 *  - QUEUED, in every other case. `queueRedeem` escrows the shares into the vault and records the
 *    epoch. When the keeper closes the week, that epoch is settled as a pot of assets and USDG,
 *    and `completeRedeem` draws a pro-rata slice of it. Nothing is promised 1:1: if the week was
 *    assigned, part of the payout arrives as USDG at the strike instead of as tokens.
 *
 * previewRedeem() deliberately returns 0 when the instant path is shut, so this form never shows
 * a number that cannot be collected right now.
 *
 * Two facts that are easy to get backwards:
 *  - escrowed shares keep earning until settlement. The queue settles after the week's harvest,
 *    so a share sitting in the queue still collects the week it sat through.
 *  - under a Stock Token issuer freeze, queueing still works — it is pure bookkeeping inside the
 *    vault — but `completeRedeem` moves the token itself and reverts until the freeze lifts.
 */
export function RedeemQueue({
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

  const shares = useMemo(() => parseAmount(raw, SHARE_DECIMALS), [raw]);
  const free = position.shares ?? 0n;
  const instant = snapshot.canRedeemInstantly === true;
  // Distinguish "we read the vault and the queue is the only path" from "we have not read the
  // vault at all". Telling someone a call is open when nothing has been read is a false claim.
  const instantKnown = snapshot.canRedeemInstantly !== undefined;
  const queued = position.queuedShares ?? 0n;
  const pendingAssets = position.pendingAssets ?? 0n;
  const pendingUsdg = position.pendingUsdg ?? 0n;
  const hasPending = pendingAssets > 0n || pendingUsdg > 0n;

  // queuedEpoch < epochId means the keeper has already closed that week, so the payout exists.
  const waitingOnKeeper =
    queued > 0n &&
    position.queuedEpoch !== undefined &&
    snapshot.epochId !== undefined &&
    position.queuedEpoch >= snapshot.epochId;

  const overBalance = shares !== null && shares > free;
  const disabled = busy || !isConnected || !VAULT || shares === null || shares === 0n || overBalance;

  async function submit() {
    if (!VAULT || !address || shares === null || shares === 0n) return;
    // Bind the narrowed vault address: the guard does not reach inside the run() callbacks.
    const vault = VAULT;
    setBusy(true);
    try {
      const hash = instant
        ? await run(
            () =>
              writeContractAsync({
                address: vault,
                abi: vaultAbi as unknown as Abi,
                functionName: "redeem",
                args: [shares, address, address],
              }),
            { pending: "Redeeming", success: `Redeemed — ${MARKET} returned` },
          )
        : await run(
            () =>
              writeContractAsync({
                address: vault,
                abi: vaultAbi as unknown as Abi,
                functionName: "queueRedeem",
                args: [shares],
              }),
            { pending: "Queuing redemption", success: "Queued for this week's close" },
          );
      if (hash) {
        setRaw("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!VAULT || !address) return;
    const vault = VAULT;
    setBusy(true);
    try {
      const hash = await run(
        () =>
          writeContractAsync({
            address: vault,
            abi: vaultAbi as unknown as Abi,
            functionName: "completeRedeem",
            args: [address],
          }),
        { pending: "Completing redemption", success: "Redemption collected" },
      );
      if (hash) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Withdraw</span>
        <span className="tiny faint mono">
          {!instantKnown ? "state unavailable" : instant ? "instant path open" : "queue only"}
        </span>
      </div>

      <div className="field">
        <label htmlFor="redeem-shares">Shares</label>
        <div className="input-wrap">
          <input
            id="redeem-shares"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={raw}
            autoComplete="off"
            onChange={(e) => setRaw(e.target.value)}
          />
          <span className="suffix">{SHARE_TICKER}</span>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span className="k">Free shares</span>
          <span className="v">
            {fmtShares(free)}
            <button
              data-size="sm"
              data-variant="ghost"
              style={{ marginLeft: 6 }}
              onClick={() => setRaw(exactShares(free))}
            >
              max
            </button>
          </span>
        </div>
        <div className="row">
          <span className="k">Queued shares</span>
          <span className="v">{fmtShares(queued)}</span>
        </div>
      </div>

      {overBalance ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          More than the free share balance. Shares already in the queue cannot be queued twice.
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        {!isConnected ? (
          <ConnectButton />
        ) : (
          <button data-variant="primary" style={{ width: "100%" }} disabled={disabled} onClick={submit}>
            {busy ? "Working…" : instant ? "Redeem now" : "Queue redemption"}
          </button>
        )}
      </div>

      <div className="notice" data-tone="info" style={{ marginTop: 12 }}>
        {!instantKnown
          ? "The vault's phase has not been read yet, so which withdrawal path is open is unknown. The contract decides at the moment you send the transaction."
          : instant
            ? "The vault is flat, so a redemption settles in the same transaction."
            : "A call is open. Redemptions are queued and paid after the keeper closes the week. An assigned week pays part of the queue in USDG at the strike instead of in tokens."}
      </div>

      {queued > 0n ? (
        <>
          <hr className="hr" />
          <div className="card-head">
            <span className="card-title">Queued redemption</span>
            <span className="tiny faint mono">
              epoch {position.queuedEpoch?.toString() ?? "—"} · current {snapshot.epochId?.toString() ?? "—"}
            </span>
          </div>
          <div className="rows">
            <div className="row">
              <span className="k">Payable {MARKET}</span>
              <span className="v">{fmtAsset(pendingAssets)}</span>
            </div>
            <div className="row">
              <span className="k">Payable USDG</span>
              <span className="v">{fmtUsdg(pendingUsdg)}</span>
            </div>
          </div>
          {waitingOnKeeper ? (
            <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
              This epoch settles after the keeper closes the week at expiry. The amounts above turn
              non-zero then.
            </div>
          ) : (
            <button style={{ width: "100%", marginTop: 12 }} disabled={busy || !hasPending} onClick={complete}>
              {busy ? "Working…" : "Complete redemption"}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}

function exactShares(value: bigint): string {
  const whole = value / 10n ** BigInt(SHARE_DECIMALS);
  const frac = (value % 10n ** BigInt(SHARE_DECIMALS)).toString().padStart(SHARE_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
