/**
 * The pricer's integration test: a real pricer loop (startPricer, the entry V2_MODE=pricer boots)
 * against ops/devnet's AutoRoller, repricing the seeded writer's live roll ask with account 9's
 * PRICER_ROLE, asserting on-chain state after every tick.
 *
 *   pnpm --filter @callhouse/keeper v2:devnet-pricer
 *   DEVNET_PORT=8561 CONTRACTS_DIR=/path/to/callhouse-contracts pnpm --filter @callhouse/keeper v2:devnet-pricer
 *
 * WHAT RUNS. ops/devnet/up.sh brings up the seeded devnet: writer `ben` has a weekly NVDA strategy with
 * smart pricing (ask 60 bps of spot, band 30-150 bps) and a live AskWrite from the seed's roll. The
 * pricer runs in process on env/pricer.env with a dead INDEXER_URL (the strategy list must come from
 * its own StrategySet scan), a 5-minute poll (only the harness's wake() ticks it) and an INJECTED fair
 * value (the pricing service needs Cboe over the network and a wall clock the devnet warps away from).
 * The harness only moves time, pushes feed rounds (ops/devnet/set-feed.mjs, so spot stays fresh) and
 * sets the fair value; every reprice is the pricer's.
 *
 *   0  boot            no fair value yet: the ask is left alone, nothing sent
 *   A  after the roll  fair moves the target to ~100 bps of spot (> 10 % from the live 60 bps): the
 *                      pricer's key reprices; Repriced(old, new, price), the new ask keeps the
 *                      remaining units and validUntil, the old one is cancelled, position() tracks it
 *   B  inside 30 min   five minutes later fair moves again by far more than 10 %: no reprice, no /fair
 *   C  < 10 %          past 30 minutes, a target 5 % from the live ask: no reprice
 *   D  cadence reopens past another 30 minutes, fair far above the band: repriced to the ceiling tick,
 *                      the inclusive end of the contract's band
 *   E  in the money    the spot reaches the strike (INTERFACE_VERSION 7): the pricer skips the pair without a
 *                      /fair request or a send, and the contract itself reverts InTheMoney; cancelStale withdraws it
 *   F  journal         two confirmed reprices, nothing else; no v2_error or v2_pricer_* alert
 *
 * Environment: DEVNET_PORT (default 8546, up.sh's), CONTRACTS_DIR (passed to up.sh), DEVNET_REUSE=1
 * (use a freshly seeded devnet already up on the port), DEVNET_KEEP=1 (leave anvil running). Output,
 * the pricer's log and its database go to a temporary directory printed at start. Exit 0 = passed.
 * Anvil public dev keys only; no key file is read.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { destination, pino } from 'pino';
import { createPublicClient, defineChain, getAddress, http, toHex, type Abi, type Address } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { loadV2Config, type PricerConfig } from '../config.js';
import { BPS, PRICE_TICK } from '../cranker/constants.js';
import { roundUpToTick } from '../cranker/planner.js';
import type { RunningMode } from '../mode.js';
import type { FairAnswer, FairRequest } from './fair-client.js';
import { startPricer } from './main.js';
import { differsEnough, priceBand, targetPrice } from './planner.js';
import { GAS_REPRICE, PRICER_ROLE } from './pricer.js';

const KEEPER_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = resolve(KEEPER_DIR, '..');
const DEVNET_DIR = join(ROOT, 'ops', 'devnet');
const PORT = Number(process.env.DEVNET_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = mkdtempSync(join(tmpdir(), 'pricer-devnet-'));

const chain = defineChain({ id: 4663, name: 'Stonkhouse devnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }), pollingInterval: 200 });

/*//////////////////////////////////////////////////////////////
                             HARNESS
//////////////////////////////////////////////////////////////*/

