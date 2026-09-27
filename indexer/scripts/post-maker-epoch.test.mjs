import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeFunctionResult } from "viem";
import { parseArgs, preflight, scheduleCalldata, setRootCalldata, validateEpoch } from "./post-maker-epoch.mjs";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../src/v2/fixtures/maker-epoch-2958.oz.json", import.meta.url))));
const copy = () => structuredClone(vector);

test("accepts the contract's OpenZeppelin epoch vector", () => {
  const result = validateEpoch(copy());
  assert.equal(result.epoch, 2958n);
  assert.equal(result.total, 1_750_001n);
  assert.equal(result.root, vector.root);
  assert.equal(result.makers, 4);
});

test("refuses changed allocation, root, proof and duplicate recipient", () => {
  const amount = copy(); amount.entries[0].amount = "700001";
  assert.throws(() => validateEpoch(amount), /entry sum/);
  const root = copy(); root.root = `0x${"1".repeat(64)}`;
  assert.throws(() => validateEpoch(root), /Merkle root/);
  const proof = copy(); proof.entries[0].proof[0] = `0x${"1".repeat(64)}`;
  assert.throws(() => validateEpoch(proof), /proof does not verify/);
  const duplicate = copy(); duplicate.entries[1].account = duplicate.entries[0].account;
  assert.throws(() => validateEpoch(duplicate), /duplicate account/);
  const rounded = copy(); rounded.entries[0].amount = 9007199254740993;
  assert.throws(() => validateEpoch(rounded), /decimal integer string/);
});

// The live v8 addresses (ops/markets/tier1.json at this base), so the calldata pins below are the bytes the Admin
// Safe would actually sign.
const DISTRIBUTOR = "0x08F233c5E338a35F7Ba6cD16C729AB61f40325ce";
const MANAGER = "0xb663C1EAEeD4664515Cc864667263f3e75238da3";
const SAFE = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const STONKHOUSE = "0xc2525b7c68b6d66dE5AABFEDC7B13314F389D5C4";
const ZERO = `0x${"0".repeat(64)}`;
// hashOperation(Admin Safe, maker distributor, SET_ROOT) read from AccessManager on 4663 at block 70319951.
const OPERATION = "0xa96500555cba7a5adff6feab13d3f5592cc4c4febaebc393d944f3f341262b7a";

/**
 * PINNED CALLDATA, derived OUTSIDE this code with Foundry:
 *   cast calldata 'setRoot(uint256,bytes32,uint256)' 2958 <vector root> 1750001
 *   cast calldata 'schedule(address,bytes,uint48)' 0x08F2...25ce <that> 0
 * setRoot's selector 0xc6ab7b2e is the one getTargetFunctionRole(distributor, 0xc6ab7b2e) = 4 answers for on chain.
 */
const SET_ROOT = "0xc6ab7b2e0000000000000000000000000000000000000000000000000000000000000b8ebaf77ffed3c63b4f37de4ac3510116b613e912df932c670f6ddba5bc78da6cb800000000000000000000000000000000000000000000000000000000001ab3f1";
const SCHEDULE = "0xf801a69800000000000000000000000008f233c5e338a35f7ba6cd16c729ab61f40325ce000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064c6ab7b2e0000000000000000000000000000000000000000000000000000000000000b8ebaf77ffed3c63b4f37de4ac3510116b613e912df932c670f6ddba5bc78da6cb800000000000000000000000000000000000000000000000000000000001ab3f100000000000000000000000000000000000000000000000000000000";
const SCHEDULE_ABI = [{ type: "function", name: "schedule", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "bytes" }, { type: "uint48" }], outputs: [{ type: "bytes32" }, { type: "uint32" }] }];

const plan = validateEpoch(copy());
const registry = {
  shared: { usdg: USDG, safes: { admin: SAFE }, token: { address: STONKHOUSE } },
  v2: { protocolAddresses: { accessManager: MANAGER, admin: SAFE, distributors: { maker: DISTRIBUTOR, lender: null } } },
};

/**
 * A chain stub with the viemChain shape. The defaults are a chain on which every check passes for the vector: the
 * epoch ended, nothing posted, the distributor holds exactly the total, the Safe holds role 4 with 86400 s, and
 * (for execute) the operation became ready one second ago.
 */
