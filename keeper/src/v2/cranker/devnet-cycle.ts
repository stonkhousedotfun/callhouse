/**
 * The cranker's integration test: a real cranker process loop against ops/devnet through two
 * expiries, asserting on-chain end state.
 *
 *   pnpm --filter @callhouse/keeper v2:devnet-cycle
 *   DEVNET_PORT=8552 CONTRACTS_DIR=/path/to/callhouse-contracts pnpm --filter @callhouse/keeper v2:devnet-cycle
 *
 * WHAT RUNS. ops/devnet/up.sh brings up the seeded devnet (the first daily expiry already settled for
 * NVDA by the seed; TSLA's a pending single-source candidate). The cranker is started IN PROCESS with
 * startCranker (the same entry V2_MODE=cranker boots), on the devnet's env/cranker.env, with a dead
 * INDEXER_URL (so every holder and strategy list comes from its own log index: the fallback path)
 * and a 5-minute poll, so anything that happens between the harness's wake() calls is the cranker's
 * own precise wake-up. The harness only moves time (evm_setNextBlockTimestamp), pushes feed rounds
 * (ops/devnet/set-feed.mjs) and, once, trades like a user (an ITM call and a resale ask). Nothing
 * here sends a lifecycle call: every snapshot, finalize, settle, prune, redeem and createSeries is
 * the cranker's.
 *
 *   A  boot            ladders for the next expiries of both markets and tenors exist at spot; the
 *                      seed's settled NVDA expiry is done; TSLA's candidate waits; its orders pruned;
 *                      the settlement pin's gas per market (measureCreateSeriesGas)
 *   B  delay           warp past TSLA's finalizableAt: finalize (single source, after the delay),
 *                      settle, redeem the shorts (the OTM long's zero payout is left alone)
 *   C  expiry e2       (the seed's second daily expiry. It is also the seed's WEEKLY expiry — the two ladders name the
 *                      same series — only when the run starts the day before the weekly; over a weekend gap it is
 *                      Monday and the seed's TSLA interest and resale ask sit on the later weekly instead, so the
 *                      checks that need them are conditioned on the chain, not assumed) an ITM NVDA call
 *                      is minted to a buyer who lists part of it for resale; the settlement window is
 *                      pushed (NVDA at the pool price, TSLA flat); spot is fresh, so ladders for the
 *                      expiries after e2 appear; the harness wakes the cranker a minute before e2 and
 *                      then only waits: the NVDA pool snapshot lands within seconds of e2 (precise
 *                      wake-up); warp past e2 + 120: NVDA finalizes corroborated, settles, BOTH resale
 *                      asks are pruned before the redeem, the ITM long (escrow included) and the shorts
 *                      are paid; warp past TSLA's delay: TSLA settles and its shorts are paid
 *   stale           INTERFACE_VERSION 7 (c16): the NVDA spot is pushed past a live roller ask's strike and the
 *                      cranker withdraws it with AutoRoller.cancelStale — StaleAskCancelled, the position keeps its
 *                      series and expiry with no tracked ask, the fixed gas limit, and the next tick sends nothing
 *   D  end state       every expiry above Finalized, every series with supply settled, no open order
 *                      left on them, the book holds none of their longs, every holder with a non-zero
 *                      payout redeemed; the SQLite journal holds every step's confirmed transactions,
 *                      each createSeries batch and roll under 90 % of its fixed gas limit;
 *                      no v2_error or v2_tx_revert alert.
 *   rolls              with an AutoRoller (the devnet's, or with CYCLE_DEPLOY_ROLLER=1 one deployed here from
 *                      CONTRACTS_DIR's build). The seed's weekly strategy (ben) already holds the position its
 *                      session roll opened (sent from the cranker's key too), so the harness adds a daily NVDA
 *                      strategy for a writer with none (ben on a roller without strategies, else ada). At boot
 *                      (16:02 New York) nothing is rolled: session-closed for the new strategy,
 *                      rolled-this-period for a held position. The pre-expiry tick at 15:58 New York rolls the
 *                      new strategy: a Rolled event from the cranker's key after the cranker started and a
 *                      position past e2; every strategy then holds a live position. Without a roller the
 *                      cranker boots anyway and reports the step skipped.
 *
 * Environment: DEVNET_PORT (default 8546, up.sh's), CONTRACTS_DIR (passed to up.sh), DEVNET_REUSE=1
 * (use the devnet already up on the port: it must be freshly seeded), DEVNET_KEEP=1 (leave anvil
 * running), CYCLE_DEPLOY_ROLLER=1 (see rolls). Output and the cranker's log and database go to a
 * temporary directory printed at start. Exit 0 = passed. Anvil public dev keys only; no key file is read.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { destination, pino } from 'pino';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, parseAbi, toHex, type Abi, type Address, type Hash } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { uniV3TwapSourceAbi } from '../abi/uniV3TwapSource.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import type { RunningMode } from '../mode.js';
import { v2Markets } from '../registry.js';
import { longIdOf, shortIdOf } from '../seriesId.js';
import { bigintReplacer } from '../store.js';
import { GAS, MIN_SERIES_LEAD, LADDER_LEAD_MARGIN_S } from './constants.js';
import { startCranker } from './main.js';
import { ladderStrikes, pinGasOf, roundDownToTick } from './planner.js';

const KEEPER_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = resolve(KEEPER_DIR, '..');
const DEVNET_DIR = join(ROOT, 'ops', 'devnet');
const PORT = Number(process.env.DEVNET_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = mkdtempSync(join(tmpdir(), 'cranker-devnet-cycle-'));

const chain = defineChain({ id: 4663, name: 'Stonkhouse devnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }), pollingInterval: 200 });

/*//////////////////////////////////////////////////////////////
                             HARNESS
//////////////////////////////////////////////////////////////*/

const say = (s: string) => process.stdout.write(`${s}\n`);
const step = (s: string) => say(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

function run(cmd: string, args: string[], env: Record<string, string>, logFile?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (logFile !== undefined) import('node:fs').then((fs) => fs.writeFileSync(logFile, out)).catch(() => undefined);
      resolveRun({ code: code ?? 1, out });
    });
  });
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return pub.request({ method: method as never, params: params as never }) as Promise<T>;
}

async function now(): Promise<number> {
  return Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
}

async function warpTo(ts: number): Promise<void> {
  if ((await now()) >= ts) return;
  await rpc('evm_setNextBlockTimestamp', [toHex(ts)]);
  await rpc('evm_mine');
}

