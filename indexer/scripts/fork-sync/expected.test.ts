/**
 * The expectation builder on a hand-built fixture shaped like the three-week keeper dry run under
 * write on fill. One depositor, 25 NVDA in at block 105, listings at 0.873192 USDG per contract,
 * 5% of premium to the protocol, one transaction per block (anvil):
 *
 *   cycle 1  unfilled. Listed 23, nobody bought, the listing invalidated at lockBook, a zero
 *            harvest against 25 shares.
 *   cycle 2  assigned. Listed 23; buyer A took 2 (1.746384), a 5 NVDA deposit while Listed
 *            checkpointed that premium against 25 shares, buyer B took 3 (2.619576); the
 *            depositor queued 10 shares; 2 exercised; the close redeemed 3 lots and 450 of
 *            strike USDG, harvested 452.619576 against 30 shares (fee on the 2.619576 only),
 *            settled the epoch, and the depositor collected and claimed.
 *   cycle 3  stranded, then recovered. Listed 20; buyer A took 4 (3.492768); the depositor queued
 *            4 shares; 1 exercised; USDG frozen, so the close stranded the claim (generation 1),
 *            harvested the 3.492768 of premium against 20 shares and gave the settling epoch 0.2
 *            of the claim; unfrozen, the retry redeemed 3 lots and 225 of strike USDG, 0.2 of
 *            each to the queue, the live 180 through a fee-free harvest against 16 shares; the
 *            depositor collected the epoch (its 0.6 NVDA + 45 USDG share included) and claimed.
 *
 * The fixture is written out rather than recorded so every figure below can be checked by hand.
 * Figures the builder merely copies from a log (a queue payout, an index value) are declared;
 * figures it derives (sums, splits, per-share, statuses) are asserted against hand arithmetic.
 */
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainCycle, ChainFacts, ChainHarvest, ChainListing, ChainStrand } from "./chain.ts";
import { buildExpectations, capacityOf, epochStrandDrawdown, isoOf, runBlocks, type RunJson } from "./expected.ts";

const LOT = 10n ** 18n;
const WAD = 10n ** 18n;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const VAULT = addr(0xc0de);
const DEPOSITOR = addr(0xd1);
const ADMIN = addr(0xad);
const KEEPER = addr(0x4ee);
const FEE_SAFE = addr(0xfee);
const KEEPER_ROLE = "0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab" as Hex;

/** One transaction per block: a block number names its transaction. */
const TS = (block: bigint) => 1_790_000_000n + block;
const at = (block: number) => ({ txHash: hash(block), block: BigInt(block), timestamp: TS(BigInt(block)) });

const UNIT = 873192n;