function chain(over = {}) {
  const s = { chainId: 4663, timestamp: plan.endsAt + 100_000n, token: USDG, authority: MANAGER, roots: {}, totals: {},
    claimed: {}, balance: plan.total, role: 4n, member: [true, 86400], schedule: 0n, revert: null, simulatedId: OPERATION,
    houseVaults: {}, factoryError: null, ...over };
  const calls = [];
  return {
    calls,
    chainId: async () => s.chainId,
    block: async () => ({ number: 70_319_951n, timestamp: s.timestamp }),
    rewardToken: async () => s.token,
    authority: async () => s.authority,
    houseVaults: async (factory) => {
      calls.push(["houseVaults", factory]);
      if (s.factoryError) throw new Error(s.factoryError);
      return s.houseVaults[factory.toLowerCase()] ?? [];
    },
    root: async (_distributor, epoch) => s.roots[String(epoch)] ?? ZERO,
    totalOf: async (_distributor, epoch) => s.totals[String(epoch)] ?? 0n,
    claimedAmount: async (_distributor, epoch) => s.claimed[String(epoch)] ?? 0n,
    balanceOf: async (token, holder) => { calls.push(["balanceOf", token, holder]); return s.balance; },
    targetFunctionRole: async (manager, target, selector) => { calls.push(["role", manager, target, selector]); return s.role; },
    hasRole: async (manager, role, account) => { calls.push(["hasRole", role, account]); return s.member; },
    hashOperation: async () => OPERATION,
    getSchedule: async () => s.schedule,
    simulate: async (call) => {
      calls.push(["simulate", call]);
      if (s.revert) throw new Error(s.revert);
      return call.to === MANAGER ? encodeFunctionResult({ abi: SCHEDULE_ABI, functionName: "schedule", result: [s.simulatedId, 1] }) : "0x";
    },
  };
}

/** A valid epoch file for the vector's epoch and total paying `accounts`: 1 each, the last one takes the rest. */
function fileFor(accounts) {
  const amounts = accounts.map((_, i) => i + 1 < accounts.length ? "1" : String(plan.total - BigInt(accounts.length - 1)));
  const values = accounts.map((account, i) => [String(plan.epoch), String(i), account, amounts[i]]);
  const tree = StandardMerkleTree.of(values, ["uint256", "uint256", "address", "uint256"]);
  return { epoch: vector.epoch, root: tree.root, total: vector.total,
    entries: values.map((v, i) => ({ index: i, account: v[2], amount: v[3], proof: tree.getProof(i) })) };
}

/** A valid epoch file for the same epoch and total whose allocation -- and therefore root -- differs. */
const otherFile = () => fileFor(vector.entries.map((entry) => entry.account));

const regenerated = [];
const sameFile = async (program, p) => { regenerated.push([program, p.epoch]); return copy(); };
const run = (mode, over = {}, regenerate = sameFile, { plan: p = plan, registry: r = registry } = {}) => {
  const stub = chain(over);
  return { stub, result: preflight(mode, { plan: p, program: "maker", registry: r, chain: stub, lookback: 52n, regenerate }) };
};
const ready = { schedule: plan.endsAt + 100_000n - 1n };   // execute: the operation matured one second ago

describe("the direct send is gone", () => {
  test("--account is refused with the reason, not silently ignored", () => {
    assert.throws(() => parseArgs(["e.json", "--apply", "--account", "admin"], { RH_RPC: "https://rpc" }),
      /--account is gone: on v8 setRoot is TREASURY_ADMIN/);
  });

  test("the calldata is the bytes Foundry derives for the vector", () => {
    assert.equal(setRootCalldata(plan), SET_ROOT);
    assert.equal(scheduleCalldata(DISTRIBUTOR, SET_ROOT), SCHEDULE);
  });
});

describe("read-only preflight", () => {
  test("reports the role, the delay and the operation, and emits nothing", async () => {
    regenerated.length = 0;
    const { stub, result } = run("read");
    const out = await result;
    assert.equal(out.status, "ready");
    assert.equal(out.batch, null);
    assert.equal(out.report.roleId, "4");
    assert.equal(out.report.executionDelaySeconds, "86400");
    assert.equal(out.report.operationId, OPERATION);
    assert.equal(out.report.scheduledAt, "0");
    assert.deepEqual(stub.calls.find((c) => c[0] === "role"), ["role", MANAGER, DISTRIBUTOR, "0xc6ab7b2e"]);
    assert.equal(stub.calls.some((c) => c[0] === "simulate"), false);
    assert.equal(regenerated.length, 0);
  });
});

