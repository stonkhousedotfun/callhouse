"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { MARKET, VAULT, vaultAbi } from "@/lib/contracts";
import { WAD, fmtAsset, fmtUsdg, fmtWadPercent } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { Button, Notice, Row, Rows, Unit } from "@/components/ui";
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
    <Notice
      tone="danger"
      className={className}
      title={
        <>
          A claim is stranded{snapshot.cycleNumber !== undefined ? ` (cycle #${snapshot.cycleNumber})` : ""}: the week closed, but Valorem
          could not return its collateral.
        </>
      }
    >
      {" "}
      {/* A readable measure: the banner spans the page, the sentence should not. */}
      <p className="max-w-[78ch]">
        The close tried to redeem the week&apos;s Valorem claim and the redeem reverted: a USDG pause or freeze, or the
        Stock Token issuer blocklisting the vault. The premium was harvested and the vault went to Idle with the claim
        kept, so <span className="num text-[0.92em] font-medium text-ink">{fmtAsset(snapshot.lockedAssets)} {MARKET}</span> (plus the strike USDG for anything assigned) is still inside
        Valorem. While that holds, deposits and instant redemption are closed and no new week can be armed. The queue
        still settles, booking each entry&apos;s share of the idle balance and of the claim, but paying it out moves
        tokens: a Stock Token blocklist of the vault holds the {MARKET} leg back until it lifts, and a USDG pause or
        freeze defers the USDG leg.
      </p>
      {!compact ? (
        <>
          <Rows className="mt-3 max-w-[720px] border-t border-danger/20">
            <Row k="Claim still owned by live shares" v={fmtWadPercent(liveWad)} dense className="border-danger/15!" />
            <Row k="Claim owed to settled queue epochs" v={fmtWadPercent(queueWad)} dense className="border-danger/15!" />
            <Row
              k="Strand generation"
              v={
                <>
                  #{snapshot.strandGen?.toString() ?? "—"}
                  {snapshot.lastResolvedGen !== undefined ? ` · last resolved #${snapshot.lastResolvedGen.toString()}` : ""}
                </>
              }
              dense
              className="border-danger/15!"
            />
            {address && position?.ready ? (
              <>
                <Row
                  title="Your queue entry's share of the stranded claim, staged or in your settled epoch. Paid with completeRedeem once the claim is redeemed."
                  k="Your pending claim share (queue)"
                  v={fmtWadPercent(pendingWad)}
                  dense
                  className="border-danger/15!"
                />
                <Row
                  title="Your live shares' slice of what the claim still owes live shares. It comes back as NAV and, for strike USDG, through the harvest when the claim is redeemed."
                  k={<>Your live shares&apos; slice</>}
                  v={fmtWadPercent(liveShareWad)}
                  dense
                  className="border-danger/15!"
                />
                <Row
                  k="Collectable now (previewCompleteRedeem)"
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
            <Button size="sm" disabled={busy || !isConnected || !VAULT} onClick={retry}>
              {busy ? "Working…" : "Retry claim"}
            </Button>
            <span className="min-w-0 flex-1 basis-60 text-[12.5px] leading-snug text-ink-3">
              Anyone can send this. It reverts StillStranded while the cause persists and settles the claim the
              first time Valorem lets it through; nothing here needs the keeper.
            </span>
          </div>
        </>
      ) : null}
    </Notice>
  );
}
