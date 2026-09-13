"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { SHARE_TICKER, VAULT, vaultAbi } from "@/lib/contracts";
import { fmtUsdg, usdgPerShare } from "@/lib/format";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { ConnectButton } from "./ConnectButton";
import { useTxRunner } from "./TxToast";

/**
 * Claim harvested USDG.
 *
 * USDG is never folded into the share price. Premium accrues as `accUsdgPerShare` and is pulled
 * with `claimUsdg()`, so the cNVDA price is a pure Stock Token number and the USDG is a separate,
 * visible balance. A week with no buyer adds exactly nothing here, and that is the point: if this
 * figure does not move, no premium was earned.
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

  // accUsdgPerShare is scaled by 1e18 against 18-decimal shares, so this is USDG per one whole
  // share over the vault's entire life — not a weekly figure and never presented as one.
  const lifetimePerShare = usdgPerShare(snapshot.totalUsdgDistributed, snapshot.totalSupply);

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
        <span className="tiny faint mono">paid only on filled weeks</span>
      </div>

      <div className="stat">
        <div className="stat-label">Claimable</div>
        <div className="stat-value">{fmtUsdg(claimable)} USDG</div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span className="k">Distributed to date, per {SHARE_TICKER}</span>
          <span className="v">{lifetimePerShare === undefined ? "—" : `${fmtUsdg(lifetimePerShare, 6)} USDG`}</span>
        </div>
        <div className="row">
          <span className="k">Vault total distributed</span>
          <span className="v">{fmtUsdg(snapshot.totalUsdgDistributed)} USDG</span>
        </div>
      </div>

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
