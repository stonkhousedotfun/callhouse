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

import { cycleJson, listingJson } from "./index";
import { toJson } from "./serialize";

type CycleRow = typeof schema.cycle.$inferSelect;
type ListingRow = typeof schema.listing.$inferSelect;

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
/** premiumNet × 1e18 / supply: USDG base units per whole share. */
const perShare = (net: bigint): bigint => (net * 10n ** 18n) / SUPPLY;

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
    harvestGross: 0n,
    fee: 0n,
    premiumNet: 0n,
    usdgPerShare: 0n,
    supplyAtHarvest: SUPPLY,
    harvestedAt: closed,
  };
}

/** A buyer took all 12 contracts on the Tuesday; the call expired out of the money. */
const FILLED: CycleRow = (() => {
  const c = week(7, "2026-08-28");
  const filledAt = ts("2026-09-01T15:10:00Z");
  const harvestGross = TO_VAULT;
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
    harvestGross,
    fee: protocolFee(harvestGross),
    premiumNet: harvestGross - protocolFee(harvestGross),
    usdgPerShare: perShare(harvestGross - protocolFee(harvestGross)),
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
  const harvestGross = TO_VAULT + assignmentUsdg;
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
    harvestGross,
    fee: protocolFee(harvestGross, assignmentUsdg),
    premiumNet: harvestGross - protocolFee(harvestGross, assignmentUsdg),
    usdgPerShare: perShare(harvestGross - protocolFee(harvestGross, assignmentUsdg)),
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
    harvestGross: 0n,
    fee: 0n,
    premiumNet: 0n,
    usdgPerShare: 0n,
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
    expect(FILLED.fee).toBe(2_280000n);
    expect(FILLED.premiumNet).toBe(43_320000n);
    expect(FILLED.usdgPerShare).toBe(433200n);
    // Five contracts assigned at 190 is 950 USDG of strike proceeds on top of the premium.
    // They are principal, never fee'd: the fee is the same 2.28 as the filled week, charged on
    // the 45.6 premium alone, and all 950 reach depositors.
    expect(ASSIGNED.assignmentUsdg).toBe(950_000000n);
    expect(ASSIGNED.harvestGross).toBe(995_600000n);
    expect(ASSIGNED.fee).toBe(2_280000n);
    expect(ASSIGNED.fee).toBe(FILLED.fee);
    expect(ASSIGNED.premiumNet).toBe(993_320000n);
    expect(ASSIGNED.premiumNet - ASSIGNED.assignmentUsdg).toBe(FILLED.premiumNet);
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

  it("marks an assigned week filled AND assigned, with the strike proceeds in the harvest", () => {
    const j = cycleJson(ASSIGNED);
    expect(j.status).toBe("assigned");
    expect(j.filled).toBe(true);
    expect(j.assigned).toBe(true);
    expect(j.settlement.contractsAssigned).toBe("5");
    expect(j.settlement.assignmentUsdg.raw).toBe("950000000");
    expect(j.settlement.assetsReturned.raw).toBe((7n * LOT).toString());
    expect(j.harvest.grossUsdg.raw).toBe("995600000");
    // The fee is on the 45.6 premium alone; the 950 of strike proceeds reach depositors whole.
    expect(j.harvest.fee.raw).toBe("2280000");
    expect(j.harvest.premiumNet.raw).toBe("993320000");
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
