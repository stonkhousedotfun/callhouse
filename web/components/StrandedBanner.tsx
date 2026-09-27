"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { CHAIN_ID } from "@/lib/chain";
import { MARKET, VAULT, vaultAbi } from "@/lib/contracts";
import { WAD, fmtAsset, fmtUsdg, fmtWadPercent } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { Button, InfoTip, Notice, Row, Rows, Unit } from "@/components/ui";
import { useTxRunner } from "./TxToast";

/**
 * The stranded-claim banner (Vault.sol "STRANDED CLAIM").
 *
 * WHAT HAPPENED. `rollClose` redeems the week's Valorem claim, and Valorem pushes USDG and then
 * NVDA to the vault in one call. Either token's issuer can make that revert at will: USDG paused,
 * the vault or the clearinghouse frozen on USDG, or the vault blocklisted on the Stock Token.
 * Rather than hold every unit of idle collateral and the whole queue hostage to a stablecoin
 * action, the vault goes to Idle anyway and KEEPS the claim. `claimKey != 0` while Idle is that
 * state, and only a failed redeem can produce it (`isStranded()`).
 *
 * WHILE IT HOLDS: deposits are refused and instant redemption is off (nobody buys in or leaves
 * at a NAV that cannot yet see the claim's strike USDG); `rollOpen` reverts StillStranded, so
 * there is one stranded claim at a time; the queue keeps settling on the IDLE balance, and every
 * epoch that settles while stranded takes a pro-rata WAD share of the claim (`EpochStrandShare`),
 * paid when the claim is finally redeemed. Settling is bookkeeping and always works; PAYING the
 * idle share out is a transfer (Vault._payoutOwed), so when the strand's cause is the Stock Token
 * issuer blocklisting the vault, the token leg of every payout reverts until that lifts too, and a
 * USDG pause or freeze defers the USDG leg. The banner says so rather than promising payouts the
 * cause itself blocks. Anyone can call `retryStrandedClaim()`; it reverts StillStranded while the
 * cause persists and settles the claim the first time Valorem lets it through.
 *
 * WHAT THIS ACCOUNT IS OWED, from the vault's own views (no indexer): a share already staged by a
 * settled queue entry (`owedStrandWad`), the queued epoch's share prorated by this account's
 * entry (`epochStrandWad(e) × shares / epoch.sharesRemaining`, the contract's own arithmetic),
 * and, for shares still live, `balance / totalSupply` of `strandedRemainingWad`. A share is a
 * fraction of whatever the claim returns: the NVDA still locked behind it plus the strike USDG
 * for anything assigned. The banner shows the fraction and the locked collateral it is a fraction
 * of, not a number it cannot know.
 */
