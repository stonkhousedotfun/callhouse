/**
 * node --test ops/v2/cranker-float.test.mjs
 *
 * The go-live check that the cranker holds the USDG float its firstmint step spends: refuse under
 * FIRST_MINT_MAX_COST, warn under FIRST_MINT_DAILY_CAP x 5 days, pass otherwise, with the thresholds read from the
 * keeper's constants.ts. The go-live-v2.sh side (cranker_float) is run in ops/go-live-v2.test.mjs.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONSTANTS_TS, FLOAT_DAYS, crankerFloat, firstMintLimits, readBigintConstant, usdg } from "./cranker-float.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cranker-float.mjs");
const KEEPER = path.resolve(HERE, "..", "..", "keeper");
const CRANKER = "0xc9924324bD7f5b07adA32B7146E71F614c845d47";

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("the thresholds are the keeper's", () => {
  test("firstMintLimits reads exactly what the keeper evaluates (tsx imports constants.ts)", () => {
    const tsx = path.join(KEEPER, "node_modules", ".bin", "tsx");
    assert.ok(fs.existsSync(tsx), `no ${tsx}: hydrate the keeper to run this cross-check`);
    const out = execFileSync(tsx, ["-e", `import { FIRST_MINT_MAX_COST as a, FIRST_MINT_DAILY_CAP as b } from ${JSON.stringify(CONSTANTS_TS)}; console.log(String(a), String(b));`], {
      cwd: KEEPER,
      encoding: "utf8",
    }).trim();
    const { maxCost, dailyCap } = firstMintLimits();
    assert.equal(`${maxCost} ${dailyCap}`, out);
  });

  test("a changed constants.ts changes the verdict: there is no second typed number", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cranker-float-"));
    const file = path.join(dir, "constants.ts");
    fs.writeFileSync(file, "export const FIRST_MINT_DAILY_CAP = 9_000_000n;\nexport const FIRST_MINT_MAX_COST = 2_000_000n;\n");
    assert.deepEqual(firstMintLimits(file), { maxCost: 2_000_000n, dailyCap: 9_000_000n });
    const r = cli(["--address", CRANKER, "--balance", "1999999", "--constants", file]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /under FIRST_MINT_MAX_COST 2000000 /);
  });

  test("an absent constant, an expression, or an unusable pair is refused, never guessed", () => {
    assert.throws(() => readBigintConstant("export const OTHER = 1n;\n", "FIRST_MINT_MAX_COST"), /FIRST_MINT_MAX_COST is not a plain/);
    assert.throws(() => readBigintConstant("export const FIRST_MINT_MAX_COST = 5n * UNIT;\n", "FIRST_MINT_MAX_COST"), /is not a plain/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cranker-float-"));
    const file = path.join(dir, "constants.ts");
    fs.writeFileSync(file, "export const FIRST_MINT_DAILY_CAP = 5_000_000n;\nexport const FIRST_MINT_MAX_COST = 0n;\n");
    assert.throws(() => firstMintLimits(file), /not a usable pair/);
    const r = cli(["--address", CRANKER, "--balance", "0", "--constants", file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a usable pair/);
  });
});

describe("refuse / warn / pass", () => {
  const { maxCost, dailyCap } = firstMintLimits();
  const want = dailyCap * FLOAT_DAYS;
  const at = (balance) => crankerFloat({ address: CRANKER, balance, maxCost, dailyCap });

  test("REFUSES at 0 USDG (the measured production state) and one unit under FIRST_MINT_MAX_COST", () => {
    for (const balance of [0n, maxCost - 1n]) {
      const v = at(balance);
      assert.equal(v.level, "refuse", `balance ${balance}`);
      assert.equal(v.shortfall, maxCost - balance);
      assert.match(v.message, new RegExp(`cranker ${CRANKER} holds ${balance} USDG base units`));
      assert.match(v.message, new RegExp(`Send at least ${maxCost - balance} base units .* of USDG to ${CRANKER}`));
      assert.match(v.message, /never sends funds/);
    }
  });

  test("WARNS from FIRST_MINT_MAX_COST up to one unit under FIRST_MINT_DAILY_CAP x 5 days, with the exact shortfall", () => {
    for (const balance of [maxCost, want - 1n]) {
      const v = at(balance);
      assert.equal(v.level, "warn", `balance ${balance}`);
      assert.equal(v.shortfall, want - balance);
      assert.match(v.message, new RegExp(`^WARNING: cranker ${CRANKER} holds ${balance} `));
      assert.match(v.message, new RegExp(`FIRST_MINT_DAILY_CAP x 5 days = ${want} .*Send ${want - balance} base units .* to ${CRANKER}`));
    }
  });

  test("passes at FIRST_MINT_DAILY_CAP x 5 days and above", () => {
    for (const balance of [want, want * 10n]) {
      const v = at(balance);
      assert.equal(v.level, "ok", `balance ${balance}`);
      assert.equal(v.shortfall, 0n);
      assert.doesNotMatch(v.message, /WARNING|Send/);
    }
  });

  test("the CLI exits 1 on refuse and 0 on warn and pass, and says which", () => {
    let r = cli(["--address", CRANKER, "--balance", "0"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /under FIRST_MINT_MAX_COST/);
    r = cli(["--address", CRANKER, "--balance", String(maxCost)]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^WARNING: /);
    r = cli(["--address", CRANKER, "--balance", String(want)]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /WARNING/);
  });

  test("a malformed balance or address is a usage error (exit 2), not a pass", () => {
    for (const args of [["--address", CRANKER, "--balance", ""], ["--address", CRANKER, "--balance", "1e6"], ["--address", "0x12", "--balance", "0"], ["--balance", "0"]]) {
      const r = cli(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
    }
  });

  test("usdg prints base units exactly", () => {
    assert.equal(usdg(0n), "0");
    assert.equal(usdg(500_000n), "0.5");
    assert.equal(usdg(25_000_001n), "25.000001");
    assert.equal(usdg(5_000_000n), "5");
  });
});
