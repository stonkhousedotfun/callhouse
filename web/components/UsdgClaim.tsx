"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { fmtUsdg } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
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
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [busy, setBusy] = useState(false);

  const claimable = position.claimableUsdg ?? 0n;

  // The distributor's own index: USDG base units x 1e27 per share base unit, so / 1e9 is USDG base
  // units per one whole (1e18) share over the vault's entire life. Lifetime total / CURRENT supply
  // is wrong as soon as shares were burned (a settled queue) or minted after a distribution.
  // Includes strike proceeds; not a weekly figure and never presented as one.
  const lifetimePerShare =
    snapshot.accUsdgPerShare === undefined ? undefined : snapshot.accUsdgPerShare / 1_000_000_000n;

  async function claim() {
    if (!VAULT || !address) return;
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
          }),
        { pending: "Claiming USDG", success: "USDG claimed" },
      );
      if (hash) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">USDG</span>
        <span className="tiny faint mono">premium on filled weeks, strike proceeds on assigned weeks</span>
      </div>

      <div className="stat">
        <div className="stat-label">Claimable</div>
        <div className="stat-value">{fmtUsdg(claimable)} USDG</div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row" title="Everything credited to one share since launch: premium net of fees plus strike proceeds from assignment. Not a return.">
          <span className="k">Distributed to date, per {SHARE_TICKER}</span>
          <span className="v">{lifetimePerShare === undefined ? "—" : `${fmtUsdg(lifetimePerShare, 6)} USDG`}</span>
        </div>
        <div className="row">
          <span className="k">Vault total distributed</span>
          <span className="v">{fmtUsdg(snapshot.totalUsdgDistributed)} USDG</span>
        </div>
      </div>
      {/* The Distributor credits strike proceeds through the same index as premium, so these
          two figures include both. Said here so neither reads as earnings (W-21). */}
      <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>
        Includes strike proceeds from assigned weeks, which are returned collateral rather than
        premium.
      </p>

      <div style={{ marginTop: 14 }}>
        {!isConnected ? (
          <ConnectButton />
        ) : (
          <button
            data-variant={claimable > 0n ? "primary" : undefined}
            style={{ width: "100%" }}
            disabled={busy || claimable === 0n}
            onClick={claim}
          >
            {busy ? "Working…" : claimable === 0n ? "Nothing to claim" : `Claim ${fmtUsdg(claimable)} USDG`}
          </button>
        )}
      </div>
    </div>
  );
}
