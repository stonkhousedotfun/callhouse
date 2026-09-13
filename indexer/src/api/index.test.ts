/**
 * The producer's half of the web <-> indexer contract.
 *
 * `cycleJson` is the shape `/v1/cycles` puts on the wire and `web/lib/api.ts` reads. The four
 * files under `ops/fixtures/api/` are that shape, byte for byte, for the four outcomes a week
 * can have: filled, unfilled, assigned, and skipped (the registry opened it, the vault never
 * wrote into it; `status: "idle"`). This test proves the indexer still emits them; the
 * matching test in `web/lib/api.test.ts` proves the dapp still reads them. A change to
 * `cycleJson` that is not mirrored in the fixtures fails here; a fixture change the dapp cannot
 * read fails there. Neither side can drift without the other noticing, which is the whole point:
 * the readiness audit found the dapp reading flat keys the indexer never sent, so every paying
 * week rendered as "unfilled, 0".
 *
 * Regenerating the fixtures is a deliberate act, never a side effect of a normal run:
 *
 *   CALLHOUSE_WRITE_FIXTURES=1 pnpm --filter @callhouse/indexer test
 *
 * then re-run the web tests. Do not change the numbers below without a reason that survives in
 * the commit message; they are chosen so the two stacked fees and the strike proceeds are each
 * visible as their own figure.
 *
 * WHY THE MOCKS: `src/api/index.ts` is the Hono app. It imports the `ponder:api` and
 * `ponder:schema` virtual modules and calls `graphql()` at module scope, which refuses to run
 * outside a Ponder process. Nothing below touches a database or the chain — `cycleJson` and
 * `listingJson` are pure — so the mocks exist only so the module can load: `ponder:schema`
 * resolves to the real `ponder.schema.ts` (the same file Ponder resolves it to), `ponder:api`
 * to inert placeholders, and `graphql` to a pass-through middleware. Nothing that is mocked is
 * asserted on. The three required env vars are given placeholder values for the same reason;
 * `lib/env.ts` throws without them, and no address here is ever dereferenced.
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
import { cycleJson, harvestJson, listingJson } from "./index";
import { toJson } from "./serialize";

type CycleRow = typeof schema.cycle.$inferSelect;
type ListingRow = typeof schema.listing.$inferSelect;
type HarvestRow = typeof schema.harvest.$inferSelect;

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
const GROSS = UNIT_PRICE * CONTRACTS; // 48.000000 USDG, what buyers paid
/** Overcall's 5%, taken per contract exactly as Policy.splitPremium does it. */
const OVERCALL_FEE_PER_CONTRACT = (UNIT_PRICE * 500n) / 10_000n; // 0.200000
const OVERCALL_FEE = OVERCALL_FEE_PER_CONTRACT * CONTRACTS; // 2.400000
const TO_VAULT = GROSS - OVERCALL_FEE; // 45.600000, the 95% that reached the vault
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
 * `RollClose.usdgFromAssignment` for the terminal harvest, 0 for a deposit checkpoint.
 */
const harvestEvent = (grossUsdg: bigint, usdgFromAssignment = 0n, supply = SUPPLY): HarvestEvent => {
  const feeUsdg = protocolFee(grossUsdg, usdgFromAssignment);
  return { grossUsdg, feeUsdg, netUsdg: grossUsdg - feeUsdg, usdgFromAssignment, supply };
};

const OPTION_ID = 0x8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b_000000000000000000000000n;
const CLAIM_KEY = OPTION_ID + 1n;

