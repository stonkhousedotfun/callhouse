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
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAD = "0x000000000000000000000000000000000000bAd0";

/** A scratch copy of ops/markets, so nothing here writes to the checkout. */
function scratch(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "render-docs-"));
  const out = path.join(dir, "markets");
  cpSync(HERE, out, { recursive: true });
  const file = path.join(out, "tier1.json");
  const reg = JSON.parse(readFileSync(file, "utf8"));
  mutate(reg);
  writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
  return { dir, script: path.join(out, "render-docs.mjs"), page: path.join(dir, "markets.md") };
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
