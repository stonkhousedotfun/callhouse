/**
 * The expectation builder on a hand-built fixture shaped like the three-week keeper dry run under
 * write on fill: 23 contracts a week at 0.873192 USDG per contract (20.083416 gross, ONE
 * consideration item, all of it to the vault), 5% of premium to the protocol, cycle 2 unfilled
 * with its listing invalidated at lockBook, cycle 3 assigned 9 at 225 with 10 of 25 shares queued.
 * The fixture is written out rather than recorded so every figure below can be checked by hand.
 */
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainCycle, ChainFacts, ChainListing } from "./chain.ts";
import { buildExpectations, capacityOf, isoOf, runBlocks, type RunJson } from "./expected.ts";

const LOT = 10n ** 18n;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const VAULT = addr(0xc0de);
const DEPOSITOR = addr(0xd1);
const ADMIN = addr(0xad);
const KEEPER = addr(0x4ee);
const FEE_SAFE = addr(0xfee);
const KEEPER_ROLE = "0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab" as Hex;

const TS = (block: bigint) => 1_790_000_000n + block;

/** 23 × 0.873192 = 20.083416 gross; fee = floor(20_083416 × 500 / 10_000) = 1_004170; net = 19_079246. */
const GROSS = 20_083416n;
const FEE = 1_004170n;
const NET = 19_079246n;

type Week = { n: 1 | 2 | 3; strike: bigint; filled: boolean; assigned: bigint; gross: bigint; fee: bigint; net: bigint; assetsReturned: bigint; strikeProceeds: bigint; acc: bigint };
const WEEKS: Week[] = [
  { n: 1, strike: 226_000000n, filled: true, assigned: 0n, gross: GROSS, fee: FEE, net: NET, assetsReturned: 23n * LOT, strikeProceeds: 0n, acc: 763169840000000n },
  // Unfilled: nothing written, so nothing to return.
  { n: 2, strike: 225_000000n, filled: false, assigned: 0n, gross: 0n, fee: 0n, net: 0n, assetsReturned: 0n, strikeProceeds: 0n, acc: 763169840000000n },
  // 9 assigned at 225: 2025 of strike proceeds on top of the premium; gross 2045.083416, fee on the premium only.
  { n: 3, strike: 225_000000n, filled: true, assigned: 9n, gross: GROSS + 2025_000000n, fee: FEE, net: NET + 2025_000000n, assetsReturned: 14n * LOT, strikeProceeds: 2025_000000n, acc: 82526339680000000n },
];
/** Block layout per week: open 11n, approve 12n, fill 13n, lock 14n, close 15n (+ 10 per week). */
const B = (w: Week, k: number) => BigInt(100 + w.n * 10 + k);

