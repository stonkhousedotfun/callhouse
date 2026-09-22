/**
 * ops/markets/write-back-v8.mjs: the writer's own assertions — planned writes, twin construction,
 * idempotence, the overwrite refusal, and the completeness gate that stops it writing a registry it
 * knows is half-filled. Offline: no chain, no network, temp copies only, the checkout is never written.
 *
 *   node --test ops/markets/write-back-v8.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  V2_DEPLOYED_REQUIRED_PATHS,
  V2_PROTOCOL_DISTRIBUTOR_KEYS,
  V2_PROTOCOL_KEYS,
  validateDeployedCompleteness,
  validateV2,
} from "./build-markets.mjs";
// `mirrorFrom` is deliberately NOT imported: an expectation computed by the code under test is the
// tautology T-442 removed. The schema constants above are the expectation instead.
import { applyRecord, plannedWrites } from "./write-back-v8.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = () => JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
const addr = (n) => `0x${String(n).padStart(40, "0")}`;

const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function tempRegistry() {
  const dir = mkdtempSync(path.join(tmpdir(), "writeback-"));
  temps.push(dir);
  const file = path.join(dir, "tier1.json");
  writeFileSync(file, `${JSON.stringify(read(), null, 2)}\n`);
  return file;
}

/**
 * A complete launch-night record IN THE SHAPE `DeployV8.s.sol` toJson ACTUALLY EMITS.
 *
 * THE PREVIOUS VERSION OF THIS FIXTURE WAS THE BUG. It wrapped the eleven addresses in a
 * `contracts: { … }` object that the emitter has never written, which is the same imagined shape
 * the reader was coded against — so the test agreed with the code, both disagreed with the
 * producer, and the suite was green while every address silently failed to be written. A fixture
 * hand-written from the same intent as the code under test cannot catch a disagreement with a
 * third party; it can only confirm that the code matches itself.
 *
 * Copied key for key from toJson:1973 and its helpers `_jsonCore`, `_jsonTrading`, `_jsonFlywheel`
 * and `_jsonPrincipals` at callhouse-contracts 5e431016c2b510caf7ad2f30c7c7e0dabbfcacd2: eleven
 * addresses at the TOP LEVEL, `sources` and `flywheel` nested beside them.
 *
 * `wallets.opsWallet` is ABSENT on purpose and must stay absent: `DeployV8` has no such input
 * (Roles carries two Safes, four bot keys, the fee recipient and the deployer), so a record that
 * carried one would be a fiction. The completeness rule is what must report it.
 */
function record(n = 1) {
  let i = n;
  const next = () => addr(i++);
  const feeSplitter = next();
  // T-OP-156 REPAIR, and the reason six cases in this file were RED at the tip since T-OP-108 / T-OP-111 landed
  // the real principals (2026-09-21): the committed registry now CARRIES the two Safes, the guardian and the three
  // bot keys, and this tool refuses to overwrite a filled slot with a different address without --force. A
  // fixture that invents principals therefore conflicts with every one of them before a single contract address
  // is written -- eight conflicts, nothing applied, six tests red -- and NOT because the writer is wrong: on
  // launch night the deployment record carries the SAME principals the registry already names (DeployV8 reads
  // them from the registry through registry-env.sh), so `current === value` and the write is a no-op there.
  // The record must therefore say what the producer would say: the registry's own principals where it has them,
  // an invented one only where it is still null. (Invented principals stay in the record's SHAPE -- every key the
  // producer emits is still emitted -- only their values follow the registry.)
  const shipped = read();
  const guardianKey = shipped.shared.guardian ?? next();
  return {
    accessManager: next(), clearinghouse: next(), orderBook: next(), settlementOracle: next(),
    expiryCalendar: next(), keeperRewards: next(), autoRoller: next(), payoutAdapter: next(),
    makerVault: next(), makerRegistry: next(), rewardsDistributor: next(),
    sources: { chainlink: next(), univ3: next(), dataStreams: next() },
    // `flywheel.deployBlock` IS emitted (DeployV8.s.sol RecordBlocks, `:122-123`: "the two start blocks the
    // write-back record carries, deployBlock (the core) and flywheel.deployBlock"), and the offline validator
    // refuses a splitter with no block; a fixture without it was the second way this file had gone stale.
    flywheel: { feeSplitter, buybackExecutor: next(), deployBlock: 70000000 },
    deployBlock: 70000000,
    safes: { admin: shipped.shared.safes?.admin ?? next(), treasury: shipped.shared.safes?.treasury ?? next() },
    // ONE guardian address in both homes, because the producer emits ONE: `_jsonPrincipals` writes
    // `_q(r.guardianKey)` for wallets.guardian AND bots.guardian. The first version of this
    // fixture gave them different addresses and the validator caught it — correctly, since it
    // enforces that the two are one hot key. A fixture may not invent a disagreement the producer
    // cannot produce.
    wallets: { guardian: guardianKey },
    bots: {
      cranker: shipped.v2.bots?.cranker ?? next(),
      pricer: shipped.v2.bots?.pricer ?? next(),
      quoter: shipped.v2.bots?.quoter ?? next(),
      guardian: guardianKey,
    },
  };
}

