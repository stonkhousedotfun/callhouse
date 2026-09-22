import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { buildEpoch, weigh, allocate, exclusions } from "./lender-epoch.mjs";
import { epochWindow, merkle } from "./lib/epoch-merkle.mjs";

const TYPES = ["uint256", "uint256", "address", "uint256"];

/**
 * THE PINNED ROOT. `test/v2/fixtures/lender-epoch-2960.oz.json` in the CONTRACTS repo is the artifact the
 * on-chain suite and the browser claim path both verify against; this literal is that file's root. It is
 * asserted here rather than read across repos so this suite fails if either side moves.
 */
const PINNED_EPOCH = 2960n;
const PINNED_ROOT = "0x42758658626162126786767f92853840ef916b398e2e936d905f329436abfb44";
const PINNED_TOTAL = "2601123456789012345678";
const PINNED_ENTRIES = [
  { account: "0x1111111111111111111111111111111111111111", amount: "100000000000000000000" },
  { account: "0x2222222222222222222222222222222222222222", amount: "2500000000000000000000" },
  { account: "0x3333333333333333333333333333333333333333", amount: "1000000000000000000" },
  { account: "0x4444444444444444444444444444444444444444", amount: "0" },
  { account: "0x5555555555555555555555555555555555555555", amount: "123456789012345678" },
];

/** A registry whose protocolAddresses block is populated, so exclusions have something to exclude. */
const TREASURY = "0x9999999999999999999999999999999999999999";
function registry(overrides: Record<string, unknown> = {}) {
  return { v2: { protocolAddresses: {
    accessManager: null, makerVault: null, autoRoller: null, admin: null, guardian: null,
    feeRecipient: null, opsWallet: null, cranker: null, pricer: null, quoter: null,
    feeSplitter: null, buybackExecutor: null, treasury: TREASURY,
    distributors: { maker: null, user: null, lender: null },
    ...overrides,
  } } };
}

const { start, end } = epochWindow(PINNED_EPOCH);
const DAY = 86_400n;

function row(account: string, timestamp: bigint, assetsAfter: bigint, block = 0n) {
  return { account, timestamp: String(timestamp), assetsAfter: String(assetsAfter), sharesAfter: String(assetsAfter), block: String(block) };
}

describe("the pinned lender vector", () => {
  /**
   * CRITERION 3. The generator's tree must be byte-identical to the contracts-repo fixture, because
   * `RewardsDistributor.claim` verifies against that root on chain and the web claim path rebuilds it in a
   * browser. This asserts against the LITERAL root, and separately against the real OpenZeppelin library, so
   * a bug in our shared module cannot agree with itself and pass.
   */
  it("reproduces the pinned root byte for byte, and the real library agrees", () => {
    const values = PINNED_ENTRIES.map((e, i) => [String(PINNED_EPOCH), String(i), e.account, e.amount]);
    const real = StandardMerkleTree.of(values, TYPES);
    expect(real.root.toLowerCase()).toBe(PINNED_ROOT);
  });

  /**
   * And OUR tree code must produce it too. The test above proves the LIBRARY agrees with the literal; this
   * proves the shared module we actually ship agrees with both. Without it, a drift in `lib/epoch-merkle.mjs`
   * would be invisible here and would only surface as a reverting claim on chain.
   */
  it("our shared merkle module reproduces the pinned root from the pinned entries", () => {
    const entries = PINNED_ENTRIES.map((e, index) => ({ index, account: e.account as `0x${string}`, amount: BigInt(e.amount) }));
    const { root, proofs } = merkle(PINNED_EPOCH, entries);
    expect(root.toLowerCase()).toBe(PINNED_ROOT);
    // and every proof it emits verifies against the real library, not merely against our own root
    const values = PINNED_ENTRIES.map((e, i) => [String(PINNED_EPOCH), String(i), e.account, e.amount]);
    const real = StandardMerkleTree.of(values, TYPES);
    for (let i = 0; i < values.length; i++) {
      expect(StandardMerkleTree.verify(real.root, TYPES, values[i], proofs.get(i)!)).toBe(true);
    }
  });

  it("the fixture's amounts sum to its published total", () => {
    const sum = PINNED_ENTRIES.reduce((total, e) => total + BigInt(e.amount), 0n);
    expect(sum.toString()).toBe(PINNED_TOTAL);
  });
});

