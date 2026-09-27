/**
 * House vault ingest replay. Handlers register through v2HouseVaultPonder; this file
 * captures them the same way flywheel.handler.test.ts:7-18 does.
 *
 * Topic0s are derived from generated ABIs and compared with independently
 * mirrored event signatures in lib/v2/houseVaultEvents.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, toEventSelector } from "viem";
import type { Abi, AbiEvent } from "viem";

import * as actualSchema from "../../ponder.schema";
import { houseVaultAbi } from "../../abis/v2/houseVault";
import { houseVaultFactoryAbi } from "../../abis/v2/houseVaultFactory";
import {
  HOUSE_VAULT_EVENTS,
} from "../../lib/v2/houseVaultEvents";
import { houseFillRows, meta } from "../../lib/v2/houseVault";
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  process.env.V2_HOUSE_VAULT_FACTORY ??= "0x000000000000000000000000000000000000f001";
  process.env.V2_HOUSE_START_BLOCK ??= "100";
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (event: string, handler: Handler) => handlers.set(event, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2HouseVaultPonder: registry,
  // The vault events and the kinded (daily) factory have gates of their own.
  v2HouseVaultEventsPonder: registry,
  v2HouseVaultKindedFactoryPonder: registry,
  // The OrderFilled handler registers here. Gives it a House-fill call site, and the only way to
  // prove that call site exists is to replay the real handler - see the fill-tape case below.
  v2Ponder: registry,
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2HouseVault: "v2HouseVault",
    v2HouseEpoch: "v2HouseEpoch",
    v2HouseNav: "v2HouseNav",
    v2HouseShareBalance: "v2HouseShareBalance",
    v2HouseDepositQueue: "v2HouseDepositQueue",
    v2HouseWithdrawQueue: "v2HouseWithdrawQueue",
    v2HouseQueueSettlement: "v2HouseQueueSettlement",
    v2HouseClaim: "v2HouseClaim",
    v2HouseInstantDeposit: "v2HouseInstantDeposit",
    v2HousePerformanceFee: "v2HousePerformanceFee",
    v2HousePerformanceFeePaid: "v2HousePerformanceFeePaid",
    v2HouseEpochBatches: "v2HouseEpochBatches",
    v2HouseEpochOpened: "v2HouseEpochOpened",
    v2HouseFill: "v2HouseFill",
    v2HouseSelfDealRefusal: "v2HouseSelfDealRefusal",
    v2HouseProtocolAccount: "v2HouseProtocolAccount",
    v2HouseLimits: "v2HouseLimits",
    v2HouseExposure: "v2HouseExposure",
    // Read or written by OrderBook:OrderFilled, which the fill-tape case replays.
    v2Order: "v2Order",
    v2Fill: "v2Fill",
    v2Series: "v2Series",
    v2Market: "v2Market",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, (value = new Map()));
    return value;
  };
  // `id` and `vault` cover every House table. The order book's rows are keyed by orderId, longId or
  // underlying, and the fill-tape case replays the real OrderFilled handler, which reads all three.
  const keyOf = (row: any) => String(row.id ?? row.vault ?? row.orderId ?? row.longId ?? row.underlying);
  const rowKey = keyOf;
  const lookupKey = keyOf;
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(lookupKey(key)) ?? null,
    insert: (name: string) => ({
      values: (row: any) => {
        const key = rowKey(row);
        const previous = table(name).get(key);
        if (previous === undefined) table(name).set(key, row);
        return {
          then: (resolve: (value: any) => void) => resolve(row),
          onConflictDoUpdate: async (values: any) => {
            table(name).set(key, previous === undefined ? { ...row, ...values } : { ...previous, ...values });
          },
        };
      },
    }),
    update: (name: string, key: any) => ({
      set: async (values: any) => {
        const id = lookupKey(key);
        const next = { ...table(name).get(id), ...values };
        table(name).set(id, next);
        return next;
      },
    }),
  };
}

const tx = `0x${"b".repeat(64)}`;
let logIndex = 0;
const FACTORY = "0x000000000000000000000000000000000000f001";
const VAULT = "0x000000000000000000000000000000000000b001";
const UNDERLYING = "0x0000000000000000000000000000000000000a01";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const ZERO = "0x0000000000000000000000000000000000000000";

const event = (args: object, address: string) => ({
  args,
  block: { timestamp: 1_700_000_000n + BigInt(logIndex), number: 64_100_000n },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address },
});

beforeAll(async () => {
  await import("./houseVault");
  await import("./orderBook");
});

/**
 * The parameter used to be `readonly { type?: string; name?: string }[]`, which widened every entry
 * to a shape {toEventSelector} does not accept. Taking viem's `Abi` keeps the discriminated union, so
 * the `type !== "event"` check below NARROWS to `AbiEvent` instead of needing an assertion -- and a
 * missing event now throws by name rather than returning undefined through a `!`.
 */
function abiEvent(abi: Abi, name: string): AbiEvent {
  const item = abi.find((entry) => entry.type === "event" && entry.name === name);
  if (item === undefined || item.type !== "event") throw new Error(`abi has no event ${name}`);
  return item;
}

