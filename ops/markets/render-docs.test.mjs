/**
 * What the published markets page may claim.
 *
 * WHY THIS FILE EXISTS: the page says "Trust only the production addresses" and stamps every token
 * and feed address with the block it was read at. `build-markets.mjs` writes `tier1.json` even when a
 * market fails its on-chain checks (it preserves the hand edits and exits 1), so a failing row can be
 * committed. Rendering it would publish an unverified address under a provenance claim.
 *
 *   node --test ops/markets/render-docs.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAD = "0x000000000000000000000000000000000000bAd0";

/** A scratch copy of ops/markets, so nothing here writes to the checkout. */
function scratch(mutate, mutateLegacy = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "render-docs-"));
  const out = path.join(dir, "markets");
  cpSync(HERE, out, { recursive: true });
  const file = path.join(out, "tier1.json");
  const reg = JSON.parse(readFileSync(file, "utf8"));
  mutate(reg);
  writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
  const legacyFile = path.join(out, "v7-legacy.json");
  const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
  mutateLegacy(legacy);
  writeFileSync(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`);
  return { dir, legacyFile, script: path.join(out, "render-docs.mjs"), page: path.join(dir, "markets.md") };
}

function render({ script, page }) {
  try {
    execFileSync(process.execPath, [script, "--out", page], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stderr: "" };
  } catch (error) {
    return { ok: false, stderr: `${error.stderr ?? ""}${error.stdout ?? ""}` };
  }
}

test("the registry as committed renders", () => {
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, `the committed registry must render: ${r.stderr}`);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /Trust only the production addresses on this page/);
  assert.match(page, /Stonkhouse v2 is unaudited/);
  assert.match(page, /`AccessManager`/);
  assert.match(page, /`FeeSplitter`/);
  assert.match(page, /`V4BuybackExecutor`/);
  assert.match(page, /`Admin Safe`/);
  assert.match(page, /`Treasury Safe`/);
  // INVERTED ON PURPOSE: this line used to REQUIRE "Legacy interface-7 contract set". The docs are
  // v9-only, so the page must carry no interface-7 or v1 section and no link to one.
  assert.doesNotMatch(page, /^## Legacy/m);
  assert.doesNotMatch(page, /interface[- ]7/i);
  assert.doesNotMatch(page, /v1 factor/i);
  assert.doesNotMatch(page, /moving-from-v1|\.\.\/legacy\//);
});

test("an empty production registry does not claim nothing deployed on chain", () => {
  const s = scratch((reg) => {
    reg.v2.deployBlock = null;
    for (const market of reg.markets) {
      market.v2.status = "planned";
      market.v2.registeredAt = null;
      market.v2.registerTx = null;
    }
    for (const key of Object.keys(reg.v2.contracts)) {
      if (key === "sources") {
        for (const source of Object.keys(reg.v2.contracts.sources)) reg.v2.contracts.sources[source] = null;
      } else reg.v2.contracts[key] = null;
    }
    reg.v2.flywheel.deployBlock = null;
    reg.v2.flywheel.feeSplitter = null;
    reg.v2.flywheel.buybackExecutor = null;
    reg.shared.safes.admin = null;
    reg.shared.safes.treasury = null;
  });
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /This registry records no v2 contract deployment/);
  assert.match(page, /not recorded in this registry/);
  assert.doesNotMatch(page, /not deployed yet|has not been deployed|They are not deployed yet/);
});

test("planned markets are not presented as live", () => {
  const s = scratch((reg) => {
    for (const market of reg.markets) {
      market.v2.status = "planned";
      market.v2.registeredAt = null;
      market.v2.registerTx = null;
    }
  });
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /No v2 market is marked live in this registry/);
  assert.match(page, /planned.*not registered according to this registry/);
  assert.match(page, /Do not buy, write or deposit through a flow/);
  assert.doesNotMatch(page, /dev preview/);
  assert.doesNotMatch(page, /No market is live on v2 yet|nothing can be bought, written or deposited for it|is not Stonkhouse/);
});

test("live status does not claim that a cranker populated strike ladders", () => {
  const s = scratch((reg) => {
    reg.v2.contracts.clearinghouse = BAD;
    const nvda = reg.markets.find((m) => m.ticker === "NVDA");
    nvda.v2.status = "live";
    nvda.v2.registeredAt = 1789600000;
    nvda.v2.registerTx = "0x" + "a".repeat(64);
  });
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /live.*registered on the live v2 contracts/);
  assert.match(page, /this status alone does not mean an automated strike ladder is running/);
  assert.match(page, /they do not prove that any series has been created or that a cranker is running/);
  assert.doesNotMatch(page, /The cranker creates its strike ladders|For each live market the cranker creates/);
});

// The registry carries NVDA and SPCX only; SPCX stands in for the row these cases spoil (AMD before).
test("a market that failed on-chain verification does not render", () => {
  const s = scratch((reg) => {
    const m = reg.markets.find((x) => x.ticker === "SPCX");
    m.feed = BAD;
    m.verification.ok = false;
    m.verification.issues = ['feed description "" is not RHSPCX / USD', "feed proxy has no code"];
  });
  const r = render(s);
  assert.equal(r.ok, false, "a failing row must not reach the page");
  assert.match(r.stderr, /SPCX: feed description/);
  assert.match(r.stderr, /failed on-chain verification/);
});

test("a market with no verification block at all does not render", () => {
  const s = scratch((reg) => {
    delete reg.markets.find((x) => x.ticker === "SPCX").verification;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /SPCX: no verification block/);
});

test("a row verified at another block does not render under one verifiedAtBlock stamp", () => {
  const s = scratch((reg) => {
    reg.markets.find((x) => x.ticker === "SPCX").verification.block = reg.verifiedAtBlock - 1000;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /SPCX=\d+ were verified at another block/);
});

test("the page does not claim USDG's address was read on chain", () => {
  const s = scratch(() => {});
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  // build-markets.mjs carries USDG as a constant and probes no symbol()/decimals() of it; what it does
  // check on chain is that each configured pool holds exactly {asset, USDG}.
  assert.doesNotMatch(page, /USDG was read on chain/);
  assert.match(page, /USDG's address is a constant of the registry, not a read/);
});

test("The registry-owned deploy knobs are known and deliberately not rendered", () => {
  // Every knob's VALUE changed, and the page is byte-identical: flywheel.config and the oracle source tuning in
  // v2.defaults are deploy inputs, not market facts. (Both keys are still required: the shape check is exact.)
  const committed = scratch(() => {});
  const changed = scratch((reg) => {
    for (const k of Object.keys(reg.v2.flywheel.config)) {
      const v = reg.v2.flywheel.config[k];
      reg.v2.flywheel.config[k] = typeof v === "string" ? `${v}1` : v + 1;
    }
    for (const k of ["maxFeedAgeS", "chainlinkMaxStaleS", "chainlinkMaxRoundJumpBps", "univ3WindowS"]) reg.v2.defaults[k] += 1;
  });
  const a = render(committed);
  assert.ok(a.ok, `the committed registry must render: ${a.stderr}`);
  const b = render(changed);
  assert.ok(b.ok, `a registry with other knob values must render: ${b.stderr}`);
  assert.equal(readFileSync(committed.page, "utf8"), readFileSync(changed.page, "utf8"));
  // Known is not the same as open: a misspelt knob in the flywheel is still refused by name.
  const typo = scratch((reg) => {
    reg.v2.flywheel.configs = reg.v2.flywheel.config;
  });
  const r = render(typo);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.flywheel\.configs is not a key this page renders/);
});

test("NVDA's Mon/Wed/Fri daily ladder is stated on its row; every-weekday rows are unchanged; a bad list is refused", () => {
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  const row = (ticker) => page.split("\n").find((line) => line.startsWith(`| **${ticker}** |`) && line.includes("strikes"));
  assert.match(row("NVDA"), /the Mon, Wed and Fri ones of the next 6 closes, 5 strikes from \+1% in 1% steps \(market setting\)/);
  assert.doesNotMatch(row("SPCX"), /Mon|Wed|closes/, "SPCX lists no dailies; its row is untouched");
  const bad = scratch((reg) => {
    reg.markets.find((m) => m.ticker === "NVDA").v2.overrides.dailyWeekdays = ["mon", "sun"];
  });
  const b = render(bad);
  assert.equal(b.ok, false);
  assert.match(b.stderr, /NVDA\.v2\.overrides\.dailyWeekdays must be a non-empty list of distinct weekdays/);
});

test("an unknown flywheel key does not disappear from the page", () => {
  const s = scratch((reg) => {
    reg.v2.flywheel.discountModule = null;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.flywheel\.discountModule is not a key this page renders/);
});

test("an unknown Safe key does not disappear from the page", () => {
  const s = scratch((reg) => {
    reg.shared.safes.recovery = null;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /shared\.safes\.recovery is not a key this page renders/);
});

/* ------------------------------------------------------------------ the external contracts */

// The external `v2.contracts` keys (houseVault, houseVaultFactory, hedger, rewardsDistributorLender,
// earnVault, stockVenueAdapter; then stockZap, which DeployEarnVault.s.sol creates and only the app reads)
// are written back by their own deploy step. At first `checkKeys` threw on them ("not a key this page
// renders"), so the first write-back would have turned the docs gate red. Now they are accepted when present and
// rendered in their own section; the key list is IMPORTED from build-markets.mjs, and any other name is still refused.
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter", "stockZap"];
const EXTERNAL_NAMES = ["HouseVault", "HouseVaultFactory", "Hedger", "RewardsDistributor (lender)", "EarnVault", "StockVenueAdapter", "StockZap"];

/**
 * Re-pinned. This used to assert "every external row not deployed" against the PRE-deploy registry. The
 * deployed registry records some externals (HouseVault, its factory, EarnVault at the v8 broadcast) and not others,
 * so the expectation is now DERIVED from the committed registry row by row: a null external renders `not deployed`,
 * a recorded one renders its address. What the test protects is unchanged -- a null is never rendered as an address
 * and an address is never rendered as "not deployed" -- and it must still see at least one of each, or it has
 * stopped testing one of the two branches.
 */
test("The committed registry renders each external as the registry records it (null -> not deployed, address -> address)", () => {
  const reg = JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /### External v2 contracts/);
  const section = page.slice(page.indexOf("### External v2 contracts"), page.indexOf("v2 also relies on these third-party contracts"));
  let nulls = 0;
  let addrs = 0;
  EXTERNAL.forEach((k, i) => {
    const name = EXTERNAL_NAMES[i].replace(/[()]/g, "\\$&");
    const v = reg.v2.contracts[k] ?? null;
    if (v === null) {
      nulls++;
      assert.match(section, new RegExp(`\\| \`${name}\` \\| [^|]+ \\| not deployed \\| — \\|`), `${k} is null in tier1.json: row must say not deployed`);
    } else {
      addrs++;
      assert.match(section, new RegExp(`\\| \`${name}\` \\| [^|]+ \\| \\[\`${v}\`\\]`), `${k} is ${v} in tier1.json: row must carry that address`);
      assert.doesNotMatch(section, new RegExp(`\\| \`${name}\` \\| [^|]+ \\| not deployed`), `${k} is recorded: never "not deployed"`);
    }
  });
  assert.ok(nulls > 0 && addrs > 0, `both branches exercised by the committed registry (null ${nulls}, recorded ${addrs})`);
});

