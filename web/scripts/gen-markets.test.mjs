// Tests for web/scripts/gen-markets.mjs.
//
// Run with `node --test web/scripts/gen-markets.test.mjs` from the repo root (or `node --test scripts/...`
// from web/). It is a node:test file, not a vitest one, on purpose: the generator is a plain Node script
// with no npm dependencies, and web's vitest include collects lib/ and components/ only, so a
// vitest file here would never run. Nothing here writes into the checkout: every case renders a scratch
// registry to a temp file through the script's own `--registry` / `--out` flags.
//
// WHAT IS PINNED. The EXTERNAL v2 contracts (houseVault, houseVaultFactory, hedger,
// rewardsDistributorLender, earnVault, stockVenueAdapter; stockZap) are `v2.contracts` keys that
// DeployV8 does not create. Before `assertExactKeys` threw on them, so the first write-back would have
// made `pnpm gen:markets` refuse the registry. Now they are accepted when present and copied through into the
// V2_CONTRACTS literal; the key list is IMPORTED from ops/markets/build-markets.mjs; any other name is still
// refused; and the committed lib/markets.generated.ts still regenerates byte-identically from the committed
// registry, which carries every external (and StockZap's address).
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
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter", "stockZap"];
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
  // The generator writes the registry's `v2.contracts` verbatim, so the committed file must come out
  // byte-identical -- this is what `pnpm gen:markets --check` gates on.
  const s = scratch(() => {});
  const r = generate(s);
  assert.ok(r.ok, r.stderr);
  // A scratch source is announced in the header (REHEARSAL marker); everything after the header must match.
  const body = (t) => t.split("\n").slice(1).join("\n");
  assert.equal(body(r.rendered), body(readFileSync(COMMITTED, "utf8")), "lib/markets.generated.ts drifts from ops/markets/tier1.json: run pnpm gen:markets");
  // Re-pinned. This used to assert that the committed registry carried NO external, which stopped being true at
  // (every external present) and was red at the base. What it protects is the copy-through: each
  // external the committed registry records reaches the literal exactly, stockZap included, which is the value
  // web/lib/v2/config.ts resolves the Zap panel from.
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const c = contractsLiteral(r.rendered);
  for (const k of EXTERNAL) assert.equal(c[k], reg.v2.contracts[k], `v2.contracts.${k} is not copied through`);
  assert.match(String(c.stockZap), /^0x[0-9a-fA-F]{40}$/, "the committed registry records StockZap (T-OP-332)");
});

test("the externals present as null pass, and the literal carries them as null", () => {
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
  });
  const r = generate(s);
  assert.ok(r.ok, r.stderr);
  const c = contractsLiteral(r.rendered);
  for (const k of EXTERNAL) assert.equal(c[k], null, k);
  // The core eleven and `sources` are untouched beside them.
  assert.equal(Object.keys(c).length, 11 + EXTERNAL.length + 1, Object.keys(c).join(","));
});

test("the written-back shape passes, and every external address is copied through", () => {
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
  // A subset is fine too: the externals step writes one key per contract it deployed. The committed registry now
  // carries every external key, so the subset starts from none of them (re-pin; red at its base).
  const some = scratch((reg) => {
    for (const k of EXTERNAL) delete reg.v2.contracts[k];
    reg.v2.contracts.earnVault = addr(505);
    reg.v2.externalDeployBlocks.earnVault = 69324904;
  });
  const t = generate(some);
  assert.ok(t.ok, t.stderr);
  assert.equal(contractsLiteral(t.rendered).earnVault, addr(505));
  assert.equal("hedger" in contractsLiteral(t.rendered), false);
});

test("stockZap is accepted, and an eighth v2.contracts key is still refused by name -- the block stays closed", () => {
  // stockZap used to be this case's refused example; it is an external now and is copied through.
  const zap = generate(scratch((reg) => { reg.v2.contracts.stockZap = addr(777); reg.v2.externalDeployBlocks.stockZap = 69518131; }));
  assert.ok(zap.ok, zap.stderr);
  assert.equal(contractsLiteral(zap.rendered).stockZap, addr(777));
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
    reg.v2.contracts.zapRouter = null;
  });
  const r = generate(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /registry v2\.contracts keys differ from the v8 registry schema; unknown zapRouter/);
  // A misspelt external is unknown, not silently taken for the real one.
  const typo = generate(scratch((reg) => { reg.v2.contracts.earnvault = null; }));
  assert.equal(typo.ok, false);
  assert.match(typo.stderr, /unknown earnvault/);
});