describe("House vault event signatures", () => {
  it("match the compiler-pinned keccak strings in HouseVaultInterface.t.sol", () => {
    // A change appended `bool weekly`: the generated ABI carries the KINDED event.
    expect(toEventSelector(abiEvent(houseVaultFactoryAbi, "VaultCreated"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.VaultCreatedKinded),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "EpochRolled"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.EpochRolled),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "DepositRequested"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.DepositRequested),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "Claimed"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.Claimed),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "LimitsSet"))).toBe(
      toEventSelector("event LimitsSet((uint64,uint128,uint16,uint16,uint32,uint128))"),
    );
    // Pinned from `cast keccak "DepositedNow(address,uint256,uint256,uint64)"` on the landed event
    // (HouseVault.sol), not from any ABI in this repo, so the export cannot vouch for itself.
    expect(toEventSelector(abiEvent(houseVaultAbi, "DepositedNow"))).toBe(
      "0x1905484b413d041afa0115185bb73aa2eb52818464f3c7e09d789841e5da406f",
    );
    // The generated ABI and the mirrored signature must be the same topic.
    expect(toEventSelector(abiEvent(houseVaultAbi, "PerformanceFeePaid"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.PerformanceFeePaid),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "EpochBatchesPriced"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.EpochBatchesPriced),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "EpochOpened"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.EpochOpened),
    );
  });
});

describe("the configured launch factory's source is on the LEGACY VaultCreated topic", () => {
  // Pinned from the signatures (cast sig-event), not from any ABI in this repo, so the ABIs cannot vouch for
  // themselves: legacy = the legacy launch factory 0x5BEa4c98...; kinded = the newer factories.
  const LEGACY_TOPIC = "0xf4c8fe3d081e6833faa5b528b19b14655145aa43759aae5d58a22b9eba726e29";
  const KINDED_TOPIC = "0xeef0325f711a74caa786a3b9c97a9a07cb8a3070605e8a89625fd624d05d500d";

  it("pins both topics", () => {
    expect(toEventSelector(HOUSE_VAULT_EVENTS.VaultCreated)).toBe(LEGACY_TOPIC);
    expect(toEventSelector(HOUSE_VAULT_EVENTS.VaultCreatedKinded)).toBe(KINDED_TOPIC);
    expect(toEventSelector(abiEvent(houseVaultFactoryAbi, "VaultCreated"))).toBe(KINDED_TOPIC);
  });

  // A change changed the discovery half of this case on purpose. This test's env factory (0x…f001) is one the baked
  // registry does NOT name, and the case pinned its factory() discovery on LEGACY_TOPIC. Only the factory a registry
  // records as its weekly (legacy) launch factory emits that topic; any other is compiled after kinding and
  // emits only the 5-field one, so a v9 factory in this footing discovered zero vaults. The v8 case follows.
  it("indexes the configured factory on the legacy event, and discovers an unnamed factory's clones on the 5-field one", async () => {
    const { default: config } = await import("../../ponder.config");
    const contracts = config.contracts as unknown as Record<string, { abi: Abi; address: unknown }>;
    const factorySource = contracts.HouseVaultFactory;
    const vaultSource = contracts.HouseVault;
    expect(factorySource, "positive control: the House sources are configured in this test's env").toBeDefined();
    expect(toEventSelector(abiEvent(factorySource!.abi, "VaultCreated"))).toBe(LEGACY_TOPIC);
    const discovery = vaultSource!.address as { event: AbiEvent };
    expect(toEventSelector(discovery.event)).toBe(KINDED_TOPIC);
    // Everything else on the factory source is still the generated ABI (AuthorityUpdated is handled too).
    expect(factorySource!.abi.filter((item) => item.type === "event").map((item) => (item as AbiEvent).name).sort())
      .toEqual(["AuthorityUpdated", "VaultCreated"]);
  });

  // The same footing (env Clearinghouse 0x…c011 and factory 0x…f001, neither in the baked registry): the vaults
  // discovered on KINDED_TOPIC above are created by a VaultCreated on that same topic, and that event needs a source of
  // its own or no vault gets its v2HouseVault row. Earlier HouseVaultFactoryKinded was absent here.
  it("sources the unnamed factory's own 5-field VaultCreated, so its vaults get their v2HouseVault rows", async () => {
    const { default: config } = await import("../../ponder.config");
    const kinded = (config.contracts as unknown as Record<string, { abi: Abi; address: unknown; startBlock: number }>).HouseVaultFactoryKinded;
    expect(kinded, "HouseVaultFactoryKinded is configured for a factory the registry does not name").toBeDefined();
    expect(kinded!.address).toEqual([getAddress(process.env.V2_HOUSE_VAULT_FACTORY!)]);
    expect(kinded!.startBlock).toBe(Number(process.env.V2_HOUSE_START_BLOCK));
    expect(toEventSelector(abiEvent(kinded!.abi, "VaultCreated"))).toBe(KINDED_TOPIC);
  });

  it("v8: a registry that records the configured factory as its WEEKLY launch factory (no vault yet) discovers on the legacy event", async () => {
    const REGISTRY_MODULE = "../../lib/v2/marketRegistry.generated";
    const f001 = process.env.V2_HOUSE_VAULT_FACTORY!;
    vi.doMock(REGISTRY_MODULE, async (importOriginal) => {
      const real = (await importOriginal()) as { V2_REGISTRY: Record<string, any> };
      return {
        V2_REGISTRY: {
          ...real.V2_REGISTRY,
          contracts: { ...real.V2_REGISTRY.contracts, houseVaultFactory: f001 },
          house: { factories: [{ kind: "weekly", address: f001, deployBlock: 100 }], vaults: [] },
        },
      };
    });
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { default: config } = await import("../../ponder.config");
      const discovery = (config.contracts as unknown as Record<string, { address: unknown }>).HouseVault!.address as { event: AbiEvent };
      expect(toEventSelector(discovery.event)).toBe(LEGACY_TOPIC);
    } finally {
      warn.mockRestore();
      vi.doUnmock(REGISTRY_MODULE);
      vi.resetModules();
    }
  });
});

