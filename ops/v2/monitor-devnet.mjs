#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/monitor-devnet.mjs — the devnet gate of ops/v2/monitor.mjs, end to end.
 *
 * In ONE process, so the relay, the Telegram stand-in and anvil are stopped even when a step fails
 * (up.sh's anvil runs in its own session and outlives this process unless step 8 stops it):
 *   1. ops/devnet/up.sh (DEVNET_PORT, CONTRACTS_DIR as up.sh reads them), unless --no-up;
 *   2. the real relay (relay/src/index.ts through tsx) with a Telegram stand-in behind it, so every
 *      alert is proven to pass the relay's own payload validation and to be forwarded;
 *   3. run A: monitor --once against the fresh devnet: exit 0, no finding, nothing sent;
 *   4. provoke: the guardian vetoes TSLA's pending expiry (held), the guardian pauses trading on the
 *      book (an admin event), KeeperRewards' USDG is set to 1 USDG (budget), USDG paused() and
 *      isFrozen(OrderBook) are flipped in storage (found by probing the slots the view reads), time
 *      is warped 2 h past the next expiry with open interest and nobody cranks it (late, snapshot
 *      missed), NVDA's mock feed prints -10 % (round jump; a FALL, so the AutoRoller's call ask stays
 *      out of the money until step 9 provokes it on purpose), and a /health target that does not answer
 *      is added (service down). Then INTERFACE_VERSION 7 (step 4c): the MakerVault's outflow cap is
 *      tightened to what the quoter has already spent (or to 0), and TSLA's market rent goes to 0.
 *      Then the INTERFACE_VERSION 6 wiring, from anvil's admin and spare accounts:
 *        - TSLA's oracle deviation goes to 200 bps, a TSLA series is created on a fresh expiry (it pins 200),
 *          and 150 is restored (two MarketConfigured admin events; that expiry's pin mismatches the registry);
 *        - the OrderBook schedules a 1 % higher seller fee (fee schedule, a rise);
 *        - the payout route of NVDA goes to a pool the registry does not name (the factory's getPool slot for
 *          the 0.30 % tier is pointed at a stand-in first: route changed);
 *        - ChainlinkFeedSource allow-lists the spare account, which pins TSLA's feed for another fresh expiry
 *          (allow-list, a source pre-pin);
 *        - the oracle's clearinghouse pointer goes to the admin, which pins NVDA for a third fresh expiry
 *          (pointer, an oracle pre-pin, pinnedBy the admin; every Clearinghouse pin now reverts NotAuthorized);
 *   5. six empty blocks (past the scan's reorg overlap), then run B: exit 1; each provoked kind is sent
 *      exactly once and reaches Telegram through the relay; the warp also leaves TSLA's mock feed without a
 *      round for more than its heartbeat + 1 h of open 24/5 market (v2_mon_feed_stale, error, once), while
 *      NVDA's, which printed, is not flagged;
 *   6. run C: exit 1; nothing is sent again (dedupe), and the pins check is served from its cache (no pin
 *      or wiring log since run B);
 *   7. USDG's pause bit is restored; run D: exactly one v2_mon_resolved, for v2_mon_usdg_paused;
 *   8. the oracle's pointer is restored; run E: the pins are read again (a ClearinghouseSet log), one alert (the
 *      pointer, warn) and exactly four resolutions, the blocked pins; pinnedBy and the mismatched pin stay open;
 *   9. INTERFACE_VERSION 7 (c16): trading is unpaused, the chain is warped to 10:00 New York of the next regular
 *      session, every mock feed prints there, ben is rolled again (the seed's roll expired at step 4's warp) and
 *      NVDA then prints just past the new ask's strike. Run F starts the clock and pages nothing (one pass over the
 *      strike is not evidence); 3 minutes are warped; run G pages v2_mon_roller_ask_overtaken once, as an error,
 *      because nothing called the permissionless cancelStale; a key with no role calls it, and run H resolves;
 *  10. the relay and the stand-in stop, and ops/devnet/down.sh stops anvil (unless --keep).
 * Prints MONITOR DEVNET GATE PASSED and exits 0, or names the failed expectation and exits 1.
 *
 *   DEVNET_PORT=8546 CONTRACTS_DIR=../callhouse-contracts node ops/v2/monitor-devnet.mjs
 *   node ops/v2/monitor-devnet.mjs --no-up --keep      # against a devnet already up (same checkout)
 *
 * Keys: none. Transactions come from anvil's unlocked dev accounts (ops/devnet/lib.mjs); the relay
 * token is random per run and never printed. Reports land in ops/v2/state/monitor-devnet/ (gitignored).
 * ------------------------------------------------------------------------------------------------- */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const NO_UP = argv.includes("--no-up");
for (const a of argv) {
  if (a !== "--keep" && a !== "--no-up") {
    process.stderr.write(`usage: node ops/v2/monitor-devnet.mjs [--no-up] [--keep] (unknown argument ${a})\n`);
    process.exit(2);
  }
}
process.env.DEVNET_PORT ??= "8546";
const PORT = process.env.DEVNET_PORT;
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = path.join(HERE, "state", "monitor-devnet");
const REGISTRY = path.join(ROOT, "ops", "devnet", "tier1.devnet.json");
const MONITOR = path.join(HERE, "monitor.mjs");

function fail(message, code = 1) {
  process.stderr.write(`MONITOR DEVNET GATE FAILED: ${message}\n`);
  process.exitCode = code;
  throw new GateError(message);
}
class GateError extends Error {}
const say = (line) => process.stdout.write(`${line}\n`);
const expect = (cond, message) => {
  if (!cond) fail(message);
  say(`  ok  ${message}`);
};