test("plannedWrites touches only blocks the builder preserves, and never a market row", () => {
  // ops/markets/tier1.json _readme: the builder regenerates everything but the hand-maintained
  // blocks. A write-back into a regenerated block is discarded by the next build, silently.
  for (const [p] of plannedWrites(record())) {
    assert.ok(p.startsWith("v2.") || p.startsWith("shared."), `${p} is outside the preserved blocks`);
    assert.ok(!p.startsWith("markets"), `${p} touches a market row`);
  }
});

test("shared.feeRecipient is never read from the record: it IS the fee splitter", () => {
  const r = record();
  const writes = Object.fromEntries(plannedWrites(r));
  assert.equal(writes["shared.feeRecipient"], r.flywheel.feeSplitter);
  assert.equal(writes["shared.admin"], r.safes.admin, "shared.admin is the Admin Safe, written from safes.admin");
  // One hot key, two homes, and the validator refuses a mismatch - so the writer fills both.
  assert.equal(writes["v2.bots.guardian"], r.bots.guardian);
  assert.equal(writes["shared.guardian"], r.wallets.guardian);
});

test("a complete record fills every required slot and leaves the registry complete", () => {
  const registry = read();
  const { conflicts, issues, changed } = applyRecord(registry, record());
  assert.deepEqual(conflicts, []);
  assert.deepEqual(issues, [], "the result must satisfy the post-broadcast completeness rule");
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) {
    const value = p.split(".").reduce((n, k) => n?.[k], registry);
    assert.ok(value !== null && value !== undefined, `${p} is still null after the write-back`);
  }
  assert.ok(changed.includes("v2.protocolAddresses (rebuilt from its twins)"));
});

