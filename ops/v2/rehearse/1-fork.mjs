#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 1 of the v7 rehearsal: one anvil fork of chain 4663 -> the PRODUCTION deploy path -> a detached node.
 *
 *   a. anvil --fork-url <public RPC> (the fork block anvil pins is recorded) with --code-size-limit 98304
 *   b. INTERFACE_VERSION 8. The tickers are the registry's launchSet.markets (launch-set.mjs; NVDA and SPCX
 *      only), never a literal. ops/markets/tier1.json records the LIVE v8 set, so the
 *      batch is handed a fresh INPUT copy (out/tier1.input.json, launch-set.mjs freshInput): every recorded
 *      deployment field nulled, and the single-source market's pool and payout route nulled, exactly as ops/devnet
 *      does and as callhouse-contracts rehearse-v2.sh CHAINLINK_ONLY does:
 *        dual    (NVDA)  Chainlink + its Uniswap v3 pool (TWAP source), paid out through its payout route canary
 *                        (the registry's v2.payoutRoute, v3 or v4; v9: v3 fee 500)
 *        single  (SPCX)  Chainlink only on this copy, no route (paid in kind): the old META beats        launch set
 *      callhouse-contracts script/v2/DeployV2Batch.sh --rehearse --registry <input copy> --tickers <launch set>
 *      (DeployV8, the externals, RegisterMarkets DIRECT per market, HandBack, VerifyV8; the write-back goes to
 *      out/tier1.rehearsal.json), then DeployV2Batch.sh --verify --expect-fresh true against the copy
 *   c. the ledger gets every deploy and registration transaction with its gas (the batch's forge records)
 *   d. the rehearsal copy: v2.status live for the three markets (a hand step)
 *   e. FEEDS: the last real rounds of each market's Chainlink proxy are read, then MockRoundFeed is etched over the
 *      proxy address and continues that history (lib.mjs etchFeed); a fresh round is printed at the real answer
 *   f. owner funding rehearsed (KeeperRewards 1,000 USDG, the MakerVault's USDG and Stock
 *      Tokens, the quoter's depositToClearinghouse), gas for the bots
 *   g. WARM-UP, then DETACH. The public RPC serves state only ~15 minutes behind its head and a fork reads every
 *      unseen slot at the fork block, so every token path the story needs is touched by a transaction now (deposit
 *      and withdraw of each Stock Token and USDG, a swap each way through the NVDA and TSLA pools, the views the
 *      bots and the monitor read), the node is dumped (anvil_dumpState) and restarted from the dump with no fork
 *      and one block per second (ops/devnet/up.sh's method). Untouched slots read as zero from then on.
 *
 * Writes out/state.json (fork block, contracts, markets, feed history, accounts), out/tier1.rehearsal.json,
 * out/ledger.json, out/state/fork-state.json. Exit 0 = step 1 passed.
 * ------------------------------------------------------------------------------------------------- */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ABI, ANVIL_ACCOUNTS, CONTRACTS_DIR, LOGS, OUT, PORTS, PUBLIC_RPC, REGISTRY, ROLE_INDEX, RPC, SOURCES, RehearsalError, accountOf, deal, devKey,
  encodeFunctionData, etchFeed, expect, fail, getAddress, impersonate, info, ledgerAppend, loadServices, now, patchState, portFree, pub, pushRound,
  read, readJson, rpc, saveState, say, send, setStage, sleep, startService, step, stopService, toHex, until, usd, viem, writeJson, nyTime,
} from "./lib.mjs";
import { NULLED_DEPLOYMENT_FIELDS, NULLED_SINGLE_FIELDS, ROUTE_VENUES, freshInput, payoutRouteIssues, rehearsalRoles } from "./launch-set.mjs";
import { applyHouseRecord } from "../../markets/write-back-v8.mjs";

setStage("1-fork");
const ROLES = rehearsalRoles(readJson(REGISTRY));
const TICKERS = ROLES.tickers;
const INPUT = path.join(OUT, "tier1.input.json");
const COPY = path.join(OUT, "tier1.rehearsal.json");
const STATE_DIR = path.join(OUT, "state");
const HISTORY_ROUNDS = 12;

function run(label, cmd, args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const log = path.join(LOGS, `${label}.log`);
    const fd = openSync(log, "w");
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
    child.on("close", (code) => {
      closeSync(fd);
      resolve({ code, log, text: readFileSync(log, "utf8") });
    });
  });
}

async function main() {
  const t0 = Date.now();
  // The build below and DeployV2Batch.sh compile [profile.default] only. The batch refuses any other
  // FOUNDRY_PROFILE itself (contracts script/v2/lib/default-profile.sh), but only after this build, with the
  // fork's clock already running. Refused here instead, by name, before anything runs: the same rule as stonkctl's
  // rehearsal build, where a set FOUNDRY_PROFILE, even empty, passes only as exactly "default". Never
  // deleted from the environment: a profile set on purpose is the caller's to drop.
  const profile = process.env.FOUNDRY_PROFILE;
  if (profile !== undefined && profile !== "default") {
    fail(`FOUNDRY_PROFILE=${profile} is set in your shell. The rehearsal builds and deploys the contracts with [profile.default] only; unset it (or set FOUNDRY_PROFILE=default) and rerun`);
  }
  step("1a. preconditions and the fork");
  for (const f of [path.join(CONTRACTS_DIR, "script/v2/DeployV2Batch.sh"), path.join(CONTRACTS_DIR, "out/MockRoundFeed.sol/MockRoundFeed.json"), REGISTRY, SOURCES]) {
    if (!existsSync(f)) fail(`missing ${f} (CONTRACTS_DIR=${CONTRACTS_DIR}: a built callhouse-contracts checkout on v2)`);
  }
  if (loadServices().anvil) fail("a rehearsal anvil is recorded in out/services.json: stop it first (node ops/v2/rehearse/stop.mjs)");
  if (!(await portFree(PORTS.anvil))) fail(`port ${PORTS.anvil} is busy`);
  rmSync(COPY, { force: true });
  rmSync(INPUT, { force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  const contractsHead = (await run("1-contracts-head", "/opt/homebrew/bin/git", ["-C", CONTRACTS_DIR, "rev-parse", "HEAD"])).text.trim();
  const registrySha = (await run("1-registry-sha", "shasum", ["-a", "256", REGISTRY])).text.split(" ")[0];
  info(`contracts ${CONTRACTS_DIR} @ ${contractsHead}; registry sha256 ${registrySha}`);
  const source = readJson(REGISTRY);
  expect(source.v2.interfaceVersion === 8, `registry ${path.relative(process.cwd(), REGISTRY)} says v2.interfaceVersion ${source.v2.interfaceVersion} (8 required)`);
  writeJson(INPUT, freshInput(source, ROLES));
  info(`launch set ${TICKERS.join(", ")} (registry launchSet.markets): dual-source ${ROLES.dual}, single-source ${ROLES.single} (its ${NULLED_SINGLE_FIELDS.join(", ")} nulled in the input copy)`);
  info(`input copy ${INPUT}: nulled ${NULLED_DEPLOYMENT_FIELDS.join("; ")}`);

  // Build first: the fork's 15-minute clock starts with anvil. `--skip test`: every forge step the batch runs is a
  // script over src/ + script/; a full build recompiles
  // every test unit (measured there: 17 min against 0.7 s).
  const build = await run("1-forge-build", "forge", ["build", "--skip", "test"], { cwd: CONTRACTS_DIR });
  if (build.code !== 0) fail(`forge build failed (log ${build.log})`);
  const forkBlockArg = process.env.REHEARSE_FORK_BLOCK;
  const anvilArgs = ["--fork-url", PUBLIC_RPC, "--chain-id", "4663", "--port", String(PORTS.anvil), "--code-size-limit", "98304",
    "--retries", "12", "--fork-retry-backoff", "1000", "--timeout", "60000", "--accounts", String(ANVIL_ACCOUNTS)];
  if (forkBlockArg) anvilArgs.push("--fork-block-number", forkBlockArg);
  const forkStartedAt = Date.now();
  startService("anvil", "anvil", anvilArgs, { cwd: CONTRACTS_DIR, port: PORTS.anvil });
  await until("the forked anvil", async () => (await rpc("eth_chainId")) === "0x1237", { timeoutMs: 180_000, intervalMs: 500, service: "anvil" });
  const nodeInfo = await rpc("anvil_nodeInfo");
  const forkBlock = Number(nodeInfo.forkConfig?.forkBlockNumber ?? (await pub.getBlockNumber()));
  const forkTs = await now();
  info(`fork block ${forkBlock} (${nyTime(forkTs)} New York), anvil on ${RPC}`);
  saveState({ createdAt: new Date().toISOString(), contractsDir: CONTRACTS_DIR, contractsHead, registrySha, forkBlock, forkTs, rpc: RPC, checks: [] });

  step("1b. dev accounts as plain EOAs (EIP-7702 code cleared on the fork), gas");
  let cleared = 0;
  for (let i = 0; i < ANVIL_ACCOUNTS; i += 1) {
    const { address } = devKey(i);
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (code && code !== "0x") {
      await rpc("anvil_setCode", [address, "0x"]);
      cleared += 1;
    }
    await rpc("anvil_setBalance", [address, toHex(10n ** 22n)]);
  }
  info(`cleared delegation code of ${cleared} of ${ANVIL_ACCOUNTS} dev accounts; 10,000 ETH each`);
  // A few empty blocks before the deploy: the detached node serves only blocks mined after the fork block, and Ponder
  // reads the parent of V2_START_BLOCK (the deploy block), which must therefore not be the fork block itself.
  for (let i = 0; i < 3; i += 1) await rpc("evm_mine");

  step("1c. DeployV2Batch.sh --rehearse (production scripts: DeployV8, externals, RegisterMarkets DIRECT per market, HandBack, VerifyV8)");
  const batch = await run("1-batch", "bash", [path.join(CONTRACTS_DIR, "script/v2/DeployV2Batch.sh"), "--rehearse", "--rpc", RPC, "--registry", INPUT, "--sources", SOURCES, "--tickers", TICKERS.join(","), "--out", COPY], { cwd: CONTRACTS_DIR });
  for (const line of batch.text.split("\n").filter((l) => /BATCH (PASSED|FAILED)|VERIFY PASSED|recorded: |DEPLOY DONE|REGISTER DONE|rehearsal record|source registry untouched|log directory/.test(l))) info(line.trim());
  expect(batch.code === 0 && /BATCH PASSED \(rehearse\)/.test(batch.text), `DeployV2Batch.sh --rehearse passed for ${TICKERS.join(", ")} (log ${batch.log})`);
  const logDir = /log directory: (\S+)/.exec(batch.text)?.[1];
  if (!logDir) fail("the batch printed no log directory");

  step("1d. VerifyV8 alone against the copy (--verify --expect-fresh true)");
  const verify = await run("1-verify", "bash", [path.join(CONTRACTS_DIR, "script/v2/DeployV2Batch.sh"), "--verify", "--rpc", RPC, "--registry", COPY, "--sources", SOURCES, "--expect-fresh", "true"], { cwd: CONTRACTS_DIR });
  const checks = /VERIFY PASSED: (\d+) checks/.exec(verify.text)?.[1];
  expect(verify.code === 0 && checks !== undefined && !/^\s+FAIL/m.test(verify.text), `VerifyV8 clean: VERIFY PASSED ${checks} checks, no FAIL line (log ${verify.log})`);
  const infoLines = verify.text.split("\n").filter((l) => /^\s+info/.test(l)).map((l) => l.trim());
  for (const l of infoLines) info(l);

  step("1e. ledger: every deploy and registration transaction from the batch's forge records");
  const entries = [];
  const fromRecord = (file, action) => {
    if (!existsSync(file)) return;
    const run = readJson(file);
    for (const tx of run.transactions ?? []) {
      const receipt = (run.receipts ?? []).find((r) => r.transactionHash === tx.hash);
      entries.push({
        step: "1-deploy", action, label: `${tx.transactionType} ${tx.contractName ?? ""}${tx.function ? `.${tx.function.split("(")[0]}` : ""}`.trim(),
        from: tx.transaction?.from ?? null, to: tx.contractAddress ?? tx.transaction?.to ?? null, hash: tx.hash,
        status: receipt?.status === "0x1" ? "success" : "reverted", gasUsed: receipt ? BigInt(receipt.gasUsed).toString() : null,
        block: receipt ? Number(BigInt(receipt.blockNumber)) : null, ts: null,
      });
    }
  };
  fromRecord(path.join(logDir, "deploy-run-latest.json"), "deploy");
  for (const T of TICKERS) fromRecord(path.join(logDir, `${T}-run-latest.json`), `register ${T}`);
  ledgerAppend(entries);
  const deployGas = entries.filter((e) => e.action === "deploy").reduce((a, e) => a + BigInt(e.gasUsed ?? 0), 0n);
  info(`${entries.length} transactions recorded: deploy ${entries.filter((e) => e.action === "deploy").length} (${deployGas} gas); ${TICKERS.map((T) => `${T} ${entries.filter((e) => e.action === `register ${T}`).length}`).join(", ")}`);
  expect(entries.length > 0 && entries.every((e) => e.status === "success"), "every batch transaction succeeded on the fork");

  step("1f. the rehearsal registry copy: markets live (DEPLOY-V2.md step 5)");
  const reg = readJson(COPY);
  reg._readme = `O2-03 REHEARSAL COPY of ops/markets/tier1.json written by DeployV2Batch.sh --rehearse on an anvil fork (ops/v2/rehearse), from the fresh input copy (${ROLES.single}'s pool and route nulled). Never commit, never deploy from it.`;
  expect(reg.v2.interfaceVersion === 8, "the write-back copy says v2.interfaceVersion 8");
  // DeployV2Batch.sh ends with "NEXT STEP, MANDATORY, NOT RUN BY THIS SCRIPT": record flywheel.deployBlock (and the
  // record's wallets) from DeployV8's deploy-record.json, or the keeper refuses the copy ("v2.flywheel.feeSplitter is
  // set but v2.flywheel.deployBlock is null"). The launch tool for that, ops/markets/write-back-v8.mjs, refuses THIS
  // copy by design: its completeness rule requires a payout route on every launch market, and the rehearsal nulls
  // the single market's route on purpose. So the same three slots it writes (write-back-v8.mjs put(): flywheel
  // .deployBlock, shared.feeRecipient = the splitter, v2.bots.guardian = wallets.guardian) are copied here, each
  // only into a null slot or one that already agrees. v2.deployBlock stays the batch's (the core's first block).
  const record = readJson(path.join(logDir, "deploy-record.json"));
  const fill = (label, obj, key, value) => {
    if (value === undefined || value === null) fail(`deploy-record.json has no ${label}`);
    if (obj[key] !== null && obj[key] !== undefined && String(obj[key]).toLowerCase() !== String(value).toLowerCase()) fail(`${label}: the copy holds ${obj[key]}, the deploy record ${value}`);
    obj[key] = value;
  };
  expect(getAddress(record.flywheel.feeSplitter) === getAddress(reg.v2.flywheel.feeSplitter), `deploy-record.json names the copy's FeeSplitter ${reg.v2.flywheel.feeSplitter}`);
  fill("flywheel.deployBlock", reg.v2.flywheel, "deployBlock", record.flywheel.deployBlock);
  fill("shared.feeRecipient", reg.shared, "feeRecipient", record.flywheel.feeSplitter);
  fill("wallets.guardian", reg.v2.bots, "guardian", record.wallets?.guardian);
  info(`from deploy-record.json: v2.flywheel.deployBlock ${reg.v2.flywheel.deployBlock}, shared.feeRecipient ${reg.shared.feeRecipient}, v2.bots.guardian ${reg.v2.bots.guardian}`);
  // The House factory list and each launch market's weekly vault. The launch tool writes
  // them from DeployHouseVault's JSON out (write-back-v8.mjs --house-deployment <file> --house-kind weekly) and refuses
  // this copy for the reason above; its applyHouseRecord is the same mapping without that completeness gate. Pass A
  // deployed the launch factory, pass B created the launch vaults: applied in that order, as the operator would.
  // Without them the copy names House vaults beside an EMPTY factory list (freshInput's fresh shape), and the cranker
  // refuses to boot: house-factory-missing (keeper/src/v2/config.ts houseFactoryBootProblem).
  for (const pass of ["A", "B"]) {
    const house = applyHouseRecord(reg, readJson(path.join(logDir, `externals-house-${pass}.json`)), { kind: "weekly" });
    if (house.conflicts.length) fail(`externals-house-${pass}.json does not apply to the copy: ${house.conflicts.join("; ")}`);
    if (house.pending.length) fail(`externals-house-${pass}.json printed createVault for the Safe instead of sending it: ${house.pending.join(", ")}`);
    info(`from externals-house-${pass}.json (write-back-v8.mjs applyHouseRecord, weekly): ${house.changed.join(", ") || "nothing new"}`);
  }
  const weeklyFactory = reg.v2.house.factories.find((f) => f.kind === "weekly");
  const weeklyVaults = TICKERS.map((T) => reg.markets.find((x) => x.ticker === T).v2);
  expect(weeklyFactory !== undefined && getAddress(weeklyFactory.address) === getAddress(reg.v2.contracts.houseVaultFactory) && weeklyVaults.every((v) => v.house.weekly !== null && getAddress(v.house.weekly) === getAddress(v.houseVault)),
    `v2.house: the weekly factory is v2.contracts.houseVaultFactory ${weeklyFactory?.address} (block ${weeklyFactory?.deployBlock}); each launch market's weekly vault is its houseVault`);
  const C = reg.v2.contracts;
  const sources = readJson(SOURCES);
  const markets = {};
  for (const T of TICKERS) {
    const m = reg.markets.find((x) => x.ticker === T);
    expect(m.v2.registeredAt !== null && m.v2.registerTx !== null, `${T} registered: registerTx ${m.v2.registerTx}`);
    m.v2.status = "live";
    const poolFee = m.v2.univ3Pool ? sources.markets.find((x) => x.ticker === T)?.pools?.find((p) => p.address.toLowerCase() === m.v2.univ3Pool.toLowerCase())?.fee ?? null : null;
    markets[T] = { ticker: T, asset: getAddress(m.asset), feed: getAddress(m.feed), pool: m.v2.univ3Pool ? getAddress(m.v2.univ3Pool) : null, poolFee, payoutRoute: m.v2.payoutRoute ?? null, strikeTick: m.v2.strikeTick, registerTx: m.v2.registerTx, registeredAt: m.v2.registeredAt };
  }
  writeJson(COPY, reg);
  // A null key is a contract this run does not deploy (the owner's externals window: hedger, rewardsDistributorLender,
  // stockVenueAdapter). It is kept out of `contracts` and listed, never checksummed as an address.
  const undeployed = Object.entries(C).filter(([k, v]) => k !== "sources" && v === null).map(([k]) => k);
  const contracts = { ...Object.fromEntries(Object.entries(C).filter(([k, v]) => k !== "sources" && v !== null).map(([k, v]) => [k, getAddress(v)])), sources: Object.fromEntries(Object.entries(C.sources).map(([k, v]) => [k, getAddress(v)])) };
  info(`not deployed by this run: ${undeployed.join(", ") || "none"}`);
  const admin = getAddress(reg.shared.admin);
  const guardian = getAddress(reg.shared.guardian);
  const usdg = getAddress(reg.shared.usdg);
  // INTERFACE_VERSION 8 renamed the quoter key (v2.bots.quoter; DeployV2Batch.sh reads `bot quoter`). The rehearsal's
  // role name stays mmQuoter (anvil #10).
  const bots = { cranker: getAddress(reg.v2.bots.cranker), pricer: getAddress(reg.v2.bots.pricer), mmQuoter: getAddress(reg.v2.bots.quoter) };
  expect(bots.cranker === accountOf("cranker") && bots.pricer === accountOf("pricer") && bots.mmQuoter === accountOf("mmQuoter"), "the batch's bot stand-ins are anvil #8/#9/#10 (cranker, pricer, mmQuoter)");
  step("1f'. payout routes on chain: the dual market's route = the registry's payoutRoute (v3 or v4), none on the single-source market");
  for (const T of TICKERS) {
    const r = await read(contracts.payoutAdapter, ABI.payoutAdapter, "routes", [markets[T].asset]);
    const want = markets[T].payoutRoute;
    const venue = ROUTE_VENUES[Number(r.venue)] ?? String(r.venue);
    // A v3 route is checked by venue and fee (setRouteV3 stores tickSpacing 0), a v4 one also by tickSpacing and poolId.
    const issues = payoutRouteIssues(want, r, { asset: markets[T].asset, usdg });
    const seen = venue === "V4" ? ` tickSpacing ${r.tickSpacing}` : venue === "V3" ? ` pool ${r.v3Pool}` : "";
    if (want) {
      expect(issues.length === 0, `${T} PayoutRouter route ${venue} fee ${r.fee}${seen} = the registry's payoutRoute (${JSON.stringify(want)})${issues.length ? `: ${issues.join("; ")}` : ""}`);
    } else {
      expect(issues.length === 0, `${T} has no PayoutRouter route (venue ${venue}): its ITM longs are paid in kind`);
    }
    markets[T].routeOnChain = { venue, fee: Number(r.fee), tickSpacing: Number(r.tickSpacing), v3Pool: venue === "V3" ? getAddress(r.v3Pool) : null };
  }
  patchState({ registryCopy: COPY, inputCopy: INPUT, roles: { dual: ROLES.dual, single: ROLES.single }, launchSet: TICKERS, nulled: { single: ROLES.single, fields: [...NULLED_SINGLE_FIELDS], deployment: [...NULLED_DEPLOYMENT_FIELDS] },
    interfaceVersion: reg.v2.interfaceVersion, undeployed, deployBlock: reg.v2.deployBlock, contracts, markets, admin, guardian, usdg, bots, batchLogDir: logDir, verifyChecks: Number(checks), verifyInfo: infoLines,
    accounts: Object.fromEntries(Object.keys(ROLE_INDEX).map((r) => [r, accountOf(r)])) });
  for (const [k, v] of Object.entries(contracts)) if (k !== "sources") info(`${k.padEnd(18)} ${v}`);
  info(`sources            chainlink ${contracts.sources.chainlink} univ3 ${contracts.sources.univ3} dataStreams ${contracts.sources.dataStreams}`);

  step("1g. feeds: copy the real round history, etch MockRoundFeed over each proxy, print a fresh round");
  const runtime = readJson(path.join(CONTRACTS_DIR, "out/MockRoundFeed.sol/MockRoundFeed.json")).deployedBytecode.object;
  const history = {};
  for (const T of TICKERS) {
    const feed = markets[T].feed;
    const decimals = Number(await read(feed, ABI.feed, "decimals"));
    const description = await read(feed, ABI.feed, "description");
    const [id, answer, , updatedAt] = await read(feed, ABI.feed, "latestRoundData");
    const rounds = [{ id: id.toString(), answer: answer.toString(), updatedAt: Number(updatedAt) }];
    for (let k = 1n; k < BigInt(HISTORY_ROUNDS) && ((id & ((1n << 64n) - 1n)) - k) >= 1n; k += 1n) {
      const [, a, , u] = await read(feed, ABI.feed, "getRoundData", [id - k]);
      if (u === 0n) break;
      rounds.push({ id: (id - k).toString(), answer: a.toString(), updatedAt: Number(u) });
    }
    history[T] = { feed, decimals, description, rounds };
    info(`${T} ${description}: latest round ${id} answer ${Number(answer) / 10 ** decimals} at ${nyTime(Number(updatedAt))} NY (${Math.round((forkTs - Number(updatedAt)) / 60)} min before the fork), ${rounds.length} rounds read`);
  }
  // Pool state before the etch (the TWAP source does not read feeds).
  const poolsBefore = {};
  for (const T of TICKERS.filter((t) => markets[t].pool)) {
    const [ok, price] = await read(contracts.sources.univ3, ABI.univ3, "latest", [markets[T].asset]);
    poolsBefore[T] = { ok, price: price.toString() };
    info(`${T} pool ${markets[T].pool} (fee ${markets[T].poolFee}): 5-minute TWAP ${ok ? usd(price) : "not ok"} USDG`);
  }
  for (const T of TICKERS) await etchFeed(markets[T].feed, history[T], runtime);
  const t1 = await now();
  for (const T of TICKERS) await pushRound(markets[T].feed, BigInt(history[T].rounds[0].answer), t1, `${T} fresh round at the real answer`);
  for (const T of TICKERS) {
    const [ok, spot] = await read(contracts.settlementOracle, ABI.oracle, "trySpot", [markets[T].asset]);
    expect(ok && spot > 0n, `${T} oracle spot fresh through the etched feed: ${usd(spot)} USDG`);
  }
  patchState({ feedHistory: history, poolsBefore });

  step("1h. owner funding (DEPLOY-V2.md step 6) and the story's balances");
  await impersonate(admin);
  await impersonate(guardian);
  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;
  const bal = (token, who) => read(token, ABI.erc20, "balanceOf", [who]);
  // Admin treasury for the owner steps.
  await deal(usdg, admin, 200_000n * E6, "USDG admin treasury");
  for (const T of TICKERS) await deal(markets[T].asset, admin, 200n * E18, `${T} admin treasury`);
  const KEEPER_FUND = 1_000n * E6;
  await send(admin, { address: usdg, abi: ABI.erc20, functionName: "approve", args: [contracts.keeperRewards, KEEPER_FUND], label: "admin USDG approve KeeperRewards", action: "owner-fund" });
  await send(admin, { address: contracts.keeperRewards, abi: ABI.keeperRewards, functionName: "fund", args: [KEEPER_FUND], label: "KeeperRewards.fund 1,000 USDG", action: "owner-fund" });
  expect((await bal(usdg, contracts.keeperRewards)) === KEEPER_FUND, "KeeperRewards holds 1,000 USDG of bounties");
  const VAULT = { USDG: 100_000n * E6, [ROLES.dual]: 100n * E18, [ROLES.single]: 50n * E18 };
  for (const [name, amount] of Object.entries(VAULT)) {
    const token = name === "USDG" ? usdg : markets[name].asset;
    await send(admin, { address: token, abi: ABI.erc20, functionName: "approve", args: [contracts.makerVault, amount], label: `admin ${name} approve MakerVault`, action: "owner-fund" });
    await send(admin, { address: contracts.makerVault, abi: ABI.makerVault, functionName: "deposit", args: [token, amount], label: `MakerVault.deposit ${name}`, action: "owner-fund" });
  }
  for (const T of TICKERS) {
    await send(accountOf("mmQuoter"), { address: contracts.makerVault, abi: ABI.makerVault, functionName: "depositToClearinghouse", args: [markets[T].asset, VAULT[T]], label: `quoter depositToClearinghouse ${T}`, action: "owner-fund" });
    expect((await read(contracts.clearinghouse, ABI.clearinghouse, "free", [contracts.makerVault, markets[T].asset])) === VAULT[T], `MakerVault ledger holds ${VAULT[T] / E18} ${T} of write collateral`);
  }
  // The story's wallets: USDG for everyone, Stock Tokens for the writers.
  for (const role of ["ada", "ben", "cy", "dee", "eve", "fay", "gus", "hal", "ivy", "web", "whale"]) await deal(usdg, accountOf(role), 100_000n * E6, `USDG ${role}`);
  for (const role of ["ada", "ben", "whale"]) for (const T of TICKERS) await deal(markets[T].asset, accountOf(role), 50n * E18, `${T} ${role}`);

  step("1i. warm-up: the token, pool and view paths the detached node must keep");
  const whale = accountOf("whale");
  for (const [name, token, amount] of [["USDG", usdg, 10n * E6], ...TICKERS.map((T) => [T, markets[T].asset, E18])]) {
    await send(whale, { address: token, abi: ABI.erc20, functionName: "approve", args: [contracts.clearinghouse, amount], label: `warm ${name} approve`, action: "warm-up" });
    await send(whale, { address: contracts.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [token, amount, whale], label: `warm ${name} deposit`, action: "warm-up" });
    await send(whale, { address: contracts.clearinghouse, abi: ABI.clearinghouse, functionName: "withdraw", args: [token, amount, whale], label: `warm ${name} withdraw`, action: "warm-up" });
  }
  const router = getAddress(reg.v2.uniswapV3.swapRouter02);
  for (const T of TICKERS.filter((t) => markets[t].pool)) {
    const m = markets[T];
    const IN = E18 / 2n;
    await send(whale, { address: m.asset, abi: ABI.erc20, functionName: "approve", args: [contracts.payoutAdapter, IN], label: `warm ${T} approve adapter`, action: "warm-up" });
    const before = await bal(usdg, whale);
    await send(whale, { address: contracts.payoutAdapter, abi: ABI.payoutAdapter, functionName: "swapToUsdg", args: [m.asset, IN, 1n, whale], label: `warm adapter swapToUsdg 0.5 ${T}`, action: "warm-up" });
    const out = (await bal(usdg, whale)) - before;
    await send(whale, { address: usdg, abi: ABI.erc20, functionName: "approve", args: [router, 100n * E6], label: "warm USDG approve router", action: "warm-up" });
    const tBefore = await bal(m.asset, whale);
    await send(whale, { address: router, abi: ABI.swapRouter02, functionName: "exactInputSingle", label: `warm router 100 USDG -> ${T}`, action: "warm-up",
      args: [{ tokenIn: usdg, tokenOut: m.asset, fee: m.poolFee, recipient: whale, amountIn: 100n * E6, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] });
    info(`${T}: adapter 0.5 ${T} -> ${usd(out)} USDG; router 100 USDG -> ${(Number((await bal(m.asset, whale)) - tBefore) / 1e18).toFixed(6)} ${T}`);
  }
  const calls = [];
  const add = (target, abi, functionName, args = []) => calls.push({ target, allowFailure: true, callData: encodeFunctionData({ abi, functionName, args }) });
  const ours = Object.entries(contracts).filter(([k]) => k !== "sources").map(([, v]) => v).concat(Object.values(contracts.sources));
  const people = Object.keys(ROLE_INDEX).map(accountOf);
  for (const t of [usdg, ...TICKERS.map((T) => markets[T].asset)]) {
    for (const fn of ["name", "symbol", "decimals", "totalSupply", "paused", "oraclePaused", "uiMultiplier", "owner", "newUIMultiplier", "effectiveAt"]) add(t, ABI.token, fn);
    for (const who of [...ours, ...people]) add(t, ABI.token, "balanceOf", [who]);
  }
  for (const c of ours) add(usdg, ABI.token, "isFrozen", [c]);
  for (const T of TICKERS) {
    const accessRegistry = await read(markets[T].asset, ABI.token, "ACCESS_CONTROLLED_REGISTRY").catch(() => null);
    if (accessRegistry) for (const who of [...ours, ...people, markets[T].pool].filter(Boolean)) add(accessRegistry, ABI.token, "isBlocked", [who]);
  }
  for (const T of TICKERS.filter((t) => markets[t].pool)) {
    const p = markets[T].pool;
    for (const fn of ["slot0", "liquidity", "token0", "token1", "fee", "tickSpacing"]) add(p, ABI.pool, fn);
    for (const window of [[0], [300, 0], [1800, 0], [3600, 0]]) add(p, ABI.pool, "observe", [window]);
    const slot0 = await read(p, ABI.pool, "slot0");
    add(p, ABI.pool, "observations", [BigInt(slot0[2])]);
    add(contracts.sources.univ3, ABI.univ3, "latest", [markets[T].asset]);
  }
  for (const T of TICKERS) {
    add(contracts.sources.chainlink, ABI.chainlink, "latest", [markets[T].asset]);
    add(contracts.settlementOracle, ABI.oracle, "trySpot", [markets[T].asset]);
  }
  // The registry's Safes (shared.safes.*), for ops/v2/monitor.mjs's safes check (getCode, nonce, getThreshold,
  // getOwners). Nothing else reads them before the detach, so on the detached node the Admin Safe's proxy answered
  // nothing (its singleton slot read zero), the Treasury Safe had no code, and step 4's monitor baseline exited 3 with
  // `safes` incomplete. A call through each proxy fetches its code, its singleton's code and the slots those views read.
  const SAFE_VIEWS = viem.parseAbi(["function nonce() view returns (uint256)", "function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
  // Not `.map(getAddress)`: map passes the index as viem's chainId argument, so every Safe after the first got an
  // EIP-1191 chain-specific checksum that encodeFunctionData then refused as an invalid address.
  const safes = Object.values(reg.shared.safes ?? {}).filter(Boolean).map((a) => getAddress(a));
  for (const safe of safes) for (const fn of ["nonce", "getThreshold", "getOwners"]) add(safe, SAFE_VIEWS, fn);
  const { result } = await send(admin, { address: reg.shared.multicall3, abi: ABI.multicall3, functionName: "aggregate3", args: [calls], label: "warm-up multicall", action: "warm-up" });
  info(`warm-up multicall: ${calls.length} reads, ${result.filter((r) => r.success).length} answered`);
  const forkSeconds = Math.round((Date.now() - forkStartedAt) / 1000);
  info(`fork window used: ${forkSeconds} s of ~900 s`);
  if (forkSeconds > 840) say("  WARNING: the fork window is nearly spent; a later untouched slot may read as zero or fail");

  step("1j. detach: dump the node, restart anvil from the dump with no fork (one block per second)");
  const hex = await rpc("anvil_dumpState");
  const dumpFile = path.join(STATE_DIR, "fork-state.json");
  const json = gunzipSync(Buffer.from(hex.replace(/^0x/, ""), "hex"));
  writeFileSync(dumpFile, json);
  const dumped = JSON.parse(json.toString("utf8"));
  const dumpedTs = Number(BigInt(dumped.block.timestamp));
  info(`dumped ${Object.keys(dumped.accounts).length} accounts, best block ${dumped.best_block_number} -> ${dumpFile}`);
  await stopService("anvil");
  await until(`port ${PORTS.anvil} free`, () => portFree(PORTS.anvil), { timeoutMs: 20_000, intervalMs: 250 });
  startService("anvil", "anvil", ["--load-state", dumpFile, "--chain-id", "4663", "--code-size-limit", "98304", "--block-time", "1", "--port", String(PORTS.anvil), "--accounts", String(ANVIL_ACCOUNTS)], { cwd: OUT, port: PORTS.anvil });
  await until("the detached anvil", async () => (await rpc("eth_chainId")) === "0x1237", { timeoutMs: 120_000, intervalMs: 500, service: "anvil" });
  if ((await now()) < dumpedTs) {
    await rpc("evm_setNextBlockTimestamp", [toHex(dumpedTs + 1)]);
    await rpc("evm_mine");
  }
  await impersonate(admin);
  await impersonate(guardian);
  const client = await rpc("web3_clientVersion");
  const head = await pub.getBlockNumber();
  expect(/anvil/i.test(client) && head >= BigInt(dumped.best_block_number), `detached anvil serves ${RPC} from the dump (head ${head}, chain time ${nyTime(await now())} NY)`);
  for (const T of TICKERS) {
    const [ok, spot] = await read(contracts.settlementOracle, ABI.oracle, "trySpot", [markets[T].asset]);
    expect(ok, `${T} spot still readable on the detached node (${usd(spot)} USDG)`);
  }
  expect((await read(contracts.clearinghouse, ABI.clearinghouse, "free", [contracts.makerVault, markets.NVDA.asset])) === VAULT.NVDA, "Clearinghouse state survived the detach (vault NVDA ledger)");
  for (const safe of safes) {
    const threshold = await read(safe, SAFE_VIEWS, "getThreshold").catch(() => null);
    expect(threshold !== null && threshold > 0n, `Safe ${safe} survived the detach: getThreshold ${threshold} (ops/v2/monitor.mjs's safes check reads it)`);
  }
  patchState({ detached: true, dumpFile, detachedAt: await now(), forkSeconds, step1Seconds: Math.round((Date.now() - t0) / 1000) });
  say(`\nSTEP 1 PASSED: fork block ${forkBlock}, ${TICKERS.join(" + ")} registered by DeployV2Batch.sh --rehearse (v8), VerifyV8 ${checks} checks clean, feeds etched, funded, detached (${Math.round((Date.now() - t0) / 1000)} s)`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nSTEP 1 FAILED: ${error instanceof RehearsalError ? error.message : (error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
