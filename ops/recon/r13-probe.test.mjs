/**
 * r13-probe.mjs's offline guards. Every case runs the probe in a mode that sends no RPC:
 *
 *   --addresses          the pinned literals of the probe's own source + the tier1.json values it copies
 *   --audit <file.json>  the same strict rule over every address-shaped string in a JSON file
 *   --drift <file.json>  the --check comparison of a candidate against the committed v2-sources.json
 *   --validate <file.json>  the schema validate() applies to every generated file before it is written
 *
 * Each case builds a SCRATCH copy of the layout the probe resolves relative to itself
 * (<tmp>/recon/r13-probe.mjs, <tmp>/markets/{tier1,v2-sources}.json), so a break is made in the copy and
 * never in the committed files. Needs `cast` on PATH (the strict rule's one dependency); without it the
 * probe exits 2 and these cases fail rather than pass unchecked.
 *
 *   node --test ops/recon/r13-probe.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "r13-probe.mjs");
const MARKETS = path.join(HERE, "../markets");

/** A scratch copy of the probe + its two inputs; `edit` rewrites the probe's source in the copy. */
function scratch(t, edit = (s) => s) {
  const root = mkdtempSync(path.join(tmpdir(), "r13-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "recon"));
  mkdirSync(path.join(root, "markets"));
  writeFileSync(path.join(root, "recon/r13-probe.mjs"), edit(readFileSync(PROBE, "utf8")));
  for (const f of ["tier1.json", "v2-sources.json"]) cpSync(path.join(MARKETS, f), path.join(root, "markets", f));
  return root;
}

/** Runs the probe copy offline; resolves { code, stderr } whatever the exit code. */
function run(root, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, "recon/r13-probe.mjs"), ...args], { timeout: 120_000 }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stderr });
    });
  });
}

const writeJson = (root, name, value) => {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};

// EIP-55 forms written by hand here are positive controls ON THE TEST: cast must agree they are canonical,
// which the "accepts" case proves before any refusal is trusted.
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

test("--addresses: every pinned literal in the probe is strict EIP-55 at this commit", async (t) => {
  const { code, stderr } = await run(scratch(t), "--addresses");
  assert.equal(code, 0, stderr);
  assert.match(stderr, /address guard: all strict EIP-55/);
  assert.match(stderr, /FACTORY .*ROUTER .*QUOTER /);
});

test("strict rule: an EIP-55 address passes --audit, the SAME address all-lowercase is refused by name (one rule with check-deploy-inputs.sh checksum_ok)", async (t) => {
  const root = scratch(t);
  const ok = await run(root, "--audit", writeJson(root, "ok.json", { usdg: USDG }));
  assert.equal(ok.code, 0, ok.stderr);
  const lower = await run(root, "--audit", writeJson(root, "lower.json", { usdg: USDG.toLowerCase() }));
  assert.equal(lower.code, 1, lower.stderr);
  assert.match(lower.stderr, new RegExp(`usdg ${USDG.toLowerCase()} is not EIP-55 \\(checksum form ${USDG}\\)`));
  // A wrong-case checksum (one letter flipped) is refused too, and never silently corrected.
  const flipped = `${USDG.slice(0, 3)}${USDG[3] === USDG[3].toUpperCase() ? USDG[3].toLowerCase() : USDG[3].toUpperCase()}${USDG.slice(4)}`;
  const bad = await run(root, "--audit", writeJson(root, "bad.json", { usdg: flipped }));
  assert.equal(bad.code, 1, bad.stderr);
  assert.match(bad.stderr, /is not EIP-55/);
});

test("positive control (criterion 1): the three v3 constants lowercased in a scratch copy -> --audit red naming FACTORY, ROUTER, QUOTER", async (t) => {
  const root = scratch(t, (src) => src.replace(/^const (FACTORY|ROUTER|QUOTER) = '(0x[\da-fA-F]{40})';/gm, (_, name, a) => `const ${name} = '${a.toLowerCase()}';`));
  const { code, stderr } = await run(root, "--audit", path.join(root, "markets/tier1.json"));
  assert.equal(code, 1, stderr);
  assert.match(stderr, /address guard refused 3 of \d+ in r13-probe\.mjs/);
  for (const name of ["FACTORY", "ROUTER", "QUOTER"]) assert.match(stderr, new RegExp(`pinned ${name} \\(r13-probe\\.mjs:\\d+\\) 0x[\\da-f]{40} is not EIP-55`));
});

