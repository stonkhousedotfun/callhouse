/**
 * Tests for OWN8-07 (ops/v8/makervault-canary.mjs) and OWN8-08 (ops/v8/buyback-enable.mjs).
 *
 * Both modules are covered here because T-196's scope names one test file. Every guard below is written to go
 * RED when the fact it protects is ABSENT, not only when it is wrong: the dominant defect in this build is a
 * check that passes because it cannot see its subject, so `undefined`, a missing key, a five-field tuple, a
 * dead address and a route that reports configured:false each get their own case.
 *
 *   node --test ops/v8/makervault-canary.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT,
  LIMITS_FIELDS,
  Refusal,
  Unproven,
  assertNoKeyMaterial,
  compareLimits,
  fundingPlan,
  governingRole,
  intendedLimits,
  limitsCalldata,
  newRunId,
  parseAmount,
  parseArgs,
  readUsdgDecimals,
  resolveAddress,
  resolveTargets,
  verifyLimits,
} from "./makervault-canary.mjs";

import {
  SET_LIMITS_SIGNATURE,
} from "./makervault-canary.mjs";

import {
  CAP_USDG,
  SET_BUYBACK_CAP_SIGNATURE,
  capBaseUnits,
  capCalldata,
  classifyFlywheel,
  flywheelUrl,
  loadFeeSplitterAbi,
  parseArgs as parseBuybackArgs,
  resolveTargets as resolveBuybackTargets,
  verifyEnable,
  watchFirstBurn,
} from "./buyback-enable.mjs";

const VAULT = "0x1111111111111111111111111111111111111111";
const USDG = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";
const ADMIN = "0x4444444444444444444444444444444444444444";
const SPLITTER = "0x5555555555555555555555555555555555555555";
const EXECUTOR = "0x6666666666666666666666666666666666666666";

/** A registry with the v8 deploy written back, shaped exactly like ops/markets/tier1.json. */
function registryFixture(overrides = {}) {
  const base = {
    shared: {
      chainId: 4663,
      usdg: USDG,
      safes: { admin: ADMIN, treasury: TREASURY },
    },
    v2: {
      contracts: { makerVault: VAULT },
      flywheel: { feeSplitter: SPLITTER, buybackExecutor: EXECUTOR },
      protocolAddresses: { makerVault: VAULT, treasury: TREASURY, feeSplitter: SPLITTER, buybackExecutor: EXECUTOR },
      vault: {
        maxSeriesUnits: "10000",
        maxTotalNotional: "250000000000",
        askToleranceBps: 100,
        maxBidBpsOfSpot: 1000,
        maxOrderLifetime: 0,
        maxDailyOutflow: "2500000000",
      },
    },
  };
  return structuredClone({ ...base, ...overrides });
}

const EXPECTED = {
  maxSeriesUnits: 10_000n,
  maxTotalNotional: 250_000_000_000n,
  askToleranceBps: 100n,
  maxBidBpsOfSpot: 1_000n,
  maxOrderLifetime: 0n,
  maxDailyOutflow: 2_500_000_000n,
};

/**
 * A client whose defaults apply only to keys the caller omitted. Written with hasOwnProperty rather than
 * destructuring defaults because `{ code: undefined }` must reach the module as undefined: a fixture that
 * quietly substitutes live bytecode is itself a check that cannot see its subject, which is the defect this
 * file exists to catch. It was, on the first run.
 */
function vaultClient(options = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const chainId = has("chainId") ? options.chainId : 4663;
  const code = has("code") ? options.code : "0x60006000";
  const limits = has("limits") ? options.limits : { ...EXPECTED };
  const throws = has("throws") ? options.throws : null;
  return {
    getChainId: async () => chainId,
    getCode: async () => code,
    readContract: async () => {
      if (throws) throw throws;
      return limits;
    },
  };
}

test("the six Limits fields keep their storage order", () => {
  assert.deepEqual(
    LIMITS_FIELDS.map((f) => f.name),
    ["maxSeriesUnits", "maxTotalNotional", "askToleranceBps", "maxBidBpsOfSpot", "maxOrderLifetime", "maxDailyOutflow"],
  );
});

test("intendedLimits reads every field from the registry", () => {
  assert.deepEqual(intendedLimits(registryFixture()), EXPECTED);
});

test("a missing limits field is a refusal, never a default", () => {
  for (const { name } of LIMITS_FIELDS) {
    const registry = registryFixture();
    delete registry.v2.vault[name];
    assert.throws(() => intendedLimits(registry), (error) => error instanceof Refusal && error.message.includes(name));
  }
});

