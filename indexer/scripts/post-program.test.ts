import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpoch } from "./lender-epoch.mjs";
import { epochWindow } from "./lib/epoch-merkle.mjs";
import {
  GENERATORS, PROGRAMS, distributorFor, outstandingLiability, preflight, regenerationCommand, regenerator, requiredBalance,
  rewardTokenFor, validateEpoch,
} from "./post-maker-epoch.mjs";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ROOT = "0x42758658626162126786767f92853840ef916b398e2e936d905f329436abfb44";
const MAKER = "0x1111111111111111111111111111111111111111";
const LENDER = "0x2222222222222222222222222222222222222222";
const LEGACY = "0x3333333333333333333333333333333333333333";

/** A chain stub: `posted` maps epoch -> [total, claimed]. Injected, so none of this needs an RPC. */
function reader(posted: Record<string, [bigint, bigint]>) {
  return {
    root: async (e: bigint) => (posted[String(e)] ? ROOT : ZERO),
    totalOf: async (e: bigint) => posted[String(e)]?.[0] ?? 0n,
    claimedAmount: async (e: bigint) => posted[String(e)]?.[1] ?? 0n,
  };
}

describe("--program selects the distributor", () => {
  it("maker keeps its legacy fallback so existing invocations are unchanged", () => {
    expect(distributorFor({ v2: { contracts: { rewardsDistributor: LEGACY } } }, "maker")).toBe(LEGACY);
  });

  it("the distributors block wins over the legacy key when both exist", () => {
    const registry = { v2: { protocolAddresses: { distributors: { maker: MAKER } }, contracts: { rewardsDistributor: LEGACY } } };
    expect(distributorFor(registry, "maker")).toBe(MAKER);
  });

  it("lender resolves from the distributors block", () => {
    expect(distributorFor({ v2: { protocolAddresses: { distributors: { lender: LENDER } } } }, "lender")).toBe(LENDER);
  });

  /**
   * The asymmetry is deliberate. There is no legacy lender address, so a fallback could only ever resolve to
   * the MAKER's distributor -- which would post lender rewards, denominated in an 18-decimal token, to the
   * contract paying 6-decimal USDG.
   */
  it("lender has NO fallback and refuses rather than guessing", () => {
    expect(() => distributorFor({ v2: { contracts: { rewardsDistributor: LEGACY } } }, "lender")).toThrow(/no lender distributor/);
  });

  it("an unknown program is refused", () => {
    expect(() => distributorFor({ v2: { protocolAddresses: { distributors: {} } } }, "user")).toThrow(/unknown --program/);
    expect(PROGRAMS).toEqual(["maker", "lender"]);
  });
});

describe("the funding floor includes what is still owed", () => {
  /**
   * CRITERION 6. Every epoch pays from ONE shared balance and an unclaimed entry never expires -- a defund
   * does not cancel it. So the floor is the new total PLUS the unpaid remainder of every posted epoch.
   */
  it("sums the unpaid remainder of previously posted epochs", async () => {
    const owed = await outstandingLiability(reader({ "2958": [100n, 40n], "2959": [50n, 50n] }), 2960n, 52n);
    expect(owed).toBe(60n); // 60 unpaid from 2958, 0 from 2959
  });

  it("ignores epochs that were never posted", async () => {
    const owed = await outstandingLiability(reader({}), 2960n, 52n);
    expect(owed).toBe(0n);
  });

  it("refuses a chain that reports more claimed than posted", async () => {
    await expect(outstandingLiability(reader({ "2959": [10n, 11n] }), 2960n, 52n)).rejects.toThrow(/claimed against a total/);
  });

  it("the lookback bounds the scan", async () => {
    const posted = { "2900": [1_000n, 0n] as [bigint, bigint], "2959": [7n, 0n] as [bigint, bigint] };
    expect(await outstandingLiability(reader(posted), 2960n, 1n)).toBe(7n);      // only 2959 is in range
    expect(await outstandingLiability(reader(posted), 2960n, 100n)).toBe(1_007n); // both
  });

  /**
   * BREAK CHECK. `brokenRequired` is the check as it stood before the fix: the new total alone.
   * The scenario is the one that actually loses money -- a balance that covers the new epoch exactly while an
   * older epoch is still owed 60. The old rule posts; the new rule refuses.
   */
  it("the old new-total-only rule would have posted against a balance that cannot pay", async () => {
    const owed = await outstandingLiability(reader({ "2958": [100n, 40n] }), 2960n, 52n);
    const planTotal = 500n;
    const balance = 500n;

    const brokenRequired = planTotal;                    // the removed term
    expect(balance < brokenRequired).toBe(false);        // RED: the old check waves this through

    const required = requiredBalance(planTotal, owed);   // the term restored
    expect(required).toBe(560n);
    expect(balance < required).toBe(true);               // GREEN: the new check refuses it
  });
});

/**
 * The lender distributor pays the 18-dp STONKHOUSE token, not USDG, and its epoch files come from
 * lender-epoch.mjs, not maker-epoch.mjs. The poster used to read the USDG balance and regenerate with the maker
 * generator for every program, so a lender floor measured the wrong token and a lender regeneration could never
 * match. These build a real lender epoch and drive the preflight and the real generator against it.
 */
