import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ops = path.dirname(fileURLToPath(import.meta.url));
const address = (suffix) => `0x${suffix.toString(16).padStart(40, "0")}`;

test("a local-only registry refuses a mainnet RPC before rendering", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "local-env-"));
  const mainnetRpc = "https://rpc.mainnet.chain.robinhood.com";
  try {
    const result = spawnSync(process.execPath, [
      path.join(ops, "v2-env.mjs"), "--registry", path.join(ops, "markets/dev.json"),
      "--out", scratch, "--services", "cranker", "--rpc", mainnetRpc,
    ], { encoding: "utf8" });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /local-only registry .*ops\/markets\/dev\.json/);
    assert.match(result.stderr, new RegExp(mainnetRpc.replaceAll(".", "\\.")));
    assert.equal(existsSync(path.join(scratch, "cranker.env")), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a populated production registry renders the indexer's flywheel and existing periphery sources", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "indexer-env-"));
  try {
    const registry = JSON.parse(readFileSync(path.join(ops, "markets/tier1.json"), "utf8"));
    Object.assign(registry.v2.contracts, {
      clearinghouse: address(1), orderBook: address(2), settlementOracle: address(3),
      autoRoller: address(4), makerRegistry: address(5), makerVault: address(6),
      rewardsDistributor: address(7),
    });
    registry.v2.deployBlock = 64000000;
    registry.v2.flywheel = {
      feeSplitter: address(8), buybackExecutor: address(9), deployBlock: 63999990,
    };
    registry.shared.token.address = address(10);
    const registryFile = path.join(scratch, "populated.json");
    writeFileSync(registryFile, JSON.stringify(registry));

    const result = spawnSync(process.execPath, [
      path.join(ops, "v2-env.mjs"), "--registry", registryFile,
      "--out", scratch, "--services", "indexer-v2",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const assignments = new Map(readFileSync(path.join(scratch, "indexer-v2.env"), "utf8")
      .split("\n").filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => { const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)]; }));

    assert.equal(assignments.get("V2_FEE_SPLITTER"), address(8));
    assert.equal(assignments.get("V2_BUYBACK_EXECUTOR"), address(9));
    assert.equal(assignments.get("V2_FLYWHEEL_START_BLOCK"), "63999990");
    assert.equal(assignments.get("V2_FLYWHEEL_TOKEN_ADDRESS"), address(10));
    assert.equal(assignments.get("V2_MAKER_VAULT"), address(6));
    assert.equal(assignments.get("V2_REWARDS_DISTRIBUTOR"), address(7));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** Render `services` from `registry` into a scratch directory and return each file's text. */
function render(registry, services) {
  const scratch = mkdtempSync(path.join(tmpdir(), "v2-env-"));
  try {
    const result = spawnSync(process.execPath, [
      path.join(ops, "v2-env.mjs"), "--registry", registry, "--out", scratch, "--services", services.join(","),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(services.map((s) => [s, readFileSync(path.join(scratch, `${s}.env`), "utf8")]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The comment line that says where `name` comes from. */
const secretLine = (text, name) => text.split("\n").find((line) => line.startsWith(`# ${name}=<secret: `));

const BOT_SECRETS = { cranker: ["cranker", "CRANKER_PK"], pricer: ["pricer", "PRICER_PK"], "mm-bot": ["quoter", "MM_QUOTER_PK"] };

test("a local dev registry names anvil's dev accounts, never a production mnemonic index or key file", () => {
  // ops/markets/dev.json `_dev`: the dev registry "may not name ANY production wallet, bot key or
  // contract" (06-QUIRKS §G). Before T-477 its env files told the operator to load the PRODUCTION v8
  // keys (mnemonic indices 60-62) because botKey had no dev branch.
  const files = render(path.join(ops, "markets/dev.json"), Object.keys(BOT_SECRETS));
  for (const [service, [bot, variable]] of Object.entries(BOT_SECRETS)) {
    const line = secretLine(files[service], variable);
    assert.ok(line, `${service}.env names ${variable}`);
    assert.doesNotMatch(line, /mnemonic index \d/, `${service}.env ${variable} names a production mnemonic index`);
    assert.doesNotMatch(line, /\.callhouse-keys/, `${service}.env ${variable} names a production key file`);
    assert.match(line, new RegExp(`anvil dev account ops/devnet/lib\\.mjs ROLE_INDEX\\.${bot} \\(address in registry v2\\.bots\\.${bot}\\)`));
  }
});

test("production v8 bot keys live in ~/.callhouse-keys/v8/, and a v7 registry keeps v7's directory", () => {
  // v7 derived indices 50-52 into ~/.callhouse-keys/v2/{cranker,pricer}.env and derive-bot-keys.sh never
  // overwrites a key file, so a v8 line naming that directory points at a v7 key.
  const v8 = render(path.join(ops, "markets/tier1.json"), Object.keys(BOT_SECRETS));
  for (const [service, [bot, variable]] of Object.entries(BOT_SECRETS)) {
    assert.match(secretLine(v8[service], variable), new RegExp(`<secret: ~/\\.callhouse-keys/v8/${bot}\\.env from ops/v2/derive-bot-keys\\.sh`));
  }
  const v7 = render(path.join(ops, "markets/v7-legacy.json"), ["cranker"]);
  assert.match(secretLine(v7.cranker, "CRANKER_PK"), /<secret: ~\/\.callhouse-keys\/v2\/cranker\.env .*mnemonic index 50;/);
});

test("the v8 indexer env names all five Earn, Zap and House variables, as comments rather than empty values", () => {
  // indexer/lib/env.ts reads these five. The registry has no slot for any of them, and a file that
  // simply lacked them is how a go-live indexer came to index no Earn, Zap or House contract with
  // nothing saying so. They cannot be empty ASSIGNMENTS: go-live-v2.sh refuses a service whose env
  // renders any `NAME=` with no value, and with no registry slot that value could never be filled.
  const PERIPHERY = ["V2_EARN_VAULT", "V2_ZAP_HELPER", "V2_EARN_START_BLOCK", "V2_HOUSE_VAULT_FACTORY", "V2_HOUSE_START_BLOCK"];
  for (const registry of ["markets/tier1.json", "markets/dev.json"]) {
    const lines = render(path.join(ops, registry), ["indexer-v2"])["indexer-v2"].split("\n");
    for (const name of PERIPHERY) {
      assert.ok(lines.some((line) => line.startsWith(`# ${name}=<not in the registry: `)),
        `${registry} indexer-v2.env does not name ${name}`);
      assert.ok(!lines.some((line) => line.startsWith(`${name}=`)),
        `${registry} indexer-v2.env renders ${name} as an assignment`);
    }
  }
});