const say = (s: string) => process.stdout.write(`${s}\n`);
const step = (s: string) => say(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
let checks = 0;
function check(ok: boolean, what: string): void {
  checks += 1;
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
      if (logFile !== undefined) writeFileSync(logFile, out);
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

async function setFeed(args: string[]): Promise<void> {
  const r = await run(process.execPath, [join(DEVNET_DIR, 'set-feed.mjs'), ...args], { DEVNET_PORT: String(PORT) });
  if (r.code !== 0) throw new Error(`set-feed.mjs ${args.join(' ')} failed:\n${r.out}`);
}

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function health(running: RunningMode): Promise<{ tickInFlight: boolean; ticks: number }> {
  return (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { tickInFlight: boolean; ticks: number };
}

async function state(running: RunningMode): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${running.port}/state`);
  return res.status === 200 ? res.json() : null;
}

async function waitFor(what: string, condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(250);
  }
  say(`  (timed out after ${timeoutMs} ms waiting for ${what})`);
  return false;
}

/** Wake the pricer and wait until one more tick has finished. */
async function tickOnce(running: RunningMode): Promise<any> {
  const start = (await health(running)).ticks;
  running.wake?.();
  await waitFor('a pricer tick', async () => {
    const h = await health(running);
    return h.ticks >= start + 1 && !h.tickInFlight;
  }, 120_000);
  return state(running);
}

interface Devnet {
  contracts: { clearinghouse: Address; orderBook: Address; settlementOracle: Address; autoRoller: Address | null };
  markets: Array<{ ticker: string; underlying: Address }>;
  accounts: Record<string, Address>;
  startBlock: number;
}

interface OrderRow {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

/*//////////////////////////////////////////////////////////////
                              MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  say(`pricer devnet test on ${RPC}; output in ${OUT}`);
  if (process.env.DEVNET_REUSE !== '1') {
    step('ops/devnet/up.sh');
    const up = await run(join(DEVNET_DIR, 'up.sh'), [], { DEVNET_PORT: String(PORT), ...(process.env.CONTRACTS_DIR ? { CONTRACTS_DIR: process.env.CONTRACTS_DIR } : {}) }, join(OUT, 'devnet-up.log'));
    if (up.code !== 0) throw new Error(`up.sh failed (log ${join(OUT, 'devnet-up.log')}):\n${up.out.split('\n').slice(-30).join('\n')}`);
    say(`  devnet up (log ${join(OUT, 'devnet-up.log')})`);
  }
  const addressesFile = join(DEVNET_DIR, 'addresses.json');
  if (!existsSync(addressesFile)) throw new Error(`${addressesFile} missing: run ops/devnet/up.sh`);
  const D = JSON.parse(readFileSync(addressesFile, 'utf8')) as Devnet;
  const roller = D.contracts.autoRoller;
  if (roller === null) throw new Error('this devnet has no AutoRoller (DEV_AUTO_ROLLER=0): nothing to reprice');
  const ben = getAddress(D.accounts.ben!);
  const pricerKey = getAddress(D.accounts.pricer!);
  const NVDA = D.markets.find((m) => m.ticker === 'NVDA')!;

  const position = async () => {
    const [longId, orderId, expiry] = await read<readonly [bigint, bigint, number]>(roller, autoRollerAbi, 'position', [ben, NVDA.underlying]);
    return { longId, orderId, expiry: Number(expiry) };
  };
  const order = async (id: bigint) => (await read<readonly OrderRow[]>(D.contracts.orderBook, orderBookAbi, 'getOrders', [[id]]))[0]!;
  const spotNow = async () => {
    const [ok, spot] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [NVDA.underlying]);
    if (!ok) throw new Error('NVDA spot is not fresh right after a feed push');
    return spot;
  };
  const repricedLogs = async () => pub.getContractEvents({ address: roller, abi: autoRollerAbi, eventName: 'Repriced', fromBlock: BigInt(D.startBlock), toBlock: 'latest' });

  /* ------------------------------------------------------------ the seed */
  step("the seed's roll: ben's smart-pricing NVDA strategy and its live ask");
  const strategy = await read<{ active: boolean; smartPricing: boolean; minAskBps: number; maxAskBps: number; askBps: number }>(roller, autoRollerAbi, 'strategy', [ben, NVDA.underlying]);
  check(strategy.active && strategy.smartPricing, `ben's strategy is active with smart pricing (ask ${strategy.askBps} bps, band ${strategy.minAskBps}-${strategy.maxAskBps} bps)`);
  const p0 = await position();
  const o0 = await order(p0.orderId);
  const t0 = await now();
  check(p0.orderId !== 0n && !o0.cancelled && o0.filled < o0.units && Number(o0.validUntil) > t0 + 4 * 3_600, `ben's roll ask is live: order ${p0.orderId} (placed by the seed's roll), ${o0.units - o0.filled} units at ${o0.price}, valid until ${o0.validUntil} (chain ${t0})`);
  check(await read<boolean>(roller, autoRollerAbi, 'hasRole', [PRICER_ROLE, pricerKey]), `anvil account 9 (${pricerKey}) holds PRICER_ROLE`);
  const series = await read<{ strike: bigint; expiry: number; isPut: boolean }>(D.contracts.clearinghouse, clearinghouseAbi, 'series', [p0.longId]);
  await setFeed(['--all']);

  /* ------------------------------------------------------------ boot */
  step('start the pricer (in process, startPricer) on env/pricer.env with an injected fair value');
  let fairAnswer: FairAnswer = { ok: false, reason: 'harness: no fair value yet' };
  const fairRequests: FairRequest[] = [];
  const env = {
    ...parseEnvFile(join(DEVNET_DIR, 'env', 'pricer.env')),
    KEEPER_DB_PATH: join(OUT, 'pricer.db'),
    PRICER_PORT: '0',
    // Five minutes: only the harness's wake() ticks the pricer.
    POLL_INTERVAL_MS: '300000',
    // Nothing listens here: the strategy list must come from the pricer's own StrategySet scan.
    INDEXER_URL: 'http://127.0.0.1:9',
    PRICER_HTTP_TIMEOUT_MS: '1000',
    KEEPER_LOG_LEVEL: 'info',
  };
  const config = loadV2Config(env) as PricerConfig;
  check(getAddress(config.contracts.autoRoller) === getAddress(roller), `the pricer reprices on the devnet's AutoRoller ${roller}`);
  const { edgeBps, repriceThresholdBps, minIntervalS } = config.tuning;
  say(`  tuning: edge ${edgeBps} bps, threshold ${repriceThresholdBps} bps, interval ${minIntervalS} s`);
  const log = pino({ level: 'info', base: { service: 'callhouse-pricer', mode: 'pricer' } }, destination({ dest: join(OUT, 'pricer.log'), sync: true }));
  const started = await startPricer(config, {
    log,
    fair: {
      fair: async (request) => {
        fairRequests.push(request);
        return fairAnswer;
      },
    },
  });
  let closed = false;
  const running: RunningMode = {
    ...started,
    async close() {
      if (closed) return;
      closed = true;
      await started.close();
    },
  };
  say(`  pricer ${pricerKey} on port ${running.port}; log ${join(OUT, 'pricer.log')}; db ${env.KEEPER_DB_PATH}`);

  /** The fair value whose target (fair × (1 + edge), rounded up to the tick) is `bps` of spot. */
  const fairFor = (spot: bigint, bps: bigint) => (roundUpToTick((spot * bps) / BPS, PRICE_TICK) * BPS) / (BPS + BigInt(edgeBps));
  const pairOf = (st: any) => (st?.pairs ?? []).find((p: any) => getAddress(p.writer) === ben);

  try {
    /* ---------------------------------------------------------------- 0 */
    step('0. the first tick, before any fair value: the ask is left alone');
    await waitFor('the first tick', async () => {
      const h = await health(running);
      return h.ticks >= 1 && !h.tickInFlight;
    }, 120_000);
    const st0 = await state(running);
    check(st0.strategies >= 1 && /^down/.test(st0.indexerStatus) && st0.scannedTo !== null, `the strategy list came from the pricer's own StrategySet scan (indexer ${st0.indexerStatus}; ${st0.strategies} strateg${st0.strategies === 1 ? 'y' : 'ies'}, scanned to ${st0.scannedTo})`);
    check(st0.hasRole === true, 'the pricer read its own PRICER_ROLE');
    check(pairOf(st0)?.outcome === 'fair-unavailable' && (await repricedLogs()).length === 0, `no fair value: nothing sent (${pairOf(st0)?.outcome})`);
    check(fairRequests.length === 1 && fairRequests[0]!.ticker === 'NVDA' && fairRequests[0]!.strike === series.strike && fairRequests[0]!.expiry === Number(series.expiry) && fairRequests[0]!.type === 'call', `the /fair request names the rolled series: NVDA call ${series.strike} expiring ${series.expiry}`);

    /* ---------------------------------------------------------------- A */
    step('A. after the roll: fair moves the target to ~100 bps of spot, more than 10 % from the live ask');
    let spot = await spotNow();
    const fairA = fairFor(spot, 100n);
    const expectA = targetPrice({ fair: fairA, edgeBps, spot, minAskBps: strategy.minAskBps, maxAskBps: strategy.maxAskBps });
    if (!expectA.ok) throw new Error('band empty at A');
    check(differsEnough(expectA.price, o0.price, repriceThresholdBps), `target ${expectA.price} (fair ${fairA} + ${edgeBps} bps) is more than ${repriceThresholdBps} bps from the live ${o0.price} (spot ${spot})`);
    fairAnswer = { ok: true, fair: fairA, source: 'harness', asOf: t0 };
    const stA = await tickOnce(running);
    const pA = await position();
    const logsA = await repricedLogs();
    const lastA = logsA.at(-1);
    const argsA = lastA?.args as { writer: Address; underlying: Address; oldOrderId: bigint; newOrderId: bigint; price: bigint } | undefined;
    check(logsA.length === 1 && argsA !== undefined && getAddress(argsA.writer) === ben && argsA.oldOrderId === p0.orderId && argsA.newOrderId === pA.orderId && argsA.price === expectA.price, `Repriced(ben, NVDA, old ${argsA?.oldOrderId}, new ${argsA?.newOrderId}, price ${argsA?.price}); position() tracks order ${pA.orderId}`);
    if (lastA !== undefined) {
      const tx = await pub.getTransaction({ hash: lastA.transactionHash });
      const receipt = await pub.getTransactionReceipt({ hash: lastA.transactionHash });
      check(getAddress(tx.from) === pricerKey && tx.gas === GAS_REPRICE, `sent by the pricer's key with the fixed gas limit ${GAS_REPRICE} (used ${receipt.gasUsed})`);
      say(`       reprice gas used: ${receipt.gasUsed}`);
    }
    const oA = await order(pA.orderId);
    const oldA = await order(p0.orderId);
    check(oA.price === expectA.price && oA.units === o0.units - o0.filled && oA.filled === 0n && Number(oA.validUntil) === Number(o0.validUntil) && getAddress(oA.maker) === ben && oA.longId === p0.longId && oA.kind === 2, `the new AskWrite keeps the remaining ${oA.units} units, validUntil ${oA.validUntil} and series; price ${oA.price}`);
    check(oldA.cancelled, `the old ask ${p0.orderId} is cancelled`);
    check(pA.longId === p0.longId && pA.expiry === p0.expiry, 'the position is the same series (a reprice is not a roll)');
    const pairA = pairOf(stA);
    check(pairA?.outcome === 'repriced' && pairA?.why === 'new-position' && Number(pairA?.nextCheckAt) === stA.head.timestamp + minIntervalS, `/state: repriced right after the roll; next check at ${pairA?.nextCheckAt}`);
    const nextA = Number(pairA?.nextCheckAt);

    /* ---------------------------------------------------------------- B */
    step('B. a second tick five minutes later: fair moves by far more than 10 %, but the 30 minutes have not passed');
    await warpTo((await now()) + 300);
    await setFeed(['--all']);
    spot = await spotNow();
    fairAnswer = { ok: true, fair: fairFor(spot, 140n), source: 'harness', asOf: t0 };
    const requestsBeforeB = fairRequests.length;
    const stB = await tickOnce(running);
    const pairB = pairOf(stB);
    check((await repricedLogs()).length === 1 && (await position()).orderId === pA.orderId, 'no reprice: still one Repriced, the same ask');
    check(pairB?.outcome === 'not-due' && Number(pairB?.nextCheckAt) === nextA && stB.head.timestamp < nextA, `/state: not-due at ${stB.head.timestamp}, next check at ${pairB?.nextCheckAt}`);
    check(fairRequests.length === requestsBeforeB, 'no /fair request for a pair that is not due');

    /* ---------------------------------------------------------------- C */
    step('C. past 30 minutes: a target 5 % from the live ask is left alone');
    await warpTo(nextA + 5);
    await setFeed(['--all']);
    spot = await spotNow();
    const fairC = (roundUpToTick((oA.price * 105n) / 100n, PRICE_TICK) * BPS) / (BPS + BigInt(edgeBps));
    const expectC = targetPrice({ fair: fairC, edgeBps, spot, minAskBps: strategy.minAskBps, maxAskBps: strategy.maxAskBps });
    check(expectC.ok && !differsEnough(expectC.price, oA.price, repriceThresholdBps) && expectC.price !== oA.price, `target ${expectC.ok ? expectC.price : '-'} is within ${repriceThresholdBps} bps of the live ${oA.price} but not equal`);
    fairAnswer = { ok: true, fair: fairC, source: 'harness', asOf: t0 };
    const stC = await tickOnce(running);
    const pairC = pairOf(stC);
    check((await repricedLogs()).length === 1 && (await position()).orderId === pA.orderId, 'no reprice: still one Repriced, the same ask');
    check(pairC?.outcome === 'within-threshold' && pairC?.why === 'interval' && BigInt(pairC?.target ?? 0) === (expectC.ok ? expectC.price : -1n), `/state: within-threshold (target ${pairC?.target}, live ${pairC?.livePrice})`);
    const nextC = Number(pairC?.nextCheckAt);
    check(nextC === stC.head.timestamp + minIntervalS, `the evaluation restarted the 30 minutes: next check at ${nextC}`);

    /* ---------------------------------------------------------------- D */
    step('D. past another 30 minutes: fair far above the band reprices to the ceiling tick');
    await warpTo(nextC + 5);
    await setFeed(['--all']);
    spot = await spotNow();
    const band = priceBand(spot, strategy.minAskBps, strategy.maxAskBps)!;
    fairAnswer = { ok: true, fair: spot, source: 'harness', asOf: t0 };
    const stD = await tickOnce(running);
    const pD = await position();
    const logsD = await repricedLogs();
    const argsD = logsD.at(-1)?.args as { oldOrderId: bigint; newOrderId: bigint; price: bigint } | undefined;
    check(logsD.length === 2 && argsD?.oldOrderId === pA.orderId && argsD?.newOrderId === pD.orderId && argsD?.price === band.max, `Repriced(old ${argsD?.oldOrderId}, new ${argsD?.newOrderId}) at the ceiling ${argsD?.price} (band ${band.min}-${band.max} at spot ${spot})`);
    check(band.max * BPS <= spot * BigInt(strategy.maxAskBps) && (band.max + PRICE_TICK) * BPS > spot * BigInt(strategy.maxAskBps), 'the ceiling is the last tick inside maxAskBps x spot: accepted by the contract\'s inclusive check');
    check(pairOf(stD)?.outcome === 'repriced' && pairOf(stD)?.clamped === 'ceiling' && pairOf(stD)?.why === 'interval', `/state: repriced, clamped to the ceiling (${pairOf(stD)?.why})`);
    const oD = await order(pD.orderId);
    check(oD.units === oA.units && Number(oD.validUntil) === Number(o0.validUntil) && !oD.cancelled && (await order(pA.orderId)).cancelled, `the ceiling ask keeps ${oD.units} units and validUntil; the previous ask is cancelled`);

    /* ---------------------------------------------------------------- E */
    // INTERFACE_VERSION 7 (c16): once the spot reaches the strike, every price the writer's band allows is below
    // intrinsic value, so `reprice` reverts InTheMoney and the ask is withdrawn by the permissionless
    // AutoRoller.cancelStale (the cranker's stale step) instead. The pricer must stop before it spends a /fair
    // request or a simulation on it, and must not page: this is a normal state, not a failure.
    step('E. the spot reaches the strike: no reprice, no /fair request, no page');
    const nextD = Number(pairOf(stD)?.nextCheckAt);
    await warpTo(nextD + 5);
    // The feed source refuses a round more than maxRoundJumpBps (20 %) from the one before it: climb in steps.
    const target = (Number(series.strike) / 1e6) * 1.02;
    for (let guard = 0; guard < 6; guard += 1) {
      const spotUsd = Number(await spotNow()) / 1e6;
      if (spotUsd >= target) break;
      await setFeed(['NVDA', '--price', Math.min(target, spotUsd * 1.15).toFixed(4)]);
    }
    const spotE = await spotNow();
    check(spotE >= series.strike, `the NVDA spot ${spotE} has reached the ${series.strike} strike`);
    const liveE = await order((await position()).orderId);
    // A fair value that would otherwise move the ask by far more than the threshold.
    fairAnswer = { ok: true, fair: fairFor(spotE, 140n), source: 'harness', asOf: t0 };
    const requestsBeforeE = fairRequests.length;
    const stE = await tickOnce(running);
    const pairE = pairOf(stE);
    const pE = await position();
    check((await repricedLogs()).length === 2 && pE.orderId === pD.orderId, 'no reprice: still two Repriced, the same ask');
    check(pairE?.outcome === 'in-the-money', `/state: in-the-money (${pairE?.outcome}) — ${String(pairE?.detail ?? '').slice(0, 90)}`);
    check(fairRequests.length === requestsBeforeE, 'no /fair request is spent on an ask that cannot be repriced');
    check((await order(pE.orderId)).price === liveE.price && !(await order(pE.orderId)).cancelled, 'the ask is left exactly as it was: withdrawing it is cancelStale\'s job, not the pricer\'s');
    // And the contract agrees: a reprice inside the band would revert InTheMoney.
    let reverted: string | null = null;
    try {
      await pub.simulateContract({ address: roller, abi: autoRollerAbi, functionName: 'reprice', args: [ben, NVDA.underlying, liveE.price + PRICE_TICK], account: pricerKey });
    } catch (error) {
      reverted = error instanceof Error ? error.message : String(error);
    }
    check(reverted !== null && /InTheMoney/.test(reverted), `AutoRoller.reprice itself reverts InTheMoney (${(reverted ?? 'it did not revert').split('\n')[0]!.slice(0, 80)})`);

    /* ---------------------------------------------------------------- F */
    step('F. journal and alerts');
    await running.close();
    const db = new Database(env.KEEPER_DB_PATH, { readonly: true });
    const txs = db.prepare('SELECT kind, status, COUNT(*) AS n FROM v2_txs GROUP BY kind, status ORDER BY kind').all() as Array<{ kind: string; status: string; n: number }>;
    say(`  journal: ${txs.map((t) => `${t.kind}/${t.status} ${t.n}`).join(', ') || 'empty'}`);
    check(txs.length === 1 && txs[0]!.kind === 'reprice' && txs[0]!.status === 'success' && txs[0]!.n === 2, 'the journal holds exactly the two confirmed reprices');
    const alerts = db.prepare('SELECT kind, message FROM v2_alerts ORDER BY id').all() as Array<{ kind: string; message: string }>;
    say(`  alerts: ${alerts.map((a) => a.kind).join(', ') || 'none'}`);
    const bad = alerts.filter((a) => a.kind === 'v2_error' || a.kind === 'v2_tx_revert' || a.kind.startsWith('v2_pricer_'));
    check(bad.length === 0, `no v2_error / v2_pricer_* alert${bad.map((a) => `\n         ${a.kind}: ${a.message}`).join('')}`);
    db.close();
  } finally {
    await running.close().catch(() => undefined);
  }
}

let exitCode = 0;
try {
  await main();
  if (failures.length > 0) {
    say(`\nDEVNET PRICER FAILED: ${failures.length} of ${checks} check(s)\n  ${failures.join('\n  ')}`);
    exitCode = 1;
  } else {
    say(`\nDEVNET PRICER PASSED (${checks} checks)`);
  }
} catch (error) {
  say(`\nDEVNET PRICER FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
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
