/**
 * The producer's half of the web <-> indexer contract.
 *
 * `cycleJson` is the shape `/v1/cycles` puts on the wire and `web/lib/api.ts` reads. The four
 * files under `ops/fixtures/api/` are that shape, byte for byte, for the four outcomes a week
 * can have under write on fill: filled, unfilled, assigned, and stranded (the close could not
 * redeem the claim; `status: "stranded"` until the retry). This test proves the indexer still
 * emits them; the matching test in `web/lib/api.test.ts` proves the dapp still reads them. A
 * change to `cycleJson` that is not mirrored in the fixtures fails here; a fixture change the
 * dapp cannot read fails there. Neither side can drift without the other noticing, which is the
 * whole point: the readiness audit found the dapp reading flat keys the indexer never sent, so
 * every paying week rendered as "unfilled, 0".
 *
 * There is no `cycle-idle.json` any more. The vault numbers its own cycles (no registry), so a
 * week the vault never armed has no row at all, and the pre-redesign `registry` group became
 * `option` (the armed type's window). Both are visible in the fixture diff of the redesign commit.
 *
 * Regenerating the fixtures is a deliberate act, never a side effect of a normal run:
 *
 *   CALLHOUSE_WRITE_FIXTURES=1 pnpm --filter @callhouse/indexer test
 *
 * then re-run the web tests. Do not change the numbers below without a reason that survives in
 * the commit message; they are chosen so the protocol fee and the strike proceeds are each
 * visible as their own figure.
 *
 * WHY THE MOCKS: `src/api/index.ts` is the Hono app. It imports the `ponder:api` and
 * `ponder:schema` virtual modules and calls `graphql()` at module scope, which refuses to run
 * outside a Ponder process. Nothing below touches a database or the chain — `cycleJson`,
 * `listingJson`, `harvestJson` and `strandJson` are pure — so the mocks exist only so the module
 * can load: `ponder:schema` resolves to the real `ponder.schema.ts` (the same file Ponder
 * resolves it to), `ponder:api` to inert placeholders, and `graphql` to a pass-through
 * middleware. Nothing that is mocked is asserted on. The three required env vars are given
 * placeholder values for the same reason; `lib/env.ts` throws without them, and no address here
 * is ever dereferenced.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type * as schema from "../../ponder.schema";

vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
});

vi.mock("ponder:api", () => ({ db: {}, publicClients: {} }));
vi.mock("ponder:schema", async () => {
  const real = await import("../../ponder.schema");
  return { ...real, default: real };
});
vi.mock("ponder", async (importOriginal) => {
  const real = await importOriginal<typeof import("ponder")>();
  return { ...real, graphql: () => async (_c: unknown, next: () => Promise<void>) => next() };
});

import { ZERO_HARVEST_TOTALS, addHarvest, splitHarvest, type HarvestEvent } from "../../lib/harvest";
import { closeStatus, endedListingStatus, recoveredStatus, type HarvestOrigin } from "../../lib/lifecycle";
import { cycleStatus, epochStatus, harvestOrigin, listingStatus } from "../../ponder.schema";
import { CYCLE_STATUSES, LISTING_STATUSES, accountStrand, cycleJson, harvestJson, listingJson, strandJson, weekOptionIds } from "./index";
import { toJson } from "./serialize";

type CycleRow = typeof schema.cycle.$inferSelect;
type ListingRow = typeof schema.listing.$inferSelect;
type HarvestRow = typeof schema.harvest.$inferSelect;
type StrandRow = typeof schema.strand.$inferSelect;

const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "..", "ops", "fixtures", "api");

/*//////////////////////////////////////////////////////////////
                         THE NUMBERS
//////////////////////////////////////////////////////////////*/

const ts = (iso: string): bigint => BigInt(Date.parse(iso) / 1000);

/** One lot is exactly 1.0 Stock Token; the asset and the shares are 18 decimals. */
const LOT = 10n ** 18n;
/** 100 whole shares outstanding at every harvest below. */
const SUPPLY = 100n * 10n ** 18n;

/** USDG is 6 decimals. */
const STRIKE = 190_000000n; // 190.000000 USDG per contract
const CONTRACTS = 12n;
const UNIT_PRICE = 4_000000n; // 4.000000 USDG per contract asked and paid
/** What buyers paid, which is what reached the vault: ONE consideration item, no venue cut. */
const GROSS = UNIT_PRICE * CONTRACTS; // 48.000000 USDG
/** Policy.launchDefaults().protocolFeeBps: 5%, charged on harvested PREMIUM only. */
const PROTOCOL_FEE_BPS = 500n;
/**
 * The protocol fee exactly as Vault._accrueHarvest charges it: the strike proceeds that came
 * back with an assigned claim are principal and fee-free, so only `harvestGross − assignmentUsdg`
 * is fee-bearing. (One terminal harvest per week here, so the whole assignment is excluded.)
 */