/** Everything three consecutive weeks share: same registry rhythm, same rung, same book. */
function week(cycleNumber: number, friday: string): CycleRow {
  const set = ts(`${friday}T20:05:00Z`);
  const dayMs = 86_400_000;
  const nextFriday = new Date(Date.parse(friday) + 7 * dayMs).toISOString().slice(0, 10);
  const monday = new Date(Date.parse(friday) + 3 * dayMs).toISOString().slice(0, 10);
  const exercise = ts(`${nextFriday}T20:00:00Z`);
  const expiry = ts(`${nextFriday}T21:00:00Z`);
  const opened = ts(`${monday}T14:35:00Z`);
  const closed = expiry + 30n;
  const hex = (tag: number): `0x${string}` =>
    `0x${(cycleNumber * 16 + tag).toString(16).padStart(64, "0")}` as `0x${string}`;
  return {
    cycleNumber,
    status: "listed",
    optionIds: [OPTION_ID.toString(), (OPTION_ID + (1n << 96n)).toString()],
    strikeCount: 2,
    lotSize: LOT,
    exerciseTimestamp: exercise,
    expiryTimestamp: expiry,
    setAt: set,
    setBlock: BigInt(61_200_000 + cycleNumber * 10_000),
    setTx: hex(1),

    wrote: true,
    optionId: OPTION_ID,
    claimKey: CLAIM_KEY,
    strikeUsdg: STRIKE,
    contractsWritten: CONTRACTS,
    collateral: CONTRACTS * LOT,
    openedAt: opened,
    openedBlock: BigInt(61_201_000 + cycleNumber * 10_000),
    txOpen: hex(2),

    listingCount: 1,
    orderHash: hex(3),
    listedGrossUsdg: GROSS,
    listedUnitPriceUsdg: UNIT_PRICE,
    listedContracts: CONTRACTS,
    listedAt: opened + 60n,

    contractsSold: 0n,
    premiumGross: 0n,
    premiumToVault: 0n,
    overcallFee: 0n,
    fillUnitPriceUsdg: 0n,
    fillCount: 0,
    firstFillAt: null,
    lastFillAt: null,

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

    harvested: true,
    ...ZERO_HARVEST_TOTALS,
    supplyAtHarvest: SUPPLY,
    harvestedAt: closed,
  };
}

/** A buyer took all 12 contracts on the Tuesday; the call expired out of the money. */
const FILLED: CycleRow = (() => {
  const c = week(7, "2026-08-28");
  const filledAt = ts("2026-09-01T15:10:00Z");
  return {
    ...c,
    status: "closed",
    contractsSold: CONTRACTS,
    premiumGross: GROSS,
    premiumToVault: TO_VAULT,
    overcallFee: OVERCALL_FEE,
    fillUnitPriceUsdg: UNIT_PRICE,
    fillCount: 1,
    firstFillAt: filledAt,
    lastFillAt: filledAt,
    // One terminal harvest of the 45.6 premium, nothing assigned, folded by the handler's own code.
    ...addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(TO_VAULT)),
  };
})();

/** Wrote 12, listed 12, sold 0. The most likely outcome, and every money field is zero. */
const UNFILLED: CycleRow = { ...week(8, "2026-09-04"), status: "unfilled" };

/** Sold 12, and 5 of them were assigned: 5 lots left at the strike, 5 × 190 USDG came in. */
const ASSIGNED: CycleRow = (() => {
  const c = week(9, "2026-09-11");
  const filledAt = ts("2026-09-15T15:10:00Z");
  const assigned = 5n;
  const assignmentUsdg = assigned * STRIKE;
  return {
    ...c,
    status: "assigned",
    contractsSold: CONTRACTS,
    premiumGross: GROSS,
    premiumToVault: TO_VAULT,
    overcallFee: OVERCALL_FEE,
    fillUnitPriceUsdg: UNIT_PRICE,
    fillCount: 1,
    firstFillAt: filledAt,
    lastFillAt: filledAt,
    // Market-wide exercise is a signal about the option type, not a claim about our claim.
    marketExercised: 40n,
    bucketAssigned: assigned,
    contractsAssigned: assigned,
    assignmentUsdg,
    assetsReturned: (CONTRACTS - assigned) * LOT,
    // One terminal harvest sweeping the 45.6 premium AND the 950 of strike proceeds, with
    // RollClose.usdgFromAssignment = 950 passed as the fee-free part, exactly as rollClose does.
    ...addHarvest(ZERO_HARVEST_TOTALS, harvestEvent(TO_VAULT + assignmentUsdg, assignmentUsdg)),
  };
})();

