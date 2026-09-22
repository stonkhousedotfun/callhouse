import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2Ponder: registry,
  v2RewardsPonder: registry,
  v2MakerVaultPonder: registry,
  v2RewardsDistributorPonder: registry,
}));
vi.mock("../../lib/env", () => ({
  USDG: "0x0000000000000000000000000000000000000001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011",
}));
vi.mock("ponder:schema", () => ({ default: {
  v2RewardsEpoch: "v2RewardsEpoch",
  v2RewardsClaim: "v2RewardsClaim",
  v2ContractFunding: "v2ContractFunding",
  v2TreasuryExit: "v2TreasuryExit",
} }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  return {
    rows,
    insert: (name: string) => ({ values: (row: any) => {
      const previous = table(name).get(String(row.id));
      if (previous === undefined) table(name).set(String(row.id), row);
      return {
        then: (resolve: (value: any) => void) => resolve(row),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(String(row.id), previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
  };
}

const TX = `0x${"1".repeat(64)}`;
let logIndex = 0;
const event = (address: string, args: object) => ({
  args,
  block: { timestamp: 100n, number: 200n },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address },
});

beforeAll(async () => {
  await import("./stateFacts");
  await import("./treasury");
});

describe("multi-instance RewardsDistributor reducers", () => {
  it("keeps equal epoch and leaf indexes distinct and attributes every money movement", async () => {
    const first = "0x0000000000000000000000000000000000000099";
    const second = "0x00000000000000000000000000000000000000AA";
    const account = "0x0000000000000000000000000000000000000011";
    const root = `0x${"a".repeat(64)}`;
    const db = memoryDb();
    const context = { db };

    for (const [distributor, amount] of [[first, 8n], [second, 9n]] as const) {
      await handlers.get("RewardsDistributor:RootSet")!({
        event: event(distributor, { epoch: 7n, root, total: 20n }), context,
      });
      await handlers.get("RewardsDistributor:Claimed")!({
        event: event(distributor, { epoch: 7n, index: 0n, account, amount }), context,
      });
      await handlers.get("RewardsDistributor:Funded")!({
        event: event(distributor, { from: account, amount: amount + 10n }), context,
      });
      await handlers.get("RewardsDistributor:Defunded")!({
        event: event(distributor, { to: account, amount: amount + 1n }), context,
      });
    }

    expect([...db.rows.get("v2RewardsEpoch")!.keys()]).toEqual([
      `${first.toLowerCase()}-7`, `${second.toLowerCase()}-7`,
    ]);
    expect([...db.rows.get("v2RewardsClaim")!.keys()]).toEqual([
      `${first.toLowerCase()}-7-0`, `${second.toLowerCase()}-7-0`,
    ]);
    expect([...db.rows.get("v2ContractFunding")!.values()].map((row) => [row.contract, row.amount]))
      .toEqual([[first.toLowerCase(), 18n], [second.toLowerCase(), 19n]]);
    expect([...db.rows.get("v2TreasuryExit")!.values()].map((row) => [row.sourceAddress, row.amount]))
      .toEqual([[first.toLowerCase(), 9n], [second.toLowerCase(), 10n]]);
  });
});