const protocolFee = (harvestGross: bigint, assignmentUsdg = 0n): bigint =>
  ((harvestGross > assignmentUsdg ? harvestGross - assignmentUsdg : 0n) * PROTOCOL_FEE_BPS) / 10_000n;
/**
 * A `Harvest` event as the vault emits it, plus the fee-free part the handler passes in:
 * `RollClose.usdgFromAssignment` for the terminal harvest, 0 for a checkpoint.
 */
const harvestEvent = (grossUsdg: bigint, usdgFromAssignment = 0n, supply = SUPPLY): HarvestEvent => {
  const feeUsdg = protocolFee(grossUsdg, usdgFromAssignment);
  return { grossUsdg, feeUsdg, netUsdg: grossUsdg - feeUsdg, usdgFromAssignment, supply };
};

const OPTION_ID = 0x8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b_000000000000000000000000n;
const CLAIM_KEY = OPTION_ID + 1n;

/**
 * Everything three consecutive weeks share: the same Friday rhythm, one listing of 12 at 4.00,
 * a Tuesday fill of all 12 (written == sold, in one write), the book locked at exercise.
 */
function week(cycleNumber: number, friday: string): CycleRow {
  const dayMs = 86_400_000;
  const nextFriday = new Date(Date.parse(friday) + 7 * dayMs).toISOString().slice(0, 10);
  const monday = new Date(Date.parse(friday) + 3 * dayMs).toISOString().slice(0, 10);
  const tuesday = new Date(Date.parse(friday) + 4 * dayMs).toISOString().slice(0, 10);
  const exercise = ts(`${nextFriday}T20:00:00Z`);
  const expiry = ts(`${nextFriday}T21:00:00Z`);
  const opened = ts(`${monday}T14:35:00Z`);
  const filledAt = ts(`${tuesday}T15:10:00Z`);
  const closed = expiry + 30n;
  const hex = (tag: number): `0x${string}` =>
    `0x${(cycleNumber * 16 + tag).toString(16).padStart(64, "0")}` as `0x${string}`;
  return {
    cycleNumber,
    status: "filled",
    optionId: OPTION_ID,
    strikeUsdg: STRIKE,
    exerciseTimestamp: exercise,
    expiryTimestamp: expiry,
    openedAt: opened,
    openedBlock: BigInt(61_201_000 + cycleNumber * 10_000),
    txOpen: hex(2),

    claimKey: CLAIM_KEY,
    contractsWritten: CONTRACTS,
    collateral: CONTRACTS * LOT,
    writeCount: 1,
    firstWriteAt: filledAt,
    lastWriteAt: filledAt,

    listingCount: 1,
    orderHash: hex(3),
    listedGrossUsdg: GROSS,
    listedUnitPriceUsdg: UNIT_PRICE,
    listedContracts: CONTRACTS,
    listedAt: opened + 60n,

    contractsSold: CONTRACTS,
    premiumGross: GROSS,
    fillUnitPriceUsdg: UNIT_PRICE,
    fillCount: 1,
    firstFillAt: filledAt,
    lastFillAt: filledAt,

    marketExercised: 0n,
    bucketIndex: 0n,
    bucketAssigned: 0n,

    lockedAt: exercise,
    contractsAssigned: 0n,
    assignmentUsdg: 0n,
    assetsReturned: CONTRACTS * LOT,
    closedAt: closed,
    closedBlock: BigInt(61_205_000 + cycleNumber * 10_000),
    txClose: hex(4),

    stranded: false,
    strandGen: null,
    recoveredAt: null,
    recoveredTx: null,

    harvested: true,
    ...ZERO_HARVEST_TOTALS,
    supplyAtHarvest: SUPPLY,
    harvestedAt: closed,
  };
}

/** A buyer took all 12 contracts on the Tuesday; the call expired out of the money. */
const FILLED: CycleRow = (() => {
  const c = week(7, "2026-08-28");
  return {
    ...c,
    status: "closed",
    // One terminal harvest of the 48 premium, nothing assigned, folded by the handler's own code.
    ...addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(GROSS)),
  };
})();

/**
 * Armed and listed 12, sold 0. The most likely outcome, and every money field is zero. Under
 * write on fill nothing was written either: no claim, no collateral, nothing to return.
 */
const UNFILLED: CycleRow = (() => {
  const c = week(8, "2026-09-04");
  return {
    ...c,
    status: "unfilled",
    claimKey: null,
    contractsWritten: 0n,
    collateral: 0n,
    writeCount: 0,
    firstWriteAt: null,
    lastWriteAt: null,
    contractsSold: 0n,
    premiumGross: 0n,
    fillUnitPriceUsdg: 0n,
    fillCount: 0,
    firstFillAt: null,
    lastFillAt: null,
    bucketIndex: null,
    assetsReturned: 0n,
  };
})();

