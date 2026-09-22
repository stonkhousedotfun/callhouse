/* -------------------------------------------------------------------------------------------------
 * node --test ops/v2/devnet-admin.test.mjs
 *
 * The published selector -> role -> delay -> mode mapping of the v8 admin driver, and the refusals
 * that keep it honest. Four other tasks (K8-04, W8-04, X8-05, O8-06) code against what this file
 * pins, so it is RUN under the owner's build-mode directive rather than only written.
 *
 * NODE BUILTINS ONLY, like ops/v2/monitor.test.mjs. Nothing here imports viem, and nothing here
 * reaches a chain: ops/v2/lib/admin.mjs keeps loadRoles and planFor pure exactly so that the whole
 * mapping is testable in a worktree with no node_modules, which is the state every v8 app worktree
 * is in today. The chain half (adminCall / adminCancel) is covered on a real devnet by the drills
 * O8-06 runs; what CAN be proven without one is proven here.
 *
 * THE LITERAL DELAYS IN "the five published delay lanes" ARE A PIN, NOT A SECOND SOURCE OF TRUTH.
 * Every other assertion compares the plan against ops/abis/v2/roles.json; that one compares the
 * manifest against the numbers this task published, so a later edit of the manifest cannot move a
 * lane under four tasks without turning this test red.
 * ------------------------------------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdminError,
  INTERFACE_VERSION,
  MODES,
  MSG_SENDER_FUNCTIONS,
  ROLES_FILE,
  abiItemFor,
  allPlans,
  canonicalSignature,
  coerceArg,
  coerceArgs,
  loadRoles,
  parseSignature,
  planFor,
} from "./lib/admin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "devnet-admin.mjs");
const roles = loadRoles();

/** A child CLI run with a built environment: nothing of the caller's shell can change the answer. */
function cli(args, { addresses = null, rpc = null } = {}) {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  if (addresses !== null) env.DEVNET_ADDRESSES = addresses;
  if (rpc !== null) env.DEVNET_RPC = rpc;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const tempJson = (value) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devnet-admin-"));
  const file = path.join(dir, "addresses.json");
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return { dir, file };
};

const A_NVDA = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const A_MANAGER = "0x1111111111111111111111111111111111111111";
const A_SAFE = "0x2222222222222222222222222222222222222222";
const A_CLEARINGHOUSE = "0x3333333333333333333333333333333333333333";

/* ---------------------------------------------------------------------------------------------- */