// Re-pinned: "absent" was the committed registry itself, which had none of the external keys before the v8
// write-back. It now records some, so "absent" is made explicit: the external keys deleted. The property is
// unchanged: a key present as null renders byte-for-byte like a missing key.
test("The externals present as null render exactly like absent ones", () => {
  const absent = scratch((reg) => {
    for (const k of EXTERNAL) delete reg.v2.contracts[k];
  });
  const present = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
  });
  assert.ok(render(absent).ok);
  const r = render(present);
  assert.ok(r.ok, r.stderr);
  assert.equal(readFileSync(present.page, "utf8"), readFileSync(absent.page, "utf8"));
});

test("The written-back shape renders — every external's address with its start block, in their own section", () => {
  const s = scratch((reg) => {
    EXTERNAL.forEach((k, i) => {
      reg.v2.contracts[k] = `0x${String(501 + i).padStart(40, "0")}`;
      reg.v2.externalDeployBlocks[k] = 69324900 + i;
    });
  });
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  const section = page.slice(page.indexOf("### External v2 contracts"), page.indexOf("v2 also relies on these third-party contracts"));
  EXTERNAL.forEach((k, i) => {
    const a = `0x${String(501 + i).padStart(40, "0")}`;
    assert.match(section, new RegExp(`\\| \`${EXTERNAL_NAMES[i].replace(/[()]/g, "\\$&")}\` \\| [^|]+ \\| \\[\`${a}\`\\]\\([^)]+/address/${a}\\) \\| ${(69324900 + i).toLocaleString("en-US")} \\|`), `${k} row`);
  });
  assert.doesNotMatch(section, /not deployed \|/);
  // An external address is never listed as a CORE contract: the core table is above the section and unchanged.
  const core = page.slice(page.indexOf("## v2 contracts"), page.indexOf("### External v2 contracts"));
  assert.doesNotMatch(core, /0x0000000000000000000000000000000000000501/);
});