/**
 * The registry opened the week and the vault sat it out. This is what `Registry:CycleSet`
 * leaves behind when no `Vault:RollOpen` ever follows (src/registry.ts): registry facts only,
 * every vault column at its schema default, `wrote: false`, and — because only RollClose ever
 * stamps `closedAt` — no close on record, ever. The dapp tells this apart from the current
 * week (also idle until Monday) by the registry's expiry, which is why the fixture carries one.
 */
const SKIPPED: CycleRow = (() => {
  const friday = "2026-08-21";
  const dayMs = 86_400_000;
  const nextFriday = new Date(Date.parse(friday) + 7 * dayMs).toISOString().slice(0, 10);
  const cycleNumber = 6;
  return {
    cycleNumber,
    status: "idle",
    optionIds: [OPTION_ID.toString(), (OPTION_ID + (1n << 96n)).toString()],
    strikeCount: 2,
    lotSize: LOT,
    exerciseTimestamp: ts(`${nextFriday}T20:00:00Z`),
    expiryTimestamp: ts(`${nextFriday}T21:00:00Z`),
    setAt: ts(`${friday}T20:05:00Z`),
    setBlock: BigInt(61_200_000 + cycleNumber * 10_000),
    setTx: `0x${(cycleNumber * 16 + 1).toString(16).padStart(64, "0")}` as `0x${string}`,

    wrote: false,
    optionId: null,
    claimKey: null,
    strikeUsdg: 0n,
    contractsWritten: 0n,
    collateral: 0n,
    openedAt: null,
    openedBlock: null,
    txOpen: null,

    listingCount: 0,
    orderHash: null,
    listedGrossUsdg: 0n,
    listedUnitPriceUsdg: 0n,
    listedContracts: 0n,
    listedAt: null,

    contractsSold: 0n,
    premiumGross: 0n,
    premiumToVault: 0n,
    overcallFee: 0n,
    fillUnitPriceUsdg: 0n,
    fillCount: 0,
    firstFillAt: null,
    lastFillAt: null,

    marketExercised: 0n,
    bucketIndex: null,
    bucketAssigned: 0n,

    lockedAt: null,
    contractsAssigned: 0n,
    assignmentUsdg: 0n,
    assetsReturned: 0n,
    closedAt: null,
    closedBlock: null,
    txClose: null,

    harvested: false,
    ...ZERO_HARVEST_TOTALS,
    supplyAtHarvest: 0n,
    harvestedAt: null,
  };
})();