describe("--apply emits the schedule batch only after every check passes", () => {
  test("the batch schedules setRoot on the AccessManager, from the Admin Safe", async () => {
    regenerated.length = 0;
    const { stub, result } = run("apply");
    const out = await result;
    assert.equal(out.status, "schedule");
    assert.deepEqual(out.batch.transactions, [{ to: MANAGER, value: "0", data: SCHEDULE, contractMethod: null, contractInputsValues: null }]);
    assert.equal(out.batch.chainId, "4663");
    assert.equal(out.batch.meta.createdFromSafeAddress, SAFE);
    assert.match(out.batch.meta.name, /maker epoch 2958 1\/2: schedule/);
    assert.equal(out.report.earliestExecuteAt, String(plan.endsAt + 100_000n + 86_400n));
    assert.deepEqual(regenerated, [["maker", 2958n]]);
    assert.deepEqual(stub.calls.find((c) => c[0] === "simulate")[1], { from: SAFE, to: MANAGER, data: SCHEDULE });
  });

  test("an operation that is already scheduled is refused: that is --execute's job", async () => {
    await assert.rejects(run("apply", { schedule: 5n }).result, /already scheduled, ready at 5; run --execute/);
  });

  test("a schedule that would create a different operation is refused", async () => {
    await assert.rejects(run("apply", { simulatedId: `0x${"ab".repeat(32)}` }).result, /--execute would not find it/);
  });
});

describe("--execute re-runs the preflight, then emits the direct setRoot", () => {
  test("the batch is the Safe calling the distributor directly, not AccessManager.execute", async () => {
    regenerated.length = 0;
    const { stub, result } = run("execute", ready);
    const out = await result;
    assert.equal(out.status, "execute");
    assert.deepEqual(out.batch.transactions, [{ to: DISTRIBUTOR, value: "0", data: SET_ROOT, contractMethod: null, contractInputsValues: null }]);
    assert.match(out.batch.meta.name, /maker epoch 2958 2\/2: RewardsDistributor.setRoot/);
    assert.deepEqual(regenerated, [["maker", 2958n]]);
    assert.deepEqual(stub.calls.find((c) => c[0] === "simulate")[1], { from: SAFE, to: DISTRIBUTOR, data: SET_ROOT });
  });

  test("an operation that was never scheduled, or expired, is refused", async () => {
    await assert.rejects(run("execute", { schedule: 0n }).result, /is not scheduled .* run --apply first/);
  });

  test("an operation still inside its delay is refused", async () => {
    await assert.rejects(run("execute", { schedule: plan.endsAt + 100_001n }).result, /is not ready until/);
  });

  /**
   * THE ONE THE SECOND RUN EXISTS FOR. The distributor was funded when the schedule batch was built; during the
   * 24 h delay it was defunded. The execute batch must not be produced against a balance that cannot pay.
   */
  test("the funding floor is re-checked at execute time", async () => {
    await assert.rejects(run("execute", { ...ready, balance: plan.total - 1n }).result,
      /holds 1750000 base units, below 1750001/);
  });

  test("a root posted by someone else during the delay ends the run without a batch", async () => {
    const out = await run("execute", { ...ready, roots: { 2958: vector.root }, totals: { 2958: plan.total } }).result;
    assert.equal(out.status, "posted");
    assert.equal(out.batch, null);
  });
});