// T-442. THE ASSERTION THAT USED TO BE HERE COMPARED A VALUE WITH ITSELF.
// It read `assert.deepEqual(registry.v2.protocolAddresses, mirrorFrom(registry))` one line after
// `applyRecord` had assigned `registry.v2.protocolAddresses = mirrorFrom(registry)`. Both sides were the
// same call on the same input, so it could not fail: it stayed green while `mirrorFrom` omitted
// `distributors.lender`, and it would have stayed green if `mirrorFrom` had returned an empty object. That
// is why a P1 in the launch-night writer went undetected. The expectation below comes from the SCHEMA
// instead -- `V2_PROTOCOL_KEYS` and `V2_PROTOCOL_DISTRIBUTOR_KEYS` in build-markets.mjs, which is the same
// constant `exactKeys` validates the written registry against. write-back-v8.mjs cannot influence it, so a
// key the mirror forgets is a red test rather than a smaller object compared with itself.
test("the mirror produces exactly the key set the registry schema requires", () => {
  const registry = read();
  applyRecord(registry, record());
  const block = registry.v2.protocolAddresses;

  const missing = V2_PROTOCOL_KEYS.filter((k) => !(k in block));
  const extra = Object.keys(block).filter((k) => !V2_PROTOCOL_KEYS.includes(k));
  assert.deepEqual(missing, [], `v2.protocolAddresses is missing: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `v2.protocolAddresses has keys the schema does not know: ${extra.join(", ")}`);

  const missingD = V2_PROTOCOL_DISTRIBUTOR_KEYS.filter((k) => !(k in block.distributors));
  const extraD = Object.keys(block.distributors).filter((k) => !V2_PROTOCOL_DISTRIBUTOR_KEYS.includes(k));
  assert.deepEqual(missingD, [], `v2.protocolAddresses.distributors is missing: ${missingD.join(", ")}`);
  assert.deepEqual(extraD, [], `v2.protocolAddresses.distributors has unknown keys: ${extraD.join(", ")}`);
});

test("the mirror is built from the twins, so it cannot be written out of step", () => {
  const registry = read();
  applyRecord(registry, record());
  // Each twin is checked against the slot it mirrors -- the registry's OWN value, not mirrorFrom's output.
  assert.equal(registry.v2.protocolAddresses.feeSplitter, registry.v2.flywheel.feeSplitter);
  assert.equal(registry.v2.protocolAddresses.treasury, registry.shared.safes.treasury);
  assert.equal(registry.v2.protocolAddresses.admin, registry.shared.admin);
  assert.equal(registry.v2.protocolAddresses.accessManager, registry.v2.contracts.accessManager);
  assert.equal(registry.v2.protocolAddresses.distributors.maker, registry.v2.contracts.rewardsDistributor);
});

// T-442, criterion 6. EVERY OTHER TEST IN THIS FILE CALLS `applyRecord` DIRECTLY, so none of them reaches
// `validateV2` -- and `validateV2` is the gate that actually refused the launch-night write. A defect that
// only `main` can see needs a test that runs `main`, and `main` runs only when the file is invoked as a
// script, so this spawns it. The registry is a COPY in a temp directory; nothing in ops/markets is touched.
/*//////////////////////////////////////////////////////////////
  THE TWO TESTS BELOW FAIL AT THIS SHA, ON PURPOSE, AND MUST NOT BE "FIXED" HERE
//////////////////////////////////////////////////////////////*/
/**
 * Both refuse with: `v2.flywheel.feeSplitter is set but v2.flywheel.deployBlock is null: the
 * indexer has no block to start the flywheel from`.
 *
 * THAT IS A REAL DEFECT AND IT IS NOT THIS ROW'S TO FIX. `build-markets.mjs` requires
 * `v2.flywheel.deployBlock` whenever the splitter is set, and `DeployV8.s.sol` `_jsonFlywheel`
 * emits ONLY `feeSplitter` and `buybackExecutor` — there is no flywheel block number anywhere in
 * the record. So a real launch-night record can populate the addresses (which the eleven passing
 * tests above now prove) and still not complete end to end.
 *
 * IT WAS INVISIBLE UNTIL THE FIXTURE BECAME HONEST. The previous fixture wrote
 * `flywheel: { …, deployBlock: 69999999 }`, a field the producer has never emitted, so these two
 * tests passed against a record that cannot exist. Same family as the defect this row fixes: a
 * test written from the same imagination as the code, agreeing with itself.
 *
 * DO NOT make them pass by putting `deployBlock` back in the fixture, and do not default or derive
 * one in the writer — that is forbidden by this row and it would re-hide the gap. The fix belongs
 * either in the producer (emit a flywheel deploy block) or in the validator (stop requiring one),
 * and both are outside this fence. Reported to the coordinator.
 */
test("main() completes against a copy of the real registry and writes the mirror back", () => {
  // realpathSync, and it is load-bearing. write-back-v8.mjs decides whether to run `main` by comparing
  // `path.resolve(process.argv[1])` with `fileURLToPath(import.meta.url)`, and `path.resolve` does not
  // resolve symlinks while the module URL is already real. On macOS `tmpdir()` is `/var/folders/...`, a
  // symlink to `/private/var/folders/...`, so spawning the copy by its symlinked path makes that guard
  // false and the script exits 0 having done NOTHING -- a silent pass that would have made this test
  // assert against an empty stdout. See the ledger entry: the same trap applies to any operator who
  // invokes the real script through a symlinked path.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "writeback-main-")));
  temps.push(dir);
  // build-markets.mjs is imported relatively by the script, and v2-sources.json is read from beside the
  // registry, so the run happens in a copy of the directory rather than with a stray --registry path.
  for (const f of ["write-back-v8.mjs", "build-markets.mjs", "tier1.json", "v2-sources.json"]) {
    const from = path.join(HERE, f);
    if (existsSync(from)) writeFileSync(path.join(dir, f), readFileSync(from));
  }
  const recordPath = path.join(dir, "record.json");
  writeFileSync(recordPath, JSON.stringify(record()));

  const run = spawnSync(process.execPath, [path.join(dir, "write-back-v8.mjs"), "--deployment", recordPath, "--registry", path.join(dir, "tier1.json")], { encoding: "utf8" });

  assert.equal(run.status, 0, `main() refused:\n${run.stderr}`);
  assert.match(run.stdout, /wrote \d+ path\(s\)/, run.stdout);
  const written = JSON.parse(readFileSync(path.join(dir, "tier1.json"), "utf8"));
  for (const k of V2_PROTOCOL_DISTRIBUTOR_KEYS) {
    assert.ok(k in written.v2.protocolAddresses.distributors, `main() wrote a registry with no distributors.${k}`);
  }
});

test("idempotent: applying the same record twice changes nothing the second time", () => {
  const registry = read();
  const first = applyRecord(registry, record());
  assert.ok(first.changed.length > 0);
  const second = applyRecord(registry, record());
  assert.deepEqual(second.changed, [], second.changed.join(", "));
  assert.deepEqual(second.conflicts, []);
});

test("a different address for an already-written slot is REFUSED, not overwritten, unless --force", () => {
  const registry = read();
  applyRecord(registry, record());
  const before = registry.v2.contracts.orderBook;

  const conflicting = record(500);
  const refused = applyRecord(registry, conflicting);
  assert.ok(refused.conflicts.some((c) => c.startsWith("v2.contracts.orderBook already holds")), refused.conflicts.join("; "));
  assert.equal(registry.v2.contracts.orderBook, before, "a refused write must not have happened");

  const forced = applyRecord(registry, conflicting, { force: true });
  assert.deepEqual(forced.conflicts, []);
  assert.equal(registry.v2.contracts.orderBook, conflicting.orderBook);
});

test("an INCOMPLETE record is reported as incomplete rather than written", () => {
  // The whole failure mode: deployBlock set, most slots written, one missing. The pre-O8-08A
  // validator was green on exactly this.
  const partial = record();
  delete partial.orderBook;
  const registry = read();
  const { conflicts, issues } = applyRecord(registry, partial);
  assert.deepEqual(conflicts, []);
  assert.ok(issues.some((i) => i.startsWith("v2.contracts.orderBook is null but v2.deployBlock is")), issues.join("; "));
});

test("a non-address in the record is refused before anything is written", () => {
  const bad = record();
  bad.clearinghouse = "not-an-address";
  const registry = read();
  const { conflicts } = applyRecord(registry, bad);
  assert.ok(conflicts.some((c) => c.includes("is not an address")), conflicts.join("; "));
  assert.equal(registry.v2.contracts.clearinghouse, null, "nothing is written for a bad value");
});

test("the CLI writes a temp copy and leaves it complete; the checkout is never touched", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const file = tempRegistry();
  // v2-sources.json travels with the registry: the CLI validates against it, as build-markets does.
  writeFileSync(path.join(path.dirname(file), "v2-sources.json"), readFileSync(path.join(HERE, "v2-sources.json"), "utf8"));
  const rec = path.join(path.dirname(file), "deployment.json");
  writeFileSync(rec, `${JSON.stringify(record(), null, 2)}\n`);
  const cli = path.join(HERE, "write-back-v8.mjs");

  const first = await run(process.execPath, [cli, "--deployment", rec, "--registry", file]);
  assert.match(first.stdout, /wrote \d+ path\(s\)/);
  const written = JSON.parse(readFileSync(file, "utf8"));
  const issues = [];
  validateDeployedCompleteness(written, issues);
  assert.deepEqual(issues, []);

  const again = await run(process.execPath, [cli, "--deployment", rec, "--registry", file]);
  assert.match(again.stdout, /already matches the deployment record/);
});

test("T-444: a deployment record with no top-level deployBlock is REFUSED, and nothing is written", () => {
  // Drives the real CLI, extending the pattern of the main() test above -- same realpathSync +
  // directory-copy trick, and for the same reason recorded there. It is a CLI test on purpose:
  // applyRecord cannot see this defect, because the missing field never reaches it. `put` drops
  // undefined silently, so `v2.deployBlock` is simply never written, and build-markets.mjs
  // validateDeployedCompleteness then returns before checking anything because that field is absent.
  // The producer of the bad state is the only place that can refuse before a null lands on disk.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "writeback-noblock-")));
  temps.push(dir);
  for (const f of ["write-back-v8.mjs", "build-markets.mjs", "tier1.json", "v2-sources.json"]) {
    const from = path.join(HERE, f);
    if (existsSync(from)) writeFileSync(path.join(dir, f), readFileSync(from));
  }
  const registryPath = path.join(dir, "tier1.json");
  const before = readFileSync(registryPath, "utf8");

  const { deployBlock, ...withoutBlock } = record();
  assert.ok(deployBlock, "the fixture is supposed to carry a deployBlock for this test to remove");
  const recordPath = path.join(dir, "record.json");
  writeFileSync(recordPath, JSON.stringify(withoutBlock));

  const run = spawnSync(process.execPath, [path.join(dir, "write-back-v8.mjs"), "--deployment", recordPath, "--registry", registryPath], { encoding: "utf8" });

  assert.equal(run.status, 1, `expected a refusal, got status ${run.status}:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /has no top-level "deployBlock"/, run.stderr);
  assert.match(run.stderr, new RegExp(recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal must name the record it read, not blame the registry");
  assert.doesNotMatch(run.stdout, /wrote \d+ path\(s\)/, "it must not report a write");
  assert.equal(readFileSync(registryPath, "utf8"), before, "the registry was modified by a run that refused");
});

test("T-444: a deployBlock that is not a positive integer is refused too", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "writeback-badblock-")));
  temps.push(dir);
  for (const f of ["write-back-v8.mjs", "build-markets.mjs", "tier1.json", "v2-sources.json"]) {
    const from = path.join(HERE, f);
    if (existsSync(from)) writeFileSync(path.join(dir, f), readFileSync(from));
  }
  const registryPath = path.join(dir, "tier1.json");
  const before = readFileSync(registryPath, "utf8");
  const recordPath = path.join(dir, "record.json");

  for (const bad of ["70000000", 0, -1, 1.5, true]) {
    writeFileSync(recordPath, JSON.stringify({ ...record(), deployBlock: bad }));
    const run = spawnSync(process.execPath, [path.join(dir, "write-back-v8.mjs"), "--deployment", recordPath, "--registry", registryPath], { encoding: "utf8" });
    assert.equal(run.status, 1, `deployBlock ${JSON.stringify(bad)} should refuse, got ${run.status}:\n${run.stderr}`);
    assert.match(run.stderr, /not a positive integer block number/, run.stderr);
    assert.equal(readFileSync(registryPath, "utf8"), before, `the registry changed on a refused run (deployBlock ${JSON.stringify(bad)})`);
  }
});