describe("House vault handler registrations", () => {
  it("registers every indexed event", () => {
    for (const name of [
      "HouseVaultFactory:VaultCreated",
      "HouseVaultFactoryKinded:VaultCreated",
      "HouseVault:DepositRequested",
      "HouseVault:DepositRequestCancelled",
      "HouseVault:WithdrawRequested",
      "HouseVault:WithdrawRequestCancelled",
      "HouseVault:EpochRolled",
      "HouseVault:Claimed",
      "HouseVault:LimitsSet",
      // PerformanceFeeBpsSet moved to src/v2/adminConfig.ts (a staged rate is a setting).
      "HouseVault:PerformanceFeeBpsApplied",
      "HouseVault:ProtocolAccountSet",
      "HouseVault:QuotingPausedSet",
      "HouseVault:ExposureSet",
      "HouseVault:Transfer",
      "HouseVault:DepositedNow",
    ]) expect(handlers.has(name), name).toBe(true);
  });
});

describe("one replay assertion per indexed event", () => {
  it("VaultCreated opens the registry and a running epoch 0", async () => {
    const db = memoryDb();
    const readAbis: unknown[] = [];
    const context = {
      db,
      client: {
        readContract: async ({ abi, functionName }: { abi: unknown; functionName: string }) => {
          readAbis.push(abi);
          if (functionName === "epochEnd") return 1_700_604_800n;
          if (functionName === "epochId") return 0n;
          throw new Error(functionName);
        },
      },
    };
    await handlers.get("HouseVaultFactory:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: VAULT, name: "Stonkhouse House NVDA", symbol: "hNVDA" }, FACTORY),
      context,
    });
    expect(readAbis).toEqual([houseVaultAbi, houseVaultAbi]);
    const vault = db.rows.get("v2HouseVault")?.get(VAULT);
    expect(vault).toMatchObject({
      vault: VAULT,
      underlying: UNDERLYING,
      sharesToken: VAULT,
      factory: FACTORY,
      symbol: "hNVDA",
      sharesSupply: null,
      currentEpochId: 0n,
      currentEpochEnd: 1_700_604_800n,
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`)).toMatchObject({ status: "running", resultUsdg: null });
    expect(db.rows.get("v2HouseNav")).toBeUndefined();
  });

  it("DepositRequested / cancel, WithdrawRequested / cancel", async () => {
    const db = memoryDb();
    const context = { db };
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`)).toMatchObject({
      status: "queued", usdgAmount: 100n, stockAmount: 0n, epochId: 0n,
    });
    await handlers.get("HouseVault:DepositRequestCancelled")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("cancelled");
    await handlers.get("HouseVault:WithdrawRequested")!({
      event: event({ account: BOB, shares: 5n, epochId: 0n }, VAULT),
      context,
    });
    await handlers.get("HouseVault:WithdrawRequestCancelled")!({
      event: event({ account: BOB, shares: 5n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseWithdrawQueue")?.get(`${VAULT}-${BOB}`).status).toBe("cancelled");
  });

  it("EpochRolled writes exactly one NAV row; usdg and stockUnits stay null", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: 0n }]]));
    db.rows.set("v2HouseEpoch", new Map([[`${VAULT}-0`, { id: `${VAULT}-0`, vault: VAULT, epochId: 0n, start: 1n, status: "running" }]]));
    const context = { db };
    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 99n, price: 50n, nav: 1_000n, supply: 1_000n,
        sharesMinted: 1_000n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context,
    });
    const navs = [...(db.rows.get("v2HouseNav")?.values() ?? [])];
    expect(navs).toHaveLength(1);
    expect(navs[0]).toMatchObject({
      epochId: 0n, usdg: null, stockUnits: null, settlementPrice: 50n, navUsdg: 1_000n,
      sourceEvent: "EpochRolled", performanceFee: 0n,
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`).status).toBe("rolled");
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).status).toBe("running");
    expect(db.rows.get("v2HouseQueueSettlement")?.size).toBe(1);
    expect([...(db.rows.get("v2HousePerformanceFee")?.values() ?? [])][0].amount).toBe(0n);
  });

  it("Claimed stores in-kind legs", async () => {
    const db = memoryDb();
    const context = { db };
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 10n, usdgAmount: 4n, stockAmount: 2n }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseClaim")?.values() ?? [])][0]).toMatchObject({
      account: ALICE, shares: 10n, usdgAmount: 4n, stockAmount: 2n,
    });
  });

  it("LimitsSet, PerformanceFeeBpsApplied, ProtocolAccountSet, QuotingPausedSet, ExposureSet", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, quotingPaused: null, performanceFeeBps: null }]]));
    const context = { db };
    await handlers.get("HouseVault:LimitsSet")!({
      event: event({
        limits: { maxSeriesUnits: 1n, maxTotalNotional: 2n, askToleranceBps: 3, maxBidBpsOfSpot: 4,
          maxOrderLifetime: 0xffff_ffff, maxDailyOutflow: 6n },
      }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseLimits")?.values() ?? [])][0]).toMatchObject({
      maxSeriesUnits: 1n, maxDailyOutflow: 6n, askToleranceBps: 3,
      maxOrderLifetime: 4_294_967_295n,
    });
    expect(actualSchema.v2HouseLimits.maxOrderLifetime.getSQLType()).toBe("numeric(78)");
    // The rate in force moves on PerformanceFeeBpsApplied, as rollEpoch opens the epoch. This asserted
    // it on PerformanceFeeBpsSet, which only stages a rate: it pinned the staged-fee-shown-as-charged defect.
    // The staging call is a setting now (src/v2/adminConfig.ts), tested in settables.handler.test.ts.
    await handlers.get("HouseVault:PerformanceFeeBpsApplied")!({ event: event({ bps: 200, epochId: 3n }, VAULT), context });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).performanceFeeBps).toBe(200);
    await handlers.get("HouseVault:ProtocolAccountSet")!({
      event: event({ account: BOB, blocked: true }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseProtocolAccount")?.values() ?? [])][0]).toMatchObject({
      account: BOB, blocked: true,
    });
    expect(db.rows.get("v2HouseSelfDealRefusal")).toBeUndefined();
    await handlers.get("HouseVault:QuotingPausedSet")!({ event: event({ paused: true }, VAULT), context });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).quotingPaused).toBe(true);
    await handlers.get("HouseVault:ExposureSet")!({
      event: event({ longId: 9n, units: 8n, notional: 7n, totalNotional: 6n }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseExposure")?.values() ?? [])][0]).toMatchObject({ longId: 9n, units: 8n });
  });

  it("Transfer updates holder balances and supply; never writes NAV", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: null }]]));
    const context = { db };
    await handlers.get("HouseVault:Transfer")!({
      event: event({ from: ZERO, to: ALICE, value: 50n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).sharesSupply).toBe(50n);
    expect(db.rows.get("v2HouseShareBalance")?.get(`${VAULT}-${ALICE}`).shares).toBe(50n);
    expect(db.rows.get("v2HouseNav")).toBeUndefined();
  });
});

/*
 * HouseVault.depositNow in its own transaction order: `_mint(DEAD_SHARES, MIN_SHARES)` on a bootstrap,
 * `_mint(msg.sender, shares)`, then `emit DepositedNow` (HouseVault.sol depositNow). The mints are Transfers, which the
 * Transfer handler books; DepositedNow records the deposit fact and must NOT credit the shares a second time.
 */
describe("an instant deposit's shares appear at once, counted once, with the deposit recorded", () => {
  const DEAD = "0x000000000000000000000000000000000000dead";
  // The vault's fixed first mint pays 10 ** (share decimals - USDG decimals) shares per USDG base
  // unit, and MIN_SHARES is 1e3 USDG base units at that rate. The handler is unit-blind; the fixture uses real magnitudes.
  const SCALE = 10n ** (18n - 6n);
  const MIN_SHARES = 1_000n * SCALE;
  const ALICE_SHARES = 250_000_000n * SCALE;
  const BOB_SHARES = 99_000_000n * SCALE;

  async function depositNow(db: ReturnType<typeof memoryDb>, account: string, usdg: bigint, shares: bigint,
    epochId: bigint, bootstrap: boolean) {
    const context = { db };
    if (bootstrap) {
      await handlers.get("HouseVault:Transfer")!({ event: event({ from: ZERO, to: DEAD, value: MIN_SHARES }, VAULT), context });
    }
    await handlers.get("HouseVault:Transfer")!({ event: event({ from: ZERO, to: account, value: shares }, VAULT), context });
    await handlers.get("HouseVault:DepositedNow")!({
      event: event({ account, usdgAmount: usdg, shares, epochId }, VAULT),
      context,
    });
  }

  it("bootstrap then a flat top-up: balances and supply count each mint once; one instant-deposit row per deposit", async () => {
    logIndex = 0;
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: null, currentEpochId: 3n }]]));
    // Bootstrap (supply 0): minted at the fixed rate, SCALE shares per USDG base unit received, plus the dead shares.
    await depositNow(db, ALICE, 250_000_000n, ALICE_SHARES, 3n, true);
    const balance = (who: string) => db.rows.get("v2HouseShareBalance")?.get(`${VAULT}-${who}`)?.shares;
    expect(balance(ALICE), "the depositor holds the minted shares at once, ONCE").toBe(ALICE_SHARES);
    expect(balance(DEAD)).toBe(MIN_SHARES);
    expect(db.rows.get("v2HouseVault")!.get(VAULT).sharesSupply).toBe(ALICE_SHARES + MIN_SHARES);

    // A flat, Stock-free top-up by another holder, same epoch: floor(received x supply / cashNav). The log carries the
    // account in checksum case; every House row keys it lowercase.
    await depositNow(db, BOB.replace("b0", "B0"), 100_000_000n, BOB_SHARES, 3n, false);
    expect(balance(BOB)).toBe(BOB_SHARES);
    expect(balance(ALICE)).toBe(ALICE_SHARES);
    expect(db.rows.get("v2HouseVault")!.get(VAULT).sharesSupply).toBe(ALICE_SHARES + MIN_SHARES + BOB_SHARES);

    const deposits = [...(db.rows.get("v2HouseInstantDeposit")?.values() ?? [])];
    expect(deposits).toHaveLength(2);
    expect(deposits[0]).toMatchObject({ vault: VAULT, account: ALICE, usdgAmount: 250_000_000n, shares: ALICE_SHARES,
      epochId: 3n, tx, block: 64_100_000n });
    expect(deposits[1]).toMatchObject({ vault: VAULT, account: BOB, usdgAmount: 100_000_000n, shares: BOB_SHARES, epochId: 3n });
    expect(BOB.replace("b0", "B0"), "fixture: the log's case really differs").not.toBe(BOB);
  });

  it("touches no queue, NAV, epoch or settlement table: depositNow never enters a queue or a boundary", async () => {
    logIndex = 0;
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: null, currentEpochId: 0n }]]));
    await depositNow(db, ALICE, 5_000_000n, 5_000_000n * SCALE, 0n, true);
    for (const table of ["v2HouseDepositQueue", "v2HouseWithdrawQueue", "v2HouseNav", "v2HouseEpoch",
      "v2HouseQueueSettlement", "v2HouseClaim", "v2HousePerformanceFee"]) {
      expect(db.rows.get(table), table).toBeUndefined();
    }
    expect(db.rows.get("v2HouseVault")!.get(VAULT).currentEpochId, "the epoch pointer is not moved").toBe(0n);
  });

  it("the DepositedNow handler alone moves no share balance (a Transfer-less replay proves it is not a second credit)", async () => {
    logIndex = 0;
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: 7n }]]));
    await handlers.get("HouseVault:DepositedNow")!({
      event: event({ account: ALICE, usdgAmount: 10n, shares: 10n, epochId: 1n }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseShareBalance")).toBeUndefined();
    expect(db.rows.get("v2HouseVault")!.get(VAULT).sharesSupply).toBe(7n);
    expect([...(db.rows.get("v2HouseInstantDeposit")?.values() ?? [])]).toHaveLength(1);
  });
});

describe("two depositors, three epochs, one win and one loss; mid-epoch deposit does not write NAV", () => {
  it("walks the queue, two boundaries, and a mid-epoch deposit", async () => {
    logIndex = 0;
    const db = memoryDb();
    const context = {
      db,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "epochEnd") return 1_000n;
          if (functionName === "epochId") return 0n;
          throw new Error(functionName);
        },
      },
    };
    await handlers.get("HouseVaultFactory:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: VAULT, name: "H", symbol: "hNVDA" }, FACTORY),
      context,
    });
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: BOB, usdgAmount: 50n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size ?? 0).toBe(0);

    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 1_000n, price: 10n, nav: 200n, supply: 150n,
        sharesMinted: 150n, sharesBurned: 0n, performanceFee: 5n,
      }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size).toBe(1);
    expect([...(db.rows.get("v2HouseNav")?.values() ?? [])][0].navUsdg).toBe(200n);

    const charlie = "0x00000000000000000000000000000000000000c1";
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: charlie, usdgAmount: 20n, stockAmount: 0n, epochId: 1n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size).toBe(1);

    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 1n, epochEnd: 2_000n, price: 8n, nav: 140n, supply: 170n,
        sharesMinted: 20n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context,
    });
    const navs = [...(db.rows.get("v2HouseNav")?.values() ?? [])];
    expect(navs).toHaveLength(2);
    expect(navs.map((row) => row.navUsdg)).toEqual([200n, 140n]);
    expect(navs.every((row) => row.sourceEvent === "EpochRolled")).toBe(true);
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).status).toBe("rolled");
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-2`).status).toBe("running");
    expect(db.rows.get("v2HouseSelfDealRefusal")).toBeUndefined();
  });



  /**
   * `HouseVault.claim` retires a side on "a request existed AND its epoch is past",
   * then computes the payout, which floors to zero routinely. The event carries AMOUNTS, NOT a
   * retirement flag, so gating `closeQueue` on them left a zero-output row `queued` FOREVER - and the
   * next request added to the phantom amount, corrupting a tape only a full re-index repairs.
   */
  it("a claim that pays zero still closes the matured queue row", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 1n }]]));
    db.rows.set("v2HouseDepositQueue", new Map([[`${VAULT}-${ALICE}`, {
      id: `${VAULT}-${ALICE}`, vault: VAULT, account: ALICE, epochId: 0n,
      usdgAmount: 5n, stockAmount: 0n, status: "queued",
    }]]));
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 0n, usdgAmount: 0n, stockAmount: 0n }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("claimed");
  });

  /** The other direction: maturity, not the claim, is what closes a row. */
  it("a request made in the OPEN epoch is not closed by a claim that retired the other side", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 1n }]]));
    db.rows.set("v2HouseDepositQueue", new Map([[`${VAULT}-${ALICE}`, {
      id: `${VAULT}-${ALICE}`, vault: VAULT, account: ALICE, epochId: 1n,
      usdgAmount: 5n, stockAmount: 0n, status: "queued",
    }]]));
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 0n, usdgAmount: 7n, stockAmount: 0n }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("queued");
  });

  /**
   * The roll wrote the new epoch's `end` as null though `roll()` sets it in the SAME
   * transaction. Note the `client` mock: the existing EpochRolled case above passes no client, so the
   * read throws into its catch and that case stays green whatever this handler does - which is exactly
   * why this one supplies the client and asserts the value.
   */
  it("the roll fills the new epoch's end from epochEnd(), not null", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 0n, currentEpochEnd: 1_000n }]]));
    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 1_000n, price: 50n, nav: 1_000n, supply: 10n,
        sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context: { db, client: { readContract: async () => 2_000n } },
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`).end).toBe(1_000n);
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).end).toBe(2_000n);
    expect(db.rows.get("v2HouseVault")?.get(VAULT).currentEpochEnd).toBe(2_000n);
  });

  /**
   * THE ARCHETYPE. `recordHouseFills` was exported and called by nothing - the whole
   * repository held one occurrence of the name, its own definition - so `v2_house_fill` was silently
   * always empty. This replays the REAL OrderFilled handler rather than the pure projector below,
   * because the projector was never the broken part: the CALL SITE was. Delete the call and this goes
   * red while every houseFillRows test stays green.
   */
  it("a House vault's OrderFilled writes the fill tape", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT }]]));
    db.rows.set("v2Order", new Map([["7", {
      orderId: 7n, longId: 3n, maker: VAULT, units: 10n, filled: 0n, status: "open",
    }]]));
    db.rows.set("v2Series", new Map([["3", {
      longId: 3n, underlying: "NVDA", volumeUnits: 0n, volumeUsdg: 0n,
    }]]));
    db.rows.set("v2Market", new Map([["NVDA", {
      underlying: "NVDA", volumeUnits: 0n, volumeUsdg: 0n, premiumUsdg: 0n, feesUsdg: 0n,
    }]]));
    await handlers.get("OrderBook:OrderFilled")!({
      event: event({
        orderId: 7n, longId: 3n, taker: ALICE, maker: VAULT, units: 2n, price: 5n, premium: 10n,
        sellerFee: 1n, makerRebate: 0n, primary: true, takerIsBuyer: true, recipient: ALICE,
      }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseFill")?.size ?? 0).toBeGreaterThan(0);
  });
});

describe("houseFillRows", () => {
  it("projects an OrderFilled onto a registered vault and ignores others", () => {
    const fillEvent = {
      args: {
        orderId: 1n, longId: 2n, maker: VAULT as `0x${string}`, taker: ALICE as `0x${string}`,
        units: 3n, price: 4n, premium: 5n, sellerFee: 6n, makerRebate: 7n,
      },
      block: { timestamp: 9n, number: 8n },
      log: { logIndex: 0, address: "0x0000000000000000000000000000000000000b00" as `0x${string}` },
      transaction: { hash: tx as `0x${string}` },
    };
    expect(houseFillRows(fillEvent, new Set([VAULT]))).toEqual([
      expect.objectContaining({ vault: VAULT, side: "maker", makerRebate: 7n, units: 3n }),
    ]);
    expect(houseFillRows(fillEvent, new Set())).toEqual([]);
  });
});

describe("meta", () => {
  it("keys a row by transaction and log index", () => {
    expect(meta(event({}, VAULT) as never)).toEqual(expect.objectContaining({
      sourceAddress: VAULT,
      tx,
    }));
  });
});

describe("a VaultCreated the registry list does not name raises HOUSE_VAULT_UNREGISTERED", () => {
  // The launch factory and NVDA's House vault, read from indexer/lib/v2/marketRegistry.generated.ts (typed
  // as v8 literals before, so the v9 regen left them naming a factory the registry no longer lists). The registered
  // case is the positive control: it proves the replay reads the real list, so the unregistered case failing to
  // alert could not be an empty list passing for the wrong reason.
  const REGISTRY_FACTORY = getAddress(V2_REGISTRY.contracts.houseVaultFactory as string);
  const NVDA_VAULT = getAddress(V2_REGISTRY.house.vaults.find((v) => v.ticker === "NVDA")!.address);
  const STRAY_VAULT = "0x000000000000000000000000000000000000b0b1";

  /** Re-import the handlers under `factory` (the source decision is read from env once per module load). */
  async function replayWith(factory: string, vault: string) {
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", factory);
    vi.resetModules();
    await import("./houseVault");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = memoryDb();
      const context = { db, client: { readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "epochEnd" ? 1_700_604_800n : 0n } };
      await handlers.get("HouseVaultFactory:VaultCreated")!({
        event: event({ underlying: UNDERLYING, vault, name: "Stonkhouse House NVDA", symbol: "hNVDA" }, factory),
        context,
      });
      return {
        alerts: errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("HOUSE_VAULT_UNREGISTERED")),
        row: db.rows.get("v2HouseVault")?.get(vault.toLowerCase()),
      };
    } finally {
      errors.mockRestore();
    }
  }

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await import("./houseVault");
  });

  it("alerts, naming the vault, and still records the vault row", async () => {
    const { alerts, row } = await replayWith(REGISTRY_FACTORY, STRAY_VAULT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`HOUSE_VAULT_UNREGISTERED vault=${STRAY_VAULT}`);
    expect(alerts[0]).toContain(`factory=${REGISTRY_FACTORY.toLowerCase()}`);
    expect(row).toMatchObject({ vault: STRAY_VAULT, factory: REGISTRY_FACTORY.toLowerCase() });
  });

  it("is silent for a vault the registry lists (positive control)", async () => {
    const { alerts, row } = await replayWith(REGISTRY_FACTORY, NVDA_VAULT);
    expect(alerts).toEqual([]);
    expect(row).toMatchObject({ vault: NVDA_VAULT.toLowerCase() });
  });

  it("is silent under the factory() fallback, where every created vault is discovered and indexed", async () => {
    const { alerts } = await replayWith(FACTORY, STRAY_VAULT);
    expect(alerts).toEqual([]);
  });
});

describe("a kinded (daily) factory's VaultCreated writes the vault row with its kind", () => {
  // A kinded factory as a daily-only registry records it; the generated registry is swapped for one that names it, so
  // the handler's kinded set (houseVaultKind.ts KINDED_HOUSE_FACTORIES) is derived exactly as in production.
  const DAILY_FACTORY = "0x000000000000000000000000000000000000dA11";
  const DAILY_VAULT = "0x000000000000000000000000000000000000b0d1";

  async function replayKinded(weekly: boolean) {
    vi.doMock("../../lib/v2/marketRegistry.generated", async (importOriginal) => {
      const real = (await importOriginal()) as { V2_REGISTRY: Record<string, any> };
      return {
        V2_REGISTRY: {
          ...real.V2_REGISTRY,
          contracts: { ...real.V2_REGISTRY.contracts, houseVaultFactory: null },
          house: {
            factories: [{ kind: "daily", address: DAILY_FACTORY, deployBlock: 70_000_000 }],
            vaults: [{ ticker: "NVDA", kind: "daily", address: DAILY_VAULT }],
          },
        },
      };
    });
    vi.resetModules();
    await import("./houseVault");
    const reads: string[] = [];
    const db = memoryDb();
    const context = {
      db,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          reads.push(functionName);
          if (functionName === "epochEnd") return 1_700_086_400n;
          if (functionName === "epochId") return 0n;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
    };
    await handlers.get("HouseVaultFactoryKinded:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: DAILY_VAULT, name: "Stonkhouse House NVDA Daily", symbol: "hNVDAd", weekly }, DAILY_FACTORY),
      context,
    });
    return { reads, row: db.rows.get("v2HouseVault")?.get(DAILY_VAULT), epoch: db.rows.get("v2HouseEpoch")?.get(`${DAILY_VAULT}-0`) };
  }

  afterAll(async () => {
    vi.doUnmock("../../lib/v2/marketRegistry.generated");
    vi.resetModules();
    await import("./houseVault");
  });

  it("weekly=false is a daily vault: the row is written with kind daily, from the event, and weekly() is never read", async () => {
    const { reads, row, epoch } = await replayKinded(false);
    expect(row).toMatchObject({ vault: DAILY_VAULT, factory: DAILY_FACTORY.toLowerCase(), kind: "daily", symbol: "hNVDAd", currentEpochId: 0n });
    expect(epoch).toMatchObject({ status: "running" });
    expect(reads).toEqual(["epochEnd", "epochId"]);
  });

  it("weekly=true is a weekly vault of the same factory (the event decides, not the factory)", async () => {
    const { row } = await replayKinded(true);
    expect(row).toMatchObject({ vault: DAILY_VAULT, kind: "weekly" });
  });
});

describe("v9: the LAUNCH factory emits the 5-field VaultCreated, and its daily vault is recorded daily", () => {
  // The v9 registry shape: the redeploy's factory is v2.contracts.houseVaultFactory (so it is in the legacy set) and the
  // registry calls it daily. Under the legacy rule alone its daily vault was labelled weekly.
  const V9_FACTORY = "0x000000000000000000000000000000000000F009";
  const V9_VAULT = "0x000000000000000000000000000000000000b0d9";

  afterAll(async () => {
    vi.doUnmock("../../lib/v2/marketRegistry.generated");
    vi.resetModules();
    await import("./houseVault");
  });

  it("weekly=false from the launch factory is a daily vault, from the event, and weekly() is never read", async () => {
    vi.doMock("../../lib/v2/marketRegistry.generated", async (importOriginal) => {
      const real = (await importOriginal()) as { V2_REGISTRY: Record<string, any> };
      return {
        V2_REGISTRY: {
          ...real.V2_REGISTRY,
          contracts: { ...real.V2_REGISTRY.contracts, houseVaultFactory: V9_FACTORY },
          house: {
            factories: [{ kind: "daily", address: V9_FACTORY, deployBlock: 70_100_000 }],
            vaults: [{ ticker: "NVDA", kind: "daily", address: V9_VAULT }],
          },
        },
      };
    });
    vi.resetModules();
    const kindModule = await import("./houseVaultKind");
    expect(kindModule.legacyHouseFactories().has(V9_FACTORY.toLowerCase()), "the v9 factory IS in the legacy set").toBe(true);
    await import("./houseVault");
    const reads: string[] = [];
    const db = memoryDb();
    const context = {
      db,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          reads.push(functionName);
          if (functionName === "epochEnd") return 1_700_086_400n;
          if (functionName === "epochId") return 0n;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
    };
    await handlers.get("HouseVaultFactoryKinded:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: V9_VAULT, name: "Stonkhouse House NVDA Daily", symbol: "hNVDAd", weekly: false }, V9_FACTORY),
      context,
    });
    expect(db.rows.get("v2HouseVault")?.get(V9_VAULT)).toMatchObject({ vault: V9_VAULT, factory: V9_FACTORY.toLowerCase(), kind: "daily" });
    expect(reads).toEqual(["epochEnd", "epochId"]);
  });
});

/*
 * HouseVault.requestDeposit / requestWithdraw add to a request only inside the epoch it was opened in; a
 * request from an earlier epoch reverts TooEarly until it is claimed. The ingest used to add to ANY queued row, so a
 * matured row whose close was missed (closeMaturedQueue leaves it queued when the vault row has no epoch) swallowed the
 * next epoch's request into a phantom total.
 */
describe("a request tops up only a queued row of the same epoch", () => {
  it("adds within one epoch", async () => {
    const db = memoryDb();
    for (const usdgAmount of [100n, 50n]) {
      await handlers.get("HouseVault:DepositRequested")!({
        event: event({ account: ALICE, usdgAmount, stockAmount: 0n, epochId: 3n }, VAULT), context: { db },
      });
    }
    for (const shares of [5n, 7n]) {
      await handlers.get("HouseVault:WithdrawRequested")!({
        event: event({ account: BOB, shares, epochId: 3n }, VAULT), context: { db },
      });
    }
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`)).toMatchObject({
      status: "queued", epochId: 3n, usdgAmount: 150n, stockAmount: 0n,
    });
    expect(db.rows.get("v2HouseWithdrawQueue")?.get(`${VAULT}-${BOB}`)).toMatchObject({
      status: "queued", epochId: 3n, shares: 12n,
    });
  });

  it("never adds a later epoch's request to an earlier epoch's row left queued", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseDepositQueue", new Map([[`${VAULT}-${ALICE}`, {
      id: `${VAULT}-${ALICE}`, vault: VAULT, account: ALICE, epochId: 2n,
      usdgAmount: 5n, stockAmount: 9n, status: "queued",
    }]]));
    db.rows.set("v2HouseWithdrawQueue", new Map([[`${VAULT}-${BOB}`, {
      id: `${VAULT}-${BOB}`, vault: VAULT, account: BOB, epochId: 2n, shares: 4n, status: "queued",
    }]]));
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n, epochId: 3n }, VAULT), context: { db },
    });
    await handlers.get("HouseVault:WithdrawRequested")!({
      event: event({ account: BOB, shares: 6n, epochId: 3n }, VAULT), context: { db },
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`)).toMatchObject({
      status: "queued", epochId: 3n, usdgAmount: 100n, stockAmount: 0n,
    });
    expect(db.rows.get("v2HouseWithdrawQueue")?.get(`${VAULT}-${BOB}`)).toMatchObject({
      status: "queued", epochId: 3n, shares: 6n,
    });
  });

  it("EpochOpened is stored before VaultCreated, and the factory row uses that end", async () => {
    const db = memoryDb();
    const client = { readContract: async () => { throw new Error("no code yet"); } };
    await handlers.get("HouseVault:EpochOpened")!({
      event: event({ epochId: 0n, epochEnd: 1_800_000_000n }, VAULT),
      context: { db, client },
    });
    expect(db.rows.get("v2HouseVault")?.get(VAULT)).toBeUndefined();
    expect(db.rows.get("v2HouseEpochOpened")?.get(VAULT)).toMatchObject({
      epochId: 0n, epochEnd: 1_800_000_000n,
    });
    await handlers.get("HouseVaultFactory:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: VAULT, name: "NVDA House", symbol: "hNVDA" }, FACTORY),
      context: { db, client },
    });
    expect(db.rows.get("v2HouseVault")?.get(VAULT)).toMatchObject({
      currentEpochId: 0n, currentEpochEnd: 1_800_000_000n,
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`)).toMatchObject({ end: 1_800_000_000n, status: "running" });
  });

  /**
   * The roll emits EpochRolled before EpochOpened (HouseVault.sol:1381-1382), so when the roll's
   * epochEnd() read fails the new epoch row and the vault row are written with a null end, and only the
   * EpochOpened that follows can fill them. Deleting either backfill in the EpochOpened handler turns this red.
   * The replayed EpochOpened for the closed epoch shows the backfill touches only a null end and the current epoch.
   */
  it("EpochOpened after a roll whose epochEnd() read failed fills the null end on the epoch and vault rows", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 0n, currentEpochEnd: 1_000n }]]));
    const client = { readContract: async () => { throw new Error("rpc down"); } };
    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 1_000n, price: 50n, nav: 1_000n, supply: 10n,
        sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context: { db, client },
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).end).toBeNull();
    expect(db.rows.get("v2HouseVault")?.get(VAULT)).toMatchObject({ currentEpochId: 1n, currentEpochEnd: null });

    await handlers.get("HouseVault:EpochOpened")!({
      event: event({ epochId: 1n, epochEnd: 2_000n }, VAULT),
      context: { db, client },
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`)).toMatchObject({ end: 2_000n, status: "running" });
    expect(db.rows.get("v2HouseVault")?.get(VAULT)).toMatchObject({ currentEpochId: 1n, currentEpochEnd: 2_000n });

    await handlers.get("HouseVault:EpochOpened")!({
      event: event({ epochId: 0n, epochEnd: 999n }, VAULT),
      context: { db, client },
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`).end).toBe(1_000n);
    expect(db.rows.get("v2HouseVault")?.get(VAULT)).toMatchObject({ currentEpochId: 1n, currentEpochEnd: 2_000n });
  });

  it("PerformanceFeePaid and EpochBatchesPriced each write their own row", async () => {
    const db = memoryDb();
    await handlers.get("HouseVault:PerformanceFeePaid")!({
      event: event({ epochId: 4n, paid: 12n, owed: 3n }, VAULT),
      context: { db },
    });
    await handlers.get("HouseVault:EpochBatchesPriced")!({
      event: event({
        epochId: 4n, depositValue: 50n, depositRefused: false, withdrawUsdg: 7n, withdrawStock: 9n,
      }, VAULT),
      context: { db },
    });
    const paid = [...(db.rows.get("v2HousePerformanceFeePaid")?.values() ?? [])][0];
    const batches = [...(db.rows.get("v2HouseEpochBatches")?.values() ?? [])][0];
    expect(paid).toMatchObject({ vault: VAULT, epochId: 4n, paid: 12n, owed: 3n });
    expect(batches).toMatchObject({
      vault: VAULT, epochId: 4n, depositValue: 50n, depositRefused: false, withdrawUsdg: 7n, withdrawStock: 9n,
    });
  });
});