/** Sold 12, and 5 of them were assigned: 5 lots left at the strike, 5 × 190 USDG came in. */
const ASSIGNED: CycleRow = (() => {
  const c = week(9, "2026-09-11");
  const assigned = 5n;
  const assignmentUsdg = assigned * STRIKE;
  return {
    ...c,
    status: "assigned",
    // Market-wide exercise is a signal about the option type, not a claim about our claim.
    marketExercised: 40n,
    bucketAssigned: assigned,
    contractsAssigned: assigned,
    assignmentUsdg,
    assetsReturned: (CONTRACTS - assigned) * LOT,
    // One terminal harvest sweeping the 48 premium AND the 950 of strike proceeds, with
    // RollClose.usdgFromAssignment = 950 passed as the fee-free part, exactly as rollClose does.
    ...addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(GROSS + assignmentUsdg, assignmentUsdg)),
  };
})();

/**
 * Sold 12, 5 assigned, and the close could NOT redeem the claim (USDG paused): `RollClose`
 * reported the real assigned count but zero legs, `ClaimStranded` opened generation 1, and the
 * terminal harvest swept the 48 of premium that had already landed. The strike proceeds and
 * the 7 unassigned lots are still inside Valorem; `settlement.assignmentUsdg` and
 * `assetsReturned` are 0 until `retryStrandedClaim` lands, and the status says so.
 */
const STRANDED: CycleRow = (() => {
  const c = week(10, "2026-09-18");
  return {
    ...c,
    status: "stranded",
    marketExercised: 40n,
    bucketAssigned: 5n,
    contractsAssigned: 5n,
    assignmentUsdg: 0n,
    assetsReturned: 0n,
    stranded: true,
    strandGen: 1n,
    ...addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(GROSS)),
  };
})();

const FIXTURES: Array<{ file: string; row: CycleRow }> = [
  { file: "cycle-filled.json", row: FILLED },
  { file: "cycle-unfilled.json", row: UNFILLED },
  { file: "cycle-assigned.json", row: ASSIGNED },
  { file: "cycle-stranded.json", row: STRANDED },
];

/** Exactly the bytes `/v1/cycles` sends for one row: `toJson` is what `sendJson` gets. */
function wire(row: CycleRow): unknown {
  return JSON.parse(JSON.stringify(toJson(cycleJson(row))));
}