test("--drift: the committed JSON against itself is no drift; so is the contracts block with its keys reordered (normalised on purpose)", async (t) => {
  const root = scratch(t);
  const same = await run(root, "--drift", path.join(root, "markets/v2-sources.json"));
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stderr, /no material drift/);
  const data = JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  data.contracts = Object.fromEntries(Object.entries(data.contracts).reverse());
  const reordered = await run(root, "--drift", writeJson(root, "reordered.json", data));
  assert.equal(reordered.code, 0, reordered.stderr);
});

test("positive control (criterion 2): one contracts value hand-edited in a scratch copy -> --drift red naming it", async (t) => {
  const root = scratch(t);
  const committed = () => JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  // A different address.
  const moved = committed();
  moved.contracts.factory.address = USDG;
  let r = await run(root, "--drift", writeJson(root, "moved.json", moved));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.factory: /m);
  assert.doesNotMatch(r.stderr, /^contracts\.(router|quoter|weth)/m, "only the edited entry is named");
  // The same bytes, different case: drift too (both sides are EIP-55; a case change is a changed string).
  const recased = committed();
  recased.contracts.v4StateView.address = recased.contracts.v4StateView.address.toLowerCase();
  r = await run(root, "--drift", writeJson(root, "recased.json", recased));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.v4StateView: /m);
  // A nested field.
  const code = committed();
  code.contracts.weth.codeExists = false;
  r = await run(root, "--drift", writeJson(root, "code.json", code));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.weth: .*"codeExists":true.* -> .*"codeExists":false/m);
  // A key gone, and a key added.
  const gone = committed();
  delete gone.contracts.usdgWethV3Pool;
  gone.contracts.somethingNew = { address: USDG, codeExists: true };
  r = await run(root, "--drift", writeJson(root, "gone.json", gone));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.usdgWethV3Pool: absent from this run$/m);
  assert.match(r.stderr, /^contracts\.somethingNew: absent from the committed JSON$/m);
});

// v2-sources.json follows the registry. The probe builds its market list from tier1.json, so a
// committed file whose markets are not tier1.json's is one the probe did not write -- the 35-market recon sat
// beside a 2-market registry for a day because nothing compared the two.
function registryDisagreements(registry, sources) {
  const want = registry.markets.map((m) => m.ticker);
  const issues = [];
  const have = sources.markets.map((m) => m.ticker);
  if (have.join(",") !== want.join(",")) issues.push(`markets ${have.join(",")} are not the registry's ${want.join(",")}`);
  const history = Object.keys(sources.roundHistory ?? {}).sort();
  if (history.join(",") !== [...want].sort().join(",")) issues.push(`roundHistory covers ${history.join(",")}, not the registry's ${want.join(",")}`);
  for (const m of sources.markets) {
    const row = registry.markets.find((r) => r.ticker === m.ticker);
    if (row && (row.asset !== m.asset || row.feed !== m.feed)) issues.push(`${m.ticker}: asset/feed differ from tier1.json`);
  }
  return issues;
}

test("the committed v2-sources.json is the registry's markets in registry order, with round history for each, and tier1.json's asset/feed strings", () => {
  const registry = JSON.parse(readFileSync(path.join(MARKETS, "tier1.json"), "utf8"));
  const sources = JSON.parse(readFileSync(path.join(MARKETS, "v2-sources.json"), "utf8"));
  assert.ok(registry.markets.length > 0);
  assert.deepEqual(registryDisagreements(registry, sources), []);
});

test("positive control: a market added to the registry, a round history dropped, or an asset re-cased -> each disagreement is named", () => {
  const registry = JSON.parse(readFileSync(path.join(MARKETS, "tier1.json"), "utf8"));
  const sources = JSON.parse(readFileSync(path.join(MARKETS, "v2-sources.json"), "utf8"));
  const grown = { ...registry, markets: [...registry.markets, { ...registry.markets[0], ticker: "ZZZZ" }] };
  assert.match(registryDisagreements(grown, sources).join("\n"), /^markets .* are not the registry's .*,ZZZZ$/m);
  const first = sources.markets[0].ticker;
  const noHistory = { ...sources, roundHistory: { ...sources.roundHistory } };
  delete noHistory.roundHistory[first];
  assert.match(registryDisagreements(registry, noHistory).join("\n"), /^roundHistory covers .*, not the registry's/m);
  const recased = { ...sources, markets: sources.markets.map((m, i) => (i === 0 ? { ...m, asset: m.asset.toLowerCase() } : m)) };
  assert.deepEqual(registryDisagreements(registry, recased), [`${first}: asset/feed differ from tier1.json`]);
});

test("--drift: a market the committed JSON lists but the candidate does not is named (the registry dropped it)", async (t) => {
  const root = scratch(t);
  const data = JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  const dropped = data.markets.pop().ticker;
  const r = await run(root, "--drift", writeJson(root, "dropped.json", data));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`^${dropped}: absent from this run$`, "m"));
  assert.doesNotMatch(r.stderr, /^contracts\./m, "only the dropped market is named");
});

