/**
 * The chain fallback for /activity, fed the exact event sequence Vault.sol produces.
 *
 * WRITE ON FILL. `RollOpen.contractsCount` is always 0 and each Seaport fill emits one
 * `CallsWritten` from inside `authorizeOrder` with the contracts it sold, so a week's size is the
 * sum of its `CallsWritten` and written equals sold. A fold that read the size off RollOpen would
 * publish every week as "sold 0".
 *
 * `Harvest` is emitted from two places with the same cycle number: `_checkpointHarvest()` on
 * every deposit or mint that lands after premium has arrived, and `_harvest()` inside
 * rollClose, which always emits and carries gross 0 once the checkpoints have swept the balance.
 * The readiness audit found `foldVaultLogs` assigning instead of summing, so on a paying week
 * with one mid-week deposit the last Harvest — the zero — won, and the week rendered as
 * "unfilled, 0". These tests are that sequence, in the order the chain emits it: `RollClose`
 * is emitted immediately BEFORE the terminal `Harvest`, in the same transaction.
 *
 * Only `foldVaultLogs` is exercised. It is pure; the RPC scan and the block-timestamp lookups
 * around it are not unit-testable and are not pretended to be.
 */
import { describe, expect, it } from "vitest";

import { fmtRealizedWeek, fmtUsdg, premiumPerShare } from "./format";
import { foldVaultLogs, type LooseLog } from "./history";

const WAD = 10n ** 18n;

const tx = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const TX_OPEN = tx(1);
const TX_LIST = tx(2);
const TX_FILL_1 = tx(3);
const TX_FILL_2 = tx(4);
const TX_CLOSE = tx(5);
const TX_DEPOSIT = tx(7);
const ORDER_HASH = tx(0xabc);

/** uint32 cycleNumber decodes as a number under viem; the uint256 money fields as bigints. */
const CYCLE = 7;
const OPTION_ID = 99n;
const CLAIM_KEY = 100n;

/** Under write on fill the arm writes nothing: contractsCount is 0, always. */
const rollOpen: LooseLog = {
  eventName: "RollOpen",
  args: { cycleNumber: CYCLE, optionId: OPTION_ID, contractsCount: 0n, strikeUsdg: 190_000000n },
  blockNumber: 100n,
  transactionHash: TX_OPEN,
};

const listingApproved: LooseLog = {
  eventName: "ListingApproved",
  args: { orderHash: ORDER_HASH, optionId: OPTION_ID, amount: 12n, grossUsdg: 48_000000n, seq: 1 },
  blockNumber: 101n,
  transactionHash: TX_LIST,
};

/** One per fill, from inside authorizeOrder: the contracts that fill sold. */
const callsWritten = (n: bigint, hash: `0x${string}`, block: bigint): LooseLog => ({
  eventName: "CallsWritten",
  args: { optionId: OPTION_ID, claimKey: CLAIM_KEY, contractsCount: n, collateral: n * WAD },
  blockNumber: block,
  transactionHash: hash,
});

const rollClose = (assigned: bigint, sold = 12n): LooseLog => ({
  eventName: "RollClose",
  args: {
    cycleNumber: CYCLE,
    assetsReturned: (sold - assigned) * WAD,
    usdgFromAssignment: assigned * 190_000000n,
    contractsAssignedCount: assigned,
  },
  blockNumber: 200n,
  transactionHash: TX_CLOSE,
});

/**
 * A Harvest as Vault._accrueHarvest emits it: 5% protocol fee (launch protocolFeeBps 500) on
 * the PREMIUM only. `feeFree` is RollClose.usdgFromAssignment for the terminal harvest inside
 * rollClose and 0 for a deposit checkpoint; strike proceeds stay in the gross but are never fee'd.
 */
const harvest = (gross: bigint, hash: `0x${string}`, block: bigint, feeFree = 0n): LooseLog => {
  const fee = ((gross > feeFree ? gross - feeFree : 0n) * 500n) / 10_000n;
  return {
    eventName: "Harvest",
    args: { cycleNumber: CYCLE, grossUsdg: gross, feeUsdg: fee, netUsdg: gross - fee },
    blockNumber: block,
    transactionHash: hash,
  };
};