function fixture(): { run: RunJson; chain: ChainFacts } {
  const cycles: ChainCycle[] = WEEKS.map((w) => ({
    cycleNumber: w.n,
    open: { txHash: hash(w.n * 100 + 11), block: B(w, 1), timestamp: TS(B(w, 1)), optionId: BigInt(w.n * 1000 + 1), strike: w.strike, exerciseTs: 1_800_000_000n + BigInt(w.n), expiryTs: 1_800_086_400n + BigInt(w.n) },
    // One fill, one write, in the fill's own transaction.
    writes: w.filled ? [{ txHash: hash(w.n * 100 + 13), timestamp: TS(B(w, 3)), claimKey: BigInt(w.n * 1000 + 2), contracts: 23n, collateral: 23n * LOT }] : [],
    locked: { txHash: hash(w.n * 100 + 14), timestamp: TS(B(w, 4)) },
    close: { txHash: hash(w.n * 100 + 15), block: B(w, 5), timestamp: TS(B(w, 5)), assetsReturned: w.assetsReturned, usdgFromAssignment: w.strikeProceeds, contractsAssignedCount: w.assigned },
    stranded: null,
    accAfterClose: w.acc,
    supplyBeforeClose: 25n * LOT,
    distributedSupply: w.net === 0n ? null : 25n * LOT,
    bucketIndex: w.filled ? 0n : null,
    bucketAssigned: w.assigned,
    marketExercised: w.assigned,
  }));

  const listings: ChainListing[] = WEEKS.map((w) => ({
    orderHash: hash(w.n * 100 + 99),
    optionId: BigInt(w.n * 1000 + 1),
    amount: 23n,
    grossUsdg: GROSS,
    seq: 1,
    approvedTx: hash(w.n * 100 + 12),
    approvedBlock: B(w, 2),
    approvedTimestamp: TS(B(w, 2)),
    fills: w.filled ? [{ txHash: hash(w.n * 100 + 13), timestamp: TS(B(w, 3)), contracts: 23n, toVault: GROSS }] : [],
    cancelled: w.filled ? null : { txHash: hash(w.n * 100 + 14), timestamp: TS(B(w, 4)), reason: "lockBook" },
  }));

  const settings = { feeRecipient: FEE_SAFE, depositCap: 50n * LOT, maxPriceAge: 345600, protocolFeeBps: 500, maxUtilizationBps: 9500, maxContractsCap: 50n };

  const chain: ChainFacts = {
    rpc: "http://127.0.0.1:8547",
    chainId: 4663,
    startBlock: 100n,
    endBlock: 140n,
    vault: VAULT,
    depositor: DEPOSITOR,
    immutables: { asset: addr(0xa55e7), usdg: addr(0x05d6), clear: addr(0xc1ea), seaport: addr(0x5ea) },
    settings,
    cycles,
    harvests: WEEKS.map((w) => ({ cycleNumber: w.n, txHash: hash(w.n * 100 + 15), block: B(w, 5), timestamp: TS(B(w, 5)), gross: w.gross, fee: w.fee, net: w.net })),
    listings,
    strands: [],
    queue: {
      redeems: [{ owner: DEPOSITOR, shares: 10n * LOT, epochId: 1n }],
      settled: [{ epochId: 1n, shares: 10n * LOT, assets: 6_400000000000000000n, usdgOut: 817_631698n, txHash: hash(315), timestamp: TS(135n) }],
      entries: [{ owner: DEPOSITOR, epochId: 1n, shares: 10n * LOT, assets: 6_400000000000000000n, usdgOut: 817_631698n }],
      completes: [{ owner: DEPOSITOR, shares: 10n * LOT, assets: 6_400000000000000000n, usdgOut: 817_631698n }],
    },
    deposits: [{ owner: DEPOSITOR, assets: 25n * LOT, shares: 25n * LOT, timestamp: TS(101n) }],
    claims: [
      { account: DEPOSITOR, amount: NET },
      { account: DEPOSITOR, amount: 1226_447547n },
    ],
    feeSwept: 2n * FEE,
    usdgDistributed: 2063_158492n,
    roles: [
      { role: hash(0), account: ADMIN, granted: true },
      { role: KEEPER_ROLE, account: KEEPER, granted: true },
    ],
    lastVaultActivityBlock: 140n,
    lastVaultActivityTimestamp: TS(140n),
    endBlockTimestamp: TS(140n),
    depositorFirstSeen: TS(101n),
    depositorLastActivity: TS(140n),
    views: {
      phase: 0,
      cycleNumber: 3,
      writesHalted: false,
      canRedeemInstantly: true,
      valoremFeeAccepted: false,
      totalAssets: 9_600000000000000000n,
      idleAssets: 9_600000000000000000n,
      lockedAssets: 0n,
      reservedAssets: 0n,
      totalSupply: 15n * LOT,
      maxDepositZero: 40_400000000000000000n,
      uiMultiplier: 1_000775159164630595n,
      spotUsdg: 230_000000n,
      listingHash: hash(0),
      listingAmount: 0n,
      listingGrossUsdg: 0n,
      listingsThisCycle: 1,
      queuedShares: 0n,
      usdgReservedForQueue: 0n,
      usdgUnallocated: 0n,
      accUsdgPerShare: 82526339680000000n,
      totalUsdgDistributed: 2063_158492n,
      totalUsdgClaimed: 2063_158491n,
      epochId: 2n,
      contractsAssigned: 0n,
      contractsWritten: 0n,
      optionId: 0n,
      claimKey: 0n,
      cycleStrikeUsdg: 225_000000n,
      cycleExerciseTs: 1_800_000_003n,
      cycleExpiryTs: 1_800_086_403n,
      isStranded: false,
      strandGen: 0n,
      lastResolvedGen: 0n,
      strandedRemainingWad: 0n,
      pendingFeeUsdg: 0n,
      usdgBalance: 1n,
      assetBalance: 9_600000000000000000n,
      seaportCounter: 42n,
      oraclePaused: false,
    },
    account: { shares: 15n * LOT, sharesAsAssets: 9_600000000000000000n, claimableUsdg: 0n, queuedShares: 0n, queuedEpoch: 0n, previewAssets: 0n, previewUsdg: 0n, owedStrandWad: 0n, owedStrandGen: 0n },
  };

  const cycleRecord = (w: Week): Record<string, unknown> => ({
    optionId: String(w.n * 1000 + 1),
    exerciseTimestamp: 1_800_000_000 + w.n,
    expiryTimestamp: 1_800_086_400 + w.n,
    contracts: w.filled ? "23" : "0",
    strikeUsdg6: w.strike.toString(),
    orderHash: hash(w.n * 100 + 99),
    rollCloseTx: hash(w.n * 100 + 15),
    ...(w.filled ? { gross6: GROSS.toString() } : {}),
    harvest: { gross: w.gross.toString(), fee: w.fee.toString(), net: w.net.toString(), ...(w.n === 1 ? { depositorReceived: NET.toString() } : {}) },
  });

  const run: RunJson = {
    forkBlock: "99",
    chainId: 4663,
    error: null,
    actors: { keeper: KEEPER, admin: ADMIN, feeSafe: FEE_SAFE, depositor: DEPOSITOR, buyer: addr(0xb0) },
    addresses: { Vault: VAULT },
    cycle1: cycleRecord(WEEKS[0]!),
    cycle2: cycleRecord(WEEKS[1]!),
    cycle3: {
      ...cycleRecord(WEEKS[2]!),
      claimKey: "3002",
      contractsExercised: "9",
      harvest: { gross: (GROSS + 2025_000000n).toString(), fee: FEE.toString(), net: (NET + 2025_000000n).toString(), premium: GROSS.toString(), usdgFromAssignment: "2025000000", assetsReturned: "14000000000000000000", contractsAssigned: 9 },
      queue: { sharesQueued: "10000000000000000000", epoch: "1", payoutAssets: "6400000000000000000", escrowUsdg: "817631698", assetsOut: "6400000000000000000", usdgOut: "817631698" },
      claimed: "1226447547",
      usdgLeftInVault: { remainder: "1" },
      final: { totalSupply: "15000000000000000000", idleAssets: "9600000000000000000", depositorShares: "15000000000000000000" },
    },
    harnessTxs: [
      { label: "deploy Vault", by: ADMIN, hash: hash(2), block: "104" },
      { label: "vault.claimUsdg (depositor)", by: DEPOSITOR, hash: hash(3), block: "140" },
    ],
    db: {
      cycles: WEEKS.map((w) => ({
        cycle_number: w.n,
        option_id: String(w.n * 1000 + 1),
        strike_usdg6: w.strike.toString(),
        contracts: w.filled ? 23 : 0,
        status: "closed",
        roll_open_tx: hash(w.n * 100 + 11),
        lock_tx: hash(w.n * 100 + 14),
        roll_close_tx: hash(w.n * 100 + 15),
        gross_usdg6: w.gross.toString(),
        fee_usdg6: w.fee.toString(),
        net_usdg6: w.net.toString(),
        contracts_assigned: Number(w.assigned),
        assets_returned: w.assetsReturned.toString(),
        usdg_from_assignment: w.strikeProceeds.toString(),
      })),
      listings: WEEKS.map((w) => ({
        order_hash: hash(w.n * 100 + 99),
        cycle_number: w.n,
        seq: 1,
        option_id: String(w.n * 1000 + 1),
        contracts: "23",
        unit_price6: "873192",
        gross_usdg6: GROSS.toString(),
        status: w.filled ? "filled" : "cancelled",
        approve_tx: hash(w.n * 100 + 12),
      })),
      txs: [{ hash: hash(3), block_number: 140 }],
    },
  };
  return { run, chain };
}

