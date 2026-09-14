"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { MARKET, VAULT, vaultAbi } from "@/lib/contracts";
import { WAD, fmtAsset, fmtUsdg, fmtWadPercent } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { useTxRunner } from "./TxToast";

/**
 * The stranded-claim banner (Vault.sol "STRANDED CLAIM", AUDIT-FINDINGS F-02 / AF-02).
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
 * paid when the claim is finally redeemed. Anyone can call `retryStrandedClaim()`; it reverts
 * StillStranded while the cause persists and settles the claim the first time Valorem lets it
 * through.
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
}: {
  snapshot: VaultSnapshot;
  position?: AccountPosition;
  onDone?: () => void;
  compact?: boolean;
}) {
  const { address, isConnected } = useAccount();
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
    if (!VAULT) return;
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
          }),
        { pending: "Retrying the stranded claim", success: "Claim redeemed — the week's collateral and strike USDG are home" },
      );
      if (hash) onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice" data-tone="bad" style={{ marginTop: compact ? 0 : 16 }}>
      <strong>
        A claim is stranded{snapshot.cycleNumber !== undefined ? ` (cycle #${snapshot.cycleNumber})` : ""}: the week closed, but Valorem
        could not return its collateral.
      </strong>{" "}
      The close tried to redeem the week&apos;s Valorem claim and the redeem reverted: a USDG pause or freeze, or the
      Stock Token issuer blocklisting the vault. The premium was harvested and the vault went to Idle with the claim
      kept, so {fmtAsset(snapshot.lockedAssets)} {MARKET} (plus the strike USDG for anything assigned) is still inside
      Valorem. While that holds, deposits and instant redemption are closed and no new week can be armed; the queue
      keeps working on the idle balance and takes its share of the claim.
      {!compact ? (
        <>
          <div className="rows" style={{ marginTop: 10 }}>
            <div className="row">
              <span className="k">Claim still owned by live shares</span>
              <span className="v">{fmtWadPercent(liveWad)}</span>
            </div>
            <div className="row">
              <span className="k">Claim owed to settled queue epochs</span>
              <span className="v">{fmtWadPercent(queueWad)}</span>
            </div>
            <div className="row">
              <span className="k">Strand generation</span>
              <span className="v">
                #{snapshot.strandGen?.toString() ?? "—"}
                {snapshot.lastResolvedGen !== undefined ? ` · last resolved #${snapshot.lastResolvedGen.toString()}` : ""}
              </span>
            </div>
            {address && position?.ready ? (
              <>
                <div className="row" title="Your queue entry's share of the stranded claim, staged or in your settled epoch. Paid with completeRedeem once the claim is redeemed.">
                  <span className="k">Your pending claim share (queue)</span>
                  <span className="v">{fmtWadPercent(pendingWad)}</span>
                </div>
                <div className="row" title="Your live shares' slice of what the claim still owes live shares. It comes back as NAV and, for strike USDG, through the harvest when the claim is redeemed.">
                  <span className="k">Your live shares&apos; slice</span>
                  <span className="v">{fmtWadPercent(liveShareWad)}</span>
                </div>
                <div className="row">
                  <span className="k">Collectable now (previewCompleteRedeem)</span>
                  <span className="v">
                    {fmtAsset(position.pendingAssets)} {MARKET} · {fmtUsdg(position.pendingUsdg)} USDG
                  </span>
                </div>
              </>
            ) : null}
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button data-variant="primary" disabled={busy || !isConnected || !VAULT} onClick={retry}>
              {busy ? "Working…" : "Retry claim"}
            </button>
            <span className="tiny faint">
              Anyone can send this. It reverts StillStranded while the cause persists and settles the claim the
              first time Valorem lets it through; nothing here needs the keeper.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