const FIXTURES: Array<{ file: string; row: CycleRow }> = [
  { file: "cycle-filled.json", row: FILLED },
  { file: "cycle-unfilled.json", row: UNFILLED },
  { file: "cycle-assigned.json", row: ASSIGNED },
  { file: "cycle-idle.json", row: SKIPPED },
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
    // 48 gross, 5% to Overcall per contract, 5% of the vault's PREMIUM to the protocol.
    expect(GROSS).toBe(48_000000n);
    expect(OVERCALL_FEE).toBe(2_400000n);
    expect(TO_VAULT).toBe(45_600000n);
    // Filled week, by hand: fee = floor(45_600000 × 500 / 10_000) = 2_280000;
    // premiumNet = 45_600000 − 2_280000 = 43_320000; per share = 43_320000 × 1e18 / 100e18 = 433_200.
    expect(FILLED.harvestGross).toBe(45_600000n);
    expect(FILLED.harvestPremiumGross).toBe(45_600000n);
    expect(FILLED.strikeProceeds).toBe(0n);
    expect(FILLED.fee).toBe(2_280000n);
    expect(FILLED.premiumNet).toBe(43_320000n);
    expect(FILLED.creditedUsdg).toBe(43_320000n);
    expect(FILLED.premiumNetPerShare).toBe(433200n);
    expect(FILLED.usdgPerShare).toBe(433200n);
    // Assigned week, by hand. Five contracts assigned at 190: 5 × 190_000000 = 950_000000 of
    // strike proceeds, swept by the terminal harvest on top of the premium. They are principal,
    // never fee'd, and never premium:
    //   harvestGross       = 45_600000 + 950_000000                          = 995_600000
    //   fee                = floor((995_600000 − 950_000000) × 500 / 10_000) = 2_280000
    //   creditedUsdg       = 995_600000 − 2_280000                           = 993_320000  (Harvest.netUsdg)
    //   harvestPremiumGross= 995_600000 − 950_000000                         = 45_600000
    //   premiumNet         = 45_600000 − 2_280000                            = 43_320000   (same as FILLED)
    //   premiumNetPerShare = 43_320000 × 1e18 / 100e18                       = 433_200
    //   usdgPerShare       = 993_320000 × 1e18 / 100e18                      = 9_933_200   (NOT a premium figure)
    expect(ASSIGNED.assignmentUsdg).toBe(950_000000n);
    expect(ASSIGNED.harvestGross).toBe(995_600000n);
    expect(ASSIGNED.strikeProceeds).toBe(950_000000n);
    expect(ASSIGNED.harvestPremiumGross).toBe(45_600000n);
    expect(ASSIGNED.fee).toBe(2_280000n);
    expect(ASSIGNED.fee).toBe(FILLED.fee);
    expect(ASSIGNED.premiumNet).toBe(43_320000n);
    expect(ASSIGNED.premiumNet).toBe(FILLED.premiumNet);
    expect(ASSIGNED.creditedUsdg).toBe(993_320000n);
    expect(ASSIGNED.creditedUsdg).toBe(ASSIGNED.premiumNet + ASSIGNED.strikeProceeds);
    expect(ASSIGNED.premiumNetPerShare).toBe(433200n);
    expect(ASSIGNED.usdgPerShare).toBe(9_933200n);
  });
});