const expectedAt = (built: ReturnType<typeof buildExpectations>, route: string, path: string) => {
  const found = built.expectations.filter((e) => e.route === route && e.path === path);
  expect(found, `${route} ${path}`).toHaveLength(1);
  return found[0]!.expected;
};

describe("buildExpectations on the dry run's three weeks", () => {
  it("finds run.json and the chain in agreement", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toEqual([]);
    expect(built.crossChecks).toBeGreaterThan(100);
  });

  it("publishes the assigned week's premium and strike proceeds apart (W-21), and its one write", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const r = "GET /v1/cycles/3";
    expect(expectedAt(built, r, "cycle.status")).toBe("assigned");
    expect(expectedAt(built, r, "cycle.written.contracts")).toBe("23");
    expect(expectedAt(built, r, "cycle.written.writeCount")).toBe(1);
    expect(expectedAt(built, r, "cycle.written.claimKey")).toBe("3002");
    expect(expectedAt(built, r, "cycle.written.firstWriteAt")).toBe(isoOf(TS(133n)));
    expect(expectedAt(built, r, "cycle.fill.contractsSold")).toBe("23");
    expect(expectedAt(built, r, "cycle.fill.premiumGross.raw")).toBe("20083416");
    expect(expectedAt(built, r, "cycle.harvest.grossUsdg.raw")).toBe("2045083416");
    expect(expectedAt(built, r, "cycle.harvest.premiumGross.raw")).toBe("20083416");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.raw")).toBe("2025000000");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.formatted")).toBe("2025");
    expect(expectedAt(built, r, "cycle.harvest.fee.raw")).toBe("1004170");
    expect(expectedAt(built, r, "cycle.harvest.premiumNet.raw")).toBe("19079246");
    expect(expectedAt(built, r, "cycle.harvest.creditedUsdg.raw")).toBe("2044079246");
    // Per whole share over the 25e18 supply before the close (the escrowed 10e18 still counts).
    expect(expectedAt(built, r, "cycle.harvest.premiumNetPerShare.raw")).toBe("763169");
    expect(expectedAt(built, r, "cycle.harvest.usdgPerShare.raw")).toBe("81763169");
    expect(expectedAt(built, r, "cycle.settlement.contractsAssigned")).toBe("9");
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe("14000000000000000000");
    expect(expectedAt(built, r, "cycle.settlement.bucketIndex")).toBe("0");
    expect(expectedAt(built, r, "cycle.settlement.bucketAssigned")).toBe("9");
    expect(expectedAt(built, r, "cycle.settlement.strand")).toBeNull();
    expect(expectedAt(built, r, "cycle.option.exerciseTimestamp")).toBe("1800000003");
    expect(expectedAt(built, r, "harvests[0].origin")).toBe("rollClose");
  });

  it("publishes the unfilled week as a row of zeros with nothing written, its listing ended by lockBook", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const r = "GET /v1/cycles/2";
    expect(expectedAt(built, r, "cycle.status")).toBe("unfilled");
    expect(expectedAt(built, r, "cycle.fill.contractsSold")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.contracts")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.claimKey")).toBeNull();
    expect(expectedAt(built, r, "cycle.written.collateral.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.premiumNet.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.txOpen")).toBe(hash(211));
    expect(expectedAt(built, r, "listings[0].status")).toBe("cancelled");
    expect(expectedAt(built, r, "listings[0].endReason")).toBe("lockBook");
    expect(expectedAt(built, r, "listings[0].endedTx")).toBe(hash(214));
  });

  it("pins the queued redeem, the depositor, the lifetime sums and the capacity", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items.length")).toBe(2);
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[0].status")).toBe("settled");
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[0].cycleNumber")).toBe(3);
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[0].assetsSettled")).toBe("6400000000000000000");
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[0].usdgSettled")).toBe("817631698");
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[0].strandGen")).toBeNull();
    expect(expectedAt(built, "POST /graphql", "data.queueEpochs.items[1].status")).toBe("open");
    const acct = `GET /v1/account/${DEPOSITOR}`;
    expect(expectedAt(built, acct, "lifetime.claimedUsdg.raw")).toBe("1245526793");
    expect(expectedAt(built, acct, "lifetime.redeemedAssets.raw")).toBe("6400000000000000000");
    expect(expectedAt(built, acct, "lifetime.redeemedUsdg.formatted")).toBe("817.631698");
    expect(expectedAt(built, acct, "position.claimableUsdg.raw")).toBe("0");
    expect(expectedAt(built, acct, "strand")).toBeNull();
    const v = "GET /v1/vault";
    expect(expectedAt(built, v, "lifetime.premiumGross.raw")).toBe("40166832");
    expect(expectedAt(built, v, "lifetime.premiumNet.raw")).toBe("38158492");
    expect(expectedAt(built, v, "lifetime.strikeProceedsUsdg.raw")).toBe("2025000000");
    expect(expectedAt(built, v, "lifetime.creditedUsdg.raw")).toBe("2063158492");
    expect(expectedAt(built, v, "lifetime.protocolFee.raw")).toBe("2008340");
    expect(expectedAt(built, v, "lifetime.cyclesArmed")).toBe(3);
    expect(expectedAt(built, v, "usdg.claimed.raw")).toBe("2063158491");
    expect(expectedAt(built, v, "usdg.protocolFeeBps")).toBe(500);
    expect(expectedAt(built, v, "usdg.feeRecipient")).toBe(FEE_SAFE.toLowerCase());
    expect(expectedAt(built, v, "stranded.stranded")).toBe(false);
    expect(expectedAt(built, v, "queue.canSettle")).toBe(false);
    expect(expectedAt(built, v, "week.listing.hash")).toBeNull();
    // 9.6 NVDA at 95% utilisation = 9.12 lots → 9 contracts, nothing written: capacity 9.
    expect(expectedAt(built, v, "week.assignmentLive.capacity")).toBe("9");
    expect(expectedAt(built, v, "week.option.optionId")).toBe("3001");
    expect(expectedAt(built, v, "lastClosedCycle.cycle")).toBe(3);
    expect(expectedAt(built, "GET /v1/strands", "count")).toBe(0);
  });

  it("reports a run.json figure the chain contradicts instead of choosing one", () => {
    const { run, chain } = fixture();
    chain.harvests[2] = { ...chain.harvests[2]!, net: 2044_079245n };
    chain.queue.settled[0] = { ...chain.queue.settled[0]!, usdgOut: 817_631699n };
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toEqual([
      "cycle 3 Harvest.netUsdg: run.json says 2044079246, the chain says 2044079245",
      "cycle 3 queue USDG: run.json says 817631698, the chain says 817631699",
    ]);
  });

  it("reports a write that does not match its fill: written must equal sold, per fill", () => {
    const { run, chain } = fixture();
    chain.cycles[0]!.writes[0] = { ...chain.cycles[0]!.writes[0]!, contracts: 22n, collateral: 22n * LOT };
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toContain("cycle 1 contracts sold = sum of CallsWritten: run.json says 23, the chain says 22");
    expect(built.disagreements).toContain("cycle 1 contracts sold (Seaport) = written (CallsWritten): run.json says 23, the chain says 22");
  });

  it("refuses a dry run that did not finish", () => {
    const { run, chain } = fixture();
    delete (run.cycle3 as Record<string, unknown>).queue;
    expect(() => buildExpectations(run, chain)).toThrow(/run\.json has no cycle3\.queue/);
  });
});

describe("helpers", () => {
  it("runBlocks reads the vault's deploy block and the last block any transaction landed in", () => {
    expect(runBlocks(fixture().run)).toEqual({ vaultDeployBlock: 104n, lastBlock: 140n });
  });

  it("isoOf mirrors the API: 0 and null are null", () => {
    expect(isoOf(0n)).toBeNull();
    expect(isoOf(null)).toBeNull();
    expect(isoOf(1790028181n)).toBe("2026-09-21T22:03:01.000Z");
  });

  it("capacityOf is Policy.maxContracts(totalAssets) less what is written, floored at zero", () => {
    const p = { maxUtilizationBps: 9500, maxContractsCap: 50n };
    expect(capacityOf(p, 25n * LOT, 0n)).toBe(23n);
    expect(capacityOf(p, 25n * LOT, 23n)).toBe(0n);
    expect(capacityOf(p, 1000n * LOT, 10n)).toBe(40n);
  });
});