describe("time-weighted credit", () => {
  /**
   * CRITERION 4, and the case chosen so a closing-balance implementation CANNOT pass it. `late` ends the epoch
   * holding four times as much as `steady`, so any rule that reads the final balance pays `late` more. The
   * time-weighted rule pays `steady` more, because it supplied for seven days against one.
   */
  it("pays a whole-epoch supplier more than a bigger last-day deposit", () => {
    const steady = "0x1111111111111111111111111111111111111111";
    const late = "0x2222222222222222222222222222222222222222";
    const rows = [
      row(steady, start - DAY, 1_000n * 10n ** 18n),          // held all week, carried in
      row(late, end - DAY, 4_000n * 10n ** 18n),              // four times as much, for one day
    ];
    const weights = weigh(rows, start, end, new Set());
    const bySteady = weights.find((w) => w.account === steady)!;
    const byLate = weights.find((w) => w.account === late)!;
    expect(bySteady.weight).toBeGreaterThan(byLate.weight);

    const allocated = allocate(weights, 1_000n * 10n ** 18n, 10_000n);
    const steadyAmount = BigInt(allocated.find((a) => a.account === steady)!.amount);
    const lateAmount = BigInt(allocated.find((a) => a.account === late)!.amount);
    expect(steadyAmount).toBeGreaterThan(lateAmount);
  });

  it("a balance carried into the window is credited from the window start, not from its row", () => {
    const account = "0x1111111111111111111111111111111111111111";
    const [only] = weigh([row(account, start - 30n * DAY, 10n ** 18n)], start, end, new Set());
    expect(only.weight).toBe(10n ** 18n * (end - start));
  });

  it("a row at or after the window end is ignored", () => {
    const account = "0x1111111111111111111111111111111111111111";
    const weights = weigh([row(account, end, 10n ** 18n)], start, end, new Set());
    expect(weights).toHaveLength(0);
  });

  it("is deterministic: the same rows twice give the same root", () => {
    const rows = [
      row("0x1111111111111111111111111111111111111111", start - DAY, 5n * 10n ** 18n),
      row("0x2222222222222222222222222222222222222222", start + DAY, 7n * 10n ** 18n),
    ];
    const args = { epoch: PINNED_EPOCH, budget: 10n ** 20n, rows, registry: registry(), capBps: 10_000n, start, end };
    expect(buildEpoch(args).root).toBe(buildEpoch(args).root);
  });
});

describe("18-decimal amounts", () => {
  /**
   * CRITERION 5. 100 whole 18-dp tokens is 1e20, above `type(uint64).max`. Anything that narrowed an amount
   * to a JS number or a uint64 would pass every 6-decimal USDG test and truncate here.
   */
  it("carries an entry above 2^64 base units through to the file", () => {
    const rows = [
      row("0x1111111111111111111111111111111111111111", start - DAY, 10n ** 18n),
      row("0x2222222222222222222222222222222222222222", start - DAY, 10n ** 18n),
    ];
    const file = buildEpoch({ epoch: PINNED_EPOCH, budget: 200n * 10n ** 18n, rows, registry: registry(), capBps: 10_000n, start, end });
    const big = file.entries.filter((e) => BigInt(e.amount) > 18_446_744_073_709_551_615n);
    expect(big.length).toBeGreaterThan(0);
    expect(file.entries.every((e) => typeof e.amount === "string")).toBe(true);
  });

  it("the entry sum equals the total exactly, with dust and a cap in play", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((i) =>
      row(`0x${String(i).repeat(40)}`.slice(0, 42), start - DAY, BigInt(i) * 10n ** 18n));
    const budget = 1_000_000_000_000_000_000_007n; // prime-ish, so integer division leaves dust
    const file = buildEpoch({ epoch: PINNED_EPOCH, budget, rows, registry: registry(), capBps: 3000n, start, end });
    const sum = file.entries.reduce((total, e) => total + BigInt(e.amount), 0n);
    expect(sum).toBe(budget);
    expect(file.total).toBe(String(budget));
  });
});