/*//////////////////////////////////////////////////////////////
        T-453: THE ADDRESSES REACH THE REGISTRY, AND A STRANGER IS REFUSED
//////////////////////////////////////////////////////////////*/

test("T-453: every address in a REAL-SHAPED record reaches the registry", () => {
  // The seam this row closes. Before the fix, plannedWrites read record.contracts.* — a wrapper
  // the emitter has never written — so all fourteen of these resolved to undefined and `put`
  // dropped each one without a word.
  const r = record();
  const writes = Object.fromEntries(plannedWrites(r));
  for (const k of ["clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
    "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager"]) {
    assert.equal(writes[`v2.contracts.${k}`], r[k], `v2.contracts.${k} was not written from the record`);
  }
  for (const k of ["chainlink", "univ3", "dataStreams"]) {
    assert.equal(writes[`v2.contracts.sources.${k}`], r.sources[k], `sources.${k} was not written`);
  }
  // The count is the control: if a future edit drops a name from CONTRACTS, the loop above still
  // passes for the names it kept and this notices the shortfall.
  assert.equal(Object.keys(writes).filter((p) => p.startsWith("v2.contracts.")).length, 14);
});

test("T-453: an address key the writer does not recognise is REFUSED and NAMED", () => {
  // AC5, and the same fail-closed principle as T-444's deployBlock guard. A silent skip is what
  // let this defect live: an unrecognised key is either a contract nobody taught this tool about
  // or a record from a different producer, and both must stop the run.
  const r = { ...record(), lendingPool: "0x00000000000000000000000000000000000000ee" };
  assert.throws(() => plannedWrites(r), (e) => e.message.includes("lendingPool")
    && /does not know where to record/.test(e.message), "the refusal must NAME the key");

  // Control: the same record without the stranger does not throw, so the guard is not refusing
  // everything.
  assert.doesNotThrow(() => plannedWrites(record()));
});