/** OrderKind.AskWrite — write-on-fill (V2Types.sol:64-67); OrderKind 1 is the AskResale below it. */
const ASK_WRITE = 2;
/**
 * ada's AskWrite price for the section-C ITM call, USDG (6 dp) per SHARE. A unit is 0.01 share
 * (cranker/constants.ts:29 UNIT = 1e16), so 50 units costs dee `price * 50 / 100` = 7.50 USDG and
 * locks ada 0.5 NVDA of collateral. Both fit the seed's funding with room: ops/devnet/seed.mjs:194-197
 * deposits ada 200 NVDA, and the five wallets each hold 1,000,000 USDG. It sits below dee's 20 USDG
 * resale ask on the next line, so the resale is a resale and not a markdown.
 */
const ITM_ASK_PRICE = 15_000_000n;

async function sendAs(from: Address, call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<unknown> {
  const { result } = await pub.simulateContract({ ...call, account: from } as never);
  const wallet = createWalletClient({ account: from, chain, transport: http(RPC) });
  const hash = (await wallet.writeContract({ ...call, account: from, chain, gas: 5_000_000n } as never)) as Hash;
  await rpc('evm_mine');
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted (${hash})`);
  return result;
}

async function setFeed(args: string[]): Promise<void> {
  const r = await run(process.execPath, [join(DEVNET_DIR, 'set-feed.mjs'), ...args], { DEVNET_PORT: String(PORT) });
  if (r.code !== 0) throw new Error(`set-feed.mjs ${args.join(' ')} failed:\n${r.out}`);
}

async function waitFor(what: string, condition: () => Promise<boolean>, options: { timeoutMs: number; wake?: RunningMode }): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    options.wake?.wake?.();
    await sleep(1_000);
  }
  say(`  (timed out after ${options.timeoutMs} ms waiting for ${what})`);
  return false;
}

async function health(running: RunningMode): Promise<{ tickInFlight: boolean; ticks: number }> {
  return (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { tickInFlight: boolean; ticks: number };
}

async function state(running: RunningMode): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${running.port}/state`);
  return res.status === 200 ? res.json() : null;
}

/** Wait until the cranker has finished `ticks` more ticks and is idle, so a warp never lands mid-send. */
async function settleTicks(running: RunningMode, more: number, timeoutMs = 120_000): Promise<void> {
  const start = (await health(running)).ticks;
  running.wake?.();
  await waitFor(`${more} tick(s)`, async () => {
    const h = await health(running);
    return h.ticks >= start + more && !h.tickInFlight;
  }, { timeoutMs });
}

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], account?: Address): Promise<T> {
  // `account` matters for any view that reads msg.sender. OrderBook.quoteTake does, to apply the
  // caller's own discount, so quoting as the zero address would price a different taker's fill.
  return pub.readContract({ address, abi, functionName, args, ...(account ? { account } : {}) } as never) as Promise<T>;
}

/** AutoRoller(book, admin) from CONTRACTS_DIR's forge build, sent from anvil's unlocked admin account. */
async function deployRoller(D: Devnet): Promise<Address> {
  const contractsDir = process.env.CONTRACTS_DIR ?? resolve(ROOT, '..', 'callhouse-contracts');
  const artifactFile = join(contractsDir, 'out', 'AutoRoller.sol', 'AutoRoller.json');
  if (!existsSync(artifactFile)) throw new Error(`CYCLE_DEPLOY_ROLLER=1 needs ${artifactFile} (forge build in CONTRACTS_DIR)`);
  const artifact = JSON.parse(readFileSync(artifactFile, 'utf8')) as { abi: Abi; bytecode: { object: `0x${string}` } };
  const admin = getAddress(D.accounts.admin!);
  // C8-05 HAS LANDED, AND THE SECOND ARGUMENT CHANGED MEANING WITHOUT CHANGING ARITY.
  // src/v2/AutoRoller.sol:95 is now `AutoRoller is IAutoRoller, Managed, ...` and :181 is
  // `constructor(IOrderBook orderBook_, address authority_) Managed(authority_)`. It used to be
  // (IOrderBook, address admin) on an AccessControl contract. Passing the admin EOA still COMPILES,
  // still DEPLOYS, and produces a roller whose authority() is an address with no code, so every
  // `restricted` call on it consults a non-contract. Nothing fails at deploy time. The authority is
  // the AccessManager, which ops/devnet/addresses.json now records (F8-03/T-119).
  const authority = getAddress(D.contracts.accessManager);
  const wallet = createWalletClient({ account: admin, chain, transport: http(RPC) });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [D.contracts.orderBook, authority], account: admin, chain, gas: 8_000_000n } as never);
  await rpc('evm_mine');
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`AutoRoller deploy failed (${hash})`);
  return getAddress(receipt.contractAddress);
}

/** The writer set-up of AutoRoller's NatSpec: ledger payouts, the roller as operator and book delegate, a strategy. */
async function configureStrategy(D: Devnet, roller: Address, writer: Address, underlying: Address): Promise<void> {
  await sendAs(writer, { address: D.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'setPayoutToLedger', args: [true] });
  await sendAs(writer, { address: D.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'setOperator', args: [roller, true] });
  await sendAs(writer, { address: D.contracts.orderBook, abi: orderBookAbi, functionName: 'setDelegate', args: [roller, true] });
  await sendAs(writer, {
    address: roller,
    abi: autoRollerAbi,
    functionName: 'setStrategy',
    args: [underlying, { active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 60, minAskBps: 0, maxAskBps: 0, maxUnits: 500n }],
  });
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                           ASSERTIONS
//////////////////////////////////////////////////////////////*/

interface Devnet {
  contracts: { clearinghouse: Address; orderBook: Address; settlementOracle: Address; expiryCalendar: Address; accessManager: Address; autoRoller: Address | null; sources: { univ3: Address } };
  markets: Array<{ ticker: string; underlying: Address; feed: Address; pool: Address | null; strikeTick: string }>;
  accounts: Record<string, Address>;
  startBlock: number;
  seed: { trade: { expiries: { daily: number[]; weekly: number[] }; settleExpiry: number; resaleOrderId?: string } };
}

/** The ladder the cranker must have made for `market` at `spot` from head `at`: every rung of every tenor exists. */
async function assertLadders(D: Devnet, config: CrankerConfig, at: number, label: string): Promise<void> {
  for (const m of v2Markets(config.registry, ['live'])) {
    const [ok, spot] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [m.underlying]);
    if (!ok) {
      check(false, `${label}: ${m.ticker} spot is fresh for the ladder check`);
      continue;
    }
    const tick = BigInt(D.markets.find((x) => x.ticker === m.ticker)!.strikeTick);
    let missing = 0;
    let total = 0;
    for (const tenor of ['weekly', 'daily'] as const) {
      let after = at + MIN_SERIES_LEAD + LADDER_LEAD_MARGIN_S;
      for (let i = 0; i < m.v2.params.expiriesAhead[tenor]; i += 1) {
        const expiry = Number(await read<number>(D.contracts.expiryCalendar, expiryCalendarAbi, 'nextExpiry', [after, tenor === 'weekly']));
        after = expiry;
        for (const strike of ladderStrikes(spot, m.v2.params.ladder[tenor], tick, false)) {
          total += 1;
          if (!(await read<boolean>(D.contracts.clearinghouse, clearinghouseAbi, 'seriesExists', [longIdOf(m.underlying, false, strike, expiry)]))) missing += 1;
        }
      }
    }
    check(total > 0 && missing === 0, `${label}: ${m.ticker} ladder at spot ${spot}: ${total - missing}/${total} rungs exist over ${m.v2.params.expiriesAhead.weekly} weekly + ${m.v2.params.expiriesAhead.daily} daily expiries`);
  }
}