test("a null limits field is a refusal", () => {
  const registry = registryFixture();
  registry.v2.vault.maxDailyOutflow = null;
  assert.throws(() => intendedLimits(registry), Refusal);
});

test("limits the contract would reject are refused before they reach a Safe", () => {
  const overBps = registryFixture();
  overBps.v2.vault.askToleranceBps = 10_001;
  assert.throws(() => intendedLimits(overBps), (error) => error instanceof Refusal && /exceeds 10000/.test(error.message));

  const overflow = registryFixture();
  overflow.v2.vault.maxSeriesUnits = (2n ** 64n).toString();
  assert.throws(() => intendedLimits(overflow), (error) => error instanceof Refusal && /overflows uint64/.test(error.message));
});

test("an un-written-back registry refuses instead of verifying nothing", () => {
  const registry = registryFixture();
  registry.v2.contracts.makerVault = null;
  assert.throws(
    () => resolveTargets(registry),
    (error) => error instanceof Refusal && /has not been written back/.test(error.message),
  );
});

test("a registry that disagrees with its own mirror refuses", () => {
  const registry = registryFixture();
  registry.v2.protocolAddresses.makerVault = "0x9999999999999999999999999999999999999999";
  assert.throws(
    () => resolveTargets(registry),
    (error) => error instanceof Refusal && /disagrees with itself/.test(error.message),
  );
});

test("a null mirror beside a set address refuses - the registry is stale", () => {
  const registry = registryFixture();
  registry.v2.protocolAddresses.feeSplitter = null;
  assert.throws(
    () => resolveBuybackTargets(registry),
    (error) => error instanceof Refusal && /stale or hand-edited/.test(error.message),
  );
});

test("the zero address is not an identity", () => {
  const registry = registryFixture();
  registry.shared.usdg = "0x0000000000000000000000000000000000000000";
  assert.throws(() => resolveAddress(registry, { label: "USDG", key: "shared.usdg" }), Refusal);
});

test("compareLimits matches a full tuple", () => {
  const result = compareLimits(EXPECTED, { ...EXPECTED });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("A FIELD THE READBACK CANNOT SEE IS ABSENT, NOT A PASS", () => {
  // A v6 decoder against a v7 vault returns five fields. maxDailyOutflow is then undefined, and the whole
  // point of the outflow cap is that nobody notices it is unset. This must be RED.
  const fiveFields = { ...EXPECTED };
  delete fiveFields.maxDailyOutflow;
  const result = compareLimits(EXPECTED, fiveFields);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [{ field: "maxDailyOutflow", expected: "2500000000", observed: "ABSENT" }]);
});

test("an undefined or null field is ABSENT, not zero", () => {
  for (const value of [undefined, null]) {
    const result = compareLimits(EXPECTED, { ...EXPECTED, maxSeriesUnits: value });
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].observed, "ABSENT");
  }
});

test("a tuple that is not an object at all is UNPROVEN, not a mismatch", () => {
  for (const value of [undefined, null, "0x"]) {
    assert.throws(() => compareLimits(EXPECTED, value), Unproven);
  }
});

test("a wrong value is a mismatch with both sides named", () => {
  const result = compareLimits(EXPECTED, { ...EXPECTED, maxDailyOutflow: 1n });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [{ field: "maxDailyOutflow", expected: "2500000000", observed: "1" }]);
});

test("verifyLimits refuses the wrong chain", async () => {
  await assert.rejects(
    verifyLimits({ client: vaultClient({ chainId: 31337 }), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId: newRunId() }),
    Refusal,
  );
});

test("an address with no code is UNPROVEN - the readback has no subject", async () => {
  for (const code of ["0x", "", undefined, null]) {
    await assert.rejects(
      verifyLimits({ client: vaultClient({ code }), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId: newRunId() }),
      (error) => error instanceof Unproven && /no subject/.test(error.message),
    );
  }
});

test("a reverting limits() is UNPROVEN, not a mismatch", async () => {
  await assert.rejects(
    verifyLimits({
      client: vaultClient({ throws: new Error("execution reverted") }),
      makerVault: VAULT,
      expected: EXPECTED,
      expectedChainId: 4663,
      runId: newRunId(),
    }),
    Unproven,
  );
});