test("T-453: the two ADDRESS GROUPS are not mistaken for strangers", () => {
  // `sources` and `flywheel` are object-valued by design — DeployV2Batch.sh calls them GROUPS and
  // treats them the same way. If the refusal above ever starts rejecting them, every real record
  // fails at the first hurdle.
  const r = record();
  assert.ok(typeof r.sources === "object" && typeof r.flywheel === "object");
  assert.doesNotThrow(() => plannedWrites(r));
});

test("T-453: wallets.opsWallet is absent, is NOT invented, and completeness reports it", () => {
  // AC6. DeployV8 has no opsWallet input, so a record cannot carry one. The writer must not
  // default, derive or guess a value — the completeness rule is what surfaces the hole.
  const r = record();
  assert.equal(r.wallets.opsWallet, undefined, "the fixture must not invent one either");
  const writes = Object.fromEntries(plannedWrites(r));
  assert.equal(writes["shared.opsWallet"], undefined, "nothing may be written for opsWallet");
});

/* ------------------------------------------------------------------ T-OP-156: markets[].v2.houseVault survives the write-back */

// Two launch vaults written per ticker by the externals stage (contracts side), the first one mirrored into
// v2.contracts.houseVault (owner ruling, option A). This tool never writes any of the three; it must carry them
// through unchanged and its own offline validator must accept them -- and refuse the T-OP-114 shape (a row that
// lost the key) and a vault on a market outside the launch set.
const NVDA_VAULT = "0x6f8A7B77b72511cD8939596b1659bA28C28f101B";
const SPCX_VAULT = "0x014b996a084690FB27265BfAC157b04e9FeBbF4E";
function withLaunchVaults(registry) {
  const r = structuredClone(registry);
  for (const m of r.markets) {
    if (m.ticker === "NVDA") m.v2.houseVault = NVDA_VAULT;
    if (m.ticker === "SPCX") m.v2.houseVault = SPCX_VAULT;
  }
  r.v2.contracts.houseVault = NVDA_VAULT;
  r.v2.externalDeployBlocks.houseVault = 70000001; // T-OP-114: an external address travels with its start block
  return r;
}
const recon = () => JSON.parse(readFileSync(path.join(HERE, "v2-sources.json"), "utf8"));
const houseVaultIssues = (registry) => validateV2(registry, recon(), null).filter((i) => /(^|: )v2\.houseVault|houseVault/.test(i));