const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/**
 * INTERFACE_VERSION 6: the first series of an (underlying, expiry) pins the settlement configuration on the oracle and
 * every source, which fails closed. Measured per market on an expiry no series pinned yet (a daily four weeks out, past
 * every ladder): the eth_estimateGas of that first createSeries, of the next one of the pinned expiry, and the batch
 * the cranker sends for a lone first series (Multicall3.aggregate3) simulated at its fixed limit (created) and at the
 * limit before v6 (GAS.createSeriesBase + GAS.createSeriesEach: refused on two sources, the pin starved; one fits).
 */
async function measureCreateSeriesGas(D: Devnet, config: CrankerConfig, at: number): Promise<void> {
  const from = getAddress(D.accounts.ada!);
  const cranker = getAddress(D.accounts.cranker!);
  for (const m of v2Markets(config.registry, ['live'])) {
    let expiry = Number(await read<number>(D.contracts.expiryCalendar, expiryCalendarAbi, 'nextExpiry', [at + 28 * 86_400, false]));
    let cfg = await read<readonly [boolean, readonly Address[], number, number, number]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementConfig', [m.underlying, expiry]);
    for (let i = 0; i < 10 && cfg[0]; i += 1) {
      expiry = Number(await read<number>(D.contracts.expiryCalendar, expiryCalendarAbi, 'nextExpiry', [expiry, false]));
      cfg = await read<readonly [boolean, readonly Address[], number, number, number]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementConfig', [m.underlying, expiry]);
    }
    if (cfg[0]) {
      check(false, `gas: ${m.ticker} has an unpinned expiry four weeks out to measure`);
      continue;
    }
    const sources = cfg[1].length;
    const [, spot] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [m.underlying]);
    const tick = BigInt(D.markets.find((x) => x.ticker === m.ticker)!.strikeTick);
    const strike = roundDownToTick((spot * 105n) / 100n, tick) + tick;
    const create = (k: bigint) => encodeFunctionData({ abi: clearinghouseAbi, functionName: 'createSeries', args: [m.underlying, false, k, expiry] });
    const budget = GAS.createSeriesBase + GAS.createSeriesEach + pinGasOf(sources);
    const old = GAS.createSeriesBase + GAS.createSeriesEach;
    const lone = async (gas: bigint) => {
      const { result } = await pub.simulateContract({ address: config.multicall3, abi: multicall3Abi, functionName: 'aggregate3', args: [[{ target: D.contracts.clearinghouse, allowFailure: true, callData: create(strike) }]], account: cranker, gas });
      return result[0]!.success;
    };
    const first = await pub.estimateGas({ account: from, to: D.contracts.clearinghouse, data: create(strike) });
    const createdAtBudget = await lone(budget);
    const createdAtOld = await lone(old);
    // Create it (a series nobody trades, past every ladder) to measure the next one of the now pinned expiry.
    const wallet = createWalletClient({ account: from, chain, transport: http(RPC) });
    const hash = await wallet.sendTransaction({ account: from, chain, to: D.contracts.clearinghouse, data: create(strike), gas: 3_000_000n });
    await rpc('evm_mine');
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    const next = await pub.estimateGas({ account: from, to: D.contracts.clearinghouse, data: create(strike + tick) });
    say(`  gas: ${m.ticker} (${sources} source(s)) first series of ${expiry}: estimate ${first}, used ${receipt.gasUsed}; next series ${next}; lone-batch limit ${budget} (before v6 ${old})`);
    check(receipt.status === 'success' && first * 100n <= (budget - GAS.createSeriesBase) * 85n, `gas: ${m.ticker} first series of an expiry (${first}) fits its pin budget ${budget - GAS.createSeriesBase} with 15 % to spare`);
    check(next * 100n <= GAS.createSeriesEach * 80n, `gas: ${m.ticker} a later series of the pinned expiry (${next}) fits GAS.createSeriesEach ${GAS.createSeriesEach} with 20 % to spare`);
    // One Chainlink source pins in ~100k and still fits the pre-v6 limit; a second source (the pool) does not.
    check(createdAtBudget && (sources < 2 || !createdAtOld), `gas: a lone first series batched at its limit ${budget} is created (${createdAtBudget}); at the pre-v6 ${old}: ${createdAtOld ? 'created' : 'refused, the pin ran out of gas'}${sources < 2 ? ' (one source fits it)' : ''}`);
  }
}

interface SeriesRow {
  longId: bigint;
  underlying: Address;
  expiry: number;
  strike: bigint;
}

async function seriesOfExpiry(D: Devnet, underlying: Address, expiry: number): Promise<SeriesRow[]> {
  const logs = await pub.getContractEvents({ address: D.contracts.clearinghouse, abi: clearinghouseAbi, eventName: 'SeriesCreated', fromBlock: BigInt(D.startBlock), toBlock: 'latest' });
  return logs
    .map((l) => l.args as { longId: bigint; underlying: Address; strike: bigint; expiry: number })
    .filter((a) => a.underlying.toLowerCase() === underlying.toLowerCase() && Number(a.expiry) === expiry)
    .map((a) => ({ longId: a.longId, underlying: a.underlying, expiry: Number(a.expiry), strike: a.strike }));
}

