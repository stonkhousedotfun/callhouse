/**
 * node --test ops/v8/tvl-threshold.test.mjs
 *
 * No network, no chain, no service. The registries are read from disk because binding the derivation
 * to the REAL committed files is the point: a threshold derived from a fixture only proves the
 * arithmetic, and the arithmetic was never the risk.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIT_TRIGGER_USD, AUDIT_TRIGGER_USDG6, LOCKED_HOLDERS, MAX_TVL_AGE_S, TvlThresholdError,
  USDG_DECIMALS, deriveTrigger, main, parseArgs, thresholdArg, thresholdEnvLine,
} from "./tvl-threshold.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const registry = (name) => JSON.parse(readFileSync(path.join(ROOT, "ops/markets", name), "utf8"));

const ADDR = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const good = (over = {}) => ({
  shared: { usdg: ADDR(1) },
  v2: { contracts: Object.fromEntries(LOCKED_HOLDERS.map((h, i) => [h, ADDR(i + 2)])) },
  ...over,
});

describe("the number, derived once", () => {
  test("the trigger is $1M expressed in USDG base units, not a typed literal", () => {
    assert.equal(AUDIT_TRIGGER_USD, 1_000_000, "owner decision V3-D33");
    assert.equal(USDG_DECIMALS, 6);
    assert.equal(AUDIT_TRIGGER_USDG6, 1_000_000_000_000n);
    // Derived, so a decimals change moves it rather than leaving two numbers that disagree.
    assert.equal(AUDIT_TRIGGER_USDG6, BigInt(AUDIT_TRIGGER_USD) * 10n ** BigInt(USDG_DECIMALS));
  });

  test("the emitted strings are built from the value, so nobody retypes it", () => {
    const t = deriveTrigger(good());
    assert.equal(thresholdArg(t), "auditTriggerUsdg=1000000000000");
    assert.equal(thresholdEnvLine(t), "MONITOR_THRESHOLDS=auditTriggerUsdg=1000000000000");
    assert.ok(thresholdEnvLine(t).endsWith(String(AUDIT_TRIGGER_USDG6)));
  });
});

describe("it REFUSES rather than emitting a 0", () => {
  // A 0 here is indistinguishable from the owner deliberately turning the notice off, which is the
  // exact ambiguity OWN8-09 exists to remove. Refusing is the fail-closed answer.
  test("no shared.usdg is a refusal, and it says why", () => {
    assert.throws(() => deriveTrigger(good({ shared: {} })), TvlThresholdError);
    assert.throws(() => deriveTrigger(good({ shared: { usdg: null } })), /indistinguishable/);
    assert.throws(() => deriveTrigger(good({ shared: { usdg: "not-an-address" } })), /shared\.usdg/);
  });

  test("a registry naming none of the holders is a refusal", () => {
    assert.throws(() => deriveTrigger(good({ v2: { contracts: {} } })), /empty holder set/);
    assert.throws(() => deriveTrigger({ shared: { usdg: ADDR(1) } }), /empty holder set/);
  });

  test("a PARTIAL holder set is allowed but NAMED — it pages late and the caller must know", () => {
    const partial = good();
    delete partial.v2.contracts[LOCKED_HOLDERS[1]];
    const t = deriveTrigger(partial);
    assert.equal(t.holders.length, LOCKED_HOLDERS.length - 1);
    assert.deepEqual(t.missingHolders, [LOCKED_HOLDERS[1]]);
  });
});

describe("against the REAL committed registries", () => {
  test("v7-legacy derives the trigger over both holders", () => {
    const t = deriveTrigger(registry("v7-legacy.json"));
    assert.equal(t.auditTriggerUsdg, AUDIT_TRIGGER_USDG6);
    assert.deepEqual(t.holders.map((h) => h.name), [...LOCKED_HOLDERS]);
    assert.deepEqual(t.missingHolders, []);
    assert.match(t.usdg, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(t.maxAgeS, MAX_TVL_AGE_S);
  });

  test("tier1 and dev REFUSE today, because their v8 contract addresses are still null", () => {
    // Not a bug in this tool and not something to paper over: a registry with no deployed contracts
    // cannot express "value locked in them", and emitting 0 would read as the owner switching it off.
    for (const name of ["tier1.json", "dev.json"]) {
      assert.throws(() => deriveTrigger(registry(name)), TvlThresholdError, name);
    }
  });
});

describe("the command", () => {
  const run = (argv, readFile) => {
    const out = [];
    const err = [];
    const code = main(argv, { log: (s) => out.push(s), err: (s) => err.push(s), readFile: readFile ?? ((p) => readFileSync(p, "utf8")) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("--execute is refused: it derives a value, it never sets one", () => {
    const r = run(["--execute", "--registry", "x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /only DERIVES/);
  });

  test("an unknown flag is refused rather than ignored", () => {
    assert.equal(run(["--not-a-flag"]).code, 2);
    assert.throws(() => parseArgs(["--registry"]), /needs a value/);
  });

  test("a missing registry is a named failure, never a default", () => {
    assert.equal(run([]).code, 2);
    const r = run(["--registry", "/nonexistent/x.json"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot read/);
  });

  test("a good registry prints the threshold line and exits 0", () => {
    const r = run(["--registry", path.join(ROOT, "ops/markets/v7-legacy.json")]);
    assert.equal(r.code, 0);
    assert.match(r.out, /auditTriggerUsdg=1000000000000/);
    assert.match(r.out, /MONITOR_THRESHOLDS=/);
    assert.match(r.out, /V3-D33/);
  });

  test("a partial holder set exits NON-ZERO and warns, so a script cannot use it silently", () => {
    const partial = good();
    delete partial.v2.contracts[LOCKED_HOLDERS[1]];
    const r = run(["--registry", "x"], () => JSON.stringify(partial));
    assert.equal(r.code, 1, "a late-paging threshold must not exit 0");
    assert.match(r.out, /WARNING/);
    assert.match(r.out, /page LATE/);
  });

  test("--json carries every field a caller would otherwise re-derive", () => {
    const r = run(["--registry", path.join(ROOT, "ops/markets/v7-legacy.json"), "--json"]);
    const j = JSON.parse(r.out);
    assert.equal(j.auditTriggerUsdg, String(AUDIT_TRIGGER_USDG6));
    assert.equal(j.auditTriggerUsd, AUDIT_TRIGGER_USD);
    assert.equal(j.maxAgeS, MAX_TVL_AGE_S);
    assert.deepEqual(j.missingHolders, []);
  });
});

describe("the monitor and this file cannot drift apart", () => {
  // THE BINDING. ops/v2/monitor.mjs deliberately does NOT import this module: nothing in ops/v2
  // imports from ops/v8, and adding the first such edge would put a deploy-time resolution failure
  // in the middle of a running monitor. So the two are bound by assertion instead, parsed out of the
  // monitor's source rather than restated here — this cannot agree with itself.
  const monitor = readFileSync(path.join(ROOT, "ops/v2/monitor.mjs"), "utf8");

  test("the monitor's tvlMaxAgeS is this module's MAX_TVL_AGE_S", () => {
    const m = monitor.match(/^\s*tvlMaxAgeS:\s*(\d+),/m);
    assert.ok(m, "ops/v2/monitor.mjs no longer declares tvlMaxAgeS in DEFAULTS");
    assert.equal(Number(m[1]), MAX_TVL_AGE_S);
  });

  test("the monitor sums exactly the holders this module defines", () => {
    const block = monitor.match(/const expected = \[([^\]]*)\];/);
    assert.ok(block, "ops/v2/monitor.mjs no longer declares the tvl holder list as `expected`");
    const names = [...block[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(names, [...LOCKED_HOLDERS],
      "the monitor's value-locked holders and LOCKED_HOLDERS here must be the same set, or the trigger "
      + "is derived over one definition and measured over another");
  });

  test("the monitor does not restate the $1M figure", () => {
    // It may name it in prose; what it must not do is carry it as a second live default.
    assert.equal(/auditTriggerUsdg:\s*1_?0{6,}/.test(monitor), false,
      "ops/v2/monitor.mjs must not hard-code the trigger: it comes from --threshold, derived here");
  });
});