describe("the manifest", () => {
  test("loadRoles reads ops/abis/v2/roles.json and it is the v8 manifest", () => {
    assert.equal(roles.interfaceVersion, INTERFACE_VERSION);
    assert.equal(roles.file, ROLES_FILE);
    assert.ok(Object.keys(roles.targets).length > 0, "the manifest publishes no targets at all");
  });

  test("a manifest of another interface version is refused, not planned from", () => {
    const { dir, file } = tempJson({ ...JSON.parse(readFileSync(ROLES_FILE, "utf8")), interfaceVersion: 7 });
    try {
      assert.throws(() => loadRoles(file), (error) => error instanceof AdminError && /interfaceVersion is 7/.test(error.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a role without an execution delay is refused", () => {
    const manifest = JSON.parse(readFileSync(ROLES_FILE, "utf8"));
    delete manifest.delaysS.GUARDIAN;
    const { dir, file } = tempJson(manifest);
    try {
      assert.throws(() => loadRoles(file), (error) => error instanceof AdminError && /role GUARDIAN has delaysS/.test(error.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every published signature plans", () => {
  test("each target signature resolves to a plan whose role, id and delay are the manifest's", () => {
    let planned = 0;
    for (const [contract, functions] of Object.entries(roles.targets)) {
      for (const [signature, role] of Object.entries(functions)) {
        const plan = planFor({ target: contract, signature, roles });
        assert.equal(plan.contract, contract);
        assert.equal(plan.signature, signature, `${contract}.${signature} is not spelled canonically in the manifest`);
        assert.equal(plan.role, role);
        assert.equal(plan.roleId, roles.roles[role], `${contract}.${signature}: role id`);
        assert.equal(plan.delayS, roles.delaysS[role], `${contract}.${signature}: execution delay`);
        assert.ok(MODES.includes(plan.mode), `${contract}.${signature}: mode ${plan.mode}`);
        planned += 1;
      }
    }
    // V4BuybackExecutor has no privileged function at all (roles.json unrestricted.V4BuybackExecutor),
    // so the count is every OTHER target's; a manifest that lost a whole contract would show up here.
    assert.equal(planned, allPlans(roles).length);
    assert.ok(planned >= 60, `only ${planned} restricted functions planned; the v8 manifest publishes many more`);
  });

  test("a plan is a pure read: no node, no addresses, no environment", () => {
    const plan = planFor({ target: "Clearinghouse", signature: "setMarketFees(address,uint16,uint32)", roles });
    assert.deepEqual(plan, {
      contract: "Clearinghouse",
      signature: "setMarketFees(address,uint16,uint32)",
      role: "MARKET_FEE_MANAGER",
      roleId: roles.roles.MARKET_FEE_MANAGER,
      delayS: roles.delaysS.MARKET_FEE_MANAGER,
      mode: "schedule-execute",
    });
  });
});

describe("an unmapped signature is refused, never planned as ADMIN", () => {
  test("a signature the manifest does not carry is refused by contract and signature", () => {
    assert.throws(
      () => planFor({ target: "Clearinghouse", signature: "setOwner(address)", roles }),
      (error) =>
        error instanceof AdminError &&
        error.message.includes("Clearinghouse.setOwner(address)") &&
        error.message.includes("is not a restricted function") &&
        /ADMIN/.test(error.message),
    );
  });

  test("no unmapped signature on any target ever comes back as ADMIN", () => {
    // roles.json notes.adminHasNoTarget: an unmapped restricted selector falls to ADMIN on chain.
    // A driver that filled ADMIN in would perform that mistake instead of catching it.
    for (const contract of Object.keys(roles.targets)) {
      assert.throws(
        () => planFor({ target: contract, signature: "notAFunctionOfThisContract(uint256)", roles }),
        (error) => error instanceof AdminError && error.message.startsWith(`${contract}.notAFunctionOfThisContract(uint256)`),
        `${contract} planned an unmapped signature`,
      );
    }
    assert.equal(roles.roles.ADMIN, 0);
    for (const [contract, functions] of Object.entries(roles.targets)) {
      for (const [signature, role] of Object.entries(functions)) {
        assert.notEqual(role, "ADMIN", `${contract}.${signature} is mapped to ADMIN, which is manager-only (notes.adminHasNoTarget)`);
      }
    }
  });

  test("a contract the manifest does not carry is refused with the target list", () => {
    assert.throws(
      () => planFor({ target: "Treasury", signature: "setTreasury(address)", roles }),
      (error) => error instanceof AdminError && /Treasury is not a target/.test(error.message) && /Clearinghouse/.test(error.message),
    );
  });
});

describe("the five published delay lanes", () => {
  /**
   * One representative per lane, and the literal each lane runs at. THESE LITERALS ARE THE PIN: every
   * other assertion in this file compares a plan against the manifest, this one compares the manifest
   * against what F8-03 published for K8-04, W8-04, X8-05 and O8-06 to build against.
   */
  const LANES = [
    { delayS: 0, role: "GUARDIAN", contract: "OrderBook", signature: "setTradingPaused(bool)", mode: "execute" },
    { delayS: 3600, role: "LISTING", contract: "ExpiryCalendar", signature: "setSpecialExpiry(uint40,bool)", mode: "schedule-execute" },
    { delayS: 86400, role: "CONFIG_ADMIN", contract: "Clearinghouse", signature: "setMinter(address,bool)", mode: "schedule-execute" },
    { delayS: 172800, role: "FEE_MANAGER", contract: "OrderBook", signature: "setMakerRegistry(address)", mode: "schedule-execute" },
    { delayS: 259200, role: "MARKET_FEE_MANAGER", contract: "Clearinghouse", signature: "setMarketFees(address,uint16,uint32)", mode: "schedule-execute" },
  ];

  for (const lane of LANES) {
    test(`${lane.contract}.${lane.signature} is ${lane.role}, ${lane.delayS} s, ${lane.mode}`, () => {
      const plan = planFor({ target: lane.contract, signature: lane.signature, roles });
      assert.equal(plan.role, lane.role);
      assert.equal(plan.delayS, roles.delaysS[plan.role], "the plan's delay is not the manifest's delay for its role");
      assert.equal(plan.delayS, lane.delayS, "the manifest moved this lane");
      assert.equal(plan.mode, lane.mode);
    });
  }

  test("every role's delay is one of the five lanes, and every lane is a role", () => {
    const published = new Set(Object.values(roles.delaysS));
    assert.deepEqual([...published].sort((a, b) => a - b), [...new Set(LANES.map((l) => l.delayS))].sort((a, b) => a - b));
  });

  test("a delay-0 role is never scheduled, because schedule reverts on a zero setback", () => {
    // AccessManager.sol:464-465 reverts AccessManagerUnauthorizedCall when setback == 0, so this is
    // not belt and braces: a scheduled GUARDIAN / OPS_ADMIN / PRICER / QUOTER / BUYBACK call reverts.
    for (const plan of allPlans(roles)) {
      if (plan.delayS === 0) assert.equal(plan.mode, "execute", `${plan.contract}.${plan.signature} (${plan.role}) would be scheduled at delay 0`);
      else assert.notEqual(plan.mode, "execute", `${plan.contract}.${plan.signature} (${plan.role}) would skip its ${plan.delayS} s delay`);
    }
  });
});

describe("the schedule-direct set is exactly MSG_SENDER_FUNCTIONS", () => {
  test("nothing plans schedule-direct that the list does not name", () => {
    const direct = allPlans(roles)
      .filter((plan) => plan.mode === "schedule-direct")
      .map((plan) => `${plan.contract}.${plan.signature}`);
    assert.deepEqual(direct.sort(), [...MSG_SENDER_FUNCTIONS].sort());
  });

  test("the list is empty at INTERFACE_VERSION 8, and every name in it must be a real manifest entry", () => {
    // Empty is the read result at this base, not an oversight: v8 deleted the free-`to` money exits,
    // so no delayed target function reads msg.sender. See the comment on MSG_SENDER_FUNCTIONS. This
    // assertion is what tells the next lane that adding an entry is a deliberate act.
    assert.equal(MSG_SENDER_FUNCTIONS.size, 0);
    for (const key of MSG_SENDER_FUNCTIONS) {
      const dot = key.indexOf(".");
      const contract = key.slice(0, dot);
      const signature = key.slice(dot + 1);
      assert.ok(roles.targets[contract]?.[signature], `${key} is in MSG_SENDER_FUNCTIONS and not in the manifest`);
      assert.ok(roles.delaysS[roles.targets[contract][signature]] > 0, `${key} has no delay, so it can never be scheduled`);
    }
  });

  test("a named entry does take the schedule-direct path", () => {
    // The mode logic itself, proven without faking the published manifest: the same signature plans
    // schedule-execute out of the manifest and schedule-direct when the set names it.
    const target = "MakerVault";
    const signature = "withdraw(address,uint256)";
    assert.equal(planFor({ target, signature, roles }).mode, "schedule-execute");
    const named = planFor({ target, signature, roles, msgSenderFunctions: new Set([`${target}.${signature}`]) });
    assert.equal(named.mode, "schedule-direct");
    // A delay-0 function stays on `execute` even if it is named: scheduling it would revert.
    const zero = planFor({
      target: "OrderBook",
      signature: "setTradingPaused(bool)",
      roles,
      msgSenderFunctions: new Set(["OrderBook.setTradingPaused(bool)"]),
    });
    assert.equal(zero.mode, "execute");
  });
});

describe("signatures and arguments", () => {
  test("spacing is normalised and types are not", () => {
    assert.equal(canonicalSignature("setMarketFees( address , uint16 , uint32 )"), "setMarketFees(address,uint16,uint32)");
    assert.equal(canonicalSignature("function setMinter(address minter, bool allowed)"), "setMinter(address,bool)");
    // uint and int are aliases; the canonical spelling is what the manager was mapped with.
    assert.equal(canonicalSignature("defund(uint)"), "defund(uint256)");
    assert.equal(canonicalSignature("cancel(uint256[])"), "cancel(uint256[])");
  });

  test("a tuple signature parses into components, not into a string", () => {
    const item = abiItemFor("setFeeParams((uint16,uint16,uint32,uint16,uint16))");
    assert.equal(item.name, "setFeeParams");
    assert.equal(item.inputs.length, 1);
    assert.equal(item.inputs[0].type, "tuple");
    assert.deepEqual(item.inputs[0].components.map((c) => c.type), ["uint16", "uint16", "uint32", "uint16", "uint16"]);
    assert.equal(canonicalSignature("setFeeParams((uint16,uint16,uint32,uint16,uint16))"), "setFeeParams((uint16,uint16,uint32,uint16,uint16))");
  });

  test("the vault's 10-field take tuple survives the round trip", () => {
    const signature = "take((uint256,bool,uint256[],uint64,uint64,uint128,bool,address,uint40,uint128))";
    assert.equal(canonicalSignature(signature), signature);
    assert.equal(roles.targets.MakerVault[signature], "QUOTER");
    const { inputs } = parseSignature(signature);
    assert.equal(inputs[0].components.length, 10);
    assert.equal(inputs[0].components[2].type, "uint256[]");
  });

  test("a type the driver cannot encode is refused rather than guessed", () => {
    assert.throws(() => parseSignature("setThing(uint257)"), AdminError);
    assert.throws(() => parseSignature("setThing(bytes33)"), AdminError);
    assert.throws(() => parseSignature("setThing(Struct)"), AdminError);
    assert.throws(() => parseSignature("setThing(address"), AdminError);
  });

  test("arguments are coerced to what viem encodes, and out-of-range is caught here", () => {
    assert.deepEqual(coerceArgs("setMarketFees(address,uint16,uint32)", [A_NVDA, "500", "0"]), [A_NVDA.toLowerCase(), 500n, 0n]);
    assert.deepEqual(coerceArgs("setMinter(address,bool)", [A_NVDA, "true"]), [A_NVDA.toLowerCase(), true]);
    assert.deepEqual(coerceArgs("setFeeParams((uint16,uint16,uint32,uint16,uint16))", ["[100,50,0,25,10]"]), [[100n, 50n, 0n, 25n, 10n]]);
    assert.deepEqual(coerceArgs("setHolidays(uint32[],bool)", ["[19723,19724]", "false"]), [[19723n, 19724n], false]);
    assert.deepEqual(coerceArg({ type: "uint256" }, "1_000_000"), 1000000n);
    assert.deepEqual(coerceArg({ type: "uint256" }, "0xff"), 255n);
    assert.throws(() => coerceArgs("setMarketFees(address,uint16,uint32)", [A_NVDA, "70000", "0"]), /does not fit in uint16/);
    assert.throws(() => coerceArgs("setMarketFees(address,uint16,uint32)", ["0xnope", "500", "0"]), /not a 20-byte address/);
    assert.throws(() => coerceArgs("setMarketFees(address,uint16,uint32)", [A_NVDA, "500"]), /takes 3 argument/);
    assert.throws(() => coerceArgs("setFeeParams((uint16,uint16,uint32,uint16,uint16))", ["[100,50,0,25]"]), /wants 5 fields/);
    // A JSON number past 2^53 has already lost digits before it reaches the encoder.
    assert.throws(() => coerceArgs("defund(uint256)", ["[1]"]), /not a uint256/);
    assert.throws(() => coerceArg({ type: "uint256" }, 2 ** 53 + 2), /past 2\^53/);
  });
});

describe("no delay constant lives in the driver", () => {
  test("neither source file writes down a published delay", () => {
    // The acceptance grep, as a test: every delay is read from the manifest at run time, so a second
    // copy of one cannot drift silently. The literals below are this file's pin, not the driver's.
    const published = [...new Set(Object.values(roles.delaysS))].filter((d) => d > 0).map(String);
    for (const file of ["lib/admin.mjs", "devnet-admin.mjs"]) {
      const text = readFileSync(path.join(HERE, file), "utf8");
      for (const delay of published) {
        assert.ok(!text.includes(delay), `${file} writes down the delay ${delay}; read it from the manifest instead`);
      }
    }
  });
});

describe("the CLI", () => {
  test("--dry-run prints the plan, sends nothing, and opens no connection", async () => {
    // Proven rather than asserted: DEVNET_RPC points at a server in this process that fails the test
    // if the child so much as connects to it.
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.url);
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const rpc = `http://127.0.0.1:${server.address().port}`;
    const { dir, file } = tempJson({
      contracts: { clearinghouse: A_CLEARINGHOUSE, accessManager: A_MANAGER },
      accounts: { adminSafe: A_SAFE },
    });
    try {
      const run = await cli(["--dry-run", "Clearinghouse", "setMarketFees(address,uint16,uint32)", A_NVDA, "500", "0"], { addresses: file, rpc });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /role\s+MARKET_FEE_MANAGER \(2\)/);
      assert.match(run.stdout, new RegExp(`delay\\s+${roles.delaysS.MARKET_FEE_MANAGER} s`));
      assert.match(run.stdout, /mode\s+schedule-execute/);
      assert.match(run.stdout, /dry run: nothing was sent/);
      assert.match(run.stdout, new RegExp(A_MANAGER, "i"));
      assert.match(run.stdout, new RegExp(A_SAFE, "i"));
      assert.match(run.stdout, new RegExp(A_CLEARINGHOUSE, "i"));
      assert.deepEqual(seen, [], "the dry run reached the RPC endpoint");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unmapped signature exits non-zero and names the contract and the signature", async () => {
    const run = await cli(["--dry-run", "Clearinghouse", "setOwner(address)", A_NVDA]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Clearinghouse\.setOwner\(address\) is not a restricted function/);
    assert.match(run.stderr, /never planned as ADMIN/);
  });

  test("a missing manager or Safe fails with the exact key it looked for", async () => {
    const noManager = tempJson({ contracts: { clearinghouse: A_CLEARINGHOUSE }, accounts: { adminSafe: A_SAFE } });
    const noSafe = tempJson({ contracts: { clearinghouse: A_CLEARINGHOUSE, accessManager: A_MANAGER }, accounts: {} });
    try {
      const a = await cli(["Clearinghouse", "setCreatePaused(bool)", "true"], { addresses: noManager.file });
      assert.equal(a.code, 2);
      assert.match(a.stderr, /contracts\.accessManager/);
      const b = await cli(["Clearinghouse", "setCreatePaused(bool)", "true"], { addresses: noSafe.file });
      assert.equal(b.code, 2);
      assert.match(b.stderr, /accounts\.adminSafe/);
    } finally {
      rmSync(noManager.dir, { recursive: true, force: true });
      rmSync(noSafe.dir, { recursive: true, force: true });
    }
  });

  test("a target the address book does not name is refused before anything is sent", async () => {
    const { dir, file } = tempJson({ contracts: { accessManager: A_MANAGER }, accounts: { adminSafe: A_SAFE } });
    try {
      const run = await cli(["Clearinghouse", "setCreatePaused(bool)", "true"], { addresses: file });
      assert.equal(run.code, 2);
      assert.match(run.stderr, /no address for Clearinghouse/);
      assert.match(run.stderr, /contracts\.clearinghouse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--help is help and an unknown flag is a usage error", async () => {
    const help = await cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /usage: node ops\/v2\/devnet-admin\.mjs/);
    const bad = await cli(["--wat", "Clearinghouse", "setCreatePaused(bool)", "true"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown flag --wat/);
  });
});