// stockZap used to be this case's refused example. It is now an external, so it renders (the written-back
// case above carries it); the closed block is still pinned, with a name no list knows.
test("stockZap is accepted and rendered, and an eighth v2.contracts key is still refused by name", () => {
  const zap = scratch((reg) => {
    reg.v2.contracts.stockZap = "0x22191Ee250bcb6c79C338CAf7F4AA516554b4439";
    reg.v2.externalDeployBlocks.stockZap = 69518131;
  });
  const z = render(zap);
  assert.ok(z.ok, z.stderr);
  assert.match(readFileSync(zap.page, "utf8"), /\| `StockZap` \| [^|]+ \| \[`0x22191Ee250bcb6c79C338CAf7F4AA516554b4439`\]\([^)]+\) \| 69,518,131 \|/);
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
    reg.v2.contracts.zapRouter = null;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.contracts\.zapRouter is not a key this page renders/);
  // And a misspelt external is unknown, not silently taken for the real one.
  const typo = scratch((reg) => { reg.v2.contracts.earnvault = null; });
  const t = render(typo);
  assert.equal(t.ok, false);
  assert.match(t.stderr, /v2\.contracts\.earnvault is not a key this page renders/);
});

test("An external slot holding a non-address is refused by name", () => {
  const s = scratch((reg) => { reg.v2.contracts.earnVault = "0xnot-an-address"; });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.contracts\.earnVault is neither null nor an address/);
});