function fixture(): { run: RunJson; chain: ChainFacts } {
  const cycles: ChainCycle[] = [
    {
      cycleNumber: 1,
      open: { ...at(111), optionId: 1001n, strike: 226_000000n, exerciseTs: 1_800_000_001n, expiryTs: 1_800_086_401n },
      writes: [],
      locked: { txHash: hash(114), timestamp: TS(114n) },
      close: { ...at(115), assetsReturned: 0n, usdgFromAssignment: 0n, contractsAssignedCount: 0n },
      stranded: null,
      redeemed: null,
      bucketIndex: null,
      bucketAssigned: 0n,
      marketExercised: 0n,
    },
    {
      cycleNumber: 2,
      open: { ...at(121), optionId: 2001n, strike: 225_000000n, exerciseTs: 1_800_000_002n, expiryTs: 1_800_086_402n },
      writes: [
        { ...at(123), claimKey: 2002n, contracts: 2n, collateral: 2n * LOT },
        { ...at(125), claimKey: 2002n, contracts: 3n, collateral: 3n * LOT },
      ],
      locked: { txHash: hash(128), timestamp: TS(128n) },
      close: { ...at(129), assetsReturned: 3n * LOT, usdgFromAssignment: 450_000000n, contractsAssignedCount: 2n },
      stranded: null,
      redeemed: { ...at(129), underlyingReturned: 3n * LOT, exerciseReceived: 450_000000n },
      bucketIndex: 0n,
      bucketAssigned: 2n,
      marketExercised: 2n,
    },
    {
      cycleNumber: 3,
      open: { ...at(141), optionId: 3001n, strike: 225_000000n, exerciseTs: 1_800_000_003n, expiryTs: 1_800_086_403n },
      writes: [{ ...at(143), claimKey: 3002n, contracts: 4n, collateral: 4n * LOT }],
      locked: { txHash: hash(146), timestamp: TS(146n) },
      close: { ...at(147), assetsReturned: 0n, usdgFromAssignment: 0n, contractsAssignedCount: 1n },
      stranded: { gen: 1n, claimKey: 3002n, txHash: hash(147) },
      redeemed: { ...at(148), underlyingReturned: 3n * LOT, exerciseReceived: 225_000000n },
      bucketIndex: 0n,
      bucketAssigned: 1n,
      marketExercised: 1n,
    },
  ];

  /**
   * By hand. Cycle 2's checkpoint: fee = floor(1_746384 × 500 / 10_000) = 87319, net 1_659065,
   * index +1_659065e27 / 25e18 = 66_362_600_000_000. Its terminal: gross 2_619576 + 450_000000,
   * fee = floor(2_619576 × 500 / 10_000) = 130978, net 452_488598, index +15_082_953_266_666_666.
   * Cycle 3's terminal: fee = floor(3_492768 × 500 / 10_000) = 174638, net 3_318130, index
   * +165_906_500_000_000. Its retry: 225 back, 0.2 to the queue (45), the live 180 fee-free,
   * index +180_000000e27 / 16e18 = 11_250_000_000_000_000.
   */
  const harvests: ChainHarvest[] = [
    { cycleNumber: 1, ...at(115), gross: 0n, fee: 0n, net: 0n, origin: "rollClose", supply: 25n * LOT, supplyFromLog: false, supplyBefore: 25n * LOT, accAfter: 0n },
    { cycleNumber: 2, ...at(124), gross: 1_746384n, fee: 87319n, net: 1_659065n, origin: "checkpoint", supply: 25n * LOT, supplyFromLog: true, supplyBefore: 25n * LOT, accAfter: 66_362_600_000_000n },
    { cycleNumber: 2, ...at(129), gross: 452_619576n, fee: 130978n, net: 452_488598n, origin: "rollClose", supply: 30n * LOT, supplyFromLog: true, supplyBefore: 30n * LOT, accAfter: 15_149_315_866_666_666n },
    { cycleNumber: 3, ...at(147), gross: 3_492768n, fee: 174638n, net: 3_318130n, origin: "rollClose", supply: 20n * LOT, supplyFromLog: true, supplyBefore: 20n * LOT, accAfter: 15_315_222_366_666_666n },
    { cycleNumber: 3, ...at(148), gross: 180_000000n, fee: 0n, net: 180_000000n, origin: "retry", supply: 16n * LOT, supplyFromLog: true, supplyBefore: 16n * LOT, accAfter: 26_565_222_366_666_666n },
  ];

  const listing = (n: number, approveBlock: number, amount: bigint, fills: ChainListing["fills"], cancelBlock: number): ChainListing => ({
    orderHash: hash(1000 + n),
    optionId: BigInt(n * 1000 + 1),
    amount,
    grossUsdg: amount * UNIT,
    seq: 1,
    approvedTx: hash(approveBlock),
    approvedBlock: BigInt(approveBlock),
    approvedTimestamp: TS(BigInt(approveBlock)),
    fills,
    cancelled: { txHash: hash(cancelBlock), timestamp: TS(BigInt(cancelBlock)), reason: "lockBook" },
  });
  const listings: ChainListing[] = [
    listing(1, 112, 23n, [], 114),
    listing(2, 122, 23n, [{ ...at(123), contracts: 2n, toVault: 2n * UNIT }, { ...at(125), contracts: 3n, toVault: 3n * UNIT }], 128),
    listing(3, 142, 20n, [{ ...at(143), contracts: 4n, toVault: 4n * UNIT }], 146),
  ];

  const strands: ChainStrand[] = [
    {
      gen: 1n,
      cycleNumber: 3,
      claimKey: 3002n,
      strandedTx: hash(147),
      strandedBlock: 147n,
      strandedTimestamp: TS(147n),
      // The 4-share epoch settled at the stranded close took 4 / 20 of the claim.
      epochShares: [{ epochId: 2n, wad: 2n * 10n ** 17n }],
      recovered: { ...at(148), assets: 3n * LOT, usdgOut: 225_000000n, queueWad: 2n * 10n ** 17n },
      // The depositor was the epoch's only entry, so it took the whole 0.2: 0.6 NVDA and 45 USDG.
      shareSettlements: [{ owner: DEPOSITOR, wad: 2n * 10n ** 17n, assets: 6n * 10n ** 17n, usdgOut: 45_000000n }],
    },
  ];

  const settings = { feeRecipient: FEE_SAFE, depositCap: 50n * LOT, maxPriceAge: 345600, protocolFeeBps: 500, maxUtilizationBps: 9500, maxContractsCap: 50n };

  const chain: ChainFacts = {
    rpc: "http://127.0.0.1:8547",
    chainId: 4663,
    startBlock: 104n,
    endBlock: 150n,
    vault: VAULT,
    depositor: DEPOSITOR,
    immutables: { asset: addr(0xa55e7), usdg: addr(0x05d6), clear: addr(0xc1ea), seaport: addr(0x5ea) },
    settings,
    cycles,
    harvests,
    listings,
    strands,
    queue: {
      redeems: [
        { owner: DEPOSITOR, shares: 10n * LOT, epochId: 1n, block: 126n },
        { owner: DEPOSITOR, shares: 4n * LOT, epochId: 2n, block: 144n },
      ],
      settled: [
        { epochId: 1n, shares: 10n * LOT, assets: 9_333333333333333333n, usdgOut: 150_829532n, ...at(129) },
        { epochId: 2n, shares: 4n * LOT, assets: 2_933333333333333333n, usdgOut: 663626n, ...at(147) },
      ],
      entries: [
        { owner: DEPOSITOR, epochId: 1n, shares: 10n * LOT, assets: 9_333333333333333333n, usdgOut: 150_829532n, block: 130n },
        { owner: DEPOSITOR, epochId: 2n, shares: 4n * LOT, assets: 2_933333333333333333n, usdgOut: 663626n, block: 149n },
      ],
      completes: [
        { owner: DEPOSITOR, receiver: DEPOSITOR, shares: 10n * LOT, assets: 9_333333333333333333n, usdgOut: 150_829532n, block: 130n },
        // The epoch's 2.9333 NVDA + 0.663626 USDG plus the recovered strand share's 0.6 NVDA + 45 USDG.
        { owner: DEPOSITOR, receiver: DEPOSITOR, shares: 4n * LOT, assets: 3_533333333333333333n, usdgOut: 45_663626n, block: 149n },
      ],
      deferred: [],
      haircuts: [],
    },
    deposits: [
      { owner: DEPOSITOR, assets: 25n * LOT, shares: 25n * LOT, timestamp: TS(105n) },
      { owner: DEPOSITOR, assets: 5n * LOT, shares: 5n * LOT, timestamp: TS(124n) },
    ],
    withdraws: [],
    // 25 × 66362.6 + 20 × 15_082_953.27 = 1_659065 + 301_659065 after cycle 2; 16 × 11_415_906.5 after cycle 3.
    claims: [
      { account: DEPOSITOR, amount: 303_318130n },
      { account: DEPOSITOR, amount: 182_654504n },
    ],
    // 87319 + 130978 pushed at cycle 2's close; 174638 could not move under the freeze and was
    // pushed by the retry's harvest.
    feeSwept: 218297n + 174638n,
    usdgDistributed: 1_659065n + 452_488598n + 3_318130n + 180_000000n,
    roles: [
      { role: hash(0), account: ADMIN, granted: true },
      { role: KEEPER_ROLE, account: KEEPER, granted: true },
    ],
    lastVaultActivityBlock: 150n,
    lastVaultActivityTimestamp: TS(150n),
    endBlockTimestamp: TS(150n),
    depositorFirstSeen: TS(105n),
    depositorLastActivity: TS(150n),
    views: {
      phase: 0,
      cycleNumber: 3,
      writesHalted: false,
      canRedeemInstantly: true,
      valoremFeeAccepted: false,
      clearFeesEnabled: false,
      totalAssets: 14_133333333333333334n,
      idleAssets: 14_133333333333333334n,
      lockedAssets: 0n,
      reservedAssets: 0n,
      totalSupply: 16n * LOT,
      maxDepositZero: 35_866666666666666666n,
      uiMultiplier: 1_000775159164630595n,
      spotUsdg: 230_000000n,
      listingHash: hash(0),
      listingAmount: 0n,
      listingGrossUsdg: 0n,
      listingsThisCycle: 1,
      queuedShares: 0n,
      usdgReservedForQueue: 0n,
      usdgUnallocated: 0n,
      accUsdgPerShare: 26_565_222_366_666_666n,
      totalUsdgDistributed: 637_465793n,
      // Two claims plus the two escrow takes; one base unit of dust behind the distributed total.
      totalUsdgClaimed: 303_318130n + 182_654504n + 150_829532n + 663626n,
      epochId: 3n,
      contractsAssigned: 0n,
      contractsWritten: 0n,
      optionId: 0n,
      claimKey: 0n,
      cycleStrikeUsdg: 225_000000n,
      cycleExerciseTs: 1_800_000_003n,
      cycleExpiryTs: 1_800_086_403n,
      isStranded: false,
      strandGen: 1n,
      lastResolvedGen: 1n,
      strandedRemainingWad: 0n,
      pendingFeeUsdg: 0n,
      usdgBalance: 1n,
      assetBalance: 14_133333333333333334n,
      // Three lockBooks over a live listing, one counter bump each.
      seaportCounter: 3n,
      oraclePaused: false,
    },
    account: {
      shares: 16n * LOT,
      sharesAsAssets: 14_133333333333333334n,
      claimableUsdg: 0n,
      queuedShares: 0n,
      queuedEpoch: 0n,
      previewAssets: 0n,
      previewUsdg: 0n,
      owedStrandWad: 0n,
      owedStrandGen: 0n,
    },
  };

  const run: RunJson = {
    forkBlock: "99",
    chainId: 4663,
    error: null,
    actors: { admin: ADMIN, keeper: KEEPER, guardian: addr(0x6a), depositor: DEPOSITOR, buyerA: addr(0xb0a), buyerB: addr(0xb0b) },
    addresses: { Vault: VAULT, Clear: addr(0xc1ea) },
    blocks: { vaultDeployBlock: "104", lastBlock: "150" },
    cycles: [
      {
        cycleNumber: 1,
        optionId: "1001",
        strikeUsdg6: "226000000",
        exerciseTimestamp: 1_800_000_001,
        expiryTimestamp: 1_800_086_401,
        rollOpenTx: hash(111),
        lockTx: hash(114),
        rollCloseTx: hash(115),
        fills: [],
        contractsAssigned: 0,
        harvest: { gross: "0", fee: "0", net: "0" },
        stranded: false,
        retryTx: null,
        assetsReturned: "0",
        usdgFromAssignment: "0",
      },
      {
        cycleNumber: 2,
        optionId: "2001",
        strikeUsdg6: "225000000",
        exerciseTimestamp: "1800000002",
        expiryTimestamp: "1800086402",
        rollOpenTx: hash(121),
        lockTx: hash(128),
        rollCloseTx: hash(129),
        fills: [
          { txHash: hash(123), contracts: 2, grossUsdg6: "1746384" },
          { txHash: hash(125), contracts: "3", grossUsdg6: 2619576 },
        ],
        contractsAssigned: "2",
        harvest: { gross: "452619576", fee: "130978", net: "452488598" },
        stranded: false,
        retryTx: null,
        assetsReturned: "3000000000000000000",
        usdgFromAssignment: "450000000",
      },
      {
        cycleNumber: 3,
        optionId: "3001",
        strikeUsdg6: "225000000",
        exerciseTimestamp: "1800000003",
        expiryTimestamp: "1800086403",
        rollOpenTx: hash(141),
        lockTx: hash(146),
        rollCloseTx: hash(147),
        fills: [{ txHash: hash(143), contracts: 4, grossUsdg6: "3492768" }],
        contractsAssigned: 1,
        harvest: { gross: "3492768", fee: "174638", net: "3318130" },
        stranded: true,
        retryTx: hash(148),
        assetsReturned: "3000000000000000000",
        usdgFromAssignment: "225000000",
      },
    ],
  };
  return { run, chain };
}