// The Earn venue. callhouse-contracts script/v2/lib/registry-env.sh builds the EarnVault's
// Erc4626VenueAdapter only when this file names contracts.earnVenue.address, and
// refuses the venue unless contracts.earnVenue.maxIsAdvisory is a JSON boolean. DeployV2Batch.sh and
// broadcast-v8.sh, each where it sets SOURCES, point it at the v2-sources.json beside the registry, i.e. this file. The two jq
// programs below are copied from those lines, so the test reads the file the way the deploy does.
const EARN_VENUE = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const jq = (program, file) =>
  new Promise((resolve, reject) => {
    execFile("jq", ["-r", program, file], (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())));
  });
const JQ_ADDRESS = ".contracts.earnVenue.address // empty";
const JQ_KIND = '.contracts.earnVenue.maxIsAdvisory | if type == "boolean" then tostring else "not-a-boolean" end';

test("the committed v2-sources.json carries contracts.earnVenue: Steakhouse USDG, code, asset == tier1 USDG, maxIsAdvisory true, as registry-env.sh reads it", async () => {
  const registry = JSON.parse(readFileSync(path.join(MARKETS, "tier1.json"), "utf8"));
  const sources = JSON.parse(readFileSync(path.join(MARKETS, "v2-sources.json"), "utf8"));
  assert.deepEqual(sources.contracts.earnVenue, { address: EARN_VENUE, codeExists: true, asset: registry.shared.usdg, maxIsAdvisory: true });
  assert.equal(registry.shared.usdg, USDG);
  const file = path.join(MARKETS, "v2-sources.json");
  assert.equal(await jq(JQ_ADDRESS, file), EARN_VENUE);
  assert.equal(await jq(JQ_KIND, file), "true");
});

test("positive control: the registry-env.sh jq reads see an absent venue as empty and a string maxIsAdvisory as not-a-boolean", async (t) => {
  const root = scratch(t);
  const committed = () => JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  const absent = committed();
  delete absent.contracts.earnVenue;
  assert.equal(await jq(JQ_ADDRESS, writeJson(root, "absent.json", absent)), "");
  const stringly = committed();
  stringly.contracts.earnVenue.maxIsAdvisory = "true";
  assert.equal(await jq(JQ_KIND, writeJson(root, "stringly.json", stringly)), "not-a-boolean");
});

test("--validate: the committed JSON passes; a missing venue, a venue without code, a string maxIsAdvisory, or a venue over another asset is refused by name", async (t) => {
  const root = scratch(t);
  const ok = await run(root, "--validate", path.join(root, "markets/v2-sources.json"));
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /R13 validate: schema ok/);
  const committed = () => JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  const cases = [
    ["absent", (d) => delete d.contracts.earnVenue, /contracts\.earnVenue: an address with code/],
    ["no code", (d) => (d.contracts.earnVenue.codeExists = false), /contracts\.earnVenue: an address with code/],
    ["string kind", (d) => (d.contracts.earnVenue.maxIsAdvisory = "true"), /contracts\.earnVenue\.maxIsAdvisory is not a boolean/],
    ["no kind", (d) => delete d.contracts.earnVenue.maxIsAdvisory, /contracts\.earnVenue\.maxIsAdvisory is not a boolean/],
    ["other asset", (d) => (d.contracts.earnVenue.asset = d.contracts.weth.address), /contracts\.earnVenue asset 0x[\da-fA-F]{40} is not the registry's USDG/],
  ];
  for (const [name, edit, refusal] of cases) {
    const data = committed();
    edit(data);
    const r = await run(root, "--validate", writeJson(root, `${name.replace(/ /g, "-")}.json`, data));
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, refusal, name);
  }
});

test("--drift: a flipped maxIsAdvisory or a re-pointed venue is drift naming contracts.earnVenue", async (t) => {
  const root = scratch(t);
  const committed = () => JSON.parse(readFileSync(path.join(root, "markets/v2-sources.json"), "utf8"));
  const flipped = committed();
  flipped.contracts.earnVenue.maxIsAdvisory = false;
  let r = await run(root, "--drift", writeJson(root, "flipped.json", flipped));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.earnVenue: .*"maxIsAdvisory":true.* -> .*"maxIsAdvisory":false/m);
  const moved = committed();
  moved.contracts.earnVenue.address = USDG;
  r = await run(root, "--drift", writeJson(root, "moved-venue.json", moved));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^contracts\.earnVenue: /m);
});
