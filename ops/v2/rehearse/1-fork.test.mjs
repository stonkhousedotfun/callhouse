/**
 * node --test ops/v2/rehearse/1-fork.test.mjs
 *
 * Step 1 of the rehearsal refuses a FOUNDRY_PROFILE other than "default" by name, before anything runs (no
 * input copy, no build, no fork), and reaches its `forge build --skip test` as before when the variable is unset or
 * "default". Runs 1-fork.mjs itself with a scratch REHEARSE_OUT and CONTRACTS_DIR and a forge stub on PATH that records
 * its argv and the FOUNDRY_PROFILE it saw, then fails, so the run stops at the build. No compile, no anvil, no network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "1-fork.mjs");

/** A port nothing listens on, for the anvil the run never gets to start. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function step1(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t1043-fork-"));
  const bin = path.join(dir, "bin");
  const out = path.join(dir, "out");
  const contracts = path.join(dir, "contracts");
  const calls = path.join(dir, "calls");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(contracts, "script", "v2"), { recursive: true });
  fs.mkdirSync(path.join(contracts, "out", "MockRoundFeed.sol"), { recursive: true });
  fs.writeFileSync(path.join(contracts, "script", "v2", "DeployV2Batch.sh"), '#!/bin/bash\necho "batch $*" >> "$T1043_CALLS"; exit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(contracts, "out", "MockRoundFeed.sol", "MockRoundFeed.json"), "{}");
  fs.writeFileSync(path.join(bin, "forge"), '#!/bin/bash\necho "forge $* FOUNDRY_PROFILE=${FOUNDRY_PROFILE-<unset>}" >> "$T1043_CALLS"; exit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "anvil"), '#!/bin/bash\necho "anvil $*" >> "$T1043_CALLS"; exit 1\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REHEARSE_OUT: out, CONTRACTS_DIR: contracts, REHEARSE_ANVIL_PORT: String(await freePort()), T1043_CALLS: calls };
  delete env.FOUNDRY_PROFILE;
  if (profile !== undefined) env.FOUNDRY_PROFILE = profile;
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [],
    input: fs.existsSync(path.join(out, "tier1.input.json")),
  };
}

test("FOUNDRY_PROFILE=batch is refused by name before anything runs: no input copy, no build, no fork", async () => {
  const r = await step1("batch");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STEP 1 FAILED: FOUNDRY_PROFILE=batch is set in your shell\. The rehearsal builds and deploys the contracts with \[profile\.default\] only/);
  assert.deepEqual(r.calls, [], "a stub ran before the refusal");
  assert.equal(r.input, false, "the input copy was written before the refusal");
  assert.doesNotMatch(r.out, /1a\. preconditions/);
});

test("any other set FOUNDRY_PROFILE, even empty, is refused the same way (stonkctl's rule)", async () => {
  for (const p of ["fork", "ci", "Default", ""]) {
    const r = await step1(p);
    assert.equal(r.code, 1, `${JSON.stringify(p)}: ${r.out}`);
    assert.ok(r.out.includes(`STEP 1 FAILED: FOUNDRY_PROFILE=${p} is set in your shell`), `${JSON.stringify(p)} was not refused by name: ${r.out}`);
    assert.deepEqual(r.calls, []);
  }
});

test("positive controls: unset and \"default\" pass the check and reach `forge build --skip test`, before any fork", async () => {
  for (const [p, seen] of [[undefined, "<unset>"], ["default", "default"]]) {
    const r = await step1(p);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /STEP 1 FAILED: forge build failed/, "the stub forge's failure, i.e. the build was reached");
    assert.doesNotMatch(r.out, /is set in your shell/);
    assert.deepEqual(r.calls, [`forge build --skip test FOUNDRY_PROFILE=${seen}`], "exactly the build, and no anvil after it");
    assert.equal(r.input, true, "the preconditions ran first (the input copy is written before the build)");
  }
});