/** `_distributeUsdg` emits this inside the same call as its Harvest, with the supply it indexed against. */
const distributed = (net: bigint, supply: bigint, hash: `0x${string}`, block: bigint): LooseLog => ({
  eventName: "UsdgDistributed",
  args: { amount: net, accUsdgPerShare: 1n, totalSupply: supply },
  blockNumber: block,
  transactionHash: hash,
});

describe("foldVaultLogs", () => {
  it("sizes the week from CallsWritten per fill, not from RollOpen: written equals sold", () => {
    // Two fills: 7 contracts, then 5. The arm wrote nothing.
    const rows = foldVaultLogs([rollOpen, listingApproved, callsWritten(7n, TX_FILL_1, 150n), callsWritten(5n, TX_FILL_2, 160n)]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.contracts).toBe(12n);
    expect(row.contractsSold).toBe(12n);
    expect(row.filled).toBe(true);
    expect(row.settled).toBe(false);
    expect(row.optionId).toBe(OPTION_ID);
    expect(row.strikeUsdg).toBe(190_000000n);
    expect(row.orderHash).toBe(ORDER_HASH);
  });

  it("sums every Harvest of a week; the terminal zero does not erase the premium", () => {
    // A buyer fills 7 on Tuesday (28 USDG lands with the fill). A deposit on Wednesday checkpoints
    // it. Another fill (5 contracts, 20 USDG), another deposit, another checkpoint. rollClose on
    // Friday finds nothing left to sweep and emits Harvest(gross = 0) — the honest zero of the
    // terminal path.
    const TX_DEPOSIT_2 = tx(8);
    const rows = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(7n, TX_FILL_1, 150n),
      distributed(26_600000n, 100n * WAD, TX_DEPOSIT, 155n),
      harvest(28_000000n, TX_DEPOSIT, 155n),
      callsWritten(5n, TX_FILL_2, 160n),
      distributed(19_000000n, 120n * WAD, TX_DEPOSIT_2, 165n),
      harvest(20_000000n, TX_DEPOSIT_2, 165n),
      rollClose(0n),
      harvest(0n, TX_CLOSE, 200n),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.cycle).toBe(CYCLE);

    // The audit's failure mode, stated as the assertion.
    expect(row.filled).not.toBe(false);
    expect(row.filled).toBe(true);

    expect(row.harvestGrossUsdg).toBe(48_000000n);
    expect(row.feeUsdg).toBe(2_400000n);
    expect(row.creditedUsdg).toBe(45_600000n);
    // Not assigned: every USDG of it is premium.
    expect(row.strikeProceedsUsdg).toBe(0n);
    expect(row.premiumGrossUsdg).toBe(48_000000n);
    expect(row.premiumNetUsdg).toBe(45_600000n);
    expect(row.settled).toBe(true);
    expect(row.stranded).toBeUndefined();

    // The terminal Harvest had no UsdgDistributed; the denominator from the last sweep that
    // actually distributed survives, and it is the post-deposit supply.
    expect(row.sharesAtHarvest).toBe(120n * WAD);

    expect(row.contracts).toBe(12n);
    expect(row.contractsAssigned).toBe(0n);
    expect(row.txOpen).toBe(TX_OPEN);
    expect(row.txClose).toBe(TX_CLOSE);
    expect(row.openBlock).toBe(100n);
    expect(row.closeBlock).toBe(200n);
  });

  it("a week with no checkpoints and one terminal Harvest folds to that Harvest exactly", () => {
    const rows = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(12n, TX_FILL_1, 150n),
      rollClose(0n),
      distributed(45_600000n, 100n * WAD, TX_CLOSE, 200n),
      harvest(48_000000n, TX_CLOSE, 200n),
    ]);
    const row = rows[0]!;
    expect(row.filled).toBe(true);
    expect(row.contracts).toBe(12n);
    expect(row.harvestGrossUsdg).toBe(48_000000n);
    expect(row.feeUsdg).toBe(2_400000n);
    expect(row.creditedUsdg).toBe(45_600000n);
    // RollClose(0 assigned) shares this Harvest's tx: usdgFromAssignment is 0, so nothing is split off.
    expect(row.strikeProceedsUsdg).toBe(0n);
    expect(row.premiumNetUsdg).toBe(45_600000n);
    expect(row.sharesAtHarvest).toBe(100n * WAD);
    expect(row.settled).toBe(true);
  });

  it("an unfilled week is a full row of zeros: no CallsWritten, filled false, settled true", () => {
    // Nothing sold, so nothing was written and no checkpoint ever fired; rollClose still emits the
    // terminal zero. RollClose returns nothing (there was no claim).
    const rows = foldVaultLogs([rollOpen, listingApproved, rollClose(0n, 0n), harvest(0n, TX_CLOSE, 200n)]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.filled).toBe(false);
    expect(row.settled).toBe(true);
    expect(row.contracts).toBe(0n);
    expect(row.contractsSold).toBe(0n);
    expect(row.harvestGrossUsdg).toBe(0n);
    expect(row.feeUsdg).toBe(0n);
    expect(row.premiumNetUsdg).toBe(0n);
    expect(row.strikeProceedsUsdg).toBe(0n);
    expect(row.creditedUsdg).toBe(0n);
    expect(row.contractsAssigned).toBe(0n);
    // No UsdgDistributed fired, so there is no denominator; the page renders 0 per share from
    // the zero net without one (lib/format.ts usdgPerShare).
    expect(row.sharesAtHarvest).toBeUndefined();
  });

  it("an assigned week carries the assignment count from RollClose and splits the strike proceeds out", () => {
    const rows = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(12n, TX_FILL_1, 150n),
      distributed(43_320000n, 100n * WAD, TX_DEPOSIT, 155n),
      harvest(45_600000n, TX_DEPOSIT, 155n),
      rollClose(5n),
      // 5 × 190 USDG came back with the claim and is swept by the terminal harvest, fee-free:
      // rollClose passes RollClose.usdgFromAssignment to _harvest, so all 950 is credited.
      distributed(950_000000n, 100n * WAD, TX_CLOSE, 200n),
      harvest(950_000000n, TX_CLOSE, 200n, 950_000000n),
    ]);
    const row = rows[0]!;
    expect(row.filled).toBe(true);
    expect(row.settled).toBe(true);
    expect(row.contractsAssigned).toBe(5n);
    expect(row.harvestGrossUsdg).toBe(995_600000n);
    // 5% of the 45.6 premium only; the strike proceeds are never fee'd.
    expect(row.feeUsdg).toBe(2_280000n);
    expect(row.creditedUsdg).toBe(993_320000n);
    // Premium only: the checkpoint's 45.6 is premium; the terminal 950 is all strike proceeds
    // (RollClose.usdgFromAssignment in the same tx). 45.6 − 2.28 = 43.32.
    expect(row.strikeProceedsUsdg).toBe(950_000000n);
    expect(row.premiumGrossUsdg).toBe(45_600000n);
    expect(row.premiumNetUsdg).toBe(43_320000n);
  });

  it("fallback, assigned week: premium-only realized figures and a separate strike line, split within one close", () => {
    // A buyer fills 12 contracts at 4 USDG: 48 reaches the vault (one leg, no venue fee). No
    // deposit checkpoints it, so the whole 48 premium AND the 950 of strike proceeds arrive in
    // ONE terminal Harvest: the case where the split has to happen inside a single event.
    //   gross  = 48_000000 + 950_000000                            = 998_000000
    //   fee    = floor((998_000000 − 950_000000) × 500 / 10_000)   = 2_400000
    //   net    = 998_000000 − 2_400000                             = 995_600000
    //   strike = RollClose.usdgFromAssignment (same tx)            = 950_000000
    //   premiumGross = 998_000000 − 950_000000                     = 48_000000
    //   premiumNet   = 48_000000 − 2_400000                        = 45_600000
    //   per share    = 45_600000 × 1e18 / 100e18                   = 456_000  (0.456000 USDG)
    //   Net / TVL with 1_400 USDG of collateral: 45_600000 × 1e7 / 1_400_000000 = 325_714 → 3.257%
    const rows = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(12n, TX_FILL_1, 150n),
      rollClose(5n),
      distributed(995_600000n, 100n * WAD, TX_CLOSE, 200n),
      harvest(998_000000n, TX_CLOSE, 200n, 950_000000n),
    ]);
    const row = rows[0]!;
    expect(row.feeUsdg).toBe(2_400000n);
    expect(row.creditedUsdg).toBe(995_600000n);
    expect(row.strikeProceedsUsdg).toBe(950_000000n);
    expect(row.premiumGrossUsdg).toBe(48_000000n);
    expect(row.premiumNetUsdg).toBe(45_600000n);
    // The log fallback has no per-sweep figure; the page divides net premium by the supply.
    expect(row.premiumNetPerShare).toBeUndefined();
    expect(premiumPerShare(row)).toBe(456000n);
    expect(fmtUsdg(premiumPerShare(row), 6)).toBe("0.456000");
    expect(fmtRealizedWeek(row.premiumNetUsdg, 1_400_000000n)).toBe("3.257%");
    expect(fmtUsdg(row.strikeProceedsUsdg)).toBe("950.00");
  });

  it("a RollClose in another transaction never turns a checkpoint's premium into strike proceeds", () => {
    // The pairing is by transaction hash only. A checkpoint Harvest is premium even when the
    // week was assigned: its gross is 30, and it must stay 30 of premium.
    const rows = foldVaultLogs([
      rollOpen,
      callsWritten(12n, TX_FILL_1, 150n),
      distributed(28_500000n, 100n * WAD, TX_DEPOSIT, 155n),
      harvest(30_000000n, TX_DEPOSIT, 155n),
      rollClose(5n),
      harvest(950_000000n + 18_000000n, TX_CLOSE, 200n, 950_000000n),
    ]);
    const row = rows[0]!;
    // Checkpoint: 30 premium, fee 1.5, net premium 28.5. Terminal: 18 premium + 950 strike,
    // fee floor(18_000000 × 500 / 10_000) = 0.9, net premium 17.1. Week: 48 / 2.4 / 45.6.
    expect(row.strikeProceedsUsdg).toBe(950_000000n);
    expect(row.premiumGrossUsdg).toBe(48_000000n);
    expect(row.feeUsdg).toBe(2_400000n);
    expect(row.premiumNetUsdg).toBe(45_600000n);
    expect(row.creditedUsdg).toBe(995_600000n);
  });

  it("a checkpoint after rollClose does not restate a published unfilled week", () => {
    // rollClose does not clear `cycleNumber`, so a deposit between rollClose and the next
    // rollOpen fires `_checkpointHarvest()` under the closed week's number, sweeping whatever
    // USDG landed since (a stray transfer here: 7 USDG). Summing it onto the closed row would
    // flip a published "unfilled, 0" to "filled". The indexer drops it (`touchesCycle`); so
    // does the fold: after the close only the Harvest sharing rollClose's tx is accepted.
    const TX_LATE_DEPOSIT = tx(6);
    const rows = foldVaultLogs([
      rollOpen,
      rollClose(0n, 0n),
      harvest(0n, TX_CLOSE, 200n),
      distributed(6_650000n, 100n * WAD, TX_LATE_DEPOSIT, 250n),
      harvest(7_000000n, TX_LATE_DEPOSIT, 250n),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.settled).toBe(true);
    expect(row.filled).toBe(false);
    expect(row.harvestGrossUsdg).toBe(0n);
    expect(row.feeUsdg).toBe(0n);
    expect(row.premiumNetUsdg).toBe(0n);
    expect(row.creditedUsdg).toBe(0n);
    // The late sweep's supply must not become this week's denominator either.
    expect(row.sharesAtHarvest).toBeUndefined();
  });

  it("a CallsWritten after the close never restates a published week", () => {
    // Cannot happen under write on fill (a fill needs Listed), but a pre-redesign log range put
    // the opening write's CallsWritten before RollOpen while `currentCycle` still named the closed
    // week. The settled row refuses it.
    const rows = foldVaultLogs([rollOpen, rollClose(0n, 0n), harvest(0n, TX_CLOSE, 200n), callsWritten(9n, tx(22), 250n)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contracts).toBe(0n);
    expect(rows[0]!.filled).toBe(false);
  });

  it("a stranded close is closed and marked, premium only; the recovery Harvest later adds the strike proceeds", () => {
    // 12 sold, 5 assigned, then Valorem's redeem reverts at the close (USDG paused). RollClose
    // reports zero legs beside ClaimStranded; the terminal Harvest carries only the premium that
    // was in the balance. A week later retryStrandedClaim redeems: StrandedClaimRecovered and a
    // Harvest carrying THIS cycle's number, fee-free on the recovered USDG less the queue's slice.
    const TX_RETRY = tx(30);
    const strandedClose: LooseLog = {
      eventName: "RollClose",
      args: { cycleNumber: CYCLE, assetsReturned: 0n, usdgFromAssignment: 0n, contractsAssignedCount: 5n },
      blockNumber: 200n,
      transactionHash: TX_CLOSE,
    };
    const claimStranded: LooseLog = {
      eventName: "ClaimStranded",
      args: { cycleNumber: CYCLE, claimKey: CLAIM_KEY, gen: 1n },
      blockNumber: 200n,
      transactionHash: TX_CLOSE,
    };
    // The queue took 25% of the claim while stranded: the harvest sees 950 × 0.75 = 712.5 fee-free.
    const recovered: LooseLog = {
      eventName: "StrandedClaimRecovered",
      args: { gen: 1n, assets: 7n * WAD, usdgOut: 950_000000n, queueWad: WAD / 4n },
      blockNumber: 900n,
      transactionHash: TX_RETRY,
    };
    const rows = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(12n, TX_FILL_1, 150n),
      claimStranded,
      strandedClose,
      distributed(45_600000n, 100n * WAD, TX_CLOSE, 200n),
      harvest(48_000000n, TX_CLOSE, 200n),
      recovered,
      distributed(712_500000n, 100n * WAD, TX_RETRY, 900n),
      harvest(712_500000n, TX_RETRY, 900n, 712_500000n),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.stranded).toBe(true);
    expect(row.strandGen).toBe(1);
    expect(row.strandRecovered).toBe(true);
    expect(row.settled).toBe(true);
    expect(row.filled).toBe(true);
    expect(row.contracts).toBe(12n);
    expect(row.contractsAssigned).toBe(5n);
    // The close: 48 premium, 2.4 fee, 45.6 net. The retry: 712.5 of strike proceeds, no fee.
    expect(row.premiumGrossUsdg).toBe(48_000000n);
    expect(row.feeUsdg).toBe(2_400000n);
    expect(row.premiumNetUsdg).toBe(45_600000n);
    expect(row.strikeProceedsUsdg).toBe(712_500000n);
    expect(row.harvestGrossUsdg).toBe(760_500000n);
    expect(row.creditedUsdg).toBe(758_100000n);

    // Before the retry lands the same week is stranded and NOT recovered, with the premium alone.
    const waiting = foldVaultLogs([
      rollOpen,
      listingApproved,
      callsWritten(12n, TX_FILL_1, 150n),
      claimStranded,
      strandedClose,
      distributed(45_600000n, 100n * WAD, TX_CLOSE, 200n),
      harvest(48_000000n, TX_CLOSE, 200n),
    ])[0]!;
    expect(waiting.stranded).toBe(true);
    expect(waiting.strandGen).toBe(1);
    expect(waiting.strandRecovered).toBe(false);
    expect(waiting.settled).toBe(true);
    expect(waiting.strikeProceedsUsdg).toBe(0n);
    expect(waiting.harvestGrossUsdg).toBe(48_000000n);
    expect(waiting.premiumNetUsdg).toBe(45_600000n);
  });

  it("a week that never closed is open: no RollClose, no settled", () => {
    const rows = foldVaultLogs([rollOpen, listingApproved]);
    const row = rows[0]!;
    expect(row.settled).toBe(false);
    expect(row.filled).toBe(false);
    expect(row.contracts).toBe(0n);
    expect(row.harvestGrossUsdg).toBeUndefined();
    expect(row.premiumNetUsdg).toBeUndefined();
    expect(row.strikeProceedsUsdg).toBeUndefined();
    expect(row.txClose).toBeUndefined();
  });

  it("keeps cycles apart and ignores logs it does not fold", () => {
    const next = { ...rollOpen, args: { ...rollOpen.args, cycleNumber: CYCLE + 1 }, blockNumber: 300n, transactionHash: tx(9) };
    const rows = foldVaultLogs([
      rollOpen,
      { eventName: "Deposit", args: { assets: WAD }, blockNumber: 120n, transactionHash: tx(8) },
      rollClose(0n, 0n),
      harvest(0n, TX_CLOSE, 200n),
      next,
    ]);
    expect(rows.map((r) => r.cycle)).toEqual([CYCLE, CYCLE + 1]);
    expect(rows[0]!.settled).toBe(true);
    expect(rows[1]!.settled).toBe(false);
  });
});