function spawnLogged(cmd, args, options, logFile) {
  return new Promise((resolve) => {
    const fd = openSync(logFile, "w");
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", fd, fd] });
    child.on("close", (code) => {
      closeSync(fd);
      resolve(code);
    });
  });
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

let relay = null;
let telegram = null;
let devnetUp = false;
const texts = [];

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /* ---- 1. devnet ---- */
  if (!NO_UP) {
    say(`== ops/devnet/up.sh on port ${PORT} (log ${path.relative(ROOT, path.join(OUT, "up.log"))})`);
    const t0 = Date.now();
    devnetUp = true;
    const code = await spawnLogged(path.join(ROOT, "ops", "devnet", "up.sh"), [], { env: process.env, cwd: ROOT }, path.join(OUT, "up.log"));
    if (code !== 0) {
      const tail = readFileSync(path.join(OUT, "up.log"), "utf8").split("\n").slice(-25).join("\n");
      fail(`up.sh exited ${code}:\n${tail}`);
    }
    say(`  devnet up in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  const lib = await import("../devnet/lib.mjs");
  const { ABI, deal, devAccounts, loadAddresses, read, rpc, send, viem, warpTo, now } = lib;
  const { encodeFunctionData, pad, toHex, getAddress } = viem;
  const A = loadAddresses();
  const acct = await devAccounts();
  const C = A.contracts;
  const NVDA = A.markets.find((m) => m.ticker === "NVDA");
  const TSLA = A.markets.find((m) => m.ticker === "TSLA");
  if (!NVDA || !TSLA) fail("addresses.json lacks NVDA or TSLA");

  /* ---- 2. relay + Telegram stand-in ---- */
  const tgPort = await freePort();
  telegram = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        texts.push(JSON.parse(body).text);
      } catch {
        texts.push(null);
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{}}');
    });
  });
  await new Promise((r) => telegram.listen(tgPort, "127.0.0.1", r));
  const relayPort = await freePort();
  const token = randomBytes(32).toString("hex");
  const tsx = path.join(ROOT, "relay", "node_modules", ".bin", "tsx");
  const relayLog = openSync(path.join(OUT, "relay.log"), "w");
  relay = spawn(tsx, ["src/index.ts"], {
    cwd: path.join(ROOT, "relay"),
    env: { PATH: process.env.PATH, PORT: String(relayPort), RELAY_TOKEN: token, TELEGRAM_BOT_TOKEN: "4663:devnet-monitor-gate", TELEGRAM_CHAT_ID: "-1004663", TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}` },
    stdio: ["ignore", relayLog, relayLog],
  });
  let relayUp = false;
  for (let i = 0; i < 100 && !relayUp; i += 1) {
    try {
      relayUp = (await fetch(`http://127.0.0.1:${relayPort}/health`)).ok;
    } catch {
      await sleep(200);
    }
  }
  if (!relayUp) fail("the relay did not answer /health (relay.log)");
  say(`== relay on ${relayPort} (Telegram stand-in on ${tgPort})`);

  const ghostPort = await freePort();
  const stateFile = path.join(OUT, "monitor-state.json");
  const baseArgs = ["--once", "--json", "--rpc", RPC, "--registry", REGISTRY, "--state", stateFile, "--health", `relay=http://127.0.0.1:${relayPort}/health`];
  const runMonitor = (label, extra = []) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [MONITOR, ...baseArgs, ...extra], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, ALERT_WEBHOOK: `http://127.0.0.1:${relayPort}/alert`, ALERT_WEBHOOK_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        writeFileSync(path.join(OUT, `run-${label}.json`), out);
        let report = null;
        try {
          report = JSON.parse(out);
        } catch {
          resolve({ code, report: null, err });
          return;
        }
        say(`\n== run ${label}: exit ${code}; ${report.findings.length} finding(s), ${report.sent.length} sent, ${report.resolved.length} resolved`);
        for (const [name, c] of Object.entries(report.checks)) say(`  [${c.status.padEnd(10)}] ${name.padEnd(10)} ${c.detail}`);
        for (const n of report.notes) say(`  note: ${n}`);
        for (const f of report.findings) say(`  FIND ${f.severity.padEnd(5)} ${f.id}`);
        for (const s of report.sent) say(`  SENT ${s.reason.padEnd(9)} ${s.severity.padEnd(5)} ${s.id} delivered=${s.delivered}`);
        for (const s of report.resolved) say(`  RESOLVED ${s.resolvedKind} delivered=${s.delivered}`);
        resolve({ code, report });
      });
    });

  const mustRun = async (label, extra) => {
    const r = await runMonitor(label, extra);
    if (r.report === null) fail(`run ${label}: exit ${r.code}, no JSON report; stderr: ${r.err.slice(0, 600)}`);
    return r;
  };

  /* ---- 3. run A: clean ---- */
  const a = await mustRun("A");
  expect(a.code === 0, "run A exits 0 against the fresh devnet");
  expect(a.report.findings.length === 0 && a.report.sent.length === 0, "run A has no finding and sends nothing");
  expect(a.report.incompleteChecks.length === 0, "run A completes every check");
  for (const name of ["scan", "settlement", "backlog", "rewards", "vault", "roller", "rent", "config", "fees", "pins", "feeds", "tokens", "usdg", "pools", "head", "health"]) {
    expect(a.report.checks[name]?.status === "ok", `run A check ${name} ran (not skipped)`);
  }
  expect(texts.length === 0, "nothing reached Telegram");
  // INTERFACE_VERSION 7. Run A having nothing to say about rent is the positive result: the monitor decoded the
  // devnet's real SeriesCreated / Minted / Closed / MintFeesAccrued logs and the three add up on every series. A
  // monitor still on the v6 event signatures decodes none of them, so the detail would say 0 ledgers.
  const ledgers = Number(/^(\d+) series' rent ledgers/.exec(a.report.checks.rent.detail)?.[1] ?? 0);
  expect(ledgers > 0, `run A checked the rent ledger of ${ledgers} series from the chain's own logs, and they all add up`);
  expect(/\bNVDA \d+ ppm/.test(a.report.checks.rent.detail) && !/NVDA 0 ppm/.test(a.report.checks.rent.detail), "run A reads a non-zero MarketConfig.mintFeePpm for NVDA (the v7 market() tuple decodes)");
  expect(/[1-9]\d* rolled position/.test(a.report.checks.roller.detail), `run A tracks the seeded AutoRoller position: ${a.report.checks.roller.detail}`);

  /* ---- 4. provoke ---- */
  say("\n== provoking");
  const E1 = A.seed.settle.expiry;
  await send(acct.guardian, { address: C.settlementOracle, abi: ABI.oracle, functionName: "veto", args: [TSLA.underlying, E1], label: "veto TSLA" });
  const tslaInfo = await read(C.settlementOracle, ABI.oracle, "settlementInfo", [TSLA.underlying, E1]);
  expect(Number(tslaInfo[0]) === 3, `guardian vetoed TSLA expiry ${E1}: status Held`);

  await send(acct.guardian, { address: C.orderBook, abi: ABI.orderBook, functionName: "setTradingPaused", args: [true], label: "pause trading" });
  expect((await read(C.orderBook, ABI.orderBook, "tradingPaused")) === true, "guardian paused trading on the OrderBook (TradingPausedSet)");

  const how = await deal(A.usdg, C.keeperRewards, 1_000_000n);
  expect((await read(A.usdg, ABI.erc20, "balanceOf", [C.keeperRewards])) === 1_000_000n, `KeeperRewards USDG set to 1.00 (${how})`);

  const usdgAbi = viem.parseAbi(["function paused() view returns (bool)", "function isFrozen(address account) view returns (bool)"]);
  const probe = async (functionName, args) => {
    const data = encodeFunctionData({ abi: usdgAbi, functionName, args });
    const { accessList } = await rpc("eth_createAccessList", [{ to: A.usdg, data }, "latest"]);
    const slots = accessList.filter((x) => getAddress(x.address) === getAddress(A.usdg)).flatMap((x) => x.storageKeys).reverse();
    const bits = [0, ...Array.from({ length: 96 }, (_, i) => 160 + i), ...Array.from({ length: 159 }, (_, i) => 1 + i)];
    for (const slot of slots) {
      const original = BigInt((await rpc("eth_getStorageAt", [A.usdg, slot, "latest"])) ?? "0x0");
      for (const bit of bits) {
        await rpc("anvil_setStorageAt", [A.usdg, slot, pad(toHex(original ^ (1n << BigInt(bit))), { size: 32 })]);
        let got;
        try {
          got = await read(A.usdg, usdgAbi, functionName, args);
        } catch {
          got = undefined;
        }
        if (got === true) return { slot, bit, original };
      }
      await rpc("anvil_setStorageAt", [A.usdg, slot, pad(toHex(original), { size: 32 })]);
    }
    return null;
  };
  const paused = await probe("paused", []);
  if (paused === null) fail("could not find USDG's paused flag in storage");
  expect((await read(A.usdg, usdgAbi, "paused")) === true, `USDG paused() true (storage slot ${paused.slot.slice(0, 10)}… bit ${paused.bit})`);
  const frozen = await probe("isFrozen", [C.orderBook]);
  if (frozen === null) fail("could not find USDG's freeze flag for the OrderBook in storage");
  expect((await read(A.usdg, usdgAbi, "isFrozen", [C.orderBook])) === true, `USDG isFrozen(OrderBook) true (bit ${frozen.bit})`);
  expect((await read(A.usdg, usdgAbi, "paused")) === true, "USDG still paused after the freeze probe");

  const expiries = [...new Set(A.seed.trade.series.map((s) => s.expiry))].filter((e) => e > E1).sort((x, y) => x - y);
  let E2 = null;
  for (const e of expiries) {
    if ((await read(C.clearinghouse, ABI.clearinghouse, "openInterest", [NVDA.underlying, e])) > 0n) {
      E2 = e;
      break;
    }
  }
  if (E2 === null) fail("no later NVDA expiry with open interest in the seed");
  const tslaOi = await read(C.clearinghouse, ABI.clearinghouse, "openInterest", [TSLA.underlying, E2]);
  const warped = await warpTo(E2 + 7200 + 60);
  expect(warped >= E2 + 7260, `warped to ${warped} = NVDA expiry ${E2} + ${warped - E2} s with nobody cranking (TSLA open interest there: ${tslaOi})`);

  const feedPrice = (raw) => `${raw / 10n ** 8n}.${(raw % 10n ** 8n).toString().padStart(8, "0")}`;
  const printNvda = async (raw, label, log = "set-feed.log") => {
    const code = await spawnLogged(process.execPath, [path.join(ROOT, "ops", "devnet", "set-feed.mjs"), "NVDA", "--price", feedPrice(raw)], { env: process.env, cwd: ROOT }, path.join(OUT, log));
    expect(code === 0, `NVDA mock feed printed ${feedPrice(raw)} (${label})`);
  };
  const [, answer] = await read(NVDA.feed, ABI.mockFeed, "latestRoundData");
  // A FALL, not a rise: it trips the round-jump check the same way (the check is direction-blind) and leaves ben's
  // AutoRoller call ask, struck 5 % above the roll's spot, comfortably out of the money. Step 9 provokes that on
  // purpose, after every assertion that counts what the monitor sends.
  await printNvda((answer * 90n) / 100n, "-10.00 % on the previous round");

  /* ---- 4b. INTERFACE_VERSION 6: pins, allow-lists, pointer, fee schedule, route ---- */
  say("\n== provoking the INTERFACE_VERSION 6 wiring");
  const same = (x, y) => getAddress(x) === getAddress(y);
  const S = C.sources;
  const seeded = new Set(A.seed.trade.series.map((s) => Number(s.expiry)));
  let cursor = Math.max((await now()) + 3 * 3600, ...seeded);
  const freshExpiry = async () => {
    for (let i = 0; i < 30; i += 1) {
      cursor = Number(await read(C.expiryCalendar, ABI.calendar, "nextExpiry", [cursor, false]));
      if (!seeded.has(cursor) && same(await read(C.settlementOracle, ABI.oracle, "pinnedBy", [NVDA.underlying, cursor]), ZERO_ADDRESS) && same(await read(C.settlementOracle, ABI.oracle, "pinnedBy", [TSLA.underlying, cursor]), ZERO_ADDRESS)) return cursor;
    }
    return fail("no unpinned expiry after the seeded ones");
  };
  const E_MISMATCH = await freshExpiry();
  const E_SOURCE_PIN = await freshExpiry();
  const E_ORACLE_PIN = await freshExpiry();

  const tslaCfg = await read(C.settlementOracle, ABI.oracle, "marketConfig", [TSLA.underlying]);
  const tslaRow = await read(C.clearinghouse, ABI.clearinghouse, "market", [TSLA.underlying]);
  const [, tslaAnswer] = await read(TSLA.feed, ABI.mockFeed, "latestRoundData");
  const tick = BigInt(tslaRow.strikeTick);
  const strike = (BigInt(tslaAnswer) / 100n / tick) * tick || tick;
  await send(acct.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "setMarket", args: [TSLA.underlying, tslaCfg[0], 200, tslaCfg[2], tslaCfg[3]], label: "setMarket TSLA 200 bps" });
  await send(acct.spare, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [TSLA.underlying, false, strike, E_MISMATCH], label: "createSeries TSLA" });
  await send(acct.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "setMarket", args: [TSLA.underlying, tslaCfg[0], tslaCfg[1], tslaCfg[2], tslaCfg[3]], label: "setMarket TSLA restored" });
  const mismatch = await read(C.settlementOracle, ABI.oracle, "settlementConfig", [TSLA.underlying, E_MISMATCH]);
  expect(mismatch[0] === true && Number(mismatch[2]) === 200 && Number((await read(C.settlementOracle, ABI.oracle, "marketConfig", [TSLA.underlying]))[1]) === Number(tslaCfg[1]), `TSLA series on ${E_MISMATCH} pinned 200 bps while the market was briefly changed; the market is back at ${tslaCfg[1]}`);

  const fees = await read(C.orderBook, ABI.orderBook, "feeParams");
  await send(acct.admin, { address: C.orderBook, abi: ABI.orderBook, functionName: "setFeeParams", args: [{ ...fees, premiumFeeBps: fees.premiumFeeBps + 100 }], label: "setFeeParams (seller fee +1 %)" });
  const [, feeAt] = await read(C.orderBook, ABI.orderBook, "pendingFeeParams");
  expect(Number(feeAt) > 0, `OrderBook schedules seller fee ${fees.premiumFeeBps + 100} bps for ${feeAt}`);

  // v8: the PayoutRouter validates its own route against an initialised pool, so the v7 stand-in
  // misdirection no longer applies. Prove the routes() tuple decodes the ROUTER shape: venue first,
  // v3Pool fourth - and that the router names the registry's pool.
  await send(acct.admin, { address: C.payoutAdapter, abi: ABI.payoutAdapter, functionName: "setRouteV3", args: [NVDA.underlying, 3000], label: "setRouteV3 NVDA 3000" });
  const nvdaRoute = await read(C.payoutAdapter, ABI.payoutAdapter, "routes", [NVDA.underlying]);
  expect(Number(nvdaRoute.venue) === 1, "NVDA's payout route is venue 1 (v3)");
  expect(Number(nvdaRoute.fee) === 3000, "NVDA's payout route fee is 3000 (30 bps)");
  expect(same(nvdaRoute.v3Pool, NVDA.pool), "the router names the registry's NVDA pool (RouteSet)");

  await send(acct.admin, { address: S.chainlink, abi: ABI.chainlink, functionName: "setOracle", args: [acct.spare, true], label: "chainlink.setOracle(spare, true)" });
  await send(acct.spare, { address: S.chainlink, abi: ABI.chainlink, functionName: "pin", args: [TSLA.underlying, E_SOURCE_PIN], label: "chainlink.pin(TSLA) by the spare account" });
  expect((await read(S.chainlink, ABI.chainlink, "pinnedFeeds", [TSLA.underlying, E_SOURCE_PIN]))[3] === true, `ChainlinkFeedSource allow-lists the spare account, which pinned TSLA's feed for ${E_SOURCE_PIN} (no oracle pin, no series)`);

  await send(acct.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "setClearinghouse", args: [acct.admin], label: "oracle.setClearinghouse(admin)" });
  await send(acct.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "pin", args: [NVDA.underlying, E_ORACLE_PIN], label: "oracle.pin(NVDA) by the admin" });
  expect(same(await read(C.settlementOracle, ABI.oracle, "pinnedBy", [NVDA.underlying, E_ORACLE_PIN]), acct.admin), `the oracle's pointer is the admin, which pinned NVDA for ${E_ORACLE_PIN} (pinnedBy the admin, no series)`);

  /* ---- 4c. INTERFACE_VERSION 7: the outflow cap and a market's writer rent ---- */
  say("\n== provoking the INTERFACE_VERSION 7 conditions");
  // The cap: tightened to just above what the quoter has already paid out net, so used is 95 % of it (error). A
  // devnet whose vault has spent nothing net gets a cap of 0, the spend freeze of incident-v2.md §4c (warn). Both
  // go through setLimits, whose tuple is six fields in v7: a five-field call does not even encode.
  const limitsBefore = await read(C.makerVault, ABI.makerVault, "limits");
  const [usedBefore] = await read(C.makerVault, ABI.makerVault, "outflow");
  const tightCap = usedBefore > 0n ? (usedBefore * 100n) / 95n : 0n;
  await send(acct.admin, { address: C.makerVault, abi: ABI.makerVault, functionName: "setLimits", args: [{ ...limitsBefore, maxDailyOutflow: tightCap }], label: `setLimits maxDailyOutflow ${tightCap}` });
  const [usedAfter, availableAfter] = await read(C.makerVault, ABI.makerVault, "outflow");
  const outflowFrozen = tightCap === 0n;
  expect(
    BigInt((await read(C.makerVault, ABI.makerVault, "limits")).maxDailyOutflow) === tightCap && usedAfter === usedBefore,
    `MakerVault 24 h outflow cap set to ${tightCap} with ${usedAfter} used and ${availableAfter} left (${outflowFrozen ? "a spend freeze: the quoter has paid out nothing net yet" : "95 % of the cap"}); setLimits never refills time that has passed`,
  );

  // Writer rent at 0 on a live market is the runtime twin of the deploy blocker (DECISIONS-2026-09-17 §11): with the
  // primary premium fee at 0 that market charges its writers nothing at all.
  const tslaMarket = await read(C.clearinghouse, ABI.clearinghouse, "market", [TSLA.underlying]);
  expect(Number(tslaMarket.mintFeePpm) > 0, `TSLA is registered at ${tslaMarket.mintFeePpm} ppm of writer rent`);
  await send(acct.admin, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setMarketConfig", args: [TSLA.underlying, { ...tslaMarket, mintFeePpm: 0 }], label: "setMarketConfig TSLA mintFeePpm 0" });
  expect(Number((await read(C.clearinghouse, ABI.clearinghouse, "market", [TSLA.underlying])).mintFeePpm) === 0, "TSLA's market now charges writers no rent (MarketConfigSet, six-field config)");

  // Six empty blocks: run C's scan re-reads the last five blocks run B saw (the reorg overlap), which must not
  // hold the provoking logs if run C is to show the pins cache at work.
  for (let i = 0; i < 6; i += 1) await rpc("evm_mine");
  say(`  chain time now ${await now()}`);

  /* ---- 5. run B ---- */
  const ghost = ["--health", `ghost=http://127.0.0.1:${ghostPort}/health`];
  const b = await mustRun("B", ghost);
  expect(b.code === 1, "run B exits 1 (findings open)");
  const sentB = b.report.sent;
  const ids = sentB.map((s) => s.id);
  expect(new Set(ids).size === ids.length, "run B sends no id twice");
  expect(sentB.every((s) => s.delivered && s.reason === "new"), "run B: every alert is new and the relay accepted it");
  const count = (kind, pred = () => true) => sentB.filter((s) => s.kind === kind && pred(s)).length;
  const lc = (x) => x.toLowerCase();
  expect(count("v2_mon_settlement_held", (s) => s.id === `v2_mon_settlement_held:${lc(TSLA.underlying)}:${E1}`) === 1, "held: TSLA expiry sent once");
  expect(count("v2_mon_config_changed", (s) => /\.TradingPausedSet\(/.test(s.message)) === 1, "admin event: TradingPausedSet sent once");
  expect(count("v2_mon_config_changed", (s) => /\.SettlementVetoed\(/.test(s.message)) === 1, "guardian event: SettlementVetoed sent once");
  expect(count("v2_mon_config_changed", (s) => /\.MarketConfigured\(/.test(s.message) && s.severity === "error") === 2, "admin events: both MarketConfigured sent once each, as error");
  // v7: the two config events whose tuples grew a field. Decoding them at all proves the new topic0s and the new
  // six-field payloads; a monitor on the v6 strings sees neither log.
  expect(count("v2_mon_config_changed", (s) => /makerVault\.LimitsSet\(/.test(s.message) && /maxDailyOutflow/.test(s.message) && s.severity === "warn") === 1, "v7: MakerVault.LimitsSet with its sixth field sent once, as warn");
  expect(count("v2_mon_config_changed", (s) => /clearinghouse\.MarketConfigSet\(/.test(s.message) && /mintFeePpm/.test(s.message) && s.severity === "error") === 1, "v7: Clearinghouse.MarketConfigSet with mintFeePpm sent once, as error");
  expect(count("v2_mon_config_changed") === 6, "no other admin event reaches the generic kind (the v6 wiring has its own)");
  expect(
    count("v2_mon_vault_outflow", (s) => s.id === `v2_mon_vault_outflow:${lc(C.makerVault)}:${outflowFrozen ? "frozen" : "outflow"}` && s.severity === (outflowFrozen ? "warn" : "error")) === 1 && count("v2_mon_vault_outflow") === 1,
    `v7: the MakerVault outflow cap sent once, as ${outflowFrozen ? "warn (the spend freeze)" : "error (95 % of the cap used)"}`,
  );
  expect(
    count("v2_mon_mint_fee_zero", (s) => s.id === `v2_mon_mint_fee_zero:${lc(TSLA.underlying)}:chain` && s.severity === "error") === 1 && count("v2_mon_mint_fee_zero") === 1,
    "v7: TSLA charging writers no rent sent once, as error (NVDA's own rate is untouched, so nothing pages for it)",
  );
  expect(count("v2_mon_mint_rent") === 0, "v7: no rent ledger of the devnet's own mints, closes and settlements disagrees");
  expect(count("v2_mon_roller_ask_overtaken") === 0, "v7: ben's roll ask is out of the money after the fall; step 9 provokes it");
  expect(count("v2_mon_fee_scheduled", (s) => s.severity === "error" && /RAISES premiumFeeBps/.test(s.message)) === 1, "fee schedule: the seller fee rise sent once as error");
  expect(count("v2_mon_fee_change_pending") === 0, "no fee_change_pending: the schedule's own alert announced it");
  expect(count("v2_mon_route_changed", (s) => s.severity === "error") === 1, "route changed: NVDA through a pool the registry does not name, sent once as error");
  expect(count("v2_mon_oracle_allowlist", (s) => s.severity === "error") === 1, "allow-list: ChainlinkFeedSource.OracleSet(spare, true) sent once as error");
  expect(count("v2_mon_oracle_clearinghouse", (s) => s.severity === "error") === 1, "pointer: SettlementOracle.ClearinghouseSet(admin) sent once as error");
  expect(count("v2_mon_pre_pin", (s) => /settlementOracle\.SettlementConfigPinned\(/.test(s.message)) === 1 && count("v2_mon_pre_pin", (s) => /ChainlinkFeedSource\.FeedPinned\(/.test(s.message)) === 1 && count("v2_mon_pre_pin") === 2, "pre-pin: the admin's oracle pin and the spare's Chainlink pin, each once (the oracle pin's own source pins do not page again)");
  expect(count("v2_mon_pinned_by", (s) => s.id === `v2_mon_pinned_by:${lc(NVDA.underlying)}:${E_ORACLE_PIN}`) === 1 && count("v2_mon_pinned_by") === 1, "pinnedBy: NVDA's admin pin sent once");
  const blockedIds = [`${lc(NVDA.underlying)}:unpinned`, `${lc(TSLA.underlying)}:unpinned`, `${lc(NVDA.underlying)}:${E_ORACLE_PIN}`, `${lc(TSLA.underlying)}:${E_SOURCE_PIN}`].map((k) => `v2_mon_pin_blocked:${k}`);
  const blockedB = sentB.filter((s) => s.kind === "v2_mon_pin_blocked");
  expect(blockedB.length === 4 && blockedIds.every((id) => blockedB.some((s) => s.id === id && /NotAuthorized/.test(s.message))), "pin blocked (NotAuthorized): every unpinned expiry of NVDA and of TSLA, NVDA's admin-pinned and TSLA's source-pinned expiry, each once");
  expect(count("v2_mon_pin_mismatch", (s) => s.id === `v2_mon_pin_mismatch:${lc(TSLA.underlying)}:${E_MISMATCH}` && /maxDeviationBps 200 instead of 150/.test(s.message)) === 1 && count("v2_mon_pin_mismatch") === 1, "pin mismatch: TSLA's 200 bps pin sent once");
  expect(count("v2_mon_rewards_budget_low") === 1, "KeeperRewards budget low sent once");
  expect(count("v2_mon_usdg_paused") === 1, "USDG paused sent once");
  expect(count("v2_mon_usdg_frozen", (s) => s.id === `v2_mon_usdg_frozen:${lc(C.orderBook)}` && s.severity === "error") === 1, "USDG isFrozen(OrderBook) sent once as error");
  expect(count("v2_mon_settlement_late", (s) => s.id === `v2_mon_settlement_late:${lc(NVDA.underlying)}:${E2}` && s.severity === "error") === 1, "late: NVDA expiry 2 h past, no candidate, sent once as error");
  expect(count("v2_mon_snapshot_missed", (s) => s.id === `v2_mon_snapshot_missed:${lc(NVDA.underlying)}:${E2}`) === 1, "snapshot missed: NVDA expiry sent once");
  expect(count("v2_mon_feed_round_jump") === 1, "round jump: NVDA mock feed sent once");
  expect(count("v2_mon_service_down", (s) => s.id === "v2_mon_service_down:ghost") === 1, "service down: ghost /health sent once");
  // The feed heartbeat rule (ops/deploy.md §15.13, ops/alerts.md §V44), not the oracle's spot age. NVDA's mock feed
  // printed at the warp. TSLA's last round is the seed's settlement print at E1, so the warp to E2 + 2 h leaves it
  // without a round for a trading day plus 2 h of open 24/5 market: past the registry heartbeat + feedStaleMarginS.
  // The age is counted in open-market seconds on run B's own head (the monitor's calendar, unit-tested against the
  // measured rounds); only a holiday early close between the two expiries could keep it under the limit.
  const mon = await import("./monitor.mjs");
  const [, , , tslaUpdatedAt] = await read(TSLA.feed, ABI.mockFeed, "latestRoundData");
  const tslaHeartbeatS = JSON.parse(readFileSync(REGISTRY, "utf8")).markets.find((m) => m.ticker === "TSLA")?.feedHeartbeatS ?? mon.FEED_HEARTBEAT_S;
  const tslaOpenAgeS = mon.openMarketSeconds(Number(tslaUpdatedAt), Number(b.report.head.timestamp));
  const staleLimitS = tslaHeartbeatS + mon.DEFAULTS.feedStaleMarginS;
  const staleOf = (feed) => sentB.filter((s) => s.id === `v2_mon_feed_stale:${lc(feed)}`);
  expect(staleOf(NVDA.feed).length === 0, "feed stale: nothing for NVDA's feed, which printed at the warp");
  const tslaStale = tslaOpenAgeS > staleLimitS;
  if (tslaStale) {
    expect(staleOf(TSLA.feed).length === 1 && staleOf(TSLA.feed)[0].severity === "error" && count("v2_mon_feed_stale") === 1, `feed stale: TSLA's feed, no round for ${tslaOpenAgeS} s of open market (limit ${staleLimitS} = heartbeat ${tslaHeartbeatS} + ${mon.DEFAULTS.feedStaleMarginS}), sent once as error`);
  } else {
    expect(staleOf(TSLA.feed).every((s) => s.severity !== "error"), `feed stale: TSLA's feed, no round for only ${tslaOpenAgeS} s of open market (limit ${staleLimitS}), is not an error`);
  }
  const provoked = new Set([
    "v2_mon_settlement_held",
    "v2_mon_config_changed",
    "v2_mon_rewards_budget_low",
    "v2_mon_usdg_paused",
    "v2_mon_usdg_frozen",
    "v2_mon_settlement_late",
    "v2_mon_snapshot_missed",
    "v2_mon_feed_round_jump",
    "v2_mon_service_down",
    "v2_mon_fee_scheduled",
    "v2_mon_route_changed",
    "v2_mon_oracle_allowlist",
    "v2_mon_oracle_clearinghouse",
    "v2_mon_pre_pin",
    "v2_mon_pinned_by",
    "v2_mon_pin_blocked",
    "v2_mon_pin_mismatch",
    "v2_mon_vault_outflow",
    "v2_mon_mint_fee_zero",
  ]);
  if (tslaStale) provoked.add("v2_mon_feed_stale");
  const extra = sentB.filter((s) => !provoked.has(s.kind) || (s.kind === "v2_mon_settlement_late" && !s.id.endsWith(`:${E2}`)));
  say(`  also sent (consequences of the warp, not asserted): ${extra.length === 0 ? "none" : extra.map((s) => `${s.id} [${s.severity}]`).join(", ")}`);
  await sleep(300);
  expect(texts.length === sentB.length, `Telegram received ${texts.length} message(s) through the relay, one per alert`);

  /* ---- 6. run C: dedupe ---- */
  const c = await mustRun("C", ghost);
  expect(c.code === 1, "run C exits 1 (the same findings are still open)");
  expect(c.report.sent.length === 0 && c.report.resolved.length === 0, "run C sends nothing: every open finding was already delivered");
  expect(/served from block/.test(c.report.checks.pins?.detail ?? ""), "run C serves the pins check from its cache (no pin or wiring log since run B)");
  const openC = new Set(c.report.findings.map((f) => f.id));
  const conditionsB = b.report.findings.filter((f) => !f.event).map((f) => f.id);
  expect(conditionsB.every((id) => openC.has(id)), `run C still sees all ${conditionsB.length} open conditions of run B`);
  expect(texts.length === sentB.length, "Telegram received nothing more");

  /* ---- 7. run D: one resolution ---- */
  await rpc("anvil_setStorageAt", [A.usdg, paused.slot, pad(toHex(BigInt((await rpc("eth_getStorageAt", [A.usdg, paused.slot, "latest"])) ?? "0x0") ^ (1n << BigInt(paused.bit))), { size: 32 })]);
  expect((await read(A.usdg, usdgAbi, "paused")) === false, "USDG pause bit restored: paused() false");
  expect((await read(A.usdg, usdgAbi, "isFrozen", [C.orderBook])) === true, "the OrderBook stays frozen");
  const d = await mustRun("D", ghost);
  expect(d.code === 1, "run D exits 1 (other findings still open)");
  expect(d.report.sent.length === 0, "run D sends no new alert");
  expect(d.report.resolved.length === 1 && d.report.resolved[0].resolvedKind === "v2_mon_usdg_paused" && d.report.resolved[0].delivered, "run D sends exactly one resolution, for v2_mon_usdg_paused");
  await sleep(300);
  expect(texts.length === sentB.length + 1 && /resolved: USDG paused/.test(texts[texts.length - 1] ?? ""), "Telegram received the resolution");

  /* ---- 8. run E: the pointer restored, the pins read again ---- */
  await send(acct.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "setClearinghouse", args: [C.clearinghouse], label: "oracle.setClearinghouse(clearinghouse)" });
  const e = await mustRun("E", ghost);
  expect(e.code === 1, "run E exits 1 (other findings still open)");
  expect(!/served from block/.test(e.report.checks.pins?.detail ?? "") && e.report.checks.pins?.status === "ok", "run E reads the pins again: the scan saw a ClearinghouseSet");
  expect(e.report.sent.length === 1 && e.report.sent[0].kind === "v2_mon_oracle_clearinghouse" && e.report.sent[0].severity === "warn" && e.report.sent[0].delivered, "run E sends one alert: the pointer back at the live Clearinghouse (warn)");
  const resolvedE = e.report.resolved.map((r) => r.id).sort();
  const wantE = blockedIds.map((id) => `v2_mon_resolved:${id}`).sort();
  expect(resolvedE.length === wantE.length && resolvedE.every((id, i) => id === wantE[i]) && e.report.resolved.every((r) => r.delivered), "run E resolves exactly the four blocked pins (the admin's and the spare's pins equal the current configuration, so the Clearinghouse confirms them)");
  const openE = new Set(e.report.findings.map((f) => f.id));
  expect(openE.has(`v2_mon_pinned_by:${lc(NVDA.underlying)}:${E_ORACLE_PIN}`) && openE.has(`v2_mon_pin_mismatch:${lc(TSLA.underlying)}:${E_MISMATCH}`), "pinnedBy stays the admin's until a series confirms it, and the mismatched pin stays open: it can never change");
  await sleep(300);
  expect(texts.length === sentB.length + 1 + 1 + wantE.length, "Telegram received the alert and the four resolutions");

  /* ---- 9. runs F and G: an AutoRoller ask the market overtook (INTERFACE_VERSION 7, c16) ---- */
  say("\n== provoking an overtaken AutoRoller ask");
  const P = A.seed.trade?.periphery?.autoRoller ?? null;
  let rollerPaged = "skipped";
  if (P === null || !C.autoRoller) {
    say("  this devnet has no AutoRoller strategy (DEV_AUTO_ROLLER=0): the overtaken ask is left to monitor.test.mjs");
  } else {
    // The seed's roll expired at step 4's warp (it warps 2 h past that very expiry), so ben is rolled again: into
    // the next regular session, with trading unpaused and a fresh round on every feed. roll() refuses outside a
    // session, on a stale spot, and — v7 — inside the first ROLL_OPEN_GRACE of a session on a pre-open reading, so
    // 10:00 New York is the target the seed uses too.
    const W = getAddress(P.address);
    const SESSION_S = 23400;
    await send(acct.guardian, { address: C.orderBook, abi: ABI.orderBook, functionName: "setTradingPaused", args: [false], label: "unpause trading (the roller places an ask)" });
    let ts = await now();
    let target = null;
    for (let day = Math.floor(ts / 86400); target === null && day <= Math.floor(ts / 86400) + 10; day += 1) {
      if (!(await read(C.expiryCalendar, ABI.calendar, "isSessionDay", [day]))) continue;
      const tenAm = Number(await read(C.expiryCalendar, ABI.calendar, "closeOf", [day])) - SESSION_S + 1800;
      if (tenAm > ts) target = tenAm;
    }
    if (target === null) {
      say(`  no regular session within 10 days of ${ts}: the overtaken ask is left to monitor.test.mjs`);
    } else {
      ts = await warpTo(target);
      const refresh = await spawnLogged(process.execPath, [path.join(ROOT, "ops", "devnet", "set-feed.mjs"), "--all"], { env: process.env, cwd: ROOT }, path.join(OUT, "set-feed-session.log"));
      expect(refresh === 0, `warped to ${ts}, a regular session, and every mock feed printed a fresh round there`);
      // Twice: the first roll of a finished period only closes it out (settle, redeem, prune the expired ask) and
      // returns true without placing anything; the second one plans and places the new ask.
      let rLongId = 0n;
      let rOrderId = 0n;
      for (let i = 0; i < 2 && rOrderId === 0n; i += 1) {
        const { result: advanced } = await send(acct.cranker, { address: C.autoRoller, abi: ABI.autoRoller, functionName: "roll", args: [W, P.underlying], label: `roll ${P.writer} ${P.ticker} (${i === 0 ? "close out the finished period" : "place the new ask"})` });
        if (advanced !== true) break;
        [rLongId, rOrderId] = await read(C.autoRoller, ABI.autoRoller, "position", [W, P.underlying]);
      }
      if (rOrderId === 0n) {
        say(`  AutoRoller.roll(${P.writer}, ${P.ticker}) placed no ask at ${ts}: the overtaken ask is left to monitor.test.mjs`);
      } else {
        const ser = await read(C.clearinghouse, ABI.clearinghouse, "series", [rLongId]);
        expect(true, `rolled ${P.writer} again: NVDA call ${ser.strike} expiry ${ser.expiry}, AskWrite order ${rOrderId}`);
        // The strike is USDG (6 dp), the mock feed answers at 8. One step of about +5 %, well inside the source's
        // maxRoundJumpBps (20 %), because the roller struck 5 % above the spot it just read.
        const strike8 = BigInt(ser.strike) * 100n;
        await printNvda(strike8 + strike8 / 1000n, `0.1 % ABOVE the ${ser.strike} strike: the ask now sells below intrinsic value`, "set-feed-roller.log");
        const [spotOk, spotPrice] = await read(C.settlementOracle, ABI.oracle, "trySpot", [P.underlying]);
        expect(spotOk === true && spotPrice >= BigInt(ser.strike), `the oracle's spot is ${spotPrice}, at or past the ${ser.strike} strike, and fresh enough for cancelStale`);

        const f = await mustRun("F", ghost);
        expect(f.report.findings.filter((x) => x.kind === "v2_mon_roller_ask_overtaken").length === 0, "run F: one pass over the strike is not evidence, so nothing pages yet");
        expect(/1 at or past the strike/.test(f.report.checks.roller?.detail ?? ""), "run F does see the ask over its strike, and starts the clock");

        await rpc("evm_increaseTime", [180]);
        await rpc("evm_mine");
        const g = await mustRun("G", ghost);
        const overtaken = g.report.sent.filter((s) => s.kind === "v2_mon_roller_ask_overtaken");
        expect(
          overtaken.length === 1 && overtaken[0].id === `v2_mon_roller_ask_overtaken:${lc(W)}:${lc(P.underlying)}` && overtaken[0].severity === "error" && overtaken[0].delivered,
          "run G: the ask nothing cancelled pages once, as error (cancelStale is permissionless and no cranker runs on this devnet)",
        );
        expect(/cancelStale\(writer, underlying\) is permissionless/.test(overtaken[0].message), "and the alert says the cranker's stale step is what should have cancelled it");

        // The fix is one permissionless call from any funded key: incident-v2.md §8 step 1.
        await send(acct.spare, { address: C.autoRoller, abi: ABI.autoRoller, functionName: "cancelStale", args: [W, P.underlying], label: "cancelStale from a key with no role" });
        expect((await read(C.autoRoller, ABI.autoRoller, "position", [W, P.underlying]))[1] === 0n, "a stranger cancelled the ask (StaleAskCancelled); the position keeps its longId and expiry");
        const h = await mustRun("H", ghost);
        expect(
          h.report.resolved.some((r) => r.resolvedKind === "v2_mon_roller_ask_overtaken" && r.delivered) && h.report.findings.every((x) => x.kind !== "v2_mon_roller_ask_overtaken"),
          "run H: the condition resolves once the ask is gone",
        );
        rollerPaged = "paged in run G, resolved in run H";
      }
    }
  }

  say(
    `\nMONITOR DEVNET GATE PASSED: run A clean (exit 0); run B ${sentB.length} alert(s), each once (exit 1); run C deduped (0 sent, pins from cache); run D 1 resolution; run E pins re-read, 1 alert, ${wantE.length} resolutions; overtaken roller ask ${rollerPaged}; ${texts.length} Telegram message(s) through the relay`,
  );
}

async function cleanup() {
  if (relay !== null) relay.kill("SIGTERM");
  if (telegram !== null) telegram.close();
  if (devnetUp && !KEEP) {
    const code = await spawnLogged(path.join(ROOT, "ops", "devnet", "down.sh"), [], { env: process.env, cwd: ROOT }, path.join(OUT, "down.log"));
    say(`== ops/devnet/down.sh exit ${code}`);
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof GateError)) {
    process.stderr.write(`MONITOR DEVNET GATE FAILED: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
