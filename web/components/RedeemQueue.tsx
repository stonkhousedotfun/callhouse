"use client";

import { useMemo, useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { CHAIN_ID } from "@/lib/chain";
import { MARKET, SHARE_DECIMALS, SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { canSettleQueue, fmtAsset, fmtShares, fmtUsdg, parseAmount, redeemQueueView } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { Button, Card, CardHead, CardMeta, CardTitle, Field, InfoTip, Notice, Row, Rows } from "@/components/ui";
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
  const { address, isConnected, chainId } = useAccount();
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
  // the same pair AccountView.tsx reads: the wallet's chain from useAccount against the one
  // CHAIN_ID in @/lib/chain. Nothing here switches the wallet's network.
  const wrongNetwork = isConnected && chainId !== CHAIN_ID;
  const disabled =
    busy || !isConnected || !VAULT || shares === null || shares === 0n || overBalance || wrongNetwork;

  async function submit() {
    if (wrongNetwork) return;
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
                // without this @wagmi/core 3.6.5 disables its chain assertion entirely.
                chainId: CHAIN_ID,
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
                // without this @wagmi/core 3.6.5 disables its chain assertion entirely.
                chainId: CHAIN_ID,
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
    if (wrongNetwork) return;
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
            // without this @wagmi/core 3.6.5 disables its chain assertion entirely.
            chainId: CHAIN_ID,
          }),
        { pending: "Completing redemption", success: "Redemption collected" },
      );
      if (hash) onDone();
    } finally {
      setBusy(false);
    }
  }

  async function settle() {
    if (wrongNetwork) return;
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
            // without this @wagmi/core 3.6.5 disables its chain assertion entirely.
            chainId: CHAIN_ID,
          }),
        { pending: "Settling the queue", success: "Queue settled: ready to collect" },
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
          {!instantKnown ? "loading" : instant ? "instant" : stranded ? "queue only · claim stranded" : "queue only"}
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
          More than your free shares. Shares already queued can&apos;t be queued again.
        </Notice>
      ) : null}

      <div className="mt-5">
        {!isConnected ? (
          <ConnectButton block />
        ) : wrongNetwork ? (
          <p className="text-[13px] text-ink-2">Switch to Robinhood Chain to redeem.</p>
        ) : (
          <Button variant="primary" className="w-full" disabled={disabled} onClick={submit}>
            {busy ? "Working…" : instant ? "Redeem now" : "Queue redemption"}
          </Button>
        )}
      </div>

      <Notice tone="info" className="mt-4">
        {!instantKnown ? (
          <>
            Loading the vault. The contract picks the path when you send.{" "}
            <InfoTip label="About withdrawal paths">
              Instant while the vault holds no open call; queued otherwise. The vault has not been read yet, so this form
              cannot say which is open.
            </InfoTip>
          </>
        ) : instant ? (
          "No call is open, so you're paid in the same transaction."
        ) : stranded ? (
          <>
            A claim is stranded, so instant withdrawals are off. You can still queue.{" "}
            <InfoTip label="About queuing while a claim is stranded">
              Settling the queue always works: it only books each entry&apos;s share of the free balance and of the stranded
              claim. Paying out moves tokens, so {MARKET} is paid only while the Stock Token lets the vault transfer (an
              issuer block on the vault holds it back until lifted), and USDG only while USDG can move. The claim&apos;s
              share is paid once the claim is redeemed.
            </InfoTip>
          </>
        ) : (
          <>
            A call is open. Redemptions are queued and paid after the keeper closes the week.{" "}
            <InfoTip label="About assigned weeks">
              If the call is assigned, part of the queue is paid in USDG at the strike instead of in {MARKET}.
            </InfoTip>
          </>
        )}
      </Notice>

      {view.show ? (
        <div className="mt-5 border-t border-line pt-5">
          <CardHead className="mb-3!">
            <CardTitle as="h3" className="text-base!">{queued > 0n ? "Queued redemption" : "Ready to collect"}</CardTitle>
            <CardMeta>
              {queued > 0n
                ? `batch #${position.queuedEpoch?.toString() ?? "—"} · now #${snapshot.epochId?.toString() ?? "—"}`
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
                No call is open, so this waits until someone settles the queue. You can do it now; no keeper
                needed.{" "}
                <InfoTip label="About settling the queue">
                  It pays what an instant redemption of the same shares would pay now, plus the USDG your queued shares
                  earned
                  {stranded ? ", and books this batch's share of the stranded claim for when it is redeemed" : ""}. It
                  settles every entry in this batch, not only yours, and anyone can send it. After it confirms, collect
                  with Complete redemption.
                </InfoTip>
              </Notice>
              <Button
                variant="primary"
                className="mt-4 w-full"
                disabled={busy || !isConnected || wrongNetwork}
                onClick={settle}
              >
                {busy ? "Working…" : "Settle queue"}
              </Button>
              {wrongNetwork ? (
                <p className="mt-2 text-[13px] text-ink-2">Switch to Robinhood Chain to redeem.</p>
              ) : null}
              {hasPending ? (
                <Button variant="ghost" className="mt-2 w-full" disabled={busy || wrongNetwork} onClick={complete}>
                  {busy ? "Working…" : "Collect earlier redemption"}
                </Button>
              ) : null}
            </>
          ) : waitingOnKeeper ? (
            <>
              <Notice tone="warn" className="mt-4">
                Paid after the keeper closes the week at expiry.{" "}
                {hasPending
                  ? "The amounts above are from an earlier redemption and can be collected now."
                  : "The amounts above fill in then."}
              </Notice>
              {hasPending ? (
                <Button variant="ghost" className="mt-4 w-full" disabled={busy} onClick={complete}>
                  {busy ? "Working…" : "Collect earlier redemption"}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {strandShareWaiting ? (
                <Notice tone="warn" className="mt-4">
                  Part of this is a share of the stranded claim. It can be collected once the claim is redeemed (Retry
                  claim above). The amounts above are what you can collect now.
                </Notice>
              ) : view.strandShareRecovered ? (
                <Notice tone="info" className="mt-4">
                  The stranded claim has been redeemed. Complete redemption collects your share with anything else owed.
                </Notice>
              ) : view.usdgLegDeferred ? (
                <Notice tone="info" className="mt-4">
                  Some USDG from an earlier collection is still owed. The vault kept it for you; Complete redemption
                  tries again.{" "}
                  <InfoTip label="Why USDG is still owed">
                    It could not move at the time: USDG was paused, or the vault or the receiver was frozen on USDG.
                  </InfoTip>
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