/** Every refusal the two batch modes share, run in both modes. Each case moves one input off the passing chain. */
const SHARED_REFUSALS = [
  ["wrong chain", { chainId: 1 }, /wrong chain 1; expected 4663/],
  ["epoch still running", { timestamp: plan.endsAt - 1n, schedule: 1n }, /is still running/],
  ["already posted with a different root", { roots: { 2958: `0x${"12".repeat(32)}` }, totals: { 2958: plan.total } }, /already has a different root or total/],
  ["balance below the new total", { balance: plan.total - 1n }, /below 1750001 = new epoch total 1750001 \+ 0 still owed/],
  ["balance covers the new total but not an older unpaid epoch",
    { balance: plan.total, roots: { 2957: `0x${"34".repeat(32)}` }, totals: { 2957: 60n }, claimed: { 2957: 10n } },
    /below 1750051 = new epoch total 1750001 \+ 50 still owed/],
  ["distributor pays a different token than the program", { token: STONKHOUSE }, /pays 0xc2525b7c.*registry's maker reward token is 0x5fc5360D/],
  ["distributor governed by another manager", { authority: SAFE }, /not the registry's AccessManager/],
  ["Admin Safe lacks the role", { member: [false, 0] }, /does not hold role 4/],
  ["role held with no delay", { member: [true, 0] }, /no execution delay/],
  ["the exact Safe call reverts in simulation", { revert: "AccessManagerUnauthorizedCall" }, /reverts in simulation: AccessManagerUnauthorizedCall/],
];

for (const mode of ["apply", "execute"]) {
  describe(`--${mode} refusals`, () => {
    for (const [name, over, pattern] of SHARED_REFUSALS) {
      test(name, async () => {
        await assert.rejects(run(mode, { ...(mode === "execute" ? ready : {}), ...over }).result, pattern);
      });
    }

    test("an epoch file that no longer matches a fresh regeneration", async () => {
      await assert.rejects(run(mode, mode === "execute" ? ready : {}, async () => otherFile()).result,
        /differs from a fresh regeneration/);
    });

    test("no batch is produced when a check before the simulation fails", async () => {
      const { stub, result } = run(mode, { ...(mode === "execute" ? ready : {}), balance: 0n });
      await assert.rejects(result);
      assert.equal(stub.calls.some((c) => c[0] === "simulate"), false);
    });
  });
}

/**
 * An epoch whose leaves name a protocol account is REFUSED, in every mode, naming the
 * account and the registry key it matched. Never filtered: a dropped leaf would change the root nobody reviewed.
 */
describe("protocol accounts never earn", () => {
  const FACTORY = "0xfac7000000000000000000000000000000000001";
  const NOT_A_LEAF = "0x9999999999999999999999999999999999999999";
  /** The shared test registry plus `v2` overrides; protocolAddresses are merged, not replaced. */
  const withV2 = ({ protocolAddresses = {}, ...rest }) => ({ ...registry,
    v2: { ...registry.v2, ...rest, protocolAddresses: { ...registry.v2.protocolAddresses, ...protocolAddresses } } });
  const houseRegistry = withV2({ house: { factories: [{ kind: "daily", address: FACTORY }] } });

  /** One case per protocol-account class, each naming a leaf of the vector. */
  const CLASSES = [
    ["a registry contract (v2.contracts.earnVault)", withV2({ contracts: { earnVault: vector.entries[1].account } }), {},
      /0x2222222222222222222222222222222222222222 \(v2\.contracts\.earnVault\)/],
    ["a protocolAddresses entry (v2.protocolAddresses.feeSplitter)",
      withV2({ protocolAddresses: { feeSplitter: vector.entries[2].account } }), {},
      /0x3333333333333333333333333333333333333333 \(v2\.protocolAddresses\.feeSplitter\)/],
    ["a House vault listed by a registry factory", houseRegistry,
      { houseVaults: { [FACTORY]: [NOT_A_LEAF, vector.entries[3].account] } },
      /0x4444444444444444444444444444444444444444 \(a House vault of factory 0xfac7000000000000000000000000000000000001 \(v2\.house\.factories\[0\]\)\)/],
  ];

  for (const mode of ["read", "apply", "execute"]) {
    for (const [name, reg, over, pattern] of CLASSES) {
      test(`${mode}: refuses ${name}, and builds nothing`, async () => {
        regenerated.length = 0;
        const { stub, result } = run(mode, { ...(mode === "execute" ? ready : {}), ...over }, sameFile, { registry: reg });
        await assert.rejects(result, pattern);
        await assert.rejects(result, /must never earn a reward.*does not filter leaves/);
        assert.equal(regenerated.length, 0);
        assert.equal(stub.calls.some((c) => c[0] === "simulate"), false);
      });
    }
  }

  test("the comparison ignores case", async () => {
    const lettered = "0xabcdef0000000000000000000000000000000001";
    const lower = validateEpoch(fileFor([vector.entries[0].account, lettered]));
    const reg = withV2({ contracts: { makerVault: "0xABCDEF0000000000000000000000000000000001" } });
    await assert.rejects(run("read", {}, sameFile, { plan: lower, registry: reg }).result,
      /0xabcdef0000000000000000000000000000000001 \(v2\.contracts\.makerVault\)/);
  });

  test("control: a registry naming every class, none of them a leaf, passes; absent keys are skipped", async () => {
    const reg = withV2({
      contracts: { makerVault: NOT_A_LEAF, earnVault: NOT_A_LEAF, houseVault: null, rewardsDistributorLender: null },
      protocolAddresses: { makerVault: NOT_A_LEAF, feeSplitter: NOT_A_LEAF, treasury: null, buybackExecutor: undefined },
      house: { factories: [{ kind: "daily", address: FACTORY }] },
    });
    const { stub, result } = run("read", { houseVaults: { [FACTORY]: [NOT_A_LEAF] } }, sameFile, { registry: reg });
    assert.equal((await result).status, "ready");
    assert.deepEqual(stub.calls.filter((c) => c[0] === "houseVaults"), [["houseVaults", FACTORY]]);
    const apply = run("apply", { houseVaults: { [FACTORY]: [NOT_A_LEAF] } }, sameFile, { registry: reg });
    assert.equal((await apply.result).status, "schedule");
  });

  test("a factory whose vaults cannot be listed refuses the run instead of passing it", async () => {
    await assert.rejects(run("read", { factoryError: "execution reverted" }, sameFile, { registry: houseRegistry }).result,
      /cannot list the House vaults of factory 0xfac7000000000000000000000000000000000001 \(v2\.house\.factories\[0\]\): execution reverted/);
  });

  test("a protocol key that is set but is not an address refuses the run", async () => {
    await assert.rejects(run("read", {}, sameFile, { registry: withV2({ contracts: { earnVault: "0x1234" } }) }).result,
      /registry key v2\.contracts\.earnVault is set but is not an address/);
  });

  test("a plan without its accounts is refused, not waved through", async () => {
    await assert.rejects(run("read", {}, sameFile, { plan: { ...plan, accounts: undefined } }).result, /carries no accounts/);
  });
});

describe("argument rules", () => {
  const env = { RH_RPC: "https://rpc.mainnet.chain.robinhood.com", INDEXER_URL: "https://indexer" };

  test("read-only is the default and needs neither --out nor the indexer", () => {
    const args = parseArgs(["e.json"], { RH_RPC: env.RH_RPC });
    assert.equal(args.mode, "read");
  });

  test("each batch mode needs --out", () => {
    assert.throws(() => parseArgs(["e.json", "--apply"], env), /--apply requires --out/);
    assert.throws(() => parseArgs(["e.json", "--execute"], env), /--execute requires --out/);
    assert.equal(parseArgs(["e.json", "--execute", "--out", "b.json"], env).mode, "execute");
  });

  test("--apply and --execute are separate runs", () => {
    assert.throws(() => parseArgs(["e.json", "--apply", "--execute", "--out", "b.json"], env), /separate runs/);
  });

  test("the maker program needs INDEXER_URL to regenerate, and refuses lender inputs", () => {
    assert.throws(() => parseArgs(["e.json", "--apply", "--out", "b.json"], { RH_RPC: env.RH_RPC }), /requires INDEXER_URL/);
    assert.throws(() => parseArgs(["e.json", "--balances", "b.json"], env), /lender regeneration inputs/);
  });

  test("the lender program needs its balance file to regenerate", () => {
    assert.throws(() => parseArgs(["e.json", "--program", "lender", "--execute", "--out", "b.json"], env), /requires --balances/);
    const args = parseArgs(["e.json", "--program", "lender", "--apply", "--out", "b.json", "--balances", "in.json",
      "--cap-bps", "2000", "--exclude", SAFE, "--exclude", MANAGER], { RH_RPC: env.RH_RPC });
    assert.deepEqual([args.balances, args.capBps, args.exclude], ["in.json", "2000", [SAFE, MANAGER]]);
  });

  test("a batch is never built from a local RPC", () => {
    assert.throws(() => parseArgs(["e.json", "--apply", "--out", "b.json"], { ...env, RH_RPC: "http://127.0.0.1:8545" }),
      /refuses a local RPC/);
  });
});
