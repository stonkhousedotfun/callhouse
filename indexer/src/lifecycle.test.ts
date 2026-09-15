/**
 * lib/lifecycle.ts: the pure decisions the handlers make about where an event came from and what
 * it means. The handlers themselves import `ponder:registry` and cannot be unit-tested
 * (vitest.config.ts); these are the choices they delegate, pinned against the contract's own
 * emission order (contracts/src/Vault.sol) and arithmetic.
 */
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  PHASE,
  capacity,
  closeStatus,
  endedListingStatus,
  entryStrandShare,
  harvestOrigin,
  optionIdAfterClose,
  recoveredStatus,
  settlementCycle,
  strandRecovery,
} from "../lib/lifecycle";

const WAD = 10n ** 18n;
const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

describe("harvestOrigin", () => {
  it("is the terminal harvest in the rollClose transaction while the phase is still Settling", () => {
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Settling }, null, tx(1))).toBe("rollClose");
  });

  it("a second Harvest in the rollClose tx after the phase returned to Idle is a checkpoint (multicall rollClose + deposit)", () => {
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Idle }, null, tx(1))).toBe("checkpoint");
  });

  it("a deposit's checkpoint mid-week, and a settleQueue's checkpoint while Idle, are checkpoints", () => {
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Listed }, null, tx(2))).toBe("checkpoint");
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Idle }, null, tx(3))).toBe("checkpoint");
    expect(harvestOrigin({ rollCloseTx: null, phase: PHASE.Idle }, null, tx(3))).toBe("checkpoint");
  });

  it("is the retry's harvest in the transaction StrandedClaimRecovered stamped on the last strand", () => {
    const strand = { recoveredTx: tx(9) };
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Idle }, strand, tx(9))).toBe("retry");
    // A strand recovered weeks ago does not make today's checkpoint a retry.
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Idle }, strand, tx(10))).toBe("checkpoint");
    // An unrecovered strand has no tx to match.
    expect(harvestOrigin({ rollCloseTx: tx(1), phase: PHASE.Idle }, { recoveredTx: null }, tx(9))).toBe("checkpoint");
  });

  it("compares transaction hashes case-insensitively", () => {
    const upper = tx(0xab).replace("ab", "AB") as Hex;
    expect(harvestOrigin({ rollCloseTx: tx(0xab), phase: PHASE.Settling }, null, upper)).toBe("rollClose");
  });
});

describe("closeStatus / recoveredStatus", () => {
  it("publishes the four verdicts, unfilled being the most likely", () => {
    expect(closeStatus({ stranded: false, sold: 0n, assigned: 0n })).toBe("unfilled");
    expect(closeStatus({ stranded: false, sold: 12n, assigned: 0n })).toBe("closed");
    expect(closeStatus({ stranded: false, sold: 12n, assigned: 5n })).toBe("assigned");
  });

  it("a stranded close is stranded whatever was sold or assigned; the verdict waits for the retry", () => {
    expect(closeStatus({ stranded: true, sold: 12n, assigned: 5n })).toBe("stranded");
    expect(closeStatus({ stranded: true, sold: 12n, assigned: 0n })).toBe("stranded");
    expect(recoveredStatus({ assigned: 5n })).toBe("assigned");
    expect(recoveredStatus({ assigned: 0n })).toBe("closed");
  });
});

describe("optionIdAfterClose (Vault.rollClose)", () => {
  it("forgets the armed type on an unfilled close, exactly as `optionId = 0` does on chain", () => {
    expect(optionIdAfterClose({ stranded: false, optionId: 3001n })).toBeNull();
  });

  it("a redeemed close already had it cleared by Vault:ClaimRedeemed; null stays null", () => {
    expect(optionIdAfterClose({ stranded: false, optionId: null })).toBeNull();
  });

  it("keeps it while the claim is stranded: retryStrandedClaim and lockedAssets() still need it", () => {
    expect(optionIdAfterClose({ stranded: true, optionId: 3001n })).toBe(3001n);
  });
});