describe("registry-driven exclusions", () => {
  /**
   * CRITERION 7. The exclusion list is READ from the registry, so adding a protocol wallet is a registry edit
   * and not a code edit. Proven by removing the treasury from the registry and watching it get paid.
   */
  it("drops a protocol-owned address named in the registry", () => {
    const rows = [
      row("0x1111111111111111111111111111111111111111", start - DAY, 10n ** 18n),
      row(TREASURY, start - DAY, 10n ** 18n),
    ];
    const excluded = exclusions(registry());
    expect(excluded.has(TREASURY.toLowerCase())).toBe(true);
    const weights = weigh(rows, start, end, excluded);
    expect(weights.find((w) => w.account.toLowerCase() === TREASURY.toLowerCase())).toBeUndefined();
  });

  it("matches case-insensitively: a lowercase row is still excluded", () => {
    const rows = [row(TREASURY.toLowerCase(), start - DAY, 10n ** 18n)];
    const weights = weigh(rows, start, end, exclusions(registry()));
    expect(weights).toHaveLength(0);
  });

  it("refuses to run when the registry has no protocolAddresses block at all", () => {
    expect(() => exclusions({ v2: {} })).toThrow(/no v2.protocolAddresses/);
  });

  /**
   * T-232, AND IT IS THE WHOLE ROW. The guard above tested the block's PRESENCE. Every value in
   * `v2.protocolAddresses` is null until a deployment fills it, so on the COMMITTED registry the walk found
   * no address, returned an EMPTY SET, and the refusal whose stated purpose is "no exclusion list" did not
   * fire. Every protocol-owned balance would have been paid out of the lender budget, the run would have
   * succeeded, the Merkle root would have been valid, and nothing would have said so.
   */
  it("refuses an exclusion list that is present but EMPTY, which is the committed registry's state", () => {
    const allNull = {
      v2: {
        protocolAddresses: {
          accessManager: null, makerVault: null, autoRoller: null, admin: null, guardian: null,
          feeRecipient: null, opsWallet: null, cranker: null, pricer: null, quoter: null,
          feeSplitter: null, buybackExecutor: null, treasury: null,
          distributors: { maker: null, user: null, lender: null },
        },
      },
    };
    expect(() => exclusions(allNull)).toThrow(/exclusion list is EMPTY/);
  });

  /**
   * The House vaults are factory-created and per-market, so no fixed key in a CLOSED schema could name them.
   * `--exclude` is where they come from, and it satisfies the same emptiness guard.
   */
  it("accepts addresses the closed registry schema cannot hold, and rejects a non-address", () => {
    const allNull = { v2: { protocolAddresses: { treasury: null, distributors: { maker: null } } } };
    const house = "0x000000000000000000000000000000000000f001";
    expect([...exclusions(allNull, [house])]).toEqual([house]);
    expect(() => exclusions(allNull, ["not-an-address"])).toThrow(/not an address/);
  });
});

describe("one asset per epoch", () => {
  /**
   * D28 values stock at the settlement oracle spot and credits USD value; this program reads NO price. A
   * share of one vault's base units is not comparable to a share of another's, so a mixed input is refused
   * rather than weighted into a split that is silently wrong per asset.
   */
  it("refuses an input that mixes two assets", () => {
    const usdg = "0x000000000000000000000000000000000000dead";
    const stock = "0x000000000000000000000000000000000000beef";
    const rows = [
      { ...row("0x1111111111111111111111111111111111111111", start - DAY, 10n ** 18n), asset: usdg },
      { ...row("0x2222222222222222222222222222222222222222", start - DAY, 10n ** 18n), asset: stock },
    ];
    expect(() => weigh(rows, start, end, new Set())).toThrow(/mixes assets/);
  });

  it("a single-asset input is weighed as before, and an input with no asset field still works", () => {
    const usdg = "0x000000000000000000000000000000000000dead";
    const same = [
      { ...row("0x1111111111111111111111111111111111111111", start - DAY, 10n ** 18n), asset: usdg },
      { ...row("0x2222222222222222222222222222222222222222", start - DAY, 10n ** 18n), asset: usdg },
    ];
    expect(weigh(same, start, end, new Set())).toHaveLength(2);
    expect(weigh([row("0x1111111111111111111111111111111111111111", start - DAY, 10n ** 18n)], start, end, new Set())).toHaveLength(1);
  });
});

describe("address handling is not a stubbed identity function", () => {
  /**
   * CRITERION 8. A stubbed viem whose `checksumAddress` returned its input made assertions like this pass for
   * seventeen hours on 2026-09-19. The literal below is a KNOWN-GOOD EIP-55 checksum of an all-lowercase
   * input, so an identity implementation fails it.
   */
  it("checksums a lowercase address to its known-good EIP-55 form", () => {
    const lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const [only] = weigh([row(lower, start - DAY, 10n ** 18n)], start, end, new Set());
    expect(only.account).toBe(checksummed);
    expect(only.account).not.toBe(lower);
  });
});