/** The same run cut off at the stranded close: the retry, the collection and the last claim never happened. */
function stillStranded(): { run: RunJson; chain: ChainFacts } {
  const { run, chain } = fixture();
  chain.endBlock = 147n;
  chain.endBlockTimestamp = TS(147n);
  chain.lastVaultActivityBlock = 147n;
  chain.lastVaultActivityTimestamp = TS(147n);
  chain.depositorLastActivity = TS(144n);
  chain.harvests = chain.harvests.filter((h) => h.block <= 147n);
  chain.cycles[2]!.redeemed = null;
  chain.strands[0]!.recovered = null;
  chain.strands[0]!.shareSettlements = [];
  chain.queue.entries = chain.queue.entries.filter((e) => e.block <= 147n);
  chain.queue.completes = chain.queue.completes.filter((c) => c.block <= 147n);
  chain.claims = chain.claims.slice(0, 1);
  chain.feeSwept = 218297n;
  chain.usdgDistributed = 1_659065n + 452_488598n + 3_318130n;
  chain.views = {
    ...chain.views,
    // 14.6667 idle less the 2.9333 reserved, plus 0.8 of the 3 lots still in the claim.
    totalAssets: 14_133333333333333334n,
    idleAssets: 11_733333333333333334n,
    lockedAssets: 3n * LOT,
    reservedAssets: 2_933333333333333333n,
    maxDepositZero: 0n,
    usdgReservedForQueue: 663626n,
    accUsdgPerShare: 15_315_222_366_666_666n,
    totalUsdgDistributed: 1_659065n + 452_488598n + 3_318130n,
    totalUsdgClaimed: 303_318130n + 150_829532n + 663626n,
    contractsAssigned: 1n,
    contractsWritten: 4n,
    optionId: 3001n,
    claimKey: 3002n,
    isStranded: true,
    strandGen: 1n,
    lastResolvedGen: 0n,
    strandedRemainingWad: 8n * 10n ** 17n,
    pendingFeeUsdg: 174638n,
    usdgBalance: 174639n,
    assetBalance: 14_666666666666666667n,
  };
  chain.account = {
    shares: 16n * LOT,
    sharesAsAssets: 11_733333333333333334n,
    claimableUsdg: 0n,
    queuedShares: 4n * LOT,
    queuedEpoch: 2n,
    previewAssets: 2_933333333333333333n,
    previewUsdg: 663626n,
    owedStrandWad: 0n,
    owedStrandGen: 0n,
  };
  run.blocks.lastBlock = "147";
  const c3 = run.cycles[2]!;
  c3.retryTx = null;
  c3.assetsReturned = "0";
  c3.usdgFromAssignment = "0";
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
    expect(built.crossChecks).toBeGreaterThan(60);
    expect(built.weeks.map((w) => w.status)).toEqual(["unfilled", "assigned", "assigned"]);
  });

  it("publishes the unfilled week as a row of zeros with nothing written, its listing ended by lockBook", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const r = "GET /v1/cycles/1";
    expect(expectedAt(built, r, "cycle.status")).toBe("unfilled");
    expect(expectedAt(built, r, "cycle.stranded")).toBe(false);
    expect(expectedAt(built, r, "cycle.fill.contractsSold")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.contracts")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.claimKey")).toBeNull();
    expect(expectedAt(built, r, "cycle.written.collateral.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.written.txOpen")).toBe(hash(111));
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.premiumNet.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.supplyAtHarvest.raw")).toBe((25n * LOT).toString());
    expect(expectedAt(built, r, "cycle.settlement.strand")).toBeNull();
    expect(expectedAt(built, r, "listings.length")).toBe(1);
    expect(expectedAt(built, r, "listings[0].status")).toBe("cancelled");
    expect(expectedAt(built, r, "listings[0].endReason")).toBe("lockBook");
    expect(expectedAt(built, r, "listings[0].endedTx")).toBe(hash(114));
    expect(expectedAt(built, r, "harvests.length")).toBe(1);
    expect(expectedAt(built, r, "strands.length")).toBe(0);
  });

  it("publishes the assigned week from two fills and two harvests: written == sold per fill, premium and strike proceeds apart (W-21)", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const r = "GET /v1/cycles/2";
    expect(expectedAt(built, r, "cycle.status")).toBe("assigned");
    expect(expectedAt(built, r, "cycle.written.contracts")).toBe("5");
    expect(expectedAt(built, r, "cycle.written.writeCount")).toBe(2);
    expect(expectedAt(built, r, "cycle.written.claimKey")).toBe("2002");
    expect(expectedAt(built, r, "cycle.written.firstWriteAt")).toBe(isoOf(TS(123n)));
    expect(expectedAt(built, r, "cycle.written.lastWriteAt")).toBe(isoOf(TS(125n)));
    expect(expectedAt(built, r, "cycle.fill.contractsSold")).toBe("5");
    expect(expectedAt(built, r, "cycle.fill.fillCount")).toBe(2);
    // 2 × 0.873192 + 3 × 0.873192 = 4.365960, and the unit price recovers exactly.
    expect(expectedAt(built, r, "cycle.fill.premiumGross.raw")).toBe("4365960");
    expect(expectedAt(built, r, "cycle.fill.unitPriceUsdg.raw")).toBe("873192");
    expect(expectedAt(built, r, "cycle.listing.count")).toBe(1);
    expect(expectedAt(built, r, "cycle.listing.orderHash")).toBe(hash(1002));
    // The checkpoint (1.746384 against 25 shares) plus the terminal (2.619576 + 450 against 30).
    expect(expectedAt(built, r, "cycle.harvest.grossUsdg.raw")).toBe("454365960");
    expect(expectedAt(built, r, "cycle.harvest.premiumGross.raw")).toBe("4365960");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, r, "cycle.harvest.fee.raw")).toBe("218297"); // 87319 + 130978
    expect(expectedAt(built, r, "cycle.harvest.premiumNet.raw")).toBe("4147663"); // 1659065 + 2488598
    expect(expectedAt(built, r, "cycle.harvest.creditedUsdg.raw")).toBe("454147663");
    // Per share, summed per sweep: 1659065 / 25 → 66362, plus 2488598 / 30 → 82953.
    expect(expectedAt(built, r, "cycle.harvest.premiumNetPerShare.raw")).toBe("149315");
    // 66362 + floor(452488598 / 30) = 66362 + 15082953.
    expect(expectedAt(built, r, "cycle.harvest.usdgPerShare.raw")).toBe("15149315");
    expect(expectedAt(built, r, "cycle.harvest.supplyAtHarvest.raw")).toBe((30n * LOT).toString());
    expect(expectedAt(built, r, "cycle.harvest.harvestedAt")).toBe(isoOf(TS(129n)));
    expect(expectedAt(built, r, "cycle.settlement.contractsAssigned")).toBe("2");
    expect(expectedAt(built, r, "cycle.settlement.assignmentUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe((3n * LOT).toString());
    expect(expectedAt(built, r, "cycle.settlement.bucketAssigned")).toBe("2");
    expect(expectedAt(built, r, "cycle.settlement.strand")).toBeNull();
    // Sized to capacity, 5 of 23 taken, the rest invalidated at lockBook: a partial fill is the story.
    expect(expectedAt(built, r, "listings[0].status")).toBe("partially_filled");
    expect(expectedAt(built, r, "listings[0].endReason")).toBe("lockBook");
    expect(expectedAt(built, r, "listings[0].fill.contractsFilled")).toBe("5");
    expect(expectedAt(built, r, "listings[0].fill.fillCount")).toBe(2);
    expect(expectedAt(built, r, "listings[0].fill.lastFillTx")).toBe(hash(125));
    // Newest first: the terminal harvest, then the checkpoint that saw only the first fill.
    expect(expectedAt(built, r, "harvests.length")).toBe(2);
    expect(expectedAt(built, r, "harvests[0].origin")).toBe("rollClose");
    expect(expectedAt(built, r, "harvests[0].terminal")).toBe(true);
    expect(expectedAt(built, r, "harvests[0].contractsAssigned")).toBe("2");
    expect(expectedAt(built, r, "harvests[0].assignmentUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, r, "harvests[0].strikeProceedsUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, r, "harvests[1].origin")).toBe("checkpoint");
    expect(expectedAt(built, r, "harvests[1].terminal")).toBe(false);
    expect(expectedAt(built, r, "harvests[1].filled")).toBe(true);
    expect(expectedAt(built, r, "harvests[1].contractsSold")).toBe("2");
    expect(expectedAt(built, r, "harvests[1].contractsAssigned")).toBe("0");
    expect(expectedAt(built, r, "harvests[1].assignmentUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "harvests[1].premiumNetPerShare.raw")).toBe("66362");
    expect(expectedAt(built, r, "harvests[1].supply.raw")).toBe((25n * LOT).toString());
  });

  it("publishes the stranded-then-recovered week: the retry's legs, the fee-free retry harvest, the strand drained", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const r = "GET /v1/cycles/3";
    expect(expectedAt(built, r, "cycle.status")).toBe("assigned");
    expect(expectedAt(built, r, "cycle.stranded")).toBe(true);
    expect(expectedAt(built, r, "cycle.settlement.strand.gen")).toBe("1");
    expect(expectedAt(built, r, "cycle.settlement.strand.recovered")).toBe(true);
    expect(expectedAt(built, r, "cycle.settlement.strand.recoveredAt")).toBe(isoOf(TS(148n)));
    expect(expectedAt(built, r, "cycle.settlement.strand.recoveredTx")).toBe(hash(148));
    // The close reported zero legs; the retry's ClaimRedeemed supplies the real ones.
    expect(expectedAt(built, r, "cycle.settlement.contractsAssigned")).toBe("1");
    expect(expectedAt(built, r, "cycle.settlement.assignmentUsdg.raw")).toBe("225000000");
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe((3n * LOT).toString());
    // 3.492768 of premium at the close (fee 174638) plus the live shares' 180 through the retry.
    expect(expectedAt(built, r, "cycle.harvest.grossUsdg.raw")).toBe("183492768");
    expect(expectedAt(built, r, "cycle.harvest.premiumGross.raw")).toBe("3492768");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.raw")).toBe("180000000");
    expect(expectedAt(built, r, "cycle.harvest.fee.raw")).toBe("174638");
    expect(expectedAt(built, r, "cycle.harvest.premiumNet.raw")).toBe("3318130");
    expect(expectedAt(built, r, "cycle.harvest.creditedUsdg.raw")).toBe("183318130");
    // 3318130 / 20 → 165906 at the close; 180000000 / 16 = 11250000 at the retry.
    expect(expectedAt(built, r, "cycle.harvest.premiumNetPerShare.raw")).toBe("165906");
    expect(expectedAt(built, r, "cycle.harvest.usdgPerShare.raw")).toBe("11415906");
    expect(expectedAt(built, r, "cycle.harvest.supplyAtHarvest.raw")).toBe((16n * LOT).toString());
    expect(expectedAt(built, r, "cycle.harvest.harvestedAt")).toBe(isoOf(TS(147n)));
    expect(expectedAt(built, r, "harvests.length")).toBe(2);
    expect(expectedAt(built, r, "harvests[0].origin")).toBe("retry");
    expect(expectedAt(built, r, "harvests[0].terminal")).toBe(false);
    expect(expectedAt(built, r, "harvests[0].premiumGross.raw")).toBe("0");
    expect(expectedAt(built, r, "harvests[0].strikeProceedsUsdg.raw")).toBe("180000000");
    expect(expectedAt(built, r, "harvests[0].assignmentUsdg.raw")).toBe("225000000");
    expect(expectedAt(built, r, "harvests[0].contractsSold")).toBe("4");
    expect(expectedAt(built, r, "harvests[1].origin")).toBe("rollClose");
    expect(expectedAt(built, r, "harvests[1].strikeProceedsUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "harvests[1].assignmentUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "harvests[1].contractsAssigned")).toBe("1");
    expect(expectedAt(built, r, "strands.length")).toBe(1);
    expect(expectedAt(built, r, "strands[0].gen")).toBe("1");
    expect(expectedAt(built, r, "strands[0].claimKey")).toBe("3002");
    expect(expectedAt(built, r, "strands[0].epochWad")).toBe("200000000000000000");
    expect(expectedAt(built, r, "strands[0].epochCount")).toBe(1);
    expect(expectedAt(built, r, "strands[0].queueWad")).toBe("200000000000000000");
    expect(expectedAt(built, r, "strands[0].assetsIn.raw")).toBe((3n * LOT).toString());
    expect(expectedAt(built, r, "strands[0].usdgIn.raw")).toBe("225000000");
    // The depositor's entry took the whole queue share: nothing left of the 0.6 NVDA / 45 USDG.
    expect(expectedAt(built, r, "strands[0].wadLeft")).toBe("0");
    expect(expectedAt(built, r, "strands[0].assetsLeft.raw")).toBe("0");
    expect(expectedAt(built, r, "strands[0].usdgLeft.raw")).toBe("0");
    expect(expectedAt(built, r, "strands[0].settledCount")).toBe(1);
  });

  it("pins the vault, the tape, the strands, the depositor and the queue epochs", () => {
    const { run, chain } = fixture();
    const built = buildExpectations(run, chain);
    const v = "GET /v1/vault";
    expect(expectedAt(built, v, "lifetime.premiumGross.raw")).toBe("7858728"); // 4365960 + 3492768
    expect(expectedAt(built, v, "lifetime.protocolFee.raw")).toBe("392935"); // 218297 + 174638
    expect(expectedAt(built, v, "lifetime.premiumNet.raw")).toBe("7465793"); // 4147663 + 3318130
    expect(expectedAt(built, v, "lifetime.strikeProceedsUsdg.raw")).toBe("630000000"); // 450 + the live 180
    expect(expectedAt(built, v, "lifetime.creditedUsdg.raw")).toBe("637465793");
    // The whole strike USDG the claims returned, the queue's 45 included: above the harvested 630.
    expect(expectedAt(built, v, "lifetime.assignmentUsdg.raw")).toBe("675000000");
    expect(expectedAt(built, v, "lifetime.cyclesArmed")).toBe(3);
    expect(expectedAt(built, v, "lifetime.cyclesFilled")).toBe(2);
    expect(expectedAt(built, v, "lifetime.cyclesUnfilled")).toBe(1);
    expect(expectedAt(built, v, "lifetime.cyclesAssigned")).toBe(2);
    expect(expectedAt(built, v, "lifetime.cyclesStranded")).toBe(1);
    expect(expectedAt(built, v, "stranded.stranded")).toBe(false);
    expect(expectedAt(built, v, "stranded.gen")).toBe("1");
    expect(expectedAt(built, v, "stranded.lastResolvedGen")).toBe("1");
    expect(expectedAt(built, v, "stranded.cycle")).toBeNull();
    expect(expectedAt(built, v, "stranded.claimKey")).toBeNull();
    expect(expectedAt(built, v, "stranded.lockedAssets")).toBeNull();
    expect(expectedAt(built, v, "phase.clearFeesEnabled")).toBe(false);
    expect(expectedAt(built, v, "queue.canSettle")).toBe(false);
    expect(expectedAt(built, v, "queue.epochId")).toBe("3");
    expect(expectedAt(built, v, "usdg.claimed.raw")).toBe("637465792");
    expect(expectedAt(built, v, "usdg.feeRecipient")).toBe(FEE_SAFE.toLowerCase());
    expect(expectedAt(built, v, "week.cycle.cycle")).toBe(3);
    expect(expectedAt(built, v, "week.option.optionId")).toBe("3001");
    expect(expectedAt(built, v, "week.option.claimKey")).toBe("3002");
    expect(expectedAt(built, v, "week.listing.hash")).toBeNull();
    // 14.1333 NVDA at 95% = 13.43 lots → 13 contracts, nothing written.
    expect(expectedAt(built, v, "week.assignmentLive.capacity")).toBe("13");
    // X-3: the last TERMINAL harvest is cycle 3's close, not the retry that came after it.
    expect(expectedAt(built, v, "lastHarvest.origin")).toBe("rollClose");
    expect(expectedAt(built, v, "lastHarvest.txHash")).toBe(hash(147));
    expect(expectedAt(built, v, "lastHarvest.grossUsdg.raw")).toBe("3492768");
    expect(expectedAt(built, v, "lastClosedCycle.cycle")).toBe(3);

    expect(expectedAt(built, "GET /v1/cycles", "count")).toBe(3);
    expect(expectedAt(built, "GET /v1/cycles", "totals.stranded")).toBe(1);
    expect(expectedAt(built, "GET /v1/cycles", "cycles[0].cycle")).toBe(3);
    expect(expectedAt(built, "GET /v1/activity", "count")).toBe(3);
    expect(expectedAt(built, "GET /v1/activity", "harvests[0].txHash")).toBe(hash(147));
    expect(expectedAt(built, "GET /v1/activity?include=all", "count")).toBe(5);
    expect(expectedAt(built, "GET /v1/activity?include=all", "harvests[0].origin")).toBe("retry");
    expect(expectedAt(built, "GET /v1/activity?include=all", "harvests[3].origin")).toBe("checkpoint");
    expect(expectedAt(built, "GET /v1/listings", "count")).toBe(3);
    expect(expectedAt(built, "GET /v1/listings", "listings[0].orderHash")).toBe(hash(1003));
    expect(expectedAt(built, "GET /v1/strands", "count")).toBe(1);
    expect(expectedAt(built, "GET /v1/strands", "stranded")).toBe(false);
    expect(expectedAt(built, "GET /v1/strands", "strands[0].recovered")).toBe(true);

    const acct = `GET /v1/account/${DEPOSITOR}`;
    expect(expectedAt(built, acct, "lifetime.deposited.raw")).toBe((30n * LOT).toString());
    expect(expectedAt(built, acct, "lifetime.depositCount")).toBe(2);
    expect(expectedAt(built, acct, "lifetime.redeemedAssets.raw")).toBe("12866666666666666666");
    expect(expectedAt(built, acct, "lifetime.redeemedUsdg.raw")).toBe("196493158");
    expect(expectedAt(built, acct, "lifetime.claimedUsdg.raw")).toBe("485972634");
    expect(expectedAt(built, acct, "lifetime.withdrawn.raw")).toBe("0");
    expect(expectedAt(built, acct, "queue.epochId")).toBe("0");
    expect(expectedAt(built, acct, "queue.settled")).toBe(false);
    expect(expectedAt(built, acct, "queue.claimable")).toBe(false);
    expect(expectedAt(built, acct, "queue.deferredUsdg.raw")).toBe("0");
    expect(expectedAt(built, acct, "strand")).toBeNull();

    const g = "POST /graphql";
    expect(expectedAt(built, g, "data.queueEpochs.items.length")).toBe(3);
    expect(expectedAt(built, g, "data.queueEpochs.items[0].status")).toBe("settled");
    expect(expectedAt(built, g, "data.queueEpochs.items[0].cycleNumber")).toBe(2);
    expect(expectedAt(built, g, "data.queueEpochs.items[0].strandGen")).toBeNull();
    expect(expectedAt(built, g, "data.queueEpochs.items[0].sharesClaimed")).toBe((10n * LOT).toString());
    expect(expectedAt(built, g, "data.queueEpochs.items[1].cycleNumber")).toBe(3);
    expect(expectedAt(built, g, "data.queueEpochs.items[1].strandGen")).toBe("1");
    expect(expectedAt(built, g, "data.queueEpochs.items[1].strandWad")).toBe("200000000000000000");
    expect(expectedAt(built, g, "data.queueEpochs.items[1].strandWadClaimed")).toBe("200000000000000000");
    expect(expectedAt(built, g, "data.queueEpochs.items[1].assetsSettled")).toBe("2933333333333333333");
    expect(expectedAt(built, g, "data.queueEpochs.items[2].status")).toBe("open");
    expect(expectedAt(built, g, "data.queueEpochs.items[2].cycleNumber")).toBeNull();
    expect(expectedAt(built, g, "data.vaultState.cyclesStranded")).toBe(1);
    expect(expectedAt(built, g, "data.vaultState.stranded")).toBe(false);
    expect(expectedAt(built, g, "data.vaultState.strandedCycleNumber")).toBeNull();
    expect(expectedAt(built, g, "data.vaultState.optionId")).toBeNull();
    expect(expectedAt(built, g, "data.vaultState.claimKey")).toBeNull();
    expect(expectedAt(built, g, "data.vaultState.lockedCollateral")).toBe("0");
    expect(expectedAt(built, g, "data.vaultState.totalFeeSwept")).toBe("392935");
    expect(expectedAt(built, g, "data.vaultState.lifetimeAssignmentUsdg")).toBe("675000000");
  });

  it("a run cut off at the stranded close publishes the week as stranded and the depositor's pending share", () => {
    const { run, chain } = stillStranded();
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toEqual([]);
    const r = "GET /v1/cycles/3";
    expect(expectedAt(built, r, "cycle.status")).toBe("stranded");
    expect(expectedAt(built, r, "cycle.settlement.strand.recovered")).toBe(false);
    expect(expectedAt(built, r, "cycle.settlement.strand.recoveredTx")).toBeNull();
    expect(expectedAt(built, r, "cycle.settlement.assignmentUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.settlement.assetsReturned.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.strikeProceedsUsdg.raw")).toBe("0");
    expect(expectedAt(built, r, "cycle.harvest.supplyAtHarvest.raw")).toBe((20n * LOT).toString());
    expect(expectedAt(built, r, "harvests.length")).toBe(1);
    expect(expectedAt(built, r, "strands[0].recovered")).toBe(false);
    expect(expectedAt(built, r, "strands[0].queueWad")).toBe("0");
    expect(expectedAt(built, r, "strands[0].epochWad")).toBe("200000000000000000");

    const v = "GET /v1/vault";
    expect(expectedAt(built, v, "stranded.stranded")).toBe(true);
    expect(expectedAt(built, v, "stranded.cycle")).toBe(3);
    expect(expectedAt(built, v, "stranded.claimKey")).toBe("3002");
    expect(expectedAt(built, v, "stranded.since")).toBe(isoOf(TS(147n)));
    expect(expectedAt(built, v, "stranded.lockedAssets.raw")).toBe((3n * LOT).toString());
    expect(expectedAt(built, v, "stranded.remainingWad")).toBe("800000000000000000");
    expect(expectedAt(built, v, "week.option.optionId")).toBe("3001");
    expect(expectedAt(built, v, "phase.depositsOpen")).toBe(false);
    expect(expectedAt(built, v, "lifetime.strikeProceedsUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, v, "lifetime.assignmentUsdg.raw")).toBe("450000000");
    expect(expectedAt(built, "GET /v1/strands", "stranded")).toBe(true);

    const acct = `GET /v1/account/${DEPOSITOR}`;
    expect(expectedAt(built, acct, "queue.epochId")).toBe("2");
    expect(expectedAt(built, acct, "queue.settled")).toBe(true);
    expect(expectedAt(built, acct, "queue.claimable")).toBe(true);
    expect(expectedAt(built, acct, "queue.epochSettledAt")).toBe(isoOf(TS(147n)));
    expect(expectedAt(built, acct, "strand.gen")).toBe("1");
    expect(expectedAt(built, acct, "strand.wad")).toBe("0");
    expect(expectedAt(built, acct, "strand.epochWad")).toBe("200000000000000000");
    expect(expectedAt(built, acct, "strand.recovered")).toBe(false);
    expect(expectedAt(built, acct, "strand.strand.gen")).toBe("1");
    expect(expectedAt(built, acct, "strand.strand.assetsIn.raw")).toBe("0");

    const g = "POST /graphql";
    expect(expectedAt(built, g, "data.vaultState.stranded")).toBe(true);
    expect(expectedAt(built, g, "data.vaultState.strandedCycleNumber")).toBe(3);
    expect(expectedAt(built, g, "data.vaultState.optionId")).toBe("3001");
    expect(expectedAt(built, g, "data.vaultState.claimKey")).toBe("3002");
    expect(expectedAt(built, g, "data.vaultState.lockedCollateral")).toBe((4n * LOT).toString());
    expect(expectedAt(built, g, "data.queueEpochs.items[1].strandWadClaimed")).toBe("0");
  });

  it("reports a run.json figure the chain contradicts instead of choosing one", () => {
    const { run, chain } = fixture();
    chain.harvests[2] = { ...chain.harvests[2]!, net: 452_488597n };
    run.cycles[2]!.retryTx = null;
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toEqual([
      "cycle 2 Harvest.netUsdg: run.json says 452488598, the chain says 452488597",
      `cycle 3 retry tx: run.json says null, the chain says ${hash(148)}`,
    ]);
  });

  it("reports a write that does not match its fill: written must equal sold, per fill", () => {
    const { run, chain } = fixture();
    chain.cycles[1]!.writes[0] = { ...chain.cycles[1]!.writes[0]!, contracts: 1n };
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toContain("cycle 2 contracts sold (Seaport) = written (CallsWritten): run.json says 5, the chain says 4");
    expect(built.disagreements).toContain("cycle 2 collateral = contracts x lot: run.json says 4000000000000000000, the chain says 5000000000000000000");
  });

  it("reports a keeper that did not notice its week stranded", () => {
    const { run, chain } = fixture();
    run.cycles[2]!.stranded = false;
    const built = buildExpectations(run, chain);
    expect(built.disagreements).toContain("cycle 3 stranded: run.json says false, the chain says true");
  });

  it("refuses a run.json that did not record what it must", () => {
    const { run, chain } = fixture();
    delete (run.blocks as Partial<RunJson["blocks"]>).lastBlock;
    expect(() => buildExpectations(run, chain)).toThrow(/run\.json has no blocks\.lastBlock/);
    const bare = fixture();
    delete (bare.run as Partial<RunJson>).cycles;
    expect(() => buildExpectations(bare.run, bare.chain)).toThrow(/run\.json has no cycles/);
  });
});

describe("helpers", () => {
  it("runBlocks reads the vault's deploy block and the run's last block", () => {
    expect(runBlocks(fixture().run)).toEqual({ vaultDeployBlock: 104n, lastBlock: 150n });
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

  it("epochStrandDrawdown is Vault._settleEpochEntry: pro rata, the last claimant taking the rest", () => {
    // An epoch of 10 shares owning 0.4 of a claim; entries of 6 then 4.
    const taken = epochStrandDrawdown(10n * WAD, 4n * 10n ** 17n, [{ shares: 6n * WAD }, { shares: 4n * WAD }]);
    expect(taken).toEqual([24n * 10n ** 16n, 16n * 10n ** 16n]);
    // Awkward amounts leave nothing behind.
    const awkward = epochStrandDrawdown(7n * WAD + 3n, 123_456_789_012_345_678n, [{ shares: 2n * WAD + 1n }, { shares: 3n * WAD }, { shares: 2n * WAD + 2n }]);
    expect(awkward.reduce((s, x) => s + x, 0n)).toBe(123_456_789_012_345_678n);
    // No share, nothing drawn.
    expect(epochStrandDrawdown(10n * WAD, 0n, [{ shares: 10n * WAD }])).toEqual([0n]);
  });
});