test("T-OP-156: the round trip keeps markets[].v2.houseVault on every row and never plans a write to it", () => {
  const registry = withLaunchVaults(read());
  assert.ok(registry.markets.every((m) => Object.hasOwn(m.v2, "houseVault")), "every row carries the key before the write-back");
  // Nothing this tool plans lands under markets[] or names a house vault: the per-market slots are the contracts
  // side's (DeployV2Batch.sh write_back / registry-env.sh, the externals stage) and v2.contracts.houseVault is
  // recorded there too (registry_env_record_external), never by this record. Two plain assertions -- the first
  // version of this line was a ternary whose precedence made it true for exactly the path it meant to refuse.
  for (const [p] of plannedWrites(record())) {
    assert.ok(!p.startsWith("markets"), `${p}: this tool never writes a market row`);
    assert.ok(!/houseVault/i.test(p), `${p}: a house vault is the externals stage's write, not this record's`);
  }
  const { conflicts, issues } = applyRecord(registry, record());
  assert.deepEqual(conflicts, []);
  assert.deepEqual(issues, []);
  const byTicker = Object.fromEntries(registry.markets.map((m) => [m.ticker, m.v2.houseVault]));
  assert.equal(byTicker.NVDA, NVDA_VAULT, "NVDA's vault survives");
  assert.equal(byTicker.SPCX, SPCX_VAULT, "SPCX's vault survives");
  assert.equal(registry.v2.contracts.houseVault, NVDA_VAULT, "the walked slot survives");
  assert.equal(registry.markets.filter((m) => m.v2.houseVault === null).length, registry.markets.length - 2, "every other row is still null");
  assert.deepEqual(houseVaultIssues(registry), [], "the offline validator the CLI runs accepts the written-back shape");
});

