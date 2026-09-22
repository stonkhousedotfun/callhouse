// Tests for web/scripts/gen-markets.mjs (T-OP-138).
//
// Run with `node --test web/scripts/gen-markets.test.mjs` from the repo root (or `node --test scripts/...`
// from web/). It is a node:test file, not a vitest one, on purpose: the generator is a plain Node script
// with no npm dependencies, and web's vitest include collects lib/ and components/ only (T-OP-148), so a
// vitest file here would never run. Nothing here writes into the checkout: every case renders a scratch
// registry to a temp file through the script's own `--registry` / `--out` flags.
//
// WHAT IS PINNED. The six EXTERNAL v2 contracts (T-OP-114: houseVault, houseVaultFactory, hedger,
// rewardsDistributorLender, earnVault, stockVenueAdapter) are `v2.contracts` keys the deploy wrapper reads
// and T-OP-116's externals step writes back. Before this row `assertExactKeys` threw on them, so the first
// write-back would have made `pnpm gen:markets` refuse the registry. Now they are accepted when present and
// copied through into the V2_CONTRACTS literal; the key list is IMPORTED from ops/markets/build-markets.mjs;
// any other name is still refused; and the committed lib/markets.generated.ts still regenerates
// byte-identically from the committed registry (which does not carry the six yet).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "gen-markets.mjs");
const WEB = path.resolve(HERE, "..");
const REGISTRY = path.resolve(WEB, "..", "ops", "markets", "tier1.json");
const COMMITTED = path.resolve(WEB, "lib", "markets.generated.ts");
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter"];
const addr = (n) => `0x${String(n).padStart(40, "0")}`;

/** A scratch registry (the committed one, mutated) and an output path beside it, both in a temp dir. */
function scratch(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "gen-markets-"));
  const registry = path.join(dir, "tier1.json");
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
  mutate(reg);
  writeFileSync(registry, `${JSON.stringify(reg, null, 2)}\n`);
  return { registry, out: path.join(dir, "markets.generated.ts") };
}

/** Run the generator on a scratch registry; ok + the rendered file, or the error text. */
function generate({ registry, out }) {
  try {
    execFileSync(process.execPath, [SCRIPT, "--registry", registry, "--out", out], {
      cwd: WEB,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MARKETS_REGISTRY: "" },
    });
    return { ok: true, rendered: readFileSync(out, "utf8"), stderr: "" };
  } catch (error) {
    return { ok: false, rendered: null, stderr: `${error.stderr ?? ""}${error.stdout ?? ""}` };
  }
}

/** The V2_CONTRACTS literal of a rendered file, as an object (a TS object literal: unquoted keys, so not JSON). */
function contractsLiteral(rendered) {
  const m = rendered.match(/export const V2_CONTRACTS = (\{[\s\S]*?\n\}) as const;/);
  assert.ok(m, "no V2_CONTRACTS literal in the rendered file");
  return new Function(`return (${m[1]});`)();
}

test("the committed generated file is exactly what the committed registry renders (the drift gate)", () => {
  // The generator writes the registry's `v2.contracts` verbatim, so with no externals in tier1.json the
  // committed file must come out byte-identical -- this is what `pnpm gen:markets --check` gates on.
  const s = scratch(() => {});
  const r = generate(s);
  assert.ok(r.ok, r.stderr);
  // A scratch source is announced in the header (REHEARSAL marker); everything after the header must match.
  const body = (t) => t.split("\n").slice(1).join("\n");
  assert.equal(body(r.rendered), body(readFileSync(COMMITTED, "utf8")), "lib/markets.generated.ts drifts from ops/markets/tier1.json: run pnpm gen:markets");
  const c = contractsLiteral(r.rendered);
  for (const k of EXTERNAL) assert.equal(k in c, false, `the committed registry already carries v2.contracts.${k}`);
});

test("T-OP-138: the six present as null pass, and the literal carries them as null", () => {
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
  });
  const r = generate(s);
  assert.ok(r.ok, r.stderr);
  const c = contractsLiteral(r.rendered);
  for (const k of EXTERNAL) assert.equal(c[k], null, k);
  // The core eleven and `sources` are untouched beside them.
  assert.equal(Object.keys(c).length, 11 + 6 + 1, Object.keys(c).join(","));
});

test("T-OP-138: the written-back shape passes, and every external address is copied through", () => {
  const s = scratch((reg) => {
    EXTERNAL.forEach((k, i) => {
      reg.v2.contracts[k] = addr(501 + i);
      reg.v2.externalDeployBlocks[k] = 69324900 + i;
    });
  });
  const r = generate(s);
  assert.ok(r.ok, r.stderr);
  const c = contractsLiteral(r.rendered);
  EXTERNAL.forEach((k, i) => assert.equal(c[k], addr(501 + i), k));
  // A subset is fine too: the externals step writes one key per contract it deployed.
  const some = scratch((reg) => { reg.v2.contracts.earnVault = addr(505); reg.v2.externalDeployBlocks.earnVault = 69324904; });
  const t = generate(some);
  assert.ok(t.ok, t.stderr);
  assert.equal(contractsLiteral(t.rendered).earnVault, addr(505));
  assert.equal("hedger" in contractsLiteral(t.rendered), false);
});

test("T-OP-138: a seventh v2.contracts key is still refused by name -- the block stays closed", () => {
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
    reg.v2.contracts.stockZap = null;
  });
  const r = generate(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /registry v2\.contracts keys differ from the v8 registry schema; unknown stockZap/);
  // A misspelt external is unknown, not silently taken for the real one.
  const typo = generate(scratch((reg) => { reg.v2.contracts.earnvault = null; }));
  assert.equal(typo.ok, false);
  assert.match(typo.stderr, /unknown earnvault/);
});

test("T-OP-138: an external slot holding a non-address is refused by name", () => {
  const r = generate(scratch((reg) => { reg.v2.contracts.earnVault = "0xnot-an-address"; }));
  assert.equal(r.ok, false);
  assert.match(r.stderr, /registry v2\.contracts\.earnVault is neither null nor an address/);
});

test("T-OP-138: a core contract is still required -- accepting the externals did not loosen the eleven", () => {
  const r = generate(scratch((reg) => { delete reg.v2.contracts.accessManager; }));
  assert.equal(r.ok, false);
  assert.match(r.stderr, /missing accessManager/);
});