test("an external slot holding a non-address is refused by name", () => {
  const r = generate(scratch((reg) => { reg.v2.contracts.earnVault = "0xnot-an-address"; }));
  assert.equal(r.ok, false);
  assert.match(r.stderr, /registry v2\.contracts\.earnVault is neither null nor an address/);
});

test("a core contract is still required -- accepting the externals did not loosen the eleven", () => {
  const r = generate(scratch((reg) => { delete reg.v2.contracts.accessManager; }));
  assert.equal(r.ok, false);
  assert.match(r.stderr, /missing accessManager/);
});

/** The GENERATED_MARKETS literal of a rendered file, as an array (a TS literal: unquoted keys, so not JSON). */
function marketsLiteral(rendered) {
  const m = rendered.match(/export const GENERATED_MARKETS = (\[[\s\S]*?\n\]) as const;/);
  assert.ok(m, "no GENERATED_MARKETS literal in the rendered file");
  return new Function(`return (${m[1]});`)();
}

test("every market's v2.chainlinkBand reaches the literal field for field (it was accepted and then dropped)", () => {
  const r = generate(scratch(() => {}));
  assert.ok(r.ok, r.stderr);
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const rows = marketsLiteral(r.rendered);
  assert.equal(rows.length, reg.markets.length);
  reg.markets.forEach((m, i) => {
    assert.ok("chainlinkBand" in rows[i].v2, `${m.ticker}: v2.chainlinkBand is missing from the literal`);
    assert.deepEqual(rows[i].v2.chainlinkBand, m.v2.chainlinkBand, `${m.ticker}: v2.chainlinkBand is not copied through`);
  });
  // Positive control: the committed registry carries at least one real band, so this cannot pass on markers alone.
  assert.ok(reg.markets.some((m) => typeof m.v2.chainlinkBand === "object"), "the committed registry carries a band object");
});

test("the builder's no-band marker is copied through as it is", () => {
  const r = generate(scratch((reg) => { reg.markets[0].v2.chainlinkBand = "none"; }));
  assert.ok(r.ok, r.stderr);
  assert.equal(marketsLiteral(r.rendered)[0].v2.chainlinkBand, "none");
});

test("a chainlinkBand the builder would not accept is refused by name", () => {
  const cases = [
    [null, /v2\.chainlinkBand is neither "none" nor \{ minPrice, maxPrice \}/],
    ["", /v2\.chainlinkBand is neither "none" nor \{ minPrice, maxPrice \}/],
    [{ minPrice: "20000000" }, /v2\.chainlinkBand/],
    [{ minPrice: "20000000", maxPrice: "2000000000", extra: "1" }, /v2\.chainlinkBand/],
    [{ minPrice: 20000000, maxPrice: "2000000000" }, /v2\.chainlinkBand\.minPrice 20000000 is not a uint128 decimal string above 0/],
    [{ minPrice: "0", maxPrice: "2000000000" }, /v2\.chainlinkBand\.minPrice "0" is not a uint128 decimal string above 0/],
    [{ minPrice: "20000000", maxPrice: (1n << 128n).toString() }, /v2\.chainlinkBand\.maxPrice "\d+" is not a uint128 decimal string above 0/],
    [{ minPrice: "2000000000", maxPrice: "2000000000" }, /v2\.chainlinkBand\.maxPrice is not above minPrice/],
  ];
  for (const [band, re] of cases) {
    const r = generate(scratch((reg) => { reg.markets[0].v2.chainlinkBand = band; }));
    assert.equal(r.ok, false, `accepted ${JSON.stringify(band)}`);
    assert.match(r.stderr, re, JSON.stringify(band));
  }
  // Absent is refused too: the key set is closed (V2_MARKET_KEYS), so a missing band is not read as "no band".
  const absent = generate(scratch((reg) => { delete reg.markets[0].v2.chainlinkBand; }));
  assert.equal(absent.ok, false);
  assert.match(absent.stderr, /chainlinkBand/);
});