export function StrandedBanner({
  snapshot,
  position,
  onDone,
  compact = false,
  className,
}: {
  snapshot: VaultSnapshot;
  position?: AccountPosition;
  onDone?: () => void;
  compact?: boolean;
  /** Presentational: extra classes on the notice box. The banner sets no outer margin of its own;
   *  the pages stack their sections with a gap. */
  className?: string;
}) {
  const { address, isConnected, chainId } = useAccount();
  // same pair as AccountView.tsx. No silent network switch; a wrong network refuses and says so.
  const wrongNetwork = isConnected && chainId !== CHAIN_ID;
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [busy, setBusy] = useState(false);

  const stranded = snapshot.isStranded === true || (snapshot.phase === 0 && (snapshot.claimKey ?? 0n) !== 0n);
  if (!stranded) return null;

  const liveWad = snapshot.strandedRemainingWad;
  const queueWad = liveWad === undefined ? undefined : WAD - liveWad;

  // This account's slice, as the contract will compute it (previewCompleteRedeem folds the same).
  let pendingWad: bigint | undefined;
  if (position?.ready) {
    pendingWad = position.owedStrandWad ?? 0n;
    const queued = position.queuedShares ?? 0n;
    const settledEpoch =
      queued > 0n && position.queuedEpoch !== undefined && snapshot.epochId !== undefined && position.queuedEpoch < snapshot.epochId;
    if (settledEpoch && position.epochStrandWad !== undefined && position.epochStrandWad > 0n) {
      const rem = position.epochSharesRemaining ?? 0n;
      pendingWad += rem === 0n || queued === rem ? position.epochStrandWad : (position.epochStrandWad * queued) / rem;
    }
  }
  const liveShareWad =
    position?.shares !== undefined && snapshot.totalSupply !== undefined && snapshot.totalSupply > 0n && liveWad !== undefined
      ? (liveWad * position.shares) / snapshot.totalSupply
      : undefined;

  async function retry() {
    // Refused here as well as on the button: the button is not the only way into this function.
    if (!VAULT || wrongNetwork) return;
    const vault = VAULT;
    setBusy(true);
    try {
      const hash = await run(
        () =>
          writeContractAsync({
            address: vault,
            abi: vaultAbi as unknown as Abi,
            functionName: "retryStrandedClaim",
            args: [],
            // without this @wagmi/core 3.6.5 disables its chain assertion entirely.
            chainId: CHAIN_ID,
          }),
        { pending: "Retrying the stranded claim", success: "Claim redeemed: the week's collateral and strike USDG are back" },
      );
      if (hash) onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice
      tone="danger"
      className={className}
      title={
        <>
          A claim is stranded{snapshot.cycleNumber !== undefined ? ` (cycle #${snapshot.cycleNumber})` : ""}: the week closed, but its
          collateral could not be returned yet.
        </>
      }
    >
      {" "}
      {/* A readable measure: the banner spans the page, the sentence should not. */}
      <p className="max-w-[78ch]">
        <span className="num text-[0.92em] font-medium text-ink">{fmtAsset(snapshot.lockedAssets)} {MARKET}</span> (plus the
        strike USDG for anything assigned) is still held by the options contract. Until it comes back, deposits and
        instant withdrawals are off and no new week can start. Queued withdrawals still settle.{" "}
        <InfoTip label="Why the claim is stranded">
          At the close the vault tried to redeem the week&apos;s claim on Valorem, the options contract, and it failed:
          USDG was paused or frozen, or the Stock Token issuer blocked the vault. The premium was already collected. The
          queue still settles, booking each entry&apos;s share of the free balance and of the claim, but paying out moves
          tokens: an issuer block on the vault holds the {MARKET} part back until it lifts, and a USDG pause or freeze
          holds back the USDG part.
        </InfoTip>
      </p>
      {!compact ? (
        <>
          <Rows className="mt-3 max-w-[720px] border-t border-danger/20">
            <Row k="Claim owed to current holders" v={fmtWadPercent(liveWad)} dense className="border-danger/15!" />
            <Row k="Claim owed to settled withdrawals" v={fmtWadPercent(queueWad)} dense className="border-danger/15!" />
            <Row
              k="Stranded claim"
              v={
                <>
                  #{snapshot.strandGen?.toString() ?? "—"}
                  {snapshot.lastResolvedGen !== undefined ? ` · last cleared #${snapshot.lastResolvedGen.toString()}` : ""}
                </>
              }
              dense
              className="border-danger/15!"
            />
            {address && position?.ready ? (
              <>
                <Row
                  k={
                    <>
                      Your share, queued{" "}
                      <InfoTip label="About your queued share">
                        Your queued withdrawal&apos;s share of the stranded claim. Paid with Complete redemption once the claim
                        is redeemed.
                      </InfoTip>
                    </>
                  }
                  v={fmtWadPercent(pendingWad)}
                  dense
                  className="border-danger/15!"
                />
                <Row
                  k={
                    <>
                      Your share, held{" "}
                      <InfoTip label="About your held share">
                        Your current shares&apos; part of what the claim still owes holders. When the claim is redeemed it
                        comes back in the share price, and any strike USDG through the USDG claim.
                      </InfoTip>
                    </>
                  }
                  v={fmtWadPercent(liveShareWad)}
                  dense
                  className="border-danger/15!"
                />
                <Row
                  k="You can collect now"
                  v={
                    <>
                      {fmtAsset(position.pendingAssets)} <Unit>{MARKET}</Unit> · {fmtUsdg(position.pendingUsdg)} <Unit>USDG</Unit>
                    </>
                  }
                  dense
                  className="border-danger/15!"
                />
              </>
            ) : null}
          </Rows>
          <div className="mt-3 flex max-w-[720px] flex-wrap items-center gap-x-4 gap-y-2">
            <Button size="sm" disabled={busy || !isConnected || !VAULT || wrongNetwork} onClick={retry}>
              {busy ? "Working…" : "Retry claim"}
            </Button>
            {wrongNetwork ? (
              <span className="text-[12.5px] leading-snug text-ink-2">Switch to Robinhood Chain to retry.</span>
            ) : null}
            <span className="min-w-0 flex-1 basis-60 text-[12.5px] leading-snug text-ink-3">
              Anyone can send this. It fails until the cause clears, then brings the claim back. No keeper
              needed.
            </span>
          </div>
        </>
      ) : null}
    </Notice>
  );
}
