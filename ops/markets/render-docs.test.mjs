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
  assert.match(page, /Legacy interface-7 contract set/);
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

test("a market that failed on-chain verification does not render", () => {
  const s = scratch((reg) => {
    const m = reg.markets.find((x) => x.ticker === "AMD");
    m.feed = BAD;
    m.verification.ok = false;
    m.verification.issues = ['feed description "" is not RHAMD / USD', "feed proxy has no code"];
  });
  const r = render(s);
  assert.equal(r.ok, false, "a failing row must not reach the page");
  assert.match(r.stderr, /AMD: feed description/);
  assert.match(r.stderr, /failed on-chain verification/);
});

test("a market with no verification block at all does not render", () => {
  const s = scratch((reg) => {
    delete reg.markets.find((x) => x.ticker === "AMD").verification;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /AMD: no verification block/);
});

test("a row verified at another block does not render under one verifiedAtBlock stamp", () => {
  const s = scratch((reg) => {
    reg.markets.find((x) => x.ticker === "AMD").verification.block = reg.verifiedAtBlock - 1000;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /AMD=\d+ were verified at another block/);
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

/* ------------------------------------------------------------------ T-OP-138: the six external contracts */

// The six external `v2.contracts` keys (T-OP-114: houseVault, houseVaultFactory, hedger, rewardsDistributorLender,
// earnVault, stockVenueAdapter) are written back by their own deploy step. Before this row `checkKeys` threw on
// them ("not a key this page renders"), so the first write-back would have turned the docs gate red. Now they
// are accepted when present and rendered in their own section; the key list is IMPORTED from
// build-markets.mjs, and any other name is still refused.
const EXTERNAL = ["houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter"];
const EXTERNAL_NAMES = ["HouseVault", "HouseVaultFactory", "Hedger", "RewardsDistributor (lender)", "EarnVault", "StockVenueAdapter"];

test("T-OP-138: the committed registry (no externals yet) renders the externals section with every row not deployed", () => {
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  assert.match(page, /### External v2 contracts/);
  for (const name of EXTERNAL_NAMES) {
    assert.match(page, new RegExp(`\\| \`${name.replace(/[()]/g, "\\$&")}\` \\| [^|]+ \\| not deployed \\| — \\|`), `${name} row`);
  }
});

test("T-OP-138: the six present as null render exactly like absent ones", () => {
  const absent = scratch(() => {});
  const present = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
  });
  assert.ok(render(absent).ok);
  const r = render(present);
  assert.ok(r.ok, r.stderr);
  assert.equal(readFileSync(present.page, "utf8"), readFileSync(absent.page, "utf8"));
});

test("T-OP-138: the written-back shape renders — six addresses with their start blocks, in their own section", () => {
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

test("T-OP-138: a seventh v2.contracts key is still refused by name — the block stays closed", () => {
  const s = scratch((reg) => {
    for (const k of EXTERNAL) reg.v2.contracts[k] = null;
    reg.v2.contracts.stockZap = null;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v2\.contracts\.stockZap is not a key this page renders/);
  // And a misspelt external is unknown, not silently taken for the real one.
  const typo = scratch((reg) => { reg.v2.contracts.earnvault = null; });
  const t = render(typo);
  assert.equal(t.ok, false);
  assert.match(t.stderr, /v2\.contracts\.earnvault is not a key this page renders/);
});

test("T-OP-138: an external slot holding a non-address is refused by name", () => {
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
  const s = scratch((reg) => {
    reg.markets.find((m) => m.ticker === "AAPL").v2.payoutRoute = { venue: "v3", fee: 3000 };
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
  assert.match(marketTable, /\| \*\*AAPL\*\* .* Uniswap v3 — 0\.3% fee tier \|/);
  assert.match(marketTable, /\| \*\*NVDA\*\* .*Uniswap v3 TWAP .* Uniswap v4 — 0\.05% fee tier, tick spacing 10, pool id/);
  assert.ok(marketTable.includes(`pool id \`${poolId}\``));
  assert.match(marketTable, /\| \*\*AMD\*\* .* No route — winning calls pay in Stock Tokens in kind \|/);
  assert.doesNotMatch(page, new RegExp(`/address/${poolId}`));
});

test("an interface-8 file cannot be relabelled as the legacy interface-7 set", () => {
  const s = scratch(() => {}, (legacy) => {
    legacy.v2.interfaceVersion = 8;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /must record v2\.interfaceVersion 7/);
});

test("a file without the legacy marker cannot become the interface-7 set", () => {
  const s = scratch(() => {}, (legacy) => {
    delete legacy._legacy;
  });
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /has no _legacy marker/);
});

test("a missing legacy registry refuses instead of dropping the section", () => {
  const s = scratch(() => {});
  rmSync(s.legacyFile);
  const r = render(s);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /v7-legacy\.json is missing/);
});

test("the legacy NVDA registration never becomes a live interface-8 market", () => {
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  const current = page.slice(page.indexOf("## Tokens, feeds and settlement sources"), page.indexOf("## Strikes, ladders and puts"));
  const legacy = page.slice(page.indexOf("## Legacy interface-7 contract set"), page.indexOf("## Legacy v1 factories"));
  assert.match(current, /\| \*\*NVDA\*\* \| `planned` \|/);
  assert.doesNotMatch(current, /\| \*\*NVDA\*\* \| `live`/);
  assert.match(legacy, /\| \*\*NVDA\*\* \| `live` since/);
});

test("the interface-7 section describes policy without claiming the freeze happened", () => {
  const s = scratch(() => {});
  const r = render(s);
  assert.ok(r.ok, r.stderr);
  const page = readFileSync(s.page, "utf8");
  const legacy = page.slice(page.indexOf("## Legacy interface-7 contract set"), page.indexOf("## Legacy v1 factories"));
  assert.match(legacy, /run-off procedure, if applied/);
  assert.match(legacy, /does not record whether that procedure has been applied/);
  assert.doesNotMatch(legacy, /interface[- ]7 (?:is|was|has been) (?:frozen|stopped|paused)/i);
});