async function holdersOf(D: Devnet, tokenId: bigint): Promise<Address[]> {
  const logs = await pub.getContractEvents({ address: D.contracts.clearinghouse, abi: clearinghouseAbi, eventName: 'TransferSingle', fromBlock: BigInt(D.startBlock), toBlock: 'latest' });
  return [...new Set(logs.filter((l) => (l.args as { id: bigint }).id === tokenId).map((l) => getAddress((l.args as { to: Address }).to)))].filter((a) => a !== '0x0000000000000000000000000000000000000000');
}

/** Everything an expiry must look like once the cranker is through with it. */
async function assertExpiryDone(D: Devnet, ticker: string, expiry: number): Promise<void> {
  const m = D.markets.find((x) => x.ticker === ticker)!;
  const [status, price] = await read<readonly [number, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementPrice', [m.underlying, expiry]);
  check(status === 2, `${ticker} ${expiry}: settlement Finalized (${price})`);
  const series = await seriesOfExpiry(D, m.underlying, expiry);
  let settled = 0;
  let withSupply = 0;
  let openOrders = 0;
  let unredeemed = 0;
  let redeemedHolders = 0;
  let zeroPayoutLeft = 0;
  for (const s of series) {
    const info = await read<{ settled: boolean; longPayoutPerUnit: bigint; shortPayoutPerUnit: bigint }>(D.contracts.clearinghouse, clearinghouseAbi, 'series', [s.longId]);
    const [ids] = await read<readonly [readonly bigint[], bigint]>(D.contracts.orderBook, orderBookAbi, 'ordersOfSeries', [s.longId, 0n, 200n]);
    if (ids.length > 0) {
      const orders = await read<ReadonlyArray<{ cancelled: boolean; units: bigint; filled: bigint }>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [ids]);
      openOrders += orders.filter((o) => !o.cancelled && o.filled < o.units).length;
    }
    const escrow = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'balanceOf', [D.contracts.orderBook, s.longId]);
    check(escrow === 0n, `${ticker} strike ${s.strike}: the book holds no escrowed longs`);
    let hadSupply = false;
    for (const [tokenId, perUnit] of [
      [s.longId, info.longPayoutPerUnit],
      [shortIdOf(s.longId), info.shortPayoutPerUnit],
    ] as const) {
      for (const holder of await holdersOf(D, tokenId)) {
        if (holder.toLowerCase() === D.contracts.orderBook.toLowerCase()) continue;
        const balance = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'balanceOf', [holder, tokenId]);
        const redeemedLog = await pub.getContractEvents({ address: D.contracts.clearinghouse, abi: clearinghouseAbi, eventName: 'Redeemed', args: { tokenId, holder }, fromBlock: BigInt(D.startBlock), toBlock: 'latest' });
        if (redeemedLog.length > 0) redeemedHolders += 1;
        if (balance === 0n) continue;
        hadSupply = true;
        if (perUnit === 0n) zeroPayoutLeft += 1;
        else unredeemed += 1;
      }
    }
    const supply = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'totalSupply', [s.longId]);
    if (info.settled) settled += 1;
    if (supply > 0n || hadSupply || info.settled) withSupply += 1;
    if (!info.settled && supply > 0n) check(false, `${ticker} strike ${s.strike}: has long supply but is not settled`);
  }
  check(openOrders === 0, `${ticker} ${expiry}: no open order left on its ${series.length} series`);
  check(unredeemed === 0, `${ticker} ${expiry}: every holder with a non-zero payout redeemed (${redeemedHolders} Redeemed holder(s), ${zeroPayoutLeft} zero-payout balance(s) left as configured)`);
  say(`       (${settled} of ${series.length} series settled; ${withSupply} ever had supply)`);
}