test("a clean readback mints a proof; a dirty one mints none", async () => {
  const runId = newRunId();
  const clean = await verifyLimits({ client: vaultClient(), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId });
  assert.equal(clean.comparison.ok, true);
  assert.ok(clean.proof);

  const dirty = await verifyLimits({
    client: vaultClient({ limits: { ...EXPECTED, maxTotalNotional: 1n } }),
    makerVault: VAULT,
    expected: EXPECTED,
    expectedChainId: 4663,
    runId,
  });
  assert.equal(dirty.comparison.ok, false);
  assert.equal(dirty.proof, null);
});

/** OWN8-07's structural ordering: prove by breaking the readback and requiring funding to refuse. */
test("FUNDING IS UNREACHABLE WHEN THE LIMITS READBACK FAILED", async () => {
  const runId = newRunId();
  const dirty = await verifyLimits({
    client: vaultClient({ limits: { ...EXPECTED, maxDailyOutflow: 0n } }),
    makerVault: VAULT,
    expected: EXPECTED,
    expectedChainId: 4663,
    runId,
  });
  assert.throws(
    () => fundingPlan({ proof: dirty.proof, runId, usdg: USDG, makerVault: VAULT, amountBaseUnits: 1n, decimals: 6, treasurySafe: TREASURY }),
    (error) => error instanceof Refusal && /no limits readback proof/.test(error.message),
  );
});

test("funding is unreachable without any readback at all", () => {
  const runId = newRunId();
  for (const proof of [null, undefined, {}, { runId }, { verifiedAt: "now", runId, address: VAULT }]) {
    assert.throws(
      () => fundingPlan({ proof, runId, usdg: USDG, makerVault: VAULT, amountBaseUnits: 1n, decimals: 6, treasurySafe: TREASURY }),
      Refusal,
    );
  }
});

test("a proof from an earlier run does not authorise funding now", async () => {
  const firstRun = newRunId();
  const verified = await verifyLimits({ client: vaultClient(), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId: firstRun });
  assert.throws(
    () => fundingPlan({ proof: verified.proof, runId: newRunId(), usdg: USDG, makerVault: VAULT, amountBaseUnits: 1n, decimals: 6, treasurySafe: TREASURY }),
    (error) => error instanceof Refusal && /not this run/.test(error.message),
  );
});

test("a proof for one vault does not authorise funding another", async () => {
  const runId = newRunId();
  const verified = await verifyLimits({ client: vaultClient(), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId });
  assert.throws(
    () => fundingPlan({ proof: verified.proof, runId, usdg: USDG, makerVault: "0x7777777777777777777777777777777777777777", amountBaseUnits: 1n, decimals: 6, treasurySafe: TREASURY }),
    (error) => error instanceof Refusal && /funding target/.test(error.message),
  );
});