test("a v8 contracts block without accessManager is refused", () => {
  const s = scratch((reg) => {
    delete reg.v2.contracts.accessManager;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.contracts\.accessManager is missing/);
});

test("null, v3 and v4 payout routes render separately from settlement sources", () => {
  const poolId = `0x${"ab".repeat(32)}`;
  // Two markets carry the three shapes over two renders: SPCX v3 beside NVDA v4, then SPCX with none.
  const s = scratch((reg) => {
    reg.markets.find((m) => m.ticker === "SPCX").v2.payoutRoute = { venue: "v3", fee: 3000 };
    reg.markets.find((m) => m.ticker === "NVDA").v2.payoutRoute = {
      venue: "v4",
      fee: 500,
      tickSpacing: 10,
      poolId,
    };
  });
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  const marketTable = page.slice(page.indexOf("## Tokens, feeds and settlement sources"), page.indexOf("## Strikes, ladders and puts"));
  assert.match(marketTable, /\| \*\*SPCX\*\* .* Uniswap v3 — 0\.3% fee tier \|/);
  assert.match(marketTable, /\| \*\*NVDA\*\* .*Uniswap v3 TWAP .* Uniswap v4 — 0\.05% fee tier, tick spacing 10, pool id/);
  assert.ok(marketTable.includes(`pool id \`${poolId}\``));
  assert.doesNotMatch(page, new RegExp(`/address/${poolId}`));
  const none = scratch((reg) => {
    reg.markets.find((m) => m.ticker === "SPCX").v2.payoutRoute = null;
  });
  const n = render(none);
  assert.ok(n.ok, n.stderr);
  const nonePage = readFileSync(none.page, "utf8");
  const noneTable = nonePage.slice(nonePage.indexOf("## Tokens, feeds and settlement sources"), nonePage.indexOf("## Strikes, ladders and puts"));
  assert.match(noneTable, /\| \*\*SPCX\*\* .* No route — winning calls pay in Stock Tokens in kind \|/);
});

/**
 * The page used to render the interface-7 set from v7-legacy.json and refused a missing, relabelled or
 * unmarked file (three tests here). The docs are v9-only now, so the renderer does not read that file at all: the
 * old refusals are gone ON PURPOSE, and this test pins the replacement property instead. A v7 address planted in
 * the legacy file, or the file removed, must not change the page by one byte.
 */
test("v7-legacy.json is not read: removing it or planting an address in it changes nothing", () => {
  const base = scratch(() => {});
  assert.ok(render(base).ok);
  const expected = readFileSync(base.page, "utf8");

  const planted = scratch(() => {}, (legacy) => {
    legacy.v2.contracts.clearinghouse = BAD;
  });
  const p = render(planted);
  assert.ok(p.ok, p.stderr);
  const page = readFileSync(planted.page, "utf8");
  assert.doesNotMatch(page, new RegExp(BAD, "i"));
  assert.equal(page, expected);

  const missing = scratch(() => {});
  rmSync(missing.legacyFile);
  const m = render(missing);
  assert.ok(m.ok, m.stderr);
  assert.equal(readFileSync(missing.page, "utf8"), expected);
});

/**
 * Re-pinned, and kept after the interface-7 section was dropped: the interface-8 row's status comes from
 * tier1.json v2.status. The scratch copy forces NVDA to `planned` and the current row must follow it; the committed
 * registry must render its own status for NVDA, whatever it is.
 */
test("the NVDA row's status follows tier1.json v2.status", () => {
  const forced = scratch((reg) => {
    reg.markets.find((m) => m.ticker === "NVDA").v2.status = "planned";
  });
  const r = render(forced);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(forced.page, "utf8");
  const current = page.slice(page.indexOf("## Tokens, feeds and settlement sources"), page.indexOf("## Strikes, ladders and puts"));
  assert.match(current, /\| \*\*NVDA\*\* \| `planned` \|/);
  assert.doesNotMatch(current, /\| \*\*NVDA\*\* \| `live`/);

  const reg = JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
  const own = reg.markets.find((m) => m.ticker === "NVDA").v2.status;
  const committed = scratch(() => {});
  assert.ok(render(committed).ok);
  const cur = readFileSync(committed.page, "utf8");
  assert.match(cur.slice(cur.indexOf("## Tokens, feeds and settlement sources"), cur.indexOf("## Strikes, ladders and puts")), new RegExp(`\\| \\*\\*NVDA\\*\\* \\| \`${own}\``));
});

// The waves and tenors prose follow the registry, not a fixed plan.
test("An all-live registry says so and names its launch set; a planned market brings back the wave plan", () => {
  const reg = JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
  const s = scratch(() => {});
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  const statuses = reg.markets.map((m) => m.v2.status);
  assert.ok(statuses.every((x) => x === "live"), `the committed registry is all live (${statuses.join(",")}); this test pins that branch`);
  const launch = reg.launchSet.markets;
  assert.match(page, new RegExp(`Every market in this registry is \`live\`: the launch set, ${launch.join(" and ")}\\.`));
  assert.doesNotMatch(page, /^Markets go live in waves: the canary first/m);

  const planned = scratch((r) => { r.markets[0].v2.status = "planned"; delete r.markets[0].v2.registeredAt; delete r.markets[0].v2.registerTx; });
  const rp = render(planned);
  assert.ok(rp.ok, rp.stderr);
  const pp = readFileSync(planned.page, "utf8");
  assert.match(pp, /^Markets go live in waves: the canary first, then wave 1, then wave 2\./m);
  assert.doesNotMatch(pp, /Every market in this registry is `live`/);
  // A paused market (none planned) must not be described as live either.
  const paused = scratch((r) => { r.markets[0].v2.status = "paused"; });
  const rz = render(paused);
  assert.ok(rz.ok, rz.stderr);
  const pz = readFileSync(paused.page, "utf8");
  assert.doesNotMatch(pz, /Every market in this registry is `live`/);
  assert.match(pz, /^Markets go live in waves: the canary first/m);
});

test("With weekly expiries ahead 0 the page says only daily expiries are listed, and how many sessions ahead", () => {
  const reg = JSON.parse(readFileSync(path.join(HERE, "tier1.json"), "utf8"));
  const s = scratch(() => {});
  assert.ok(render(s).ok);
  const page = readFileSync(s.page, "utf8");
  assert.equal(reg.v2.defaults.expiriesAhead.weekly, 0, "the committed registry is 0DTE-only; this test pins that branch");
  const n = reg.v2.defaults.expiriesAhead.daily;
  assert.match(page, new RegExp(`By default only daily expiries are listed: the registry sets weekly expiries ahead to 0.*the ladder lists the next ${n} session`));

  const both = scratch((r) => { r.v2.defaults.expiriesAhead.weekly = 2; });
  const rb = render(both);
  assert.ok(rb.ok, rb.stderr);
  assert.doesNotMatch(readFileSync(both.page, "utf8"), /By default only/);
});