test("T-OP-156: the offline validator the CLI runs before writing refuses a row that lost the key and a vault outside the launch set", () => {
  const lost = withLaunchVaults(read());
  applyRecord(lost, record());
  delete lost.markets.find((m) => m.ticker === "TSLA").v2.houseVault;
  const missing = houseVaultIssues(lost);
  assert.ok(missing.length >= 1 && missing.some((i) => i.startsWith("TSLA")), `a row without the key is refused by name: ${missing.join("; ")}`);

  const wrongRow = withLaunchVaults(read());
  applyRecord(wrongRow, record());
  wrongRow.markets.find((m) => m.ticker === "TSLA").v2.houseVault = SPCX_VAULT;
  const outside = houseVaultIssues(wrongRow);
  assert.equal(outside.length, 1, outside.join("; "));
  assert.ok(outside[0].startsWith("TSLA: v2.houseVault") && outside[0].includes("not in launchSet.markets"), outside[0]);
});

test("T-OP-156: the CLI writes a registry that carries the two vaults and leaves all 35 keys in place; one lost key and it writes nothing", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const file = tempRegistry();
  writeFileSync(file, `${JSON.stringify(withLaunchVaults(read()), null, 2)}\n`);
  writeFileSync(path.join(path.dirname(file), "v2-sources.json"), readFileSync(path.join(HERE, "v2-sources.json"), "utf8"));
  const rec = path.join(path.dirname(file), "deployment.json");
  writeFileSync(rec, `${JSON.stringify(record(), null, 2)}\n`);
  const cli = path.join(HERE, "write-back-v8.mjs");

  const first = await run(process.execPath, [cli, "--deployment", rec, "--registry", file]);
  assert.match(first.stdout, /wrote \d+ path\(s\)/);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.markets.filter((m) => Object.hasOwn(m.v2, "houseVault")).length, 35, "all 35 rows keep the key");
  assert.equal(written.markets.find((m) => m.ticker === "NVDA").v2.houseVault, NVDA_VAULT);
  assert.equal(written.markets.find((m) => m.ticker === "SPCX").v2.houseVault, SPCX_VAULT);
  assert.equal(written.v2.contracts.houseVault, NVDA_VAULT);

  // The T-OP-114 shape: a registry whose written-back copy lost the key on one row is refused, not written.
  const lostFile = tempRegistry();
  const lost = withLaunchVaults(read());
  delete lost.markets.find((m) => m.ticker === "TSLA").v2.houseVault;
  writeFileSync(lostFile, `${JSON.stringify(lost, null, 2)}\n`);
  writeFileSync(path.join(path.dirname(lostFile), "v2-sources.json"), readFileSync(path.join(HERE, "v2-sources.json"), "utf8"));
  const before = readFileSync(lostFile, "utf8");
  await assert.rejects(run(process.execPath, [cli, "--deployment", rec, "--registry", lostFile]), (e) => e.code === 1 && /houseVault/.test(e.stderr) && /nothing written/.test(e.stderr));
  assert.equal(readFileSync(lostFile, "utf8"), before, "the refused registry is byte-identical: nothing was written");
});