test("a verified readback emits the funding instruction with its readback", async () => {
  const runId = newRunId();
  const verified = await verifyLimits({ client: vaultClient(), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId });
  const plan = fundingPlan({ proof: verified.proof, runId, usdg: USDG, makerVault: VAULT, amountBaseUnits: 25_000_000_000n, decimals: 6, treasurySafe: TREASURY });
  assert.equal(plan.from, TREASURY);
  assert.equal(plan.to, USDG);
  assert.match(plan.call, /^approve\(/);
  assert.equal(plan.then.to, VAULT);
  assert.match(plan.then.call, /^deposit\(/);
  assert.match(plan.readback, /balanceOf/);
  assert.equal(plan.provenLimits.maxDailyOutflow, EXPECTED.maxDailyOutflow);
});

test("funding refuses an amount with no decimals behind it", async () => {
  const runId = newRunId();
  const verified = await verifyLimits({ client: vaultClient(), makerVault: VAULT, expected: EXPECTED, expectedChainId: 4663, runId });
  for (const decimals of [null, undefined, -1, 1.5]) {
    assert.throws(
      () => fundingPlan({ proof: verified.proof, runId, usdg: USDG, makerVault: VAULT, amountBaseUnits: 1n, decimals, treasurySafe: TREASURY }),
      (error) => error instanceof Refusal && /decimals/.test(error.message),
    );
  }
  for (const amount of [0n, -1n, 1, "1"]) {
    assert.throws(
      () => fundingPlan({ proof: verified.proof, runId, usdg: USDG, makerVault: VAULT, amountBaseUnits: amount, decimals: 6, treasurySafe: TREASURY }),
      Refusal,
    );
  }
});

test("USDG decimals are read from chain and UNPROVEN when the token has no code", async () => {
  const client = { getCode: async () => "0x", readContract: async () => 6 };
  await assert.rejects(readUsdgDecimals({ client, usdg: USDG }), Unproven);
  const live = { getCode: async () => "0x6000", readContract: async () => 6 };
  assert.equal(await readUsdgDecimals({ client: live, usdg: USDG }), 6);
});

test("parseAmount refuses more precision than the token has", () => {
  assert.equal(parseAmount("25000", 6), 25_000_000_000n);
  assert.equal(parseAmount("0.5", 6), 500_000n);
  assert.throws(() => parseAmount("1.0000001", 6), Refusal);
  assert.throws(() => parseAmount("1e6", 6), Refusal);
});

test("setLimits encodes the pinned selector 0x6693cc27", () => {
  // Pinned: MakerVault.sol:126 states the INTERFACE_VERSION 7 selector. Derived here from the signature so a
  // reordered tuple in LIMITS_FIELDS or a retyped signature cannot slip through.
  const data = limitsCalldata(EXPECTED);
  assert.equal(data.slice(0, 10), "0x6693cc27");
  assert.equal(data.length, 10 + 64 * 6);
});

test("argv that carries key material is refused", () => {
  assert.throws(() => assertNoKeyMaterial(["--fund-usdg", `0x${"a".repeat(64)}`]), Refusal);
  assert.doesNotThrow(() => assertNoKeyMaterial(["--execute", "--chain-id", "4663"]));
});

test("the canary CLI is dry by default and gates funding on --execute", () => {
  assert.equal(parseArgs([]).execute, false);
  assert.throws(() => parseArgs(["--execute"]), (error) => error instanceof Refusal && /--chain-id/.test(error.message));
  assert.throws(() => parseArgs(["--fund-usdg", "1"]), (error) => error instanceof Refusal && /unreachable/.test(error.message));
  const opts = parseArgs(["--execute", "--chain-id", "4663", "--fund-usdg", "25000"]);
  assert.equal(opts.execute, true);
  assert.equal(opts.chainId, 4663);
});

/* ------------------------------- OWN8-08 ------------------------------- */

test("the FeeSplitter ABI comes from the artifact and must contain the calls this task uses", () => {
  const abi = loadFeeSplitterAbi();
  for (const name of ["setBuybackCap", "buybackCap", "executor", "paused"]) {
    assert.ok(abi.some((e) => e.type === "function" && e.name === name), `${name} missing from the shipped artifact`);
  }
});

test("an artifact missing setBuybackCap refuses instead of falling back to a typed signature", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t196-"));
  try {
    const file = path.join(dir, "FeeSplitter.json");
    writeFileSync(file, JSON.stringify([{ type: "function", name: "buybackCap", inputs: [], outputs: [] }]));
    assert.throws(() => loadFeeSplitterAbi(file), (error) => error instanceof Refusal && /setBuybackCap/.test(error.message));
    writeFileSync(file, "{}");
    assert.throws(() => loadFeeSplitterAbi(file), Refusal);
    assert.throws(() => loadFeeSplitterAbi(path.join(dir, "absent.json")), Refusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cap is never scaled by a guessed decimals", () => {
  assert.equal(capBaseUnits(CAP_USDG, 6), 50_000_000n);
  assert.equal(capBaseUnits(CAP_USDG, 18), 50n * 10n ** 18n);
  for (const decimals of [null, undefined, -1, 1.5, "6"]) {
    assert.throws(() => capBaseUnits(CAP_USDG, decimals), (error) => error instanceof Refusal && /decimals are unknown/.test(error.message));
  }
});

test("setBuybackCap encodes the pinned selector 0x364db0e2 at the 50 USDG cap", () => {
  const data = capCalldata({ capUsdg: CAP_USDG, decimals: 6 });
  assert.equal(data.slice(0, 10), "0x364db0e2");
  assert.equal(BigInt(`0x${data.slice(10)}`), 50_000_000n);
});

test("verifyEnable refuses the wrong chain and is UNPROVEN on a dead splitter", async () => {
  const client = { getChainId: async () => 1, getCode: async () => "0x60", readContract: async () => 0n };
  await assert.rejects(
    verifyEnable({ client, feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 }),
    Refusal,
  );
  const dead = { getChainId: async () => 4663, getCode: async () => "0x", readContract: async () => 0n };
  await assert.rejects(
    verifyEnable({ client: dead, feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 }),
    (error) => error instanceof Unproven && /no subject/.test(error.message),
  );
});

/** Same rule as {vaultClient}: an explicitly passed `undefined` must survive to the module. */
function splitterClient(options = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const values = {
    buybackCap: has("cap") ? options.cap : 50_000_000n,
    executor: has("executor") ? options.executor : EXECUTOR,
    paused: has("paused") ? options.paused : false,
  };
  return {
    getChainId: async () => 4663,
    getCode: async () => "0x60",
    readContract: async ({ functionName }) => values[functionName],
  };
}

test("a verified enable needs the cap, the executor and unpaused all three", async () => {
  const ok = await verifyEnable({ client: splitterClient(), feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 });
  assert.equal(ok.ok, true);

  const wrongCap = await verifyEnable({ client: splitterClient({ cap: 1n }), feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 });
  assert.equal(wrongCap.ok, false);
  assert.equal(wrongCap.findings[0].check, "buybackCap");

  const wrongExecutor = await verifyEnable({ client: splitterClient({ executor: "0x0000000000000000000000000000000000000000" }), feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 });
  assert.equal(wrongExecutor.ok, false);

  const paused = await verifyEnable({ client: splitterClient({ paused: true }), feeSplitter: SPLITTER, expectedCapBaseUnits: 50_000_000n, expectedExecutor: EXECUTOR, expectedChainId: 4663 });
  assert.equal(paused.ok, false);
});

test("A CAP OR PAUSE FLAG THE READBACK CANNOT SEE IS ABSENT, NOT A PASS", async () => {
  const blind = await verifyEnable({
    client: splitterClient({ cap: undefined, executor: undefined, paused: undefined }),
    feeSplitter: SPLITTER,
    expectedCapBaseUnits: 50_000_000n,
    expectedExecutor: EXECUTOR,
    expectedChainId: 4663,
  });
  assert.equal(blind.ok, false);
  assert.deepEqual(blind.findings.map((f) => [f.check, f.observed]), [["buybackCap", "ABSENT"], ["executor", "ABSENT"], ["paused", "ABSENT"]]);
});

test("classifyFlywheel tells apart blind, waiting and burned", () => {
  assert.equal(classifyFlywheel({ configured: true, burnedTotal: "1250" }).state, "burned");
  assert.equal(classifyFlywheel({ configured: true, burnedTotal: "0" }).state, "waiting");
  assert.equal(classifyFlywheel({ configured: false, burnedTotal: null }).state, "blind");
  assert.equal(classifyFlywheel({ configured: true, burnedTotal: null }).state, "blind");
  assert.equal(classifyFlywheel({ configured: true }).state, "blind");
  assert.equal(classifyFlywheel({ configured: true, burnedTotal: "not-a-number" }).state, "blind");
  for (const body of [null, undefined, [], "{}"]) assert.equal(classifyFlywheel(body).state, "blind");
});

test("THE BURN WATCH FAILS ON SILENCE RATHER THAN REPORTING SUCCESS", async () => {
  let clock = 0;
  const result = await watchFirstBurn({
    fetchJson: async () => ({ configured: true, burnedTotal: "0" }),
    windowSeconds: 60,
    pollSeconds: 20,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "silent");
  assert.match(result.why, /no burn indexed within 60s/);
});

test("the burn watch returns as soon as a burn is indexed", async () => {
  let polls = 0;
  const result = await watchFirstBurn({
    fetchJson: async () => {
      polls += 1;
      return polls < 3 ? { configured: true, burnedTotal: "0" } : { configured: true, burnedTotal: "1250", lastDistribution: { tx: "0xabc" } };
    },
    windowSeconds: 600,
    pollSeconds: 1,
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1250n);
  assert.equal(result.polls, 3);
});

test("a route that cannot see burns is blind, and blind is not a pass", async () => {
  const blind = await watchFirstBurn({
    fetchJson: async () => ({ configured: false, burnedTotal: null }),
    windowSeconds: 600,
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(blind.ok, false);
  assert.equal(blind.state, "blind");
  assert.match(blind.why, /configured:false/);

  const broken = await watchFirstBurn({
    fetchJson: async () => { throw new Error("HTTP 502"); },
    windowSeconds: 600,
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.state, "blind");
  assert.match(broken.why, /HTTP 502/);
});

test("the indexer URL comes from the environment", () => {
  assert.equal(flywheelUrl("https://indexer.example/"), "https://indexer.example/v2/flywheel");
  for (const base of [undefined, null, ""]) assert.throws(() => flywheelUrl(base), Refusal);
});

test("the buyback CLI is dry by default and gates the watch on --execute", () => {
  assert.equal(parseBuybackArgs([]).execute, false);
  assert.equal(parseBuybackArgs([]).capUsdg, CAP_USDG);
  assert.throws(() => parseBuybackArgs(["--execute"]), Refusal);
  assert.throws(() => parseBuybackArgs(["--watch-burn"]), (error) => error instanceof Refusal && /only runs after/.test(error.message));
  assert.throws(() => parseBuybackArgs(["--execute", "--chain-id", "4663", "--window-seconds", "0"]), Refusal);
});

test("the governing role and delay are read from roles.json, not retyped", () => {
  const roles = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "abis", "v2", "roles.json"), "utf8"));
  const limits = governingRole({ target: "MakerVault", signature: SET_LIMITS_SIGNATURE });
  assert.equal(limits.role, roles.targets.MakerVault[SET_LIMITS_SIGNATURE]);
  assert.equal(limits.delaySeconds, roles.delaysS[limits.role]);
  assert.equal(limits.roleId, roles.roles[limits.role]);

  const cap = governingRole({ target: "FeeSplitter", signature: SET_BUYBACK_CAP_SIGNATURE });
  assert.equal(cap.role, roles.targets.FeeSplitter[SET_BUYBACK_CAP_SIGNATURE]);
  assert.equal(cap.delaySeconds, roles.delaysS[cap.role]);

  // Both are delayed calls, so neither is a transaction the Safe just sends. If a manifest edit ever makes one
  // instant, this goes red and the runbook's schedule-wait-send step has to be re-read, not assumed.
  assert.ok(limits.delaySeconds > 0, "setLimits is expected to be a delayed call");
  assert.ok(cap.delaySeconds > 0, "setBuybackCap is expected to be a delayed call");
});

test("AN UNMAPPED SELECTOR OR TARGET REFUSES - IT NEVER FALLS BACK TO A DEFAULT ROLE", () => {
  const roles = { roles: { OPS_ADMIN: 6 }, delaysS: { OPS_ADMIN: 0 }, targets: { MakerVault: { "setLimits(uint256)": "OPS_ADMIN" } } };
  assert.throws(
    () => governingRole({ target: "EarnVault", signature: "setQueueAdmin(address)", roles }),
    (error) => error instanceof Refusal && /no targets.EarnVault block/.test(error.message),
  );
  assert.throws(
    () => governingRole({ target: "MakerVault", signature: SET_LIMITS_SIGNATURE, roles }),
    (error) => error instanceof Refusal && /does not map/.test(error.message),
  );
  assert.throws(
    () => governingRole({ target: "MakerVault", signature: "setLimits(uint256)", roles: { targets: { MakerVault: { "setLimits(uint256)": "GHOST" } }, delaysS: {}, roles: {} } }),
    (error) => error instanceof Refusal && /execution delay/.test(error.message),
  );
  assert.throws(() => governingRole({ target: "MakerVault", signature: SET_LIMITS_SIGNATURE, roles: {} }), Refusal);
});

test("roles.json carries no EarnVault target block at this SHA", () => {
  // T-196's contract asks for a conclusion on six EarnVault selectors said to be mapped to OPS_ADMIN, a
  // delay-0 role. In THIS repository's manifest there is no EarnVault block at all and no selector anywhere
  // maps to OPS_ADMIN, so any consumer that enumerates targets from this file covers zero EarnVault
  // selectors. This test records that state so a later edit that adds the block is visible rather than silent.
  const roles = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "abis", "v2", "roles.json"), "utf8"));
  const opsAdmin = Object.entries(roles.targets).flatMap(([t, m]) => Object.entries(m).filter(([, r]) => r === "OPS_ADMIN").map(([sel]) => `${t}.${sel}`));
  assert.deepEqual(opsAdmin, [], "a selector now maps to OPS_ADMIN (delay 0): re-read T-196's note on the EarnVault mapping");
  assert.equal(roles.targets.EarnVault, undefined, "EarnVault now has a target block: check its selectors' roles and delays");
});

test("exit codes keep UNPROVEN distinct from a failure", () => {
  assert.deepEqual(EXIT, { OK: 0, REFUSED: 1, ERROR: 2, UNPROVEN: 3 });
});
