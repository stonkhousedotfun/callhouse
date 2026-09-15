"use client";

import { useMemo, useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { MARKET, SHARE_DECIMALS, SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { canSettleQueue, fmtAsset, fmtShares, fmtUsdg, parseAmount, redeemQueueView } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { Button, Card, CardHead, CardMeta, CardTitle, Field, Notice, Row, Rows } from "@/components/ui";
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
 *
 * SETTLING WHILE FLAT. A queue entry in the current epoch used to settle only inside the keeper's
 * `rollClose`, which needs a `rollOpen` first. If the next week is never armed (writes halted, a
 * stale or paused price feed, an option type the vault refuses, less than one lot idle) the entry
 * waited indefinitely while holders who had not queued could still redeem instantly.
 * `settleQueue()` is permissionless and works only while the vault is Idle; it prices the queue
 * exactly like an instant redemption and moves no tokens, so this form offers it whenever the
 * account's entry is in the current epoch and the vault is Idle, then `completeRedeem` pays as
 * usual.
 *
 * WHILE A CLAIM IS STRANDED the queue is the only exit: instant redemption is off, an epoch
 * settled now books its slice of the idle balance now and its pro-rata share of the stranded
 * claim for when `retryStrandedClaim` succeeds (the stranded-claim notice above the forms says how
 * much). Settling is bookkeeping and always works; the payout is a transfer, so the Stock Token
 * leg waits out a Stock Token blocklist of the vault (which can be the very cause of the strand)
 * and the USDG leg is deferred while USDG cannot move. `completeRedeem` reverts StillStranded for
 * an entry whose claim share is not yet collectable; `previewCompleteRedeem` quotes only what can
 * be collected now.
 *
 * THE BLOCK OUTLIVES THE QUEUE ENTRY (lib/format.ts redeemQueueView). Collecting settles the entry
 * and zeroes `queuedSharesOf`, but a staged share of a stranded claim, or a USDG leg the vault
 * could not move, is still owed afterwards and only `completeRedeem` pays it. So the block, and
 * its Complete button, render whenever anything is queued, collectable or staged; "waiting on the
 * claim" is decided by strand generation, not by `isStranded`, which the recovery clears.
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
  const stranded = snapshot.isStranded === true;
  const queued = position.queuedShares ?? 0n;
  const pendingAssets = position.pendingAssets ?? 0n;
  const pendingUsdg = position.pendingUsdg ?? 0n;
  const view = redeemQueueView({
    queuedShares: queued,
    queuedEpoch: position.queuedEpoch,
    epochId: snapshot.epochId,
    pendingAssets,
    pendingUsdg,
    owedStrandWad: position.owedStrandWad,
    owedStrandGen: position.owedStrandGen,
    epochStrandWad: position.epochStrandWad,
    epochStrandGen: position.epochStrandGen,
    lastResolvedGen: snapshot.lastResolvedGen,
    isStranded: snapshot.isStranded,
  });
  const hasPending = view.collectable;
  const strandShareWaiting = view.strandShareWaiting;

  // queuedEpoch < epochId means the keeper has already closed that week, so the payout exists.
  const waitingOnKeeper =
    queued > 0n &&
    position.queuedEpoch !== undefined &&
    snapshot.epochId !== undefined &&
    position.queuedEpoch >= snapshot.epochId;

  // Idle and the entry is still in the current epoch: nothing will settle it unless someone calls
  // settleQueue(). Checked before waitingOnKeeper, which is also true in this state.
  const settleable = canSettleQueue({
    phase: snapshot.phase,
    epochId: snapshot.epochId,
    queuedShares: queued,
    queuedEpoch: position.queuedEpoch,
  });

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

  async function settle() {
    if (!VAULT || !address) return;
    const vault = VAULT;
    setBusy(true);
    try {
      const hash = await run(
        () =>
          writeContractAsync({
            address: vault,
            abi: vaultAbi as unknown as Abi,
            functionName: "settleQueue",
            args: [],
          }),
        { pending: "Settling the queue", success: "Queue settled — redemption ready to collect" },
      );
      if (hash) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead>
        <CardTitle>Withdraw</CardTitle>
        <CardMeta>
          {!instantKnown ? "state unavailable" : instant ? "instant path open" : stranded ? "queue only · claim stranded" : "queue only"}
        </CardMeta>
      </CardHead>

      <Field
        id="redeem-shares"
        label="Shares"
        suffix={SHARE_TICKER}
        inputMode="decimal"
        placeholder="0.0"
        value={raw}
        autoComplete="off"
        onChange={(e) => setRaw(e.target.value)}
      />

      <Rows className="mt-3">
        <Row
          k="Free shares"
          v={
            <>
              {fmtShares(free)}
              <Button variant="ghost" size="xs" className="ml-2 align-baseline" onClick={() => setRaw(exactShares(free))}>
                max
              </Button>
            </>
          }
        />
        <Row k="Queued shares" v={fmtShares(queued)} />
      </Rows>

      {overBalance ? (
        <Notice tone="danger" role="status" className="mt-4">
          More than the free share balance. Shares already in the queue cannot be queued twice.
        </Notice>
      ) : null}

      <div className="mt-5">
        {!isConnected ? (
          <ConnectButton block />
        ) : (
          <Button variant="primary" className="w-full" disabled={disabled} onClick={submit}>
            {busy ? "Working…" : instant ? "Redeem now" : "Queue redemption"}
          </Button>
        )}
      </div>

      <Notice tone="info" className="mt-4">
        {!instantKnown
          ? "The vault's phase has not been read yet, so which withdrawal path is open is unknown. The contract decides at the moment you send the transaction."
          : instant
            ? "The vault is flat, so a redemption settles in the same transaction."
            : stranded
              ? `A claim is stranded, so instant redemption is off. Queue here: settling the queue always works, because it only books each entry's share of the idle balance and of the stranded claim. Paying it out moves tokens, so ${MARKET} is paid only while the Stock Token lets the vault transfer (an issuer blocklist of the vault holds it back until lifted) and USDG only while USDG can move. The share of the claim is paid once the claim is redeemed.`
              : "A call is open. Redemptions are queued and paid after the keeper closes the week. An assigned week pays part of the queue in USDG at the strike instead of in tokens."}
      </Notice>

      {view.show ? (
        <div className="mt-5 border-t border-line pt-5">
          <CardHead className="mb-3!">
            <CardTitle as="h3" className="text-base!">{queued > 0n ? "Queued redemption" : "Settled redemption to collect"}</CardTitle>
            <CardMeta>
              {queued > 0n
                ? `epoch ${position.queuedEpoch?.toString() ?? "—"} · current ${snapshot.epochId?.toString() ?? "—"}`
                : "nothing queued"}
            </CardMeta>
          </CardHead>
          <Rows>
            <Row k={<>Payable {MARKET}</>} v={fmtAsset(pendingAssets)} />
            <Row k="Payable USDG" v={fmtUsdg(pendingUsdg)} />
          </Rows>
          {settleable ? (
            <>
              <Notice tone="info" className="mt-4">
                The vault is Idle and this entry is in the current epoch, so nothing will settle it until someone
                calls settleQueue. Settling it here does not need the keeper. It pays what an instant redemption of
                the same shares would pay now, plus the USDG the escrowed shares earned while queued
                {stranded ? ", and books this epoch's share of the stranded claim for when it is redeemed" : ""}. It
                settles every entry in this epoch, not only yours, and anyone can send it. After it confirms, collect
                with Complete redemption.
              </Notice>
              <Button variant="primary" className="mt-4 w-full" disabled={busy || !isConnected} onClick={settle}>
                {busy ? "Working…" : "Settle queue"}
              </Button>
              {hasPending ? (
                <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={complete}>
                  {busy ? "Working…" : "Collect earlier settled redemption"}
                </Button>
              ) : null}
            </>
          ) : waitingOnKeeper ? (
            <>
              <Notice tone="warn" className="mt-4">
                This epoch settles after the keeper closes the week at expiry.{" "}
                {hasPending
                  ? "The amounts above are owed from an earlier redemption and can be collected now."
                  : "The amounts above turn non-zero then."}
              </Notice>
              {hasPending ? (
                <Button variant="ghost" className="mt-4 w-full" disabled={busy} onClick={complete}>
                  {busy ? "Working…" : "Collect earlier settled redemption"}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {strandShareWaiting ? (
                <Notice tone="warn" className="mt-4">
                  Part of this redemption is a share of the stranded claim and cannot be collected until the claim is
                  redeemed (Retry claim above). The amounts above are what can be collected now.
                </Notice>
              ) : view.strandShareRecovered ? (
                <Notice tone="info" className="mt-4">
                  The stranded claim this redemption had a share of has been redeemed. Complete redemption collects that
                  share with anything else owed.
                </Notice>
              ) : view.usdgLegDeferred ? (
                <Notice tone="info" className="mt-4">
                  USDG from an earlier collection is still owed: it could not move at the time (USDG paused, or the vault
                  or the receiver frozen on USDG), so the vault kept it for you. Complete redemption tries again.
                </Notice>
              ) : null}
              <Button
                variant={hasPending ? "primary" : "ghost"}
                className="mt-4 w-full"
                disabled={busy || !hasPending}
                onClick={complete}
              >
                {busy ? "Working…" : "Complete redemption"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function exactShares(value: bigint): string {
  const whole = value / 10n ** BigInt(SHARE_DECIMALS);
  const frac = (value % 10n ** BigInt(SHARE_DECIMALS)).toString().padStart(SHARE_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