/*//////////////////////////////////////////////////////////////
                              MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  say(`cranker devnet cycle on ${RPC}; output in ${OUT}`);
  if (process.env.DEVNET_REUSE !== '1') {
    step('ops/devnet/up.sh');
    const up = await run(join(DEVNET_DIR, 'up.sh'), [], { DEVNET_PORT: String(PORT), ...(process.env.CONTRACTS_DIR ? { CONTRACTS_DIR: process.env.CONTRACTS_DIR } : {}) }, join(OUT, 'devnet-up.log'));
    if (up.code !== 0) throw new Error(`up.sh failed (log ${join(OUT, 'devnet-up.log')}):\n${up.out.split('\n').slice(-30).join('\n')}`);
    say(`  devnet up (log ${join(OUT, 'devnet-up.log')})`);
  }
  const addressesFile = join(DEVNET_DIR, 'addresses.json');
  if (!existsSync(addressesFile)) throw new Error(`${addressesFile} missing: run ops/devnet/up.sh`);
  const D = JSON.parse(readFileSync(addressesFile, 'utf8')) as Devnet;
  const acct = D.accounts;
  const NVDA = D.markets.find((m) => m.ticker === 'NVDA')!;
  const TSLA = D.markets.find((m) => m.ticker === 'TSLA')!;
  const e1 = D.seed.trade.settleExpiry;
  const e2 = D.seed.trade.expiries.daily[1]!;
  // The seed's resale ask on e2 (ops/devnet/seed.mjs records its id; periphery orders come after it).
  if (D.seed.trade.resaleOrderId === undefined) throw new Error(`${addressesFile} has no seed.trade.resaleOrderId: re-run ops/devnet/up.sh`);
  const seedResaleId = BigInt(D.seed.trade.resaleOrderId);

  // Rolls: the devnet's AutoRoller when DevDeploy wired one; else, with CYCLE_DEPLOY_ROLLER=1, one deployed here
  // from CONTRACTS_DIR's build. Either way a writer strategy exists before the cranker starts.
  let roller: Address | null = D.contracts.autoRoller;
  if (roller === null && process.env.CYCLE_DEPLOY_ROLLER === '1') {
    step('deploy an AutoRoller from the contracts build (CYCLE_DEPLOY_ROLLER=1)');
    roller = await deployRoller(D);
    say(`  AutoRoller ${roller}`);
  }
  const strategyWriters: Address[] = [];
  /** Writers whose strategy the harness set up with no position: the cranker must open theirs at 15:58. */
  const freshWriters: Address[] = [];
  const positionOf = (writer: Address) => read<readonly [bigint, bigint, number]>(roller!, autoRollerAbi, 'position', [writer, NVDA.underlying]);
  if (roller !== null) {
    const existing = await pub.getContractEvents({ address: roller, abi: autoRollerAbi, eventName: 'StrategySet', fromBlock: BigInt(D.startBlock), toBlock: 'latest' });
    for (const s of existing) {
      const writer = getAddress((s.args as { writer: Address }).writer);
      if (!strategyWriters.includes(writer)) strategyWriters.push(writer);
    }
    // The seed's strategy already holds the position its session roll opened, so it proves nothing about the
    // cranker opening one: add a daily NVDA strategy for a writer without a strategy (both deposited NVDA).
    const name = (['ben', 'ada'] as const).find((n) => !strategyWriters.includes(getAddress(acct[n]!)));
    if (name === undefined) throw new Error('rolls: ben and ada both have an AutoRoller strategy already; the harness needs a writer without one');
    const writer = getAddress(acct[name]!);
    await configureStrategy(D, roller, writer, NVDA.underlying);
    strategyWriters.push(writer);
    freshWriters.push(writer);
    say(`  ${name} rolls NVDA dailies (5 % OTM, ask 0.6 % of spot, up to 5 shares)`);
    for (const w of strategyWriters) {
      const [longId, orderId, expiry] = await positionOf(w);
      if (!freshWriters.includes(w)) say(`  ${w}: strategy from the seed, position ${longId === 0n ? 'none' : `expiry ${expiry}, order ${orderId}`}`);
    }
  }
  // Rolled events from here on are the harness's cranker (the seed's session roll used the cranker's key too).
  const cranksFrom = (await pub.getBlockNumber()) + 1n;

  step('start the cranker (in process, startCranker) on env/cranker.env');
  const env = {
    ...parseEnvFile(join(DEVNET_DIR, 'env', 'cranker.env')),
    ...(roller !== null ? { V2_AUTO_ROLLER: roller } : {}),
    KEEPER_DB_PATH: join(OUT, 'cranker.db'),
    CRANKER_PORT: '0',
    // Five minutes: between the harness's wake() calls, only the cranker's own wake-up can act in time.
    POLL_INTERVAL_MS: '300000',
    // Nothing listens here: holders and strategies must come from the cranker's log index.
    INDEXER_URL: 'http://127.0.0.1:9',
    CRANKER_INDEXER_TIMEOUT_MS: '1000',
    KEEPER_LOG_LEVEL: 'info',
  };
  const config = loadV2Config(env) as CrankerConfig;
  const log = pino({ level: 'info', base: { service: 'callhouse-cranker', mode: 'cranker' } }, destination({ dest: join(OUT, 'cranker.log'), sync: true }));
  const started = await startCranker(config, { log });
  let closed = false;
  const running: RunningMode = {
    ...started,
    async close() {
      if (closed) return;
      closed = true;
      await started.close();
    },
  };
  say(`  cranker ${getAddress(acct.cranker!)} on port ${running.port}; log ${join(OUT, 'cranker.log')}; db ${env.KEEPER_DB_PATH}`);
  say(`  autoRoller: ${config.contracts.autoRoller ?? 'none on this devnet (rolls step skipped)'}`);

  try {
    /* ---------------------------------------------------------------- A */
    step('A. boot: ladders, the settled seed expiry, TSLA pending');
    await waitFor('the first tick', async () => (await health(running)).ticks >= 1 && !(await health(running)).tickInFlight, { timeoutMs: 180_000 });
    const bootHead = (await state(running))?.head?.timestamp as number;
    await assertLadders(D, config, bootHead, 'A');
    await measureCreateSeriesGas(D, config, bootHead);
    const stA = await state(running);
    check(stA.index.doneExpiries >= 1, `A: the seed's settled NVDA expiry ${e1} is done in the index (${stA.index.doneExpiries} done)`);
    if (roller === null) {
      check(/no autoRoller configured/.test(String(stA.steps.rolls.lastNotes.skipped)) && stA.steps.rolls.errors === 0, 'A: without an AutoRoller the cranker booted and the rolls step reports itself skipped');
    } else {
      const decisions = (stA.steps.rolls.lastNotes.decisions ?? []) as Array<{ writer: Address; roll: boolean; reason: string }>;
      // A strategy without a position waits for the session; a held position blocks until its expiry.
      const expected = new Map<string, string>();
      for (const w of strategyWriters) {
        const [longId, , expiry] = await positionOf(w);
        expected.set(w.toLowerCase(), longId === 0n ? 'session-closed' : bootHead < Number(expiry) ? 'rolled-this-period' : 'close-out');
      }
      check(
        decisions.length === strategyWriters.length && decisions.every((d) => !d.roll && d.reason === expected.get(d.writer.toLowerCase())),
        `A: at 16:02 New York no roll is sent (${decisions.map((d) => `${d.writer}: ${d.reason}, expected ${expected.get(d.writer.toLowerCase()) ?? 'no strategy'}`).join('; ') || 'no decision'})`,
      );
    }
    const [tslaStatus] = await read<readonly [number, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementPrice', [TSLA.underlying, e1]);
    check(tslaStatus === 1, `A: TSLA ${e1} is a Pending single-source candidate (status ${tslaStatus})`);

    /* ---------------------------------------------------------------- B */
    step(`B. warp past TSLA ${e1}'s uncorroborated delay`);
    const [, , , finalizableAt1] = await read<readonly [bigint, number, boolean, number]>(D.contracts.settlementOracle, settlementOracleAbi, 'candidate', [TSLA.underlying, e1]);
    await warpTo(Number(finalizableAt1) + 5);
    await settleTicks(running, 1);
    await assertExpiryDone(D, 'TSLA', e1);

    /* ---------------------------------------------------------------- C */
    step(`C. expiry ${e2}: an ITM NVDA call with a resale ask, the settlement window, the precise wake-up`);
    await warpTo(e2 - 7_200);
    await setFeed(['--all']);
    const [, spot] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [NVDA.underlying]);
    const itmStrike = roundDownToTick((spot * 95n) / 100n, BigInt(NVDA.strikeTick));
    const itm = (await sendAs(acct.ada!, { address: D.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'createSeries', args: [NVDA.underlying, false, itmStrike, e2] })) as bigint;
    // THE POSITION IS MADE THE WAY A USER MAKES ONE. v8 `Clearinghouse.mint` is minter-allowlisted
    // (src/v2/Clearinghouse.sol:563-564, allowlist :166) and the OrderBook is the only protocol
    // minter (script/v2/DevDeploy.s.sol:346, T-77). ada is an EOA and never will be one, so the old
    // direct `mint(itm, 50, ada, dee)` here reverts NotMinter() on any v8 devnet. Instead ada rests
    // an AskWrite and dee takes it, and the BOOK mints: same end state, ada short 50 and dee long 50.
    const askWriteId = (await sendAs(acct.ada!, {
      address: D.contracts.orderBook, abi: orderBookAbi, functionName: 'place',
      args: [itm, ASK_WRITE, ITM_ASK_PRICE, 50n, 0],
    })) as bigint;
    // TakeParams has TEN fields in v8, `maxTotalFee` tenth and last. The order is MIRRORED from the
    // compiled ABI, not retyped from a doc: ops/abis/v2/OrderBook.json `take`, which agrees
    // field-for-field with keeper/src/v2/abi/orderBook.ts (both checked, both
    // longId, buying, orderIds, units, minUnits, limitPrice, writeToSell, recipient, deadline, maxTotalFee).
    const takeBase = {
      longId: itm, buying: true, orderIds: [askWriteId], units: 50n, minUnits: 50n,
      limitPrice: ITM_ASK_PRICE, writeToSell: false, recipient: acct.dee!,
      deadline: BigInt((await now()) + 3_600), maxTotalFee: 0n,
    };
    // v8 quoteTake returns FOUR values (unitsFilled, premium, takerFee, sellerFees) —
    // src/v2/OrderBook.sol:459-467. This take is BUYING, so the cap is the taker fee alone: the
    // seller fees of an ask that gets hit are the MAKER's, not the taker's (OrderBook.sol:464-466).
    // Quoted as dee because quoteTake reads msg.sender for the discount.
    const [, , quotedTakerFee] = await read<readonly [bigint, bigint, bigint, bigint]>(
      D.contracts.orderBook, orderBookAbi, 'quoteTake', [takeBase], acct.dee!,
    );
    // NOTE: `OrderBook.take` does NOT enforce p.maxTotalFee yet — `grep -n maxTotalFee
    // src/v2/OrderBook.sol` finds only NatSpec at :416 and :463, and the enforcement is C8-03
    // (claimed, not landed). The field is correct data either way, so it is filled from the quote
    // rather than left at a sentinel; do not assert that the cap reverts until C8-03 lands.
    await sendAs(acct.dee!, {
      address: D.contracts.orderBook, abi: orderBookAbi, functionName: 'take',
      args: [{ ...takeBase, maxTotalFee: quotedTakerFee }],
    });
    const resaleId = (await sendAs(acct.dee!, { address: D.contracts.orderBook, abi: orderBookAbi, functionName: 'place', args: [itm, 1, 20_000_000n, 20n, 0] })) as bigint;
    say(`  ada rested an AskWrite for 50 units of NVDA call ${itmStrike} (spot ${spot}) at ${ITM_ASK_PRICE}; dee took it in full (order ${askWriteId}, taker fee cap ${quotedTakerFee}) so the book minted — ada short 50, dee long 50; dee lists 20 for resale (order ${resaleId})`);

    await warpTo(e2 - 90);
    await setFeed(['NVDA', '--window', String(e2), '--pool']);
    await setFeed(['TSLA', '--window', String(e2)]);
    const beforeWake = await now();
    say(`  settlement window pushed; chain time ${beforeWake} (${e2 - beforeWake} s before expiry)`);
    const ticksBefore = (await health(running)).ticks;
    running.wake?.();
    await waitFor('the pre-expiry tick', async () => {
      const h = await health(running);
      return h.ticks > ticksBefore && !h.tickInFlight;
    }, { timeoutMs: 120_000 });
    const stC = await state(running);
    say(`  wake-up armed for ${stC.wake?.at ?? 'nothing'} (delay ${stC.wake?.delayMs ?? '-'} ms); chain time ${await now()}`);
    check(stC.wake?.at === e2, `C: the cranker armed its wake-up for expiry ${e2}`);
    if (roller !== null) {
      // 15:58 New York on a session day with a fresh spot: the rolls step of that tick rolled every due strategy.
      check(await read<boolean>(D.contracts.expiryCalendar, expiryCalendarAbi, 'isRegularSession', [stC.head.timestamp]), 'rolls: the pre-expiry tick ran inside the regular session');
      const rolled = await pub.getContractEvents({ address: roller, abi: autoRollerAbi, eventName: 'Rolled', fromBlock: cranksFrom, toBlock: 'latest' });
      for (const writer of strategyWriters) {
        const [longId, orderId, expiry] = await positionOf(writer);
        if (freshWriters.includes(writer)) {
          const mine = rolled.filter((l) => getAddress((l.args as { writer: Address }).writer) === writer);
          const byCranker = [];
          for (const l of mine) if (getAddress((await pub.getTransaction({ hash: l.transactionHash })).from) === getAddress(acct.cranker!)) byCranker.push(l);
          check(byCranker.length >= 1 && longId !== 0n && orderId !== 0n && Number(expiry) > e2, `rolls: the cranker rolled ${writer} (Rolled by the cranker's key since it started: ${byCranker.length}; position expiry ${expiry}, order ${orderId})`);
        } else {
          check(longId !== 0n && Number(expiry) > stC.head.timestamp, `rolls: the seed's strategy ${writer} still holds a live position (expiry ${expiry}, order ${orderId})`);
        }
      }
    }
    await assertLadders(D, config, stC.head.timestamp, 'C');

    // No wake() from here: the snapshot must come from the cranker's own timer.
    const snapped = await waitFor(`the NVDA pool snapshot of ${e2}`, async () => (await read<readonly [bigint, number, number]>(D.contracts.sources.univ3, uniV3TwapSourceAbi, 'snapshots', [NVDA.underlying, e2]))[0] !== 0n, { timeoutMs: 180_000 });
    const [snapPrice, , recordedAt] = await read<readonly [bigint, number, number]>(D.contracts.sources.univ3, uniV3TwapSourceAbi, 'snapshots', [NVDA.underlying, e2]);
    check(snapped && Number(recordedAt) >= e2 && Number(recordedAt) <= e2 + 600, `C: NVDA pool snapshot recorded inside [expiry, expiry + 600] (price ${snapPrice}, at expiry + ${Number(recordedAt) - e2} s)`);
    check(snapped && Number(recordedAt) <= e2 + 30, `C: recorded within 30 s of expiry by the precise wake-up (poll interval is 300 s)`);

    await waitFor('an idle cranker', async () => !(await health(running)).tickInFlight, { timeoutMs: 60_000 });
    await warpTo(e2 + 125);
    await settleTicks(running, 1);
    const [nvdaStatus2] = await read<readonly [number, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementPrice', [NVDA.underlying, e2]);
    const info2 = await read<readonly [number, bigint, number, boolean, boolean, boolean]>(D.contracts.settlementOracle, settlementOracleAbi, 'settlementInfo', [NVDA.underlying, e2]);
    const corroborated = info2[3];
    check(nvdaStatus2 === 2 && corroborated, `C: NVDA ${e2} finalized corroborated (feed vs pool snapshot) at expiry + 120`);
    // THE SEED'S RESALE ASK IS ONLY ON e2 ON SOME CALENDARS. The cycle's second daily expiry is the seed's weekly
    // when the run starts on the day before the weekly (the two ladders then name the SAME series), and a different
    // day otherwise — over a weekend gap, `daily[1]` is Monday and the weekly is the following Friday. Only the asks
    // that really rest on an e2 series can be pruned by this expiry; the harness's own always does.
    const resaleIds = [resaleId, seedResaleId];
    const resaleOrders = await read<ReadonlyArray<{ longId: bigint; cancelled: boolean }>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [resaleIds]);
    const e2Series = new Set((await seriesOfExpiry(D, NVDA.underlying, e2)).map((s) => s.longId.toString()));
    const onE2 = resaleOrders.map((o, i) => ({ id: resaleIds[i]!, ...o })).filter((o) => e2Series.has(o.longId.toString()));
    check(onE2.length > 0 && onE2.every((o) => o.cancelled), `C: every resale ask resting on an ${e2} series is pruned (${onE2.map((o) => o.id).join(', ')} of ${resaleIds.join(', ')})`);
    const deeItm = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'balanceOf', [acct.dee, itm]);
    check(deeItm === 0n, 'C: the ITM long (including the 20 units back from escrow) redeemed');
    await assertExpiryDone(D, 'NVDA', e2);

    // TSLA's turn, on the calendars where the seed left it open interest at e2 (see the resale note above: the seed's
    // TSLA fills are on its weekly, which is the second daily expiry only when the two ladders name the same series).
    // Its single-source delay is exercised at e1 in step B either way.
    const tslaOpenE2 = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'openInterest', [TSLA.underlying, e2]);
    if (tslaOpenE2 > 0n) {
      const [, , , finalizableAt2] = await read<readonly [bigint, number, boolean, number]>(D.contracts.settlementOracle, settlementOracleAbi, 'candidate', [TSLA.underlying, e2]);
      check(Number(finalizableAt2) > e2, `C: TSLA ${e2} waits as a single-source candidate until ${finalizableAt2}`);
      await warpTo(Number(finalizableAt2) + 5);
      await settleTicks(running, 1);
      await assertExpiryDone(D, 'TSLA', e2);
    } else {
      say(`  TSLA has no open interest at ${e2} on this calendar (the seed's TSLA fills are on ${D.seed.trade.expiries.weekly[0]}); its single-source delay is step B's`);
      const left = (await seriesOfExpiry(D, TSLA.underlying, e2)).map((s) => s.longId);
      const supply = await Promise.all(left.map((id) => read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'totalSupply', [id])));
      check(supply.every((n) => n === 0n), `C: TSLA ${e2} has nothing to settle (${left.length} series, no supply)`);
      let openOrders = 0;
      for (const id of left) {
        const [ids] = await read<readonly [readonly bigint[], bigint]>(D.contracts.orderBook, orderBookAbi, 'ordersOfSeries', [id, 0n, 200n]);
        if (ids.length === 0) continue;
        const orders = await read<ReadonlyArray<{ cancelled: boolean; units: bigint; filled: bigint }>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [ids]);
        openOrders += orders.filter((o) => !o.cancelled && o.filled < o.units).length;
      }
      check(openOrders === 0, `C: the cranker still pruned every expired order on TSLA ${e2} (${openOrders} left)`);
    }

    if (roller === null) {
      step('rolls');
      say('  skipped: this devnet has no AutoRoller (the cranker booted without one and reported the step skipped; CYCLE_DEPLOY_ROLLER=1 deploys one)');
    } else {
      /* --------------------------------------------------------- stale */
      // INTERFACE_VERSION 7 (c16). The roll's AskWrite is priced at a fraction of spot; once the spot reaches the
      // strike every price the writer's band allows is below intrinsic value and the ask is free money for the first
      // taker. `cancelStale` is permissionless, so the cranker withdraws it. Nothing settled above is touched: every
      // expiry of this run is already finished, and the rolled position writes a later one.
      step('stale: the spot overtakes a live roller ask and the cranker withdraws it');
      const live: Array<{ writer: Address; longId: bigint; orderId: bigint; expiry: number; strike: bigint }> = [];
      for (const w of strategyWriters) {
        const [longId, orderId, expiry] = await positionOf(w);
        if (orderId === 0n || longId === 0n) continue;
        const [o] = await read<ReadonlyArray<{ units: bigint; filled: bigint; validUntil: number; cancelled: boolean }>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [[orderId]]);
        const t = await now();
        if (o === undefined || o.cancelled || o.filled >= o.units || t >= Number(o.validUntil) || t >= Number(expiry)) continue;
        const series = await read<{ strike: bigint; isPut: boolean }>(D.contracts.clearinghouse, clearinghouseAbi, 'series', [longId]);
        if (!series.isPut) live.push({ writer: w, longId, orderId, expiry: Number(expiry), strike: series.strike });
      }
      check(live.length > 0, `stale: at least one strategy still holds a live roller ask to overtake (${live.length})`);
      if (live.length > 0) {
        const pick = live.reduce((a, b) => (a.strike <= b.strike ? a : b));
        say(`  ${pick.writer}: ask ${pick.orderId} on the ${pick.strike} call expiring ${pick.expiry}`);
        // The feed source refuses a round more than maxRoundJumpBps (20 %) from the one before it: climb in steps.
        const wanted = (Number(pick.strike) / 1e6) * 1.02;
        for (let guard = 0; guard < 8; guard += 1) {
          const [ok, spotRaw] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [NVDA.underlying]);
          if (!ok) throw new Error('stale: NVDA spot is not fresh right after a feed push');
          const spotUsd = Number(spotRaw) / 1e6;
          if (spotUsd >= wanted) break;
          await setFeed(['NVDA', '--price', Math.min(wanted, spotUsd * 1.15).toFixed(4)]);
        }
        const [, spotNow] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [NVDA.underlying]);
        check(spotNow >= pick.strike, `stale: the NVDA spot ${spotNow} has reached the ${pick.strike} strike`);
        const staleFrom = (await pub.getBlockNumber()) + 1n;
        await settleTicks(running, 1);
        const cancels = await pub.getContractEvents({ address: roller, abi: autoRollerAbi, eventName: 'StaleAskCancelled', fromBlock: staleFrom, toBlock: 'latest' });
        const mine = cancels.filter((l) => getAddress((l.args as { writer: Address }).writer) === pick.writer);
        const args = mine.at(-1)?.args as { longId: bigint; orderId: bigint; spot: bigint } | undefined;
        check(mine.length === 1 && args?.orderId === pick.orderId && args?.longId === pick.longId, `stale: StaleAskCancelled(${pick.writer}, NVDA, long ${args?.longId}, order ${args?.orderId}, spot ${args?.spot})`);
        const [longAfter, orderAfter, expiryAfter] = await positionOf(pick.writer);
        check(orderAfter === 0n && longAfter === pick.longId && Number(expiryAfter) === pick.expiry, `stale: the position keeps its series and expiry, and tracks no ask (long ${longAfter}, order ${orderAfter}, expiry ${expiryAfter})`);
        const [o] = await read<ReadonlyArray<{ cancelled: boolean }>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [[pick.orderId]]);
        check(o?.cancelled === true, `stale: the ask ${pick.orderId} is cancelled on the book`);
        if (mine.length === 1) {
          const receipt = await pub.getTransactionReceipt({ hash: mine[0]!.transactionHash });
          const tx = await pub.getTransaction({ hash: mine[0]!.transactionHash });
          check(getAddress(tx.from) === getAddress(acct.cranker!) && tx.gas === GAS.cancelStale, `stale: sent by the cranker's key with the fixed gas limit ${GAS.cancelStale} (used ${receipt.gasUsed})`);
          check(receipt.gasUsed * 10n < GAS.cancelStale * 9n, `stale: gas used ${receipt.gasUsed} is under 90 % of the limit`);
        }
        // A second tick has nothing left to withdraw: the step does not retry a position it already cleared.
        const againFrom = (await pub.getBlockNumber()) + 1n;
        await settleTicks(running, 1);
        check((await pub.getContractEvents({ address: roller, abi: autoRollerAbi, eventName: 'StaleAskCancelled', fromBlock: againFrom, toBlock: 'latest' })).length === 0, 'stale: the next tick withdraws nothing (no re-roll inside the period, no repeated send)');
      }
    }

    /* ---------------------------------------------------------------- D */
    step('D. end state, journal, alerts');
    await assertExpiryDone(D, 'NVDA', e1);
    const stD = await state(running);
    await running.close();
    const db = new Database(env.KEEPER_DB_PATH, { readonly: true });
    const txs = db.prepare('SELECT kind, status, COUNT(*) AS n FROM v2_txs GROUP BY kind, status ORDER BY kind').all() as Array<{ kind: string; status: string; n: number }>;
    say(`  journal: ${txs.map((t) => `${t.kind}/${t.status} ${t.n}`).join(', ')}`);
    for (const kind of ['createSeries', 'snapshot', 'finalize', 'settle', 'prune', 'redeemBatch', ...(roller !== null ? ['roll'] : [])]) {
      check(txs.some((t) => t.kind === kind && t.status === 'success'), `D: journal has a confirmed ${kind}`);
    }
    check(!txs.some((t) => t.status !== 'success'), 'D: every journalled transaction confirmed (none reverted, pending or dropped)');
    // The fixed limits against what the cranker's own createSeries batches (pins included) and rolls used.
    const gasRows = db.prepare("SELECT hash, kind, gas_used FROM v2_txs WHERE status = 'success' AND kind IN ('createSeries', 'roll') ORDER BY created_at").all() as Array<{ hash: Hash; kind: string; gas_used: string }>;
    const usage: string[] = [];
    let withinLimits = gasRows.length > 0;
    for (const row of gasRows) {
      const limit = (await pub.getTransaction({ hash: row.hash })).gas;
      const used = BigInt(row.gas_used);
      usage.push(`${row.kind} ${used}/${limit}`);
      if (used * 10n >= limit * 9n) withinLimits = false;
    }
    say(`  gas used / limit: ${usage.join(', ')}`);
    check(withinLimits, 'D: every createSeries batch and roll used under 90 % of its fixed limit');
    const alerts = db.prepare('SELECT kind, message FROM v2_alerts ORDER BY id').all() as Array<{ kind: string; message: string }>;
    say(`  alerts: ${alerts.map((a) => a.kind).join(', ') || 'none'}`);
    check(!alerts.some((a) => a.kind === 'v2_error' || a.kind === 'v2_tx_revert'), `D: no v2_error / v2_tx_revert alert${alerts.filter((a) => a.kind === 'v2_error' || a.kind === 'v2_tx_revert').map((a) => `\n         ${a.kind}: ${a.message}`).join('')}`);
    db.close();
    const outcomes = Object.fromEntries(Object.entries(stD.steps as Record<string, { runs: number; errors: number; outcomes: Record<string, number> }>).map(([k, v]) => [k, { runs: v.runs, errors: v.errors, ...v.outcomes }]));
    say(`  /state steps: ${JSON.stringify(outcomes, bigintReplacer)}`);
    check(Object.values(stD.steps as Record<string, { errors: number }>).every((s) => s.errors === 0), 'D: no step failed');
  } finally {
    await running.close().catch(() => undefined);
  }
}

let exitCode = 0;
try {
  await main();
  if (failures.length > 0) {
    say(`\nDEVNET CYCLE FAILED: ${failures.length} check(s)\n  ${failures.join('\n  ')}`);
    exitCode = 1;
  } else {
    say('\nDEVNET CYCLE PASSED');
  }
} catch (error) {
  say(`\nDEVNET CYCLE FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  exitCode = 1;
} finally {
  if (process.env.DEVNET_KEEP !== '1') {
    const down = await run(join(DEVNET_DIR, 'down.sh'), [], { DEVNET_PORT: String(PORT) });
    say(down.out.trim() === '' ? `devnet on ${PORT} stopped` : down.out.trim());
  } else {
    say(`devnet left running on ${RPC} (DEVNET_KEEP=1)`);
  }
}
process.exit(exitCode);
