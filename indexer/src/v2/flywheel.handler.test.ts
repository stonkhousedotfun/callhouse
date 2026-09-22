import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toEventSelector } from "viem";

import { buybackExecutorAbi } from "../../abis/v2/buybackExecutor";
import { erc20Abi } from "../../abis/erc20";
import { orderBookAbi } from "../../abis/v2/orderBook";
import { feeSplitterAbi } from "../../abis/v2/feeSplitter";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (event: string, handler: Handler) => handlers.set(event, handler) } };
});
vi.mock("../../lib/registry", () => ({
  v2PayoutRouterPonder: registry,
  v2FeeSplitterPonder: registry,
  v2BuybackExecutorPonder: registry,
  v2MakerVaultPonder: registry,
  v2RewardsPonder: registry,
  v2RewardsDistributorPonder: registry,
}));
vi.mock("../../lib/env", () => ({
  USDG: "0x000000000000000000000000000000000000d001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011",
  V2_FLYWHEEL_TOKEN_ADDRESS: "0x000000000000000000000000000000000000f001",
}));

vi.mock("ponder:schema", () => ({ default: {
  v2PayoutRoute: "v2PayoutRoute", v2FlywheelDistribution: "v2FlywheelDistribution",
  v2FlywheelDistributionSkip: "v2FlywheelDistributionSkip", v2FlywheelBuyback: "v2FlywheelBuyback",
  v2FlywheelBurn: "v2FlywheelBurn", v2FlywheelBuybackSkip: "v2FlywheelBuybackSkip",
  v2FlywheelExecution: "v2FlywheelExecution", v2FlywheelExecutorBurn: "v2FlywheelExecutorBurn",
  v2TreasuryExit: "v2TreasuryExit", v2FlywheelStrandedFees: "v2FlywheelStrandedFees",
} }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const rowKey = (row: any) => String(row.id ?? row.asset);
  return {
    rows,
    insert: (name: string) => ({ values: (row: any) => {
      const key = rowKey(row);
      const previous = table(name).get(key);
      if (previous === undefined) table(name).set(key, row);
      return {
        then: (resolve: (value: any) => void) => resolve(row),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(key, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
  };
}

const tx = `0x${"c".repeat(64)}`;
let nextLog = 0;
const event = (args: object, address: string) => ({
  args,
  block: { timestamp: 700n, number: 800n },
  transaction: { hash: tx },
  log: { logIndex: nextLog++, address },
});

const transferLog = (from: string, to: string, value: bigint, logIndex: number) => ({
  address: "0x000000000000000000000000000000000000d001",
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
  logIndex,
});

/** An OwedClaimed log as the BOOK emits it: `account` is the claimant, the book is `address`. */
const owedClaimedLog = (book: string, account: string, amount: bigint, logIndex: number) => ({
  address: book,
  topics: encodeEventTopics({ abi: orderBookAbi, eventName: "OwedClaimed", args: { account } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  logIndex,
});

/** An OrderBookFeesStranded log as the SPLITTER emits it; `orderBook` is the indexed arg. */
const strandedLog = (splitter: string, book: string, amount: bigint, logIndex: number) => ({
  address: splitter,
  topics: encodeEventTopics({ abi: feeSplitterAbi, eventName: "OrderBookFeesStranded", args: { orderBook: book } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  logIndex,
});

beforeAll(async () => {
  await import("./flywheel");
  await import("./treasury");
});

describe("v8 flywheel, router, and treasury exit reducers", () => {
  it("pins the generated executor event ABI", () => {
    const bought = buybackExecutorAbi.find((item) => item.type === "event" && item.name === "Bought")!;
    const burned = buybackExecutorAbi.find((item) => item.type === "event" && item.name === "Burned")!;
    expect(bought.inputs.map((input) => [input.name, input.type, input.indexed])).toEqual([
      ["usdgIn", "uint256", false], ["usdgSpent", "uint256", false], ["wethOut", "uint256", false],
      ["tokenOut", "uint256", false], ["minWethOut", "uint256", false],
      ["declaredFeeBps", "uint256", false], ["measuredFeeBps", "uint256", false],
    ]);
    expect(toEventSelector(bought)).toBe("0xf91ffcb1e1ceec00139217b998fe9d9fa895a8908f3e45b6331f277c93fca427");
    expect(toEventSelector(burned)).toBe("0xd83c63197e8e676d80ab0122beba9a9d20f3828839e9a1d6fe81d242e9cd7e6e");
  });

  it("decodes the five-field router tuple and clears every route field", async () => {
    const db = memoryDb();
    const router = "0x000000000000000000000000000000000000a010";
    const asset = "0x000000000000000000000000000000000000a011";
    const pool = "0x000000000000000000000000000000000000a012";
    const context = { db, client: { readContract: async ({ functionName }: any) => {
      if (functionName === "routes") return { venue: 1, fee: 100, tickSpacing: 0, v3Pool: pool, feeBps: 1 };
      throw new Error(`unexpected ${functionName}`);
    } } };
    await handlers.get("PayoutRouter:RouteSet")!({
      event: event({ asset, venue: 1, poolId: `0x${"0".repeat(24)}${pool.slice(2)}`, fee: 100, feeBps: 1 }, router),
      context,
    });
    expect(db.rows.get("v2PayoutRoute")?.get(asset)).toMatchObject({
      active: true, venue: 1, fee: 100, tickSpacing: 0, v3Pool: pool, feeBps: 1,
    });
    await handlers.get("PayoutRouter:RouteCleared")!({ event: event({ asset }, router), context });
    expect(db.rows.get("v2PayoutRoute")?.get(asset)).toMatchObject({
      active: false, venue: 0, fee: 0, tickSpacing: 0,
      v3Pool: "0x0000000000000000000000000000000000000000", feeBps: 0,
    });
  });

  it("attributes a distribution to its transfer recipient across a same-block treasury rotation", async () => {
    const db = memoryDb();
    const splitter = "0x000000000000000000000000000000000000a020";
    const asset = "0x000000000000000000000000000000000000a021";
    const treasuryAtDistribution = "0x000000000000000000000000000000000000a022";
    const treasuryAfterRotation = "0x000000000000000000000000000000000000a023";
    const reason = `0x${"1".repeat(64)}`;
    const reads: string[] = [];
    const distributed = event({ asset, assetIn: 100n, usdgIn: 80n, treasuryOut: 40n, buybackAdded: 40n }, splitter);
    const context = { db, client: { readContract: async ({ functionName }: any) => {
      reads.push(functionName);
      if (functionName === "treasury") return treasuryAfterRotation;
      if (functionName === "totalSupply") return 900n;
      throw new Error(`unexpected ${functionName}`);
    }, getTransactionReceipt: async () => ({ logs: [
      transferLog(splitter, treasuryAtDistribution, 40n, distributed.log.logIndex - 1),
      // Same token, sender, and amount after Distributed: the rotation is already visible at block end.
      transferLog(splitter, treasuryAfterRotation, 40n, distributed.log.logIndex + 1),
    ] }) } };
    await handlers.get("FeeSplitter:Distributed")!({
      event: distributed, context,
    });
    await handlers.get("FeeSplitter:DistributionSkipped")!({ event: event({ asset, reason }, splitter), context });
    await handlers.get("FeeSplitter:BoughtBack")!({ event: event({ usdgIn: 40n, tokenOut: 5n }, splitter), context });
    await handlers.get("FeeSplitter:Burned")!({ event: event({ amount: 5n }, splitter), context });
    await handlers.get("FeeSplitter:BuybackSkipped")!({ event: event({ reason }, splitter), context });

    expect(reads).toEqual(["totalSupply"]);
    expect([...(db.rows.get("v2FlywheelBurn")?.values() ?? [])][0]).toMatchObject({
      token: "0x000000000000000000000000000000000000f001",
      amount: 5n, totalSupplyAtBlock: 900n,
    });
    expect([...(db.rows.get("v2FlywheelDistributionSkip")?.values() ?? [])][0].reason).toBe(reason);
    expect([...(db.rows.get("v2TreasuryExit")?.values() ?? [])][0]).toMatchObject({
      source: "feeSplitter", eventKind: "distributed", assetKind: "erc20",
      asset: "0x000000000000000000000000000000000000d001",
      recipient: treasuryAtDistribution, amount: 40n,
    });
  });

  it("keeps executor burn audit separate from the canonical splitter burn", async () => {
    const db = memoryDb();
    const executor = "0x000000000000000000000000000000000000a030";
    const context = { db };
    await handlers.get("BuybackExecutor:Bought")!({
      event: event({ usdgIn: 20n, usdgSpent: 19n, wethOut: 18n, tokenOut: 17n,
        minWethOut: 16n, declaredFeeBps: 201n, measuredFeeBps: 202n }, executor), context,
    });
    await handlers.get("BuybackExecutor:Burned")!({ event: event({ amount: 17n }, executor), context });
    expect([...(db.rows.get("v2FlywheelExecution")?.values() ?? [])][0]).toMatchObject({
      usdgIn: 20n, usdgSpent: 19n, tokenOut: 17n, measuredFeeBps: 202n,
    });
    expect([...(db.rows.get("v2FlywheelExecutorBurn")?.values() ?? [])][0].amount).toBe(17n);
    expect(db.rows.get("v2FlywheelBurn")).toBeUndefined();
  });

  it("normalizes vault, keeper, and distributor exits into one table", async () => {
    const db = memoryDb();
    const context = { db };
    const recipient = "0x000000000000000000000000000000000000a099";
    const asset = "0x000000000000000000000000000000000000a098";
    await handlers.get("MakerVault:Withdrawn")!({
      event: event({ asset, to: recipient, amount: 11n }, "0x000000000000000000000000000000000000a040"), context,
    });
    await handlers.get("MakerVault:PositionWithdrawn")!({
      event: event({ tokenId: 12n, to: recipient, units: 13n }, "0x000000000000000000000000000000000000a040"), context,
    });
    await handlers.get("KeeperRewards:Defunded")!({
      event: event({ to: recipient, amount: 14n }, "0x000000000000000000000000000000000000a041"), context,
    });
    await handlers.get("RewardsDistributor:Defunded")!({
      event: event({ to: recipient, amount: 15n }, "0x000000000000000000000000000000000000a042"), context,
    });
    const exits = [...(db.rows.get("v2TreasuryExit")?.values() ?? [])];
    expect(exits.map((row) => [row.source, row.eventKind, row.assetKind, row.amount])).toEqual([
      ["makerVault", "withdrawn", "erc20", 11n],
      ["makerVault", "positionWithdrawn", "erc1155", 13n],
      ["keeperRewards", "defunded", "erc20", 14n],
      ["rewardsDistributor", "defunded", "erc20", 15n],
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // T-510. FeeSplitter._drainOrderBook emits OrderBookFeesStranded at three sites whose payloads
  // (orderBook, amount) cannot be told apart on their own. The handler separates them by whether
  // OrderBook.claimOwed's OwedClaimed log is present in the same transaction: it is emitted BEFORE
  // the transfer, so a revert inside the splitter's try/catch rolls it back with everything else.
  describe("T-510 stranded fee sweeps", () => {
    const splitter = "0x000000000000000000000000000000000000a030";
    const bookA = "0x000000000000000000000000000000000000a031";
    const bookB = "0x000000000000000000000000000000000000a032";
    const ctx = (db: any, logs: any[]) => ({
      db,
      client: { getTransactionReceipt: async () => ({ logs }) },
    });
    const stranded = (db: any) => [...(db.rows.get("v2FlywheelStrandedFees")?.values() ?? [])];

    it("amount 0 is OWED_UNREADABLE and never reads the receipt", async () => {
      const db = memoryDb();
      // No receipt is provided at all: if the handler fetched one for a zero amount this throws,
      // which is the point - the zero case must be decided without the transaction.
      const context = { db, client: { getTransactionReceipt: async () => { throw new Error("must not fetch"); } } };
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({
        event: event({ orderBook: bookA, amount: 0n }, splitter), context,
      });
      expect(stranded(db)).toMatchObject([{ orderBook: bookA, kind: "OWED_UNREADABLE", amount: 0n }]);
    });

    it("a preceding OwedClaimed from the same book means the claim committed: CLAIM_SHORT", async () => {
      const db = memoryDb();
      const ev = event({ orderBook: bookA, amount: 40n }, splitter);
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({
        event: ev,
        context: ctx(db, [owedClaimedLog(bookA, splitter, 60n, ev.log.logIndex - 1)]),
      });
      expect(stranded(db)).toMatchObject([{ orderBook: bookA, kind: "CLAIM_SHORT", amount: 40n }]);
    });

    it("no OwedClaimed means the claim reverted and nothing moved: CLAIM_REVERTED", async () => {
      const db = memoryDb();
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({
        event: event({ orderBook: bookA, amount: 100n }, splitter), context: ctx(db, []),
      });
      expect(stranded(db)).toMatchObject([{ orderBook: bookA, kind: "CLAIM_REVERTED", amount: 100n }]);
    });

    // THE FIXTURE THAT CATCHES THE ONE MISTAKE WORTH CATCHING. OwedClaimed's `account` arg is
    // msg.sender, which is the FeeSplitter on EVERY one of them; the book is the log's emitting
    // ADDRESS. A handler that correlated on the arg would match book A's claim to book B and
    // report B's CLAIM_REVERTED as a CLAIM_SHORT - value described as partly collected when none
    // was. Every single-book fixture above passes under either reading, so this is the only case
    // that can fail.
    it("two books in one transaction: each is judged by its OWN claim log, not by the account arg", async () => {
      const db = memoryDb();
      const evA = event({ orderBook: bookA, amount: 7n }, splitter);
      const evB = event({ orderBook: bookB, amount: 90n }, splitter);
      // Book A's claim committed; book B's reverted, so only A emitted OwedClaimed. Both logs carry
      // account = splitter, which is exactly what makes the arg useless as a discriminator.
      const logs = [owedClaimedLog(bookA, splitter, 30n, evA.log.logIndex - 1)];
      const context = ctx(db, logs);
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({ event: evA, context });
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({ event: evB, context });
      const rows = stranded(db);
      expect(rows).toHaveLength(2);
      expect(rows.find((row: any) => row.orderBook === bookA)).toMatchObject({ kind: "CLAIM_SHORT", amount: 7n });
      expect(rows.find((row: any) => row.orderBook === bookB)).toMatchObject({ kind: "CLAIM_REVERTED", amount: 90n });
    });
    it("a book drained TWICE in one transaction judges the second drain on its own window", async () => {
      // setOrderBook is the only caller of _drainOrderBook and is guarded by `previous != orderBook_`,
      // so this needs a transaction that repoints repeatedly: A->B->A->B. The first drain of A
      // committed and emitted OwedClaimed; the second reverted. A handler that accepted ANY earlier
      // claim for this book would report the second as CLAIM_SHORT on the strength of the first.
      const db = memoryDb();
      const firstClaim = owedClaimedLog(bookA, splitter, 10n, nextLog++);
      const firstStranded = strandedLog(splitter, bookA, 5n, nextLog++);
      const second = event({ orderBook: bookA, amount: 25n }, splitter);
      await handlers.get("FeeSplitter:OrderBookFeesStranded")!({
        event: second, context: ctx(db, [firstClaim, firstStranded]),
      });
      expect(stranded(db)).toMatchObject([{ orderBook: bookA, kind: "CLAIM_REVERTED", amount: 25n }]);
    });
  });
});
