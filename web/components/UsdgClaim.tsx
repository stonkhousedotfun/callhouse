"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { CHAIN_ID } from "@/lib/chain";
import { SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { fmtUsdg } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { Button, Card, CardHead, CardMeta, CardTitle, Row, Rows, Stat, Unit } from "@/components/ui";
import { ConnectButton } from "./ConnectButton";
import { useTxRunner } from "./TxToast";

/**
 * Claim harvested USDG.
 *
 * USDG is never folded into the share price. Premium accrues as `accUsdgPerShare` and is pulled
 * with `claimUsdg()`, so the cNVDA price is a pure Stock Token number and the USDG is a separate,
 * visible balance. A week with no buyer adds exactly nothing here, and that is the point: if this
 * figure does not move, no premium was earned. The converse does not hold: on an assigned week
 * the strike proceeds are credited through the same index, so a move here is not all premium.
 *
 * The per-share index is also what keeps a mid-week deposit honest: `deposit` runs
 * `_checkpointHarvest()` BEFORE minting, folding everything earned so far into the index, so a
 * depositor arriving on Thursday starts from the current index and cannot claim premium earned
 * on Tuesday. The claimable figure below is the vault's own `claimableUsdg` view, not an
 * estimate computed here.
 */
export function UsdgClaim({
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
  const [busy, setBusy] = useState(false);

  // W8-450. The wallet's chain is read from useAccount and compared with the ONE source of truth the rest
  // of the app uses, `CHAIN_ID` from @/lib/chain -- the same pair AccountView.tsx reads. Nothing here switches
  // the wallet's network; a wrong network refuses the action and says so.
  const wrongNetwork = isConnected && chainId !== CHAIN_ID;

  const claimable = position.claimableUsdg ?? 0n;

  // The distributor's own index: USDG base units x 1e27 per share base unit, so / 1e9 is USDG base
  // units per one whole (1e18) share over the vault's entire life. Lifetime total / CURRENT supply
  // is wrong as soon as shares were burned (a settled queue) or minted after a distribution.
  // Includes strike proceeds; not a weekly figure and never presented as one.
  const lifetimePerShare =
    snapshot.accUsdgPerShare === undefined ? undefined : snapshot.accUsdgPerShare / 1_000_000_000n;

  async function claim() {
    // Refused here as well as in the render branch: the button is not the only way into this function.
    if (!VAULT || !address || wrongNetwork) return;
    const vault = VAULT;
    setBusy(true);
    try {
      const hash = await run(
        () =>
          writeContractAsync({
            address: vault,
            abi: vaultAbi as unknown as Abi,
            functionName: "claimUsdg",
            args: [],
            // W8-450. Without this @wagmi/core 3.6.5 keys its chain assertion off `!!chainId` and submits to
            // whatever network the wallet is on. This is a live vault action.
            chainId: CHAIN_ID,
          }),
        { pending: "Claiming USDG", success: "USDG claimed" },
      );
      if (hash) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead>
        <CardTitle>USDG</CardTitle>
        <CardMeta className="font-body! tracking-normal!">premium on filled weeks, strike proceeds on assigned weeks</CardMeta>
      </CardHead>

      <Stat
        size="lg"
        tone="usdg"
        className="rounded-md bg-usdg-soft p-4 sm:p-5"
        label="Claimable"
        value={fmtUsdg(claimable)}
        unit="USDG"
      />

      <Rows className="mt-3">
        <Row
          title="Everything credited to one share since launch: premium net of fees plus strike proceeds from assignment. Not a return."
          k={<>Distributed to date, per {SHARE_TICKER}</>}
          v={
            lifetimePerShare === undefined ? (
              "—"
            ) : (
              <>
                {fmtUsdg(lifetimePerShare, 6)} <Unit>USDG</Unit>
              </>
            )
          }
        />
        <Row
          k="Vault total distributed"
          v={
            <>
              {fmtUsdg(snapshot.totalUsdgDistributed)} <Unit>USDG</Unit>
            </>
          }
        />
      </Rows>
      {/* The Distributor credits strike proceeds through the same index as premium, so these
          two figures include both. Said here so neither reads as earnings (W-21). */}
      <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-3">
        Includes strike proceeds from assigned weeks, which are returned collateral rather than
        premium.
      </p>

      <div className="mt-5">
        {!isConnected ? (
          <ConnectButton block />
        ) : wrongNetwork ? (
          <p className="text-[13px] text-ink-2">Switch to Robinhood Chain to claim.</p>
        ) : (
          <Button
            variant={claimable > 0n ? "primary" : "ghost"}
            className="w-full"
            disabled={busy || claimable === 0n}
            onClick={claim}
          >
            {busy ? "Working…" : claimable === 0n ? "Nothing to claim" : `Claim ${fmtUsdg(claimable)} USDG`}
          </Button>
        )}
      </div>
    </Card>
  );
}