describe("the lender program is measured and regenerated as the lender", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const STONKHOUSE = "0xc2525b7c68b6d66dE5AABFEDC7B13314F389D5C4";
  const MANAGER = "0xb663C1EAEeD4664515Cc864667263f3e75238da3";
  const SAFE = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B";
  const TREASURY = "0x9999999999999999999999999999999999999999";
  const OPERATION = `0x${"ab".repeat(32)}`;
  const EPOCH = 2960n;
  const BUDGET = 3n * 10n ** 20n;
  const { start, end } = epochWindow(EPOCH);

  const registry = {
    shared: { usdg: USDG, safes: { admin: SAFE }, token: { address: STONKHOUSE } },
    v2: { protocolAddresses: {
      accessManager: MANAGER, makerVault: null, autoRoller: null, admin: SAFE, guardian: null, feeRecipient: null,
      opsWallet: null, cranker: null, pricer: null, quoter: null, feeSplitter: null, buybackExecutor: null, treasury: TREASURY,
      distributors: { maker: MAKER, user: null, lender: LENDER },
    } },
  };
  const row = (account: string, timestamp: bigint, assetsAfter: bigint) =>
    ({ account, timestamp: String(timestamp), assetsAfter: String(assetsAfter), sharesAfter: String(assetsAfter), block: "0" });
  const rows = [
    row("0x6666666666666666666666666666666666666666", start - 1n, 5_000_000n),
    row("0x7777777777777777777777777777777777777777", start - 1n, 3_000_000n),
    row("0x8888888888888888888888888888888888888888", start + 86_400n, 2_000_000n),
  ];
  const file = buildEpoch({ epoch: EPOCH, budget: BUDGET, rows, registry, capBps: 5_000n, exclude: [], start, end });
  const plan = validateEpoch(file);

  /** Balances keyed by token, so a read of the wrong token is visible as the wrong number. */
  function chain(balances: Record<string, bigint>, token = STONKHOUSE) {
    const reads: string[] = [];
    return {
      reads,
      chainId: async () => 4663,
      block: async () => ({ number: 1n, timestamp: end + 1n }),
      rewardToken: async () => token,
      authority: async () => MANAGER,
      root: async () => ZERO,
      totalOf: async () => 0n,
      claimedAmount: async () => 0n,
      balanceOf: async (t: string) => { reads.push(t); return balances[t.toLowerCase()] ?? 0n; },
      targetFunctionRole: async () => 4n,
      hasRole: async () => [true, 86400],
      hashOperation: async () => OPERATION,
      getSchedule: async () => 0n,
      simulate: async () => "0x",
    };
  }
  const read = (stub: ReturnType<typeof chain>) =>
    preflight("read", { plan, program: "lender", registry, chain: stub, lookback: 52n, regenerate: async () => file });

  it("the reward token is the program's: USDG for maker, STONKHOUSE for lender", () => {
    expect(rewardTokenFor(registry, "maker")).toBe(USDG);
    expect(rewardTokenFor(registry, "lender")).toBe(STONKHOUSE);
    expect(() => rewardTokenFor({ shared: { usdg: USDG } }, "lender")).toThrow(/shared.token.address/);
  });

  it("the funding floor reads the STONKHOUSE balance of the lender distributor", async () => {
    const stub = chain({ [STONKHOUSE.toLowerCase()]: BUDGET });
    const out = await read(stub);
    expect(out.report.distributorBalance).toBe(String(BUDGET));
    expect(out.report.rewardToken).toBe(STONKHOUSE);
    expect(stub.reads).toEqual([STONKHOUSE]);
  });

  /**
   * THE DEFECT, AS A CASE. Plenty of USDG, no STONKHOUSE: the old poster read USDG and passed, against a
   * distributor that cannot pay a single lender claim.
   */
  it("USDG on the lender distributor does not satisfy the floor", async () => {
    await expect(read(chain({ [USDG.toLowerCase()]: 10n ** 30n }))).rejects.toThrow(/lender distributor holds 0 base units/);
  });

  it("a lender key that points at a USDG-paying distributor is refused", async () => {
    await expect(read(chain({ [USDG.toLowerCase()]: BUDGET }, USDG))).rejects.toThrow(
      /lender distributor 0x2222.* pays 0x5fc5360D.*lender reward token is 0xc2525b7c/);
  });

  it("maker regenerates with maker-epoch.mjs from the indexer; lender with lender-epoch.mjs from its inputs", () => {
    expect(regenerationCommand("maker", plan, {}, "/tmp/out.json")).toEqual(
      { script: GENERATORS.maker, args: ["2960", String(BUDGET), "--output", "/tmp/out.json"] });
    expect(regenerationCommand("lender", plan, { balances: "in.json", registry: "reg.json", capBps: "5000",
      exclude: [TREASURY] }, "/tmp/out.json")).toEqual({ script: GENERATORS.lender, args: ["2960", String(BUDGET),
      "--input", "in.json", "--output", "/tmp/out.json", "--registry", "reg.json", "--cap-bps", "5000", "--exclude", TREASURY] });
    expect(GENERATORS.lender).toMatch(/lender-epoch\.mjs$/);
    expect(() => regenerationCommand("lender", plan, {}, "/tmp/out.json")).toThrow(/--balances/);
  });

  /** The real generator, as a child process, on the inputs the file was built from -- and on a changed cap. */
  it("the real lender generator reproduces the file, and a changed input does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-program-"));
    try {
      const balances = join(dir, "balances.json");
      const registryPath = join(dir, "registry.json");
      await writeFile(balances, JSON.stringify(rows));
      await writeFile(registryPath, JSON.stringify(registry));
      const same = validateEpoch(await regenerator({ balances, registry: registryPath, capBps: "5000", exclude: [] })("lender", plan));
      expect(same.root).toBe(plan.root);
      expect(same.total).toBe(BUDGET);
      const changed = validateEpoch(await regenerator({ balances, registry: registryPath, capBps: "4000", exclude: [] })("lender", plan));
      expect(changed.root).not.toBe(plan.root);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