describe("settlementCycle", () => {
  it("attributes a QueueSettled in the rollClose tx to the closing week", () => {
    expect(settlementCycle({ rollCloseTx: tx(1), cycleNumber: 7 }, tx(1))).toBe(7);
  });

  it("attributes a flat settleQueue() to no week at all", () => {
    expect(settlementCycle({ rollCloseTx: tx(1), cycleNumber: 7 }, tx(2))).toBeNull();
    expect(settlementCycle({ rollCloseTx: null, cycleNumber: 0 }, tx(2))).toBeNull();
  });
});

describe("entryStrandShare (Vault._settleEpochEntry)", () => {
  // An epoch of 10 shares that owns 0.4e18 of a stranded claim; two owners with 6 and 4 shares.
  const epoch = { sharesSettled: 10n * WAD, sharesClaimed: 0n, strandWad: 4n * 10n ** 17n, strandWadClaimed: 0n };

  it("gives the first claimant its pro-rata floor and the last claimant the rest", () => {
    const first = entryStrandShare(epoch, 6n * WAD);
    expect(first).toBe((4n * 10n ** 17n * 6n) / 10n); // 0.24e18
    const after = { ...epoch, sharesClaimed: 6n * WAD, strandWadClaimed: first };
    expect(entryStrandShare(after, 4n * WAD)).toBe(4n * 10n ** 17n - first); // exactly what is left
  });

  it("an epoch with no strand share, or a fully drawn one, gives nothing", () => {
    expect(entryStrandShare({ ...epoch, strandWad: 0n }, 6n * WAD)).toBe(0n);
    expect(entryStrandShare({ ...epoch, strandWadClaimed: epoch.strandWad }, 6n * WAD)).toBe(0n);
  });

  it("awkward amounts leave no WAD behind across three claimants", () => {
    let ep = { sharesSettled: 7n * WAD + 3n, sharesClaimed: 0n, strandWad: 123_456_789_012_345_678n, strandWadClaimed: 0n };
    let total = 0n;
    for (const shares of [2n * WAD + 1n, 3n * WAD, 2n * WAD + 2n]) {
      const mine = entryStrandShare(ep, shares);
      total += mine;
      ep = { ...ep, sharesClaimed: ep.sharesClaimed + shares, strandWadClaimed: ep.strandWadClaimed + mine };
    }
    expect(total).toBe(123_456_789_012_345_678n);
  });
});

describe("strandRecovery (Vault.retryStrandedClaim)", () => {
  it("splits both legs by the queue's WAD, floors, and hands the rest to live shares", () => {
    // 14 NVDA and 2025 USDG back; the queue owned 0.4 of the claim.
    const r = strandRecovery(14n * WAD, 2025_000000n, 4n * 10n ** 17n);
    expect(r.queueAssets).toBe(5_600000000000000000n);
    expect(r.queueUsdg).toBe(810_000000n);
    expect(r.liveAssets).toBe(8_400000000000000000n);
    expect(r.liveUsdg).toBe(1215_000000n);
    expect(r.queueUsdg + r.liveUsdg).toBe(2025_000000n);
  });

  it("with no epoch settled while stranded, everything is the live shares'", () => {
    const r = strandRecovery(23n * WAD, 0n, 0n);
    expect(r.queueAssets).toBe(0n);
    expect(r.liveAssets).toBe(23n * WAD);
    expect(r.liveUsdg).toBe(0n);
  });
});

describe("endedListingStatus", () => {
  it("keeps a partial fill as the better story", () => {
    expect(endedListingStatus(0n)).toBe("cancelled");
    expect(endedListingStatus(3n)).toBe("partially_filled");
  });
});

describe("capacity (Policy.maxContracts − contractsWritten)", () => {
  const launch = { maxUtilizationBps: 9500, maxContractsCap: 50n };

  it("is the utilisation bound in lots, less what is written", () => {
    // 25 NVDA at 95% = 23.75 → 23 contracts; 5 written → 18.
    expect(capacity(launch, 25n * WAD, 5n)).toBe(18n);
    expect(capacity(launch, 25n * WAD, 0n)).toBe(23n);
  });

  it("is the compiled cap when the book is large, and never negative", () => {
    expect(capacity(launch, 1000n * WAD, 0n)).toBe(50n);
    expect(capacity(launch, 1000n * WAD, 50n)).toBe(0n);
    expect(capacity(launch, 1n * WAD, 5n)).toBe(0n);
  });
});