describe("cycleJson", () => {
  it("nests money as {raw, decimals, formatted} and never as a bare number", () => {
    const j = cycleJson(FILLED);
    expect(j.fill.premiumGross).toEqual({ raw: "48000000", decimals: 6, formatted: "48" });
    expect(j.fill.overcallFee).toEqual({ raw: "2400000", decimals: 6, formatted: "2.4" });
    expect(j.fill.premiumToVault.raw).toBe("45600000");
    expect(j.harvest.grossUsdg.raw).toBe("45600000");
    expect(j.harvest.fee.raw).toBe("2280000");
    expect(j.harvest.premiumNet.raw).toBe("43320000");
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
    expect(j.registry.exerciseTimestamp).toBe(FILLED.exerciseTimestamp!.toString());
    expect(j.registry.exerciseAt).toBe("2026-09-04T20:00:00.000Z");
    expect(j.written.openedAt).toBe("2026-08-31T14:35:00.000Z");
    expect(j.settlement.closedAt).toBe("2026-09-04T21:00:30.000Z");
  });

  it("publishes an unfilled week as a full row of zeros, not a gap", () => {
    const j = cycleJson(UNFILLED);
    expect(j.status).toBe("unfilled");
    expect(j.wrote).toBe(true);
    expect(j.filled).toBe(false);
    expect(j.assigned).toBe(false);
    expect(j.written.contracts).toBe("12");
    expect(j.fill.contractsSold).toBe("0");
    expect(j.fill.premiumGross.raw).toBe("0");
    expect(j.harvest.grossUsdg.raw).toBe("0");
    expect(j.harvest.fee.raw).toBe("0");
    expect(j.harvest.premiumNet.raw).toBe("0");
    expect(j.harvest.harvested).toBe(true);
    expect(j.settlement.closedAt).not.toBeNull();
    expect(j.fill.firstFillAt).toBeNull();
  });

  it("publishes a skipped week as idle with registry facts, no write, and no close — ever", () => {
    const j = cycleJson(SKIPPED);
    expect(j.status).toBe("idle");
    expect(j.wrote).toBe(false);
    expect(j.filled).toBe(false);
    expect(j.assigned).toBe(false);
    // The registry's clock is all the dapp has to tell this week from the current one.
    expect(j.registry.expiryTimestamp).toBe(SKIPPED.expiryTimestamp!.toString());
    expect(j.registry.expiryAt).toBe("2026-08-28T21:00:00.000Z");
    expect(j.written.optionId).toBeNull();
    expect(j.written.contracts).toBe("0");
    expect(j.written.openedAt).toBeNull();
    expect(j.listing.orderHash).toBeNull();
    expect(j.settlement.closedAt).toBeNull();
    expect(j.settlement.txClose).toBeNull();
    expect(j.harvest.harvested).toBe(false);
    expect(j.harvest.grossUsdg.raw).toBe("0");
    expect(j.harvest.supplyAtHarvest.raw).toBe("0");
  });

  it("marks an assigned week filled AND assigned, and publishes premium and strike proceeds apart", () => {
    const j = cycleJson(ASSIGNED);
    expect(j.status).toBe("assigned");
    expect(j.filled).toBe(true);
    expect(j.assigned).toBe(true);
    expect(j.settlement.contractsAssigned).toBe("5");
    expect(j.settlement.assignmentUsdg.raw).toBe("950000000");
    expect(j.settlement.assetsReturned.raw).toBe((7n * LOT).toString());
    // The harvest swept 45.6 of premium and 950 of strike proceeds: 995.6 in all.
    expect(j.harvest.grossUsdg.raw).toBe("995600000");
    expect(j.harvest.strikeProceedsUsdg.raw).toBe("950000000");
    expect(j.harvest.premiumGross.raw).toBe("45600000");
    // The fee is on the 45.6 premium alone; the 950 of strike proceeds reach depositors whole.
    expect(j.harvest.fee.raw).toBe("2280000");
    // W-21: the premium figures are premium only (the same 43.32 a filled, unassigned week
    // earns) and the 993.32 credited to holders is published under its own name.
    expect(j.harvest.premiumNet.raw).toBe("43320000");
    expect(j.harvest.premiumNet).toEqual(cycleJson(FILLED).harvest.premiumNet);
    expect(j.harvest.premiumNetPerShare.raw).toBe("433200");
    expect(j.harvest.creditedUsdg.raw).toBe("993320000");
    expect(j.harvest.usdgPerShare.raw).toBe("9933200");
  });

  it("publishes strike proceeds as an explicit zero on every week that was not assigned", () => {
    for (const row of [FILLED, UNFILLED, SKIPPED]) {
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
    // 100 shares, then mints 20 more. Thursday another fill lands 15.6. Friday rollClose redeems
    // the claim with 5 contracts assigned at 190 (950 USDG back) and sweeps 15.6 + 950 against
    // 120 shares, passing usdgFromAssignment = 950 as the fee-free part.
    const checkpoint = harvestEvent(30_000000n, 0n, 100n * 10n ** 18n);
    const terminal = harvestEvent(15_600000n + 950_000000n, 950_000000n, 120n * 10n ** 18n);

    // Checkpoint, by hand:  fee = floor(30_000000 × 500 / 10_000) = 1_500000
    //                       net = 30_000000 − 1_500000            = 28_500000
    expect(checkpoint.feeUsdg).toBe(1_500000n);
    expect(checkpoint.netUsdg).toBe(28_500000n);
    // Terminal, by hand:    gross = 15_600000 + 950_000000          = 965_600000
    //                       fee   = floor(15_600000 × 500 / 10_000) = 780_000
    //                       net   = 965_600000 − 780_000            = 964_820000
    expect(terminal.grossUsdg).toBe(965_600000n);
    expect(terminal.feeUsdg).toBe(780_000n);
    expect(terminal.netUsdg).toBe(964_820000n);

    const t = splitHarvest(terminal);
    expect(t.strikeProceeds).toBe(950_000000n);
    expect(t.premiumGross).toBe(15_600000n); // 965_600000 − 950_000000
    expect(t.premiumNet).toBe(14_820000n); // 15_600000 − 780_000
    expect(t.premiumNetPerShare).toBe(123500n); // 14_820000 × 1e18 / 120e18
    expect(t.creditedPerShare).toBe(8_040166n); // floor(964_820000 × 1e18 / 120e18) = floor(8_040_166.67)

    const week = addHarvest(addHarvest(ZERO_HARVEST_TOTALS, checkpoint), terminal);
    expect(week.harvestGross).toBe(995_600000n); // 30_000000 + 965_600000
    expect(week.strikeProceeds).toBe(950_000000n);
    expect(week.harvestPremiumGross).toBe(45_600000n); // 30_000000 + 15_600000
    expect(week.fee).toBe(2_280000n); // 1_500000 + 780_000 = 5% of the 45.6 premium
    expect(week.premiumNet).toBe(43_320000n); // 28_500000 + 14_820000
    expect(week.creditedUsdg).toBe(993_320000n); // 28_500000 + 964_820000
    expect(week.creditedUsdg).toBe(week.premiumNet + week.strikeProceeds);
    // Per share, summed per sweep: 285_000 + 123_500 = 408_500. Not 43_320000 / 120 shares,
    // because the first 28.5 was indexed against 100, and never 993_320000 over anything.
    expect(week.premiumNetPerShare).toBe(408500n);
    expect(week.usdgPerShare).toBe(285000n + 8_040166n);
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

describe("harvestJson (/v1/activity, /v1/cycles/:cycle, /v1/vault lastWeek)", () => {
  it("splits the terminal harvest of an assigned week into premium and strike proceeds", () => {
    const e = harvestEvent(TO_VAULT + 950_000000n, 950_000000n);
    const s = splitHarvest(e);
    const row: HarvestRow = {
      id: "61295000-7",
      cycleNumber: 9,
      filled: true,
      terminal: true,
      grossUsdg: e.grossUsdg,
      feeUsdg: e.feeUsdg,
      netUsdg: e.netUsdg,
      premiumGrossUsdg: s.premiumGross,
      strikeProceedsUsdg: s.strikeProceeds,
      premiumNetUsdg: s.premiumNet,
      premiumToVault: TO_VAULT,
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
    // The event's own amounts, verbatim: 995.6 gross, 2.28 fee, 993.32 net.
    expect(j.grossUsdg.raw).toBe("995600000");
    expect(j.fee.raw).toBe("2280000");
    expect(j.netUsdg.raw).toBe("993320000");
    // The split: 950 strike proceeds, 45.6 premium, 43.32 after the fee, 0.4332 per share.
    expect(j.strikeProceedsUsdg.raw).toBe("950000000");
    expect(j.premiumGross.raw).toBe("45600000");
    expect(j.premiumNet.raw).toBe("43320000");
    expect(j.premiumNetPerShare.raw).toBe("433200");
    expect(j.usdgPerShare.raw).toBe("9933200");
  });
});

describe("listingJson", () => {
  it("recomputes the 95/5 split per contract, the way Policy.splitPremium does", () => {
    const l: ListingRow = {
      orderHash: FILLED.orderHash!,
      cycleNumber: 7,
      seq: 1,
      optionId: OPTION_ID,
      amount: CONTRACTS,
      grossUsdg: GROSS,
      unitPriceUsdg: UNIT_PRICE,
      writerUsdg: TO_VAULT,
      overcallFeeUsdg: OVERCALL_FEE,
      status: "filled",
      contractsFilled: CONTRACTS,
      proceedsUsdg: TO_VAULT,
      feePaidUsdg: OVERCALL_FEE,
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
    expect(j.writerUsdg.raw).toBe("45600000");
    expect(j.overcallFeeUsdg.raw).toBe("2400000");
    expect(j.fill.proceedsUsdg.raw).toBe("45600000");
    expect(j.fill.feePaidUsdg.raw).toBe("2400000");
    expect(j.status).toBe("filled");
  });
});