function loadFixture(file: string): unknown {
  const path = join(FIXTURE_DIR, file);
  if (process.env.CALLHOUSE_WRITE_FIXTURES === "1") {
    const row = FIXTURES.find((f) => f.file === file)!.row;
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(wire(row), null, 2)}\n`, "utf8");
  }
  if (!existsSync(path)) {
    throw new Error(`missing fixture ${path}; run with CALLHOUSE_WRITE_FIXTURES=1 to create it`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/*//////////////////////////////////////////////////////////////
                             TESTS
//////////////////////////////////////////////////////////////*/

describe("cycleJson is the shape in ops/fixtures/api/", () => {
  for (const { file, row } of FIXTURES) {
    it(`${file} is what cycleJson emits today`, () => {
      expect(wire(row)).toEqual(loadFixture(file));
    });
  }

  it("the arithmetic behind the fixtures is the one the contracts use", () => {
    // 48 gross, all of it to the vault (one consideration item), 5% of the PREMIUM to the protocol.
    expect(GROSS).toBe(48_000000n);
    // Filled week, by hand: fee = floor(48_000000 × 500 / 10_000) = 2_400000;
    // premiumNet = 48_000000 − 2_400000 = 45_600000; per share = 45_600000 × 1e18 / 100e18 = 456_000.
    expect(FILLED.harvestGross).toBe(48_000000n);
    expect(FILLED.harvestPremiumGross).toBe(48_000000n);
    expect(FILLED.strikeProceeds).toBe(0n);
    expect(FILLED.fee).toBe(2_400000n);
    expect(FILLED.premiumNet).toBe(45_600000n);
    expect(FILLED.creditedUsdg).toBe(45_600000n);
    expect(FILLED.premiumNetPerShare).toBe(456000n);
    expect(FILLED.usdgPerShare).toBe(456000n);
    // Assigned week, by hand. Five contracts assigned at 190: 5 × 190_000000 = 950_000000 of
    // strike proceeds, swept by the terminal harvest on top of the premium. They are principal,
    // never fee'd, and never premium:
    //   harvestGross       = 48_000000 + 950_000000                          = 998_000000
    //   fee                = floor((998_000000 − 950_000000) × 500 / 10_000) = 2_400000
    //   creditedUsdg       = 998_000000 − 2_400000                           = 995_600000  (Harvest.netUsdg)
    //   harvestPremiumGross= 998_000000 − 950_000000                         = 48_000000
    //   premiumNet         = 48_000000 − 2_400000                            = 45_600000   (same as FILLED)
    //   premiumNetPerShare = 45_600000 × 1e18 / 100e18                       = 456_000
    //   usdgPerShare       = 995_600000 × 1e18 / 100e18                      = 9_956_000   (NOT a premium figure)
    expect(ASSIGNED.assignmentUsdg).toBe(950_000000n);
    expect(ASSIGNED.harvestGross).toBe(998_000000n);
    expect(ASSIGNED.strikeProceeds).toBe(950_000000n);
    expect(ASSIGNED.harvestPremiumGross).toBe(48_000000n);
    expect(ASSIGNED.fee).toBe(2_400000n);
    expect(ASSIGNED.fee).toBe(FILLED.fee);
    expect(ASSIGNED.premiumNet).toBe(45_600000n);
    expect(ASSIGNED.premiumNet).toBe(FILLED.premiumNet);
    expect(ASSIGNED.creditedUsdg).toBe(995_600000n);
    expect(ASSIGNED.creditedUsdg).toBe(ASSIGNED.premiumNet + ASSIGNED.strikeProceeds);
    expect(ASSIGNED.premiumNetPerShare).toBe(456000n);
    expect(ASSIGNED.usdgPerShare).toBe(9_956000n);
    // Stranded week: the premium was swept, the strike proceeds were not (they are still in the claim).
    expect(STRANDED.harvestGross).toBe(48_000000n);
    expect(STRANDED.strikeProceeds).toBe(0n);
    expect(STRANDED.premiumNet).toBe(FILLED.premiumNet);
    expect(STRANDED.assignmentUsdg).toBe(0n);
    expect(STRANDED.contractsAssigned).toBe(5n);
  });
});

describe("cycleJson", () => {
  it("nests money as {raw, decimals, formatted} and never as a bare number", () => {
    const j = cycleJson(FILLED);
    expect(j.fill.premiumGross).toEqual({ raw: "48000000", decimals: 6, formatted: "48" });
    expect(j.harvest.grossUsdg.raw).toBe("48000000");
    expect(j.harvest.fee.raw).toBe("2400000");
    expect(j.harvest.premiumNet.raw).toBe("45600000");
    // 18 decimals for the asset and the shares, never 6.
    expect(j.harvest.supplyAtHarvest).toEqual({
      raw: "100000000000000000000",
      decimals: 18,
      formatted: "100",
    });
    expect(j.written.collateral.decimals).toBe(18);
    expect(j.written.strikeUsdg.decimals).toBe(6);
  });

  it("carries counts as decimal strings and timestamps both as ISO and as seconds", () => {
    const j = cycleJson(FILLED);
    expect(j.fill.contractsSold).toBe("12");
    expect(j.written.contracts).toBe("12");
    expect(j.option.exerciseTimestamp).toBe(FILLED.exerciseTimestamp!.toString());
    expect(j.option.exerciseAt).toBe("2026-09-04T20:00:00.000Z");
    expect(j.option.expiryAt).toBe("2026-09-04T21:00:00.000Z");
    expect(j.written.openedAt).toBe("2026-08-31T14:35:00.000Z");
    expect(j.written.firstWriteAt).toBe("2026-09-01T15:10:00.000Z");
    expect(j.settlement.closedAt).toBe("2026-09-04T21:00:30.000Z");
  });

  it("publishes written and sold apart, and equal: the fill is the write", () => {
    const j = cycleJson(FILLED);
    expect(j.written.contracts).toBe(j.fill.contractsSold);
    expect(j.written.writeCount).toBe(j.fill.fillCount);
    expect(j.written.claimKey).toBe(CLAIM_KEY.toString());
  });

  it("publishes an unfilled week as a full row of zeros, not a gap — and nothing written", () => {
    const j = cycleJson(UNFILLED);
    expect(j.status).toBe("unfilled");
    expect(j.filled).toBe(false);
    expect(j.assigned).toBe(false);
    expect(j.stranded).toBe(false);
    // Armed, listed 12, and under write on fill nothing was written because nothing sold.
    expect(j.written.optionId).toBe(OPTION_ID.toString());
    expect(j.listing.contracts).toBe("12");
    expect(j.written.contracts).toBe("0");
    expect(j.written.claimKey).toBeNull();
    expect(j.written.collateral.raw).toBe("0");
    expect(j.fill.contractsSold).toBe("0");
    expect(j.fill.premiumGross.raw).toBe("0");
    expect(j.harvest.grossUsdg.raw).toBe("0");
    expect(j.harvest.fee.raw).toBe("0");
    expect(j.harvest.premiumNet.raw).toBe("0");
    expect(j.harvest.harvested).toBe(true);
    expect(j.settlement.assetsReturned.raw).toBe("0");
    expect(j.settlement.closedAt).not.toBeNull();
    expect(j.settlement.strand).toBeNull();
    expect(j.fill.firstFillAt).toBeNull();
  });

  it("marks an assigned week filled AND assigned, and publishes premium and strike proceeds apart", () => {
    const j = cycleJson(ASSIGNED);
    expect(j.status).toBe("assigned");
    expect(j.filled).toBe(true);
    expect(j.assigned).toBe(true);
    expect(j.settlement.contractsAssigned).toBe("5");
    expect(j.settlement.assignmentUsdg.raw).toBe("950000000");
    expect(j.settlement.assetsReturned.raw).toBe((7n * LOT).toString());
    // The harvest swept 48 of premium and 950 of strike proceeds: 998 in all.
    expect(j.harvest.grossUsdg.raw).toBe("998000000");
    expect(j.harvest.strikeProceedsUsdg.raw).toBe("950000000");
    expect(j.harvest.premiumGross.raw).toBe("48000000");
    // The fee is on the 48 premium alone; the 950 of strike proceeds reach depositors whole.
    expect(j.harvest.fee.raw).toBe("2400000");
    // W-21: the premium figures are premium only (the same 45.6 a filled, unassigned week
    // earns) and the 995.6 credited to holders is published under its own name.
    expect(j.harvest.premiumNet.raw).toBe("45600000");
    expect(j.harvest.premiumNet).toEqual(cycleJson(FILLED).harvest.premiumNet);
    expect(j.harvest.premiumNetPerShare.raw).toBe("456000");
    expect(j.harvest.creditedUsdg.raw).toBe("995600000");
    expect(j.harvest.usdgPerShare.raw).toBe("9956000");
  });

  it("publishes a stranded week as stranded, with the assigned count known and the legs still zero", () => {
    const j = cycleJson(STRANDED);
    expect(j.status).toBe("stranded");
    expect(j.stranded).toBe(true);
    expect(j.filled).toBe(true);
    // `RollClose.contractsAssignedCount` is read before the redeem is attempted, so it is real.
    expect(j.assigned).toBe(true);
    expect(j.settlement.contractsAssigned).toBe("5");
    // The claim's legs have not arrived: the strike USDG and the 7 lots are still in Valorem.
    expect(j.settlement.assignmentUsdg.raw).toBe("0");
    expect(j.settlement.assetsReturned.raw).toBe("0");
    expect(j.settlement.strand).toEqual({ gen: "1", recovered: false, recoveredAt: null, recoveredTx: null });
    // The premium that landed was harvested; nothing of it is strike proceeds yet.
    expect(j.harvest.harvested).toBe(true);
    expect(j.harvest.grossUsdg.raw).toBe("48000000");
    expect(j.harvest.strikeProceedsUsdg.raw).toBe("0");
    expect(j.harvest.premiumNet.raw).toBe("45600000");
  });

  it("publishes strike proceeds as an explicit zero on every week that was not assigned", () => {
    for (const row of [FILLED, UNFILLED]) {
      const j = cycleJson(row);
      expect(j.harvest.strikeProceedsUsdg.raw).toBe("0");
      expect(j.harvest.premiumNet).toEqual(j.harvest.creditedUsdg);
      expect(j.harvest.premiumGross).toEqual(j.harvest.grossUsdg);
    }
  });
});

describe("lib/harvest.ts: one Harvest event split into premium and strike proceeds", () => {
  it("a checkpoint's whole gross is premium", () => {
    // The handler passes 0 as the fee-free part for a checkpoint.
    // 30_000000 gross: fee = floor(30_000000 × 500 / 10_000) = 1_500000; net = 28_500000.
    const s = splitHarvest(harvestEvent(30_000000n));
    expect(s.strikeProceeds).toBe(0n);
    expect(s.premiumGross).toBe(30_000000n);
    expect(s.premiumNet).toBe(28_500000n);
    expect(s.credited).toBe(28_500000n);
    // 28_500000 × 1e18 / 100e18 = 285_000
    expect(s.premiumNetPerShare).toBe(285000n);
  });

  it("an assigned week with a mid-week deposit: premium-only realized figures, strike proceeds apart", () => {
    // Tuesday a buyer fills: 30 USDG of premium lands. Wednesday a deposit checkpoints it against
    // 100 shares, then mints 20 more. Thursday another fill lands 18. Friday rollClose redeems
    // the claim with 5 contracts assigned at 190 (950 USDG back) and sweeps 18 + 950 against
    // 120 shares, passing usdgFromAssignment = 950 as the fee-free part.
    const checkpoint = harvestEvent(30_000000n, 0n, 100n * 10n ** 18n);
    const terminal = harvestEvent(18_000000n + 950_000000n, 950_000000n, 120n * 10n ** 18n);

    // Checkpoint, by hand:  fee = floor(30_000000 × 500 / 10_000) = 1_500000
    //                       net = 30_000000 − 1_500000            = 28_500000
    expect(checkpoint.feeUsdg).toBe(1_500000n);
    expect(checkpoint.netUsdg).toBe(28_500000n);
    // Terminal, by hand:    gross = 18_000000 + 950_000000          = 968_000000
    //                       fee   = floor(18_000000 × 500 / 10_000) = 900_000
    //                       net   = 968_000000 − 900_000            = 967_100000
    expect(terminal.grossUsdg).toBe(968_000000n);
    expect(terminal.feeUsdg).toBe(900_000n);
    expect(terminal.netUsdg).toBe(967_100000n);

    const t = splitHarvest(terminal);
    expect(t.strikeProceeds).toBe(950_000000n);
    expect(t.premiumGross).toBe(18_000000n); // 968_000000 − 950_000000
    expect(t.premiumNet).toBe(17_100000n); // 18_000000 − 900_000
    expect(t.premiumNetPerShare).toBe(142500n); // 17_100000 × 1e18 / 120e18
    expect(t.creditedPerShare).toBe(8_059166n); // floor(967_100000 × 1e18 / 120e18) = floor(8_059_166.67)

    const week = addHarvest(addHarvest(ZERO_HARVEST_TOTALS, checkpoint), terminal);
    expect(week.harvestGross).toBe(998_000000n); // 30_000000 + 968_000000
    expect(week.strikeProceeds).toBe(950_000000n);
    expect(week.harvestPremiumGross).toBe(48_000000n); // 30_000000 + 18_000000
    expect(week.fee).toBe(2_400000n); // 1_500000 + 900_000 = 5% of the 48 premium
    expect(week.premiumNet).toBe(45_600000n); // 28_500000 + 17_100000
    expect(week.creditedUsdg).toBe(995_600000n); // 28_500000 + 967_100000
    expect(week.creditedUsdg).toBe(week.premiumNet + week.strikeProceeds);
    // Per share, summed per sweep: 285_000 + 142_500 = 427_500. Not 45_600000 / 120 shares,
    // because the first 28.5 was indexed against 100, and never 995_600000 over anything.
    expect(week.premiumNetPerShare).toBe(427500n);
    expect(week.usdgPerShare).toBe(285000n + 8_059166n);
  });

  it("the retry of a stranded claim: the live shares' USDG is strike proceeds, fee-free", () => {
    // The stranded week's 48 of premium was swept at the close. Later the retry redeems 950 of
    // strike USDG; the queue owned 0.4 of the claim, so 380 went straight to the reserves and
    // the handler passes the live shares' 570 as the fee-free part of the retry's Harvest.
    const retry = harvestEvent(570_000000n, 570_000000n);
    expect(retry.feeUsdg).toBe(0n);
    const s = splitHarvest(retry);
    expect(s.strikeProceeds).toBe(570_000000n);
    expect(s.premiumGross).toBe(0n);
    expect(s.premiumNet).toBe(0n);
    expect(s.credited).toBe(570_000000n);
    const week = addHarvest(addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(GROSS)), retry);
    expect(week.premiumNet).toBe(45_600000n);
    expect(week.strikeProceeds).toBe(570_000000n); // the live part only; assignmentUsdg says 950
    expect(week.creditedUsdg).toBe(615_600000n);
  });

  it("clamps: strike proceeds never exceed the sweep, and premium never goes negative", () => {
    const s = splitHarvest({ grossUsdg: 5n, feeUsdg: 0n, netUsdg: 5n, usdgFromAssignment: 9n, supply: 0n });
    expect(s.strikeProceeds).toBe(5n);
    expect(s.premiumGross).toBe(0n);
    expect(s.premiumNet).toBe(0n);
    // No supply to index against: zero per share, not a division by zero.
    expect(s.premiumNetPerShare).toBe(0n);
  });
});

describe("harvestJson (/v1/activity, /v1/cycles/:cycle, /v1/vault lastHarvest)", () => {
  it("splits the terminal harvest of an assigned week into premium and strike proceeds", () => {
    const e = harvestEvent(GROSS + 950_000000n, 950_000000n);
    const s = splitHarvest(e);
    const row: HarvestRow = {
      id: "61295000-7",
      cycleNumber: 9,
      filled: true,
      terminal: true,
      origin: "rollClose",
      grossUsdg: e.grossUsdg,
      feeUsdg: e.feeUsdg,
      netUsdg: e.netUsdg,
      premiumGrossUsdg: s.premiumGross,
      strikeProceedsUsdg: s.strikeProceeds,
      premiumNetUsdg: s.premiumNet,
      assignmentUsdg: 950_000000n,
      contractsSold: CONTRACTS,
      contractsAssigned: 5n,
      accUsdgPerShare: 0n,
      supply: SUPPLY,
      premiumNetPerShare: s.premiumNetPerShare,
      usdgPerShare: s.creditedPerShare,
      timestamp: ASSIGNED.harvestedAt!,
      blockNumber: ASSIGNED.closedBlock!,
      txHash: ASSIGNED.txClose!,
    };
    const j = harvestJson(row);
    expect(j.origin).toBe("rollClose");
    expect(j.terminal).toBe(true);
    // The event's own amounts, verbatim: 998 gross, 2.4 fee, 995.6 net.
    expect(j.grossUsdg.raw).toBe("998000000");
    expect(j.fee.raw).toBe("2400000");
    expect(j.netUsdg.raw).toBe("995600000");
    // The split: 950 strike proceeds, 48 premium, 45.6 after the fee, 0.456 per share.
    expect(j.strikeProceedsUsdg.raw).toBe("950000000");
    expect(j.premiumGross.raw).toBe("48000000");
    expect(j.premiumNet.raw).toBe("45600000");
    expect(j.premiumNetPerShare.raw).toBe("456000");
    expect(j.usdgPerShare.raw).toBe("9956000");
  });
});

describe("listingJson", () => {
  it("publishes the one consideration item: gross is the vault's, with no venue split", () => {
    const l: ListingRow = {
      orderHash: FILLED.orderHash!,
      cycleNumber: 7,
      seq: 1,
      optionId: OPTION_ID,
      amount: CONTRACTS,
      grossUsdg: GROSS,
      unitPriceUsdg: UNIT_PRICE,
      status: "filled",
      contractsFilled: CONTRACTS,
      proceedsUsdg: GROSS,
      fillCount: 1,
      approvedAt: FILLED.listedAt!,
      approvedBlock: FILLED.openedBlock!,
      approvedTx: FILLED.txOpen!,
      lastFillAt: FILLED.lastFillAt,
      lastFillTx: FILLED.txOpen,
      endedAt: FILLED.lastFillAt,
      endedTx: FILLED.txOpen,
      endReason: "filled",
    };
    const j = listingJson(l);
    expect(j.contracts).toBe("12");
    expect(j.grossUsdg.raw).toBe("48000000");
    expect(j.unitPriceUsdg.raw).toBe("4000000");
    expect(j.fill.proceedsUsdg.raw).toBe("48000000");
    expect(j.status).toBe("filled");
    expect(j.endReason).toBe("filled");
    expect("writerUsdg" in j).toBe(false);
  });
});

/**
 * X-2: no enum value the handlers never produce, and none they produce that the API cannot
 * filter on. Each schema enum is pinned to the set of values the code actually writes: the two
 * statuses the handlers assign by hand (`listed` at RollOpen, `filled` at the first
 * OrderFulfilled; `approved` at ListingApproved, `filled` at a complete fill) plus everything the
 * pure lifecycle helpers can return. The fixtures above are the four terminal cycle outcomes; the
 * tape's `status` column can hold nothing else.
 */
describe("every enum value is produced, and every produced value is an enum value (X-2)", () => {
  it("cycle_status", () => {
    const produced = new Set<string>(["listed", "filled"]);
    for (const stranded of [false, true]) {
      for (const written of [0n, 12n]) {
        for (const assigned of [0n, 5n]) produced.add(closeStatus({ stranded, written, assigned }));
      }
    }
    for (const assigned of [0n, 5n]) produced.add(recoveredStatus({ assigned }));
    expect([...produced].sort()).toEqual([...cycleStatus.enumValues].sort());
    expect([...CYCLE_STATUSES].sort()).toEqual([...cycleStatus.enumValues].sort());
  });

  it("listing_status", () => {
    const produced = new Set<string>(["approved", "filled", endedListingStatus(0n), endedListingStatus(3n)]);
    expect([...produced].sort()).toEqual([...listingStatus.enumValues].sort());
    expect([...LISTING_STATUSES].sort()).toEqual([...listingStatus.enumValues].sort());
  });

  it("harvest_origin", () => {
    const origins: HarvestOrigin[] = ["rollClose", "checkpoint", "retry"];
    expect([...origins].sort()).toEqual([...harvestOrigin.enumValues].sort());
  });

  it("epoch_status", () => {
    // `open` is the row default at the first QueueRedeem / EpochStrandShare; `settled` is QueueSettled.
    expect(["open", "settled"].sort()).toEqual([...epochStatus.enumValues].sort());
  });
});

describe("strandJson (/v1/strands, /v1/cycles/:cycle)", () => {
  it("publishes a recovered generation with the queue's part and what is left of it", () => {
    const s: StrandRow = {
      gen: 1n,
      cycleNumber: 10,
      claimKey: CLAIM_KEY,
      strandedAt: STRANDED.closedAt!,
      strandedBlock: STRANDED.closedBlock!,
      strandedTx: STRANDED.txClose!,
      epochWad: 4n * 10n ** 17n,
      epochCount: 1,
      recovered: true,
      recoveredAt: STRANDED.closedAt! + 86_400n,
      recoveredBlock: STRANDED.closedBlock! + 1000n,
      recoveredTx: `0x${"a".repeat(64)}`,
      assetsIn: 7n * LOT,
      usdgIn: 950_000000n,
      queueWad: 4n * 10n ** 17n,
      wadLeft: 4n * 10n ** 17n,
      assetsLeft: 2_800000000000000000n,
      usdgLeft: 380_000000n,
      settledCount: 0,
    };
    const j = strandJson(s);
    expect(j.gen).toBe("1");
    expect(j.cycle).toBe(10);
    expect(j.recovered).toBe(true);
    expect(j.assetsIn.raw).toBe((7n * LOT).toString());
    expect(j.usdgIn.raw).toBe("950000000");
    expect(j.queueWad).toBe("400000000000000000");
    expect(j.assetsLeft.raw).toBe("2800000000000000000");
    expect(j.usdgLeft.raw).toBe("380000000");
    expect(j.strandedAt).toBe("2026-09-25T21:00:30.000Z");
  });
});

describe("weekOptionIds (/v1/vault week.option)", () => {
  it("a zero live read is absent, not \"0\": week 4 Listed with nothing written has an option and no claim", () => {
    // Armed: optionId() is the type, claimKey() is 0 until the first fill writes.
    expect(weekOptionIds({ optionId: OPTION_ID, claimKey: 0n }, { optionId: OPTION_ID, claimKey: null })).toEqual({
      optionId: OPTION_ID.toString(),
      claimKey: null,
    });
  });

  it("after a redeemed close both views read 0 and the week's own row answers", () => {
    expect(weekOptionIds({ optionId: 0n, claimKey: 0n }, FILLED)).toEqual({ optionId: OPTION_ID.toString(), claimKey: CLAIM_KEY.toString() });
    // An unfilled close: the type is forgotten on chain and no claim ever existed.
    expect(weekOptionIds({ optionId: 0n, claimKey: 0n }, UNFILLED)).toEqual({ optionId: OPTION_ID.toString(), claimKey: null });
  });

  it("the live ids win when there are any, a dead RPC falls back to the row, and nothing at all is null", () => {
    expect(weekOptionIds({ optionId: 3001n, claimKey: 3002n }, FILLED)).toEqual({ optionId: "3001", claimKey: "3002" });
    expect(weekOptionIds({ optionId: null, claimKey: null }, FILLED)).toEqual({ optionId: OPTION_ID.toString(), claimKey: CLAIM_KEY.toString() });
    expect(weekOptionIds({ optionId: 0n, claimKey: 0n }, null)).toEqual({ optionId: null, claimKey: null });
  });
});

describe("accountStrand (/v1/account/:addr strand)", () => {
  // An epoch of 10 shares settled while generation 2 was stranded and took 0.4 of that claim.
  // Two owners queued into it: A with 6 shares, B with 4. Nobody has collected yet.
  const EPOCH = { strandGen: 2n, sharesSettled: 10n * LOT, sharesClaimed: 0n, strandWad: 4n * 10n ** 17n, strandWadClaimed: 0n };
  const base = { stagedWad: 0n, stagedGen: null, epochId: 5n, currentEpoch: 6n, epoch: EPOCH };

  it("two queuers each see their own pro-rata part, not the epoch's whole 0.4", () => {
    // A: floor(0.4e18 × 6 / 10) = 0.24e18. B: floor(0.4e18 × 4 / 10) = 0.16e18. Together the whole 0.4.
    const a = accountStrand({ ...base, queuedShares: 6n * LOT });
    const b = accountStrand({ ...base, queuedShares: 4n * LOT });
    expect(a).toEqual({ wad: 0n, gen: 2n, epochWad: 240000000000000000n, epochGen: 2n });
    expect(b.epochWad).toBe(160000000000000000n);
    expect(a.epochWad + b.epochWad).toBe(EPOCH.strandWad);
  });

  it("after A collects, B is the last claimant and takes exactly what is left", () => {
    // A's entry took 0.24e18 and 6 shares; B's 4 shares are all that remain.
    const afterA = { ...EPOCH, sharesClaimed: 6n * LOT, strandWadClaimed: 240000000000000000n };
    expect(accountStrand({ ...base, epoch: afterA, queuedShares: 4n * LOT }).epochWad).toBe(160000000000000000n);
  });

  it("an epoch that has not settled, or settled with no strand share, has nothing pending", () => {
    expect(accountStrand({ ...base, currentEpoch: 5n, queuedShares: 6n * LOT }).epochWad).toBe(0n);
    expect(accountStrand({ ...base, epoch: { ...EPOCH, strandGen: null }, queuedShares: 6n * LOT })).toEqual({ wad: 0n, gen: null, epochWad: 0n, epochGen: null });
    expect(accountStrand({ ...base, epochId: null, epoch: null, queuedShares: 0n })).toEqual({ wad: 0n, gen: null, epochWad: 0n, epochGen: null });
  });

  it("a staged share of one generation and an epoch share of another keep their own labels", () => {
    // 0.1e18 of generation 1 staged (resolved, not yet folded), and A's entry in generation 2's epoch.
    const r = accountStrand({ ...base, stagedWad: 10n ** 17n, stagedGen: 1n, queuedShares: 6n * LOT });
    expect(r).toEqual({ wad: 10n ** 17n, gen: 1n, epochWad: 240000000000000000n, epochGen: 2n });
  });
});
