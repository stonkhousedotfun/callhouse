/**
 * The MM bot's integration test: the real MM mode (startMm, the entry V2_MODE=mm boots) against ops/devnet, asserting
 * on-chain end state.
 *
 *   pnpm --filter @callhouse/keeper v2:devnet-mm
 *   DEVNET_PORT=8560 CONTRACTS_DIR=/path/to/callhouse-contracts pnpm --filter @callhouse/keeper v2:devnet-mm
 *   pnpm --filter @callhouse/keeper v2:devnet-mm -- --pricing-url http://127.0.0.1:8790
 *   PRICING_URL=http://127.0.0.1:8790 pnpm --filter @callhouse/keeper v2:devnet-mm
 *
 * --pricing-url (or PRICING_URL): run against a real running pricing service instead of the
 * harness's stand-in. Step C (a ticker whose /fair turns null) belongs to the stand-in and is
 * skipped with an explicit note then; every other step runs unchanged. The default path is
 * untouched.
 *
 * WHAT RUNS. ops/devnet/up.sh brings up the seeded devnet: MakerVault funded with 100,000 USDG in its wallet and 100 NVDA
 * in its Clearinghouse ledger, QUOTER_ROLE on anvil account 10, two vault quotes the seed placed on NVDA weekly1-r0,
 * ladders of daily and weekly NVDA and TSLA calls. The harness warps into the next regular session (10:00 New York)
 * and pushes a fresh feed round per market, then serves a stand-in pricing service: GET /fair prices every series with
 * the pricing service's own Black-Scholes (pricing/bs.ts, trading-time years) at the devnet oracle's spot and a fixed
 * vol, asOf = the head block's time (the real service needs the live Cboe chain, which cannot follow a warped clock).
 * The MM bot runs in process with a 5-minute poll; the harness drives it with wake() and only ever trades like a user.
 *
 *   0  stale database  the bot's database is seeded as an earlier devnet would have left it: the same addresses,
 *                      another deployment anchor, the vault's order index and the series cursor at this chain's head.
 *                      Trusted, it would adopt none of the seed's orders and scan no series (A would fail); the bot
 *                      must reset it at boot (a warning in its log) and record this chain's anchor
 *   A  quotes          two-sided vault quotes (a Bid and an ask) on >= 5 series, each inside the vault's bid cap and
 *                      ask floor, bid < fair < ask; at most one order per kind per series; the seed's orders adopted
 *   B  discipline      a second tick with nothing moved sends nothing (no replace under MM_REQUOTE_BPS)
 *   C  no fair         /fair answers null for TSLA: every TSLA vault quote is pulled, NVDA untouched
 *   D  taker fill      a buyer lifts a vault AskWrite (its taker-side fees capped by TakeParams.maxTotalFee, the v8
 *                      rule): the vault is short, the sale is booked at the seller fee of its OrderFilled log,
 *                      /state's net delta goes negative, the skew raises the quotes, and the vault's quotes are
 *                      replaced higher on chain
 *   E  rent and cap    INTERFACE_VERSION 7: every advertised AskWrite is fillable WHOLE at the head block —
 *                      OrderBook.quoteTake answers its full remaining units, collateral plus the Clearinghouse's
 *                      rent — and the asks on one asset together fit in the vault's free collateral. Then the Safe,
 *                      through the admin driver, drops maxDailyOutflow under what the bids escrow (a TREASURY_ADMIN
 *                      call, so it warps 24 h): the next tick trims them inside the
 *                      remaining allowance instead of reverting, /state shows the budget, and v2_mm_outflow pages
 *   F  kill switch     POST /kill without or with a wrong token: 401; with MM_KILL_TOKEN: every vault order cancelled
 *                      (no live order left on the book); a later tick places nothing; POST /resume quotes again
 *   G  journal         every journalled transaction confirmed; gas used under the fixed limits; no v2_error or
 *                      v2_tx_revert alert; v2_mm_killed and v2_mm_outflow raised
 *
 * Environment: DEVNET_PORT (default 8546, up.sh's), CONTRACTS_DIR (passed to up.sh), DEVNET_REUSE=1 (use the devnet
 * already up on the port: it must be freshly seeded), DEVNET_KEEP=1 (leave anvil running). Output, the bot's log and its
 * database go to a temporary directory printed at start. Exit 0 = passed. Anvil public dev keys only; no key file read.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { destination, pino } from 'pino';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, toHex, type Abi, type Address, type Hash } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { makerVaultAbi } from '../abi/makerVault.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { loadV2Config, type MmConfig } from '../config.js';
import { resolveDevnetPricingUrl } from '../devnet-pricing-url.js';
import { bsDelta, bsPrice, tradingYears } from '../pricing/bs.js';
import { bigintReplacer, V2Store } from '../store.js';
import { collateralNeeded, remainingLife } from '../mintFee.js';
import { MM_GAS } from './constants.js';
import { startMm, type StartedMm } from './main.js';
import { MM_META, MmStore } from './mm-store.js';

const KEEPER_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = resolve(KEEPER_DIR, '..');
const DEVNET_DIR = join(ROOT, 'ops', 'devnet');
const PORT = Number(process.env.DEVNET_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = mkdtempSync(join(tmpdir(), 'mm-devnet-'));
const KILL_TOKEN = randomBytes(32).toString('hex');
/** The stand-in pricing service's vols (the seed prices its asks with the same). */
/**
 * `type(uint128).max` for `TakeParams.maxTotalFee`, i.e. NO cap. Correct for a QUOTE -- `quoteTake` does not
 * enforce the field (IOrderBook.sol:137) -- and WRONG for a take, where it would make `FeeAboveMax` unreachable
 * and turn a real protection into decoration. Every take in this file derives its bound from a quote instead.
 */
const UINT128_MAX = (1n << 128n) - 1n;

const IV: Record<string, number> = { NVDA: 0.55, TSLA: 0.65 };

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

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

/**
 * A MakerVault `setLimits` through the ONE admin driver, never straight from an admin EOA.
 *
 * Under v8 `MakerVault.setLimits((uint64,uint128,uint16,uint16,uint32,uint128))` is TREASURY_ADMIN
 * (`ops/abis/v2/roles.json` targets.MakerVault) and that role carries a real 86,400 s delay
 * (`roles.json` delaysS.TREASURY_ADMIN), so a direct `sendAs(admin, ...)` reverts. Every devnet admin call goes
 * schedule -> warp -> execute as the impersonated Safe, through `ops/v2/devnet-admin.mjs` (06-QUIRKS D.8).
 *
 * The signature string is spelled EXACTLY as roles.json spells it, because the driver looks the role up by that
 * string; a differently-spaced equivalent is a different key and finds no role.
 *
 * NOTE THE SIDE EFFECT, which section E has to live with: executing a TREASURY_ADMIN call warps the chain
 * forward past the delay. See the comment at the head of section E2.
 */
const SET_LIMITS_SIG = 'setLimits((uint64,uint128,uint16,uint16,uint32,uint128))';
type VaultLimits = { maxSeriesUnits: bigint; maxTotalNotional: bigint; askToleranceBps: number; maxBidBpsOfSpot: number; maxOrderLifetime: number; maxDailyOutflow: bigint };
async function setVaultLimits(vault: Address, limits: VaultLimits, label: string): Promise<void> {
  const tuple = JSON.stringify([
    String(limits.maxSeriesUnits), String(limits.maxTotalNotional), limits.askToleranceBps,
    limits.maxBidBpsOfSpot, limits.maxOrderLifetime, String(limits.maxDailyOutflow),
  ]);
  const { code, out } = await run('node', ['ops/v2/devnet-admin.mjs', vault, SET_LIMITS_SIG, tuple], {});
  if (code !== 0) throw new Error(`${label}: devnet-admin.mjs exited ${code}\n${out}`);
}

async function sendAs(from: Address, call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<unknown> {
  const { result } = await pub.simulateContract({ ...call, account: from } as never);
  const wallet = createWalletClient({ account: from, chain, transport: http(RPC) });
  const hash = (await wallet.writeContract({ ...call, account: from, chain, gas: 3_000_000n } as never)) as Hash;
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
  if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted (${hash})`);
  return result;
}

async function setFeed(args: string[]): Promise<void> {
  const r = await run(process.execPath, [join(DEVNET_DIR, 'set-feed.mjs'), ...args], { DEVNET_PORT: String(PORT) });
  if (r.code !== 0) throw new Error(`set-feed.mjs ${args.join(' ')} failed:\n${r.out}`);
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function waitFor(what: string, condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(1_000);
  }
  say(`  (timed out after ${timeoutMs} ms waiting for ${what})`);
  return false;
}

async function health(mm: StartedMm): Promise<{ tickInFlight: boolean; ticks: number; lastTickError: { message: string } | null }> {
  return (await (await fetch(`http://127.0.0.1:${mm.port}/health`)).json()) as { tickInFlight: boolean; ticks: number; lastTickError: { message: string } | null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function state(mm: StartedMm): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${mm.port}/state`);
  return res.status === 200 ? res.json() : null;
}

/** Run one more tick now and wait until it has finished (the bot idle), so a check never races a send. */
async function tick(mm: StartedMm, timeoutMs = 300_000): Promise<void> {
  await waitFor('an idle bot', async () => !(await health(mm)).tickInFlight, timeoutMs);
  const start = (await health(mm)).ticks;
  mm.wake?.();
  await waitFor('the tick', async () => {
    const h = await health(mm);
    return h.ticks > start && !h.tickInFlight;
  }, timeoutMs);
  const h = await health(mm);
  if (h.lastTickError !== null) say(`  (last tick error: ${h.lastTickError.message})`);
}

/*//////////////////////////////////////////////////////////////
                         DEVNET VIEWS
//////////////////////////////////////////////////////////////*/

interface Devnet {
  contracts: { clearinghouse: Address; orderBook: Address; settlementOracle: Address; expiryCalendar: Address; makerVault: Address | null };
  markets: Array<{ ticker: string; underlying: Address }>;
  accounts: Record<string, Address>;
}

interface BookOrder {
  id: bigint;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const KIND = ['Bid', 'AskResale', 'AskWrite'] as const;

/** Every order the vault ever placed, with its state now. */
async function vaultOrders(D: Devnet): Promise<BookOrder[]> {
  const vault = D.contracts.makerVault!;
  const count = await read<bigint>(D.contracts.orderBook, orderBookAbi, 'makerOrderCount', [vault]);
  if (count === 0n) return [];
  const [ids] = await read<readonly [readonly bigint[], bigint]>(D.contracts.orderBook, orderBookAbi, 'ordersOfMaker', [vault, 0n, count]);
  const orders = await read<ReadonlyArray<Omit<BookOrder, 'id'>>>(D.contracts.orderBook, orderBookAbi, 'getOrders', [ids]);
  return orders.map((o, i) => ({ ...o, id: ids[i]!, units: BigInt(o.units), filled: BigInt(o.filled), price: BigInt(o.price), validUntil: Number(o.validUntil), kind: Number(o.kind) }));
}

const isLive = (o: BookOrder, t: number) => !o.cancelled && o.filled < o.units && t < o.validUntil;

/** Live vault orders grouped by series. */
async function liveBySeries(D: Devnet): Promise<Map<string, BookOrder[]>> {
  const t = await now();
  const out = new Map<string, BookOrder[]>();
  for (const o of await vaultOrders(D)) {
    if (!isLive(o, t)) continue;
    const list = out.get(o.longId.toString()) ?? [];
    list.push(o);
    out.set(o.longId.toString(), list);
  }
  return out;
}

const twoSided = (orders: BookOrder[]) => orders.some((o) => o.kind === 0) && orders.some((o) => o.kind !== 0);

/*//////////////////////////////////////////////////////////////
                    STAND-IN PRICING SERVICE
//////////////////////////////////////////////////////////////*/

const money = (raw: bigint) => ({ raw: raw.toString(), decimals: 6, formatted: (Number(raw) / 1e6).toFixed(6) });

function startPricing(D: Devnet, nullTickers: Set<string>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body, bigintReplacer));
      };
      if (url.pathname !== '/fair') return send(404, { error: 'not found' });
      const ticker = url.searchParams.get('ticker') ?? '';
      const market = D.markets.find((m) => m.ticker === ticker);
      if (market === undefined) return send(404, { error: { code: 'unknown-ticker' } });
      if (nullTickers.has(ticker)) return send(200, { fair: null, reason: 'chain-stale', detail: 'devnet harness: switched off' });
      const strike = Number(url.searchParams.get('strike')) / 1e6;
      const expiry = Number(url.searchParams.get('expiry'));
      const type = url.searchParams.get('type') === 'put' ? 'put' : 'call';
      const head = await now();
      const [ok, spotRaw] = await read<readonly [boolean, bigint, bigint]>(D.contracts.settlementOracle, settlementOracleAbi, 'trySpot', [market.underlying]);
      if (!ok) return send(200, { fair: null, reason: 'spot-stale', detail: 'oracle trySpot not ok' });
      const spot = Number(spotRaw) / 1e6;
      const t = tradingYears(head, expiry);
      const input = { type, spot, strike, vol: IV[ticker] ?? 0.5, t } as const;
      const fair = BigInt(Math.round(bsPrice(input) * 1e6));
      send(200, { fair: money(fair), iv: input.vol, delta: bsDelta(input), source: 'model', spot: money(spotRaw), asOf: head });
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

/*//////////////////////////////////////////////////////////////
                              MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  say(`MM devnet test on ${RPC}; output in ${OUT}`);
  if (process.env.DEVNET_REUSE !== '1') {
    step('ops/devnet/up.sh');
    const up = await run(join(DEVNET_DIR, 'up.sh'), [], { DEVNET_PORT: String(PORT), ...(process.env.CONTRACTS_DIR ? { CONTRACTS_DIR: process.env.CONTRACTS_DIR } : {}) }, join(OUT, 'devnet-up.log'));
    if (up.code !== 0) throw new Error(`up.sh failed (log ${join(OUT, 'devnet-up.log')}):\n${up.out.split('\n').slice(-30).join('\n')}`);
    say(`  devnet up (log ${join(OUT, 'devnet-up.log')})`);
  }
  const addressesFile = join(DEVNET_DIR, 'addresses.json');
  if (!existsSync(addressesFile)) throw new Error(`${addressesFile} missing: run ops/devnet/up.sh`);
  const D = JSON.parse(readFileSync(addressesFile, 'utf8')) as Devnet;
  if (D.contracts.makerVault === null) throw new Error('this devnet has no MakerVault (DEV_MAKER_SUITE=0)');
  const vault = getAddress(D.contracts.makerVault);
  const NVDA = D.markets.find((m) => m.ticker === 'NVDA')!;
  const TSLA = D.markets.find((m) => m.ticker === 'TSLA')!;

  step('warp into the next regular session (10:00 New York) and push a fresh round per market');
  const t0 = await now();
  let target: number | null = null;
  for (let day = Math.floor(t0 / 86_400); target === null && day <= Math.floor(t0 / 86_400) + 10; day += 1) {
    if (!(await read<boolean>(D.contracts.expiryCalendar, expiryCalendarAbi, 'isSessionDay', [day]))) continue;
    const tenAm = Number(await read<bigint>(D.contracts.expiryCalendar, expiryCalendarAbi, 'closeOf', [day])) - 23_400 + 1_800;
    if (tenAm > t0 && (await read<boolean>(D.contracts.expiryCalendar, expiryCalendarAbi, 'isRegularSession', [tenAm]))) target = tenAm;
  }
  if (target === null) throw new Error(`no regular session within 10 days of ${t0}`);
  await warpTo(target);
  await setFeed(['--all']);
  say(`  chain time ${await now()} (was ${t0})`);
  const seededLive = await liveBySeries(D);
  say(`  the seed left ${[...seededLive.values()].flat().length} live vault order(s)`);

  const nullTickers = new Set<string>();
  const pricingUrl = resolveDevnetPricingUrl(process.argv.slice(2), process.env);
  const standIn = pricingUrl.url === null;
  const pricing = standIn ? await startPricing(D, nullTickers) : null;
  say(standIn ? `  stand-in pricing service on ${pricing!.url}` : `  real pricing service at ${pricingUrl.url} (${pricingUrl.source}): the stand-in is off`);

  step('start the MM bot (in process, startMm) on env/mm-bot.env');
  const env = {
    ...parseEnvFile(join(DEVNET_DIR, 'env', 'mm-bot.env')),
    KEEPER_DB_PATH: join(OUT, 'mm.db'),
    MM_PORT: '0',
    PRICING_URL: standIn ? pricing!.url : pricingUrl.url!,
    MM_KILL_TOKEN: KILL_TOKEN,
    // Five minutes: the harness drives every tick with wake().
    POLL_INTERVAL_MS: '300000',
    KEEPER_TX_TIMEOUT_MS: '60000',
    KEEPER_LOG_LEVEL: 'info',
    MM_MAX_SERIES: '16',
    MM_MAX_SERIES_PER_MARKET: '8',
    MM_BID_UNITS: '100',
    MM_ASK_UNITS: '100',
    MM_MAX_TX_PER_TICK: '120',
    // A strong skew, so one 100-unit fill moves every NVDA quote past MM_REQUOTE_BPS.
    MM_SKEW_BPS_PER_DELTA_SHARE: '500',
    MM_MAX_SKEW_BPS: '2000',
    MM_REQUOTE_BPS: '300',
  };
  const config = loadV2Config(env) as MmConfig;

  step('0. seed the database as an earlier devnet at the same addresses would have left it');
  const deployBlock = config.registry.deployBlock;
  if (deployBlock === null) throw new Error('the devnet registry copy has no v2.deployBlock');
  const anchorNow = `${deployBlock}:${(await pub.getBlock({ blockNumber: deployBlock })).hash.toLowerCase()}`;
  const staleAnchor = `${deployBlock}:0x${'00'.repeat(32)}`;
  const staleOrders = await read<bigint>(D.contracts.orderBook, orderBookAbi, 'makerOrderCount', [vault]);
  const staleCursor = await pub.getBlockNumber();
  {
    const file = new V2Store(env.KEEPER_DB_PATH);
    const stale = new MmStore(file);
    stale.bind({ chainId: config.chainId, clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, vault: config.contracts.makerVault });
    stale.bindAnchor(staleAnchor);
    stale.ingestOrders([], staleOrders, 0);
    stale.applySeriesRange([], staleCursor);
    file.close();
  }
  say(`  stale file: anchor ${staleAnchor.slice(0, 24)}..., makerIndex ${staleOrders}, series cursor ${staleCursor}; this chain's anchor ${anchorNow}`);

  const log = pino({ level: 'info', base: { service: 'callhouse-mm', mode: 'mm' } }, destination({ dest: join(OUT, 'mm.log'), sync: true }));
  const mm = await startMm(config, { log });
  say(`  quoter ${getAddress(D.accounts.mmQuoter!)} vault ${vault} port ${mm.port}; log ${join(OUT, 'mm.log')}; db ${env.KEEPER_DB_PATH}`);

  try {
    /* ---------------------------------------------------------------- A */
    step('A. two-sided quotes');
    await waitFor('the first tick', async () => {
      const h = await health(mm);
      return h.ticks >= 1 && !h.tickInFlight;
    }, 600_000);
    const hA = await health(mm);
    check(hA.lastTickError === null, `A: the first tick ran without error${hA.lastTickError ? ` (${hA.lastTickError.message})` : ''}`);
    {
      const db = new Database(env.KEEPER_DB_PATH, { readonly: true });
      const meta = (key: string) => (db.prepare('SELECT value FROM v2_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
      const recorded = meta(MM_META.anchor);
      const cursor = meta(MM_META.scannedTo);
      const series = (db.prepare('SELECT COUNT(*) AS n FROM v2_mm_series').get() as { n: number }).n;
      db.close();
      const reset = readFileSync(join(OUT, 'mm.log'), 'utf8').split('\n').filter((l) => l.includes('"check":"changed"') && l.includes('another deployment at the same addresses'));
      check(reset.length === 1, `0: the bot logged that it reset the stale database (${reset.length} warning(s))`);
      check(recorded === anchorNow, `0: the database now records this chain's anchor (${recorded})`);
      check(series > 0 && cursor !== null && BigInt(cursor) >= staleCursor, `0: the series were rescanned from the deploy block (${series} series, cursor ${cursor})`);
    }
    const stA = await state(mm);
    const liveA = await liveBySeries(D);
    const tA = await now();
    const two = [...liveA].filter(([, orders]) => twoSided(orders));
    say(`  ${two.length} series quoted on both sides on chain; /state: ${stA?.quoting?.twoSided} two-sided of ${stA?.quoting?.selected} selected (${JSON.stringify(stA?.quoting?.byHalt)})`);
    check(two.length >= 5, `A: two-sided vault quotes on >= 5 series (${two.length})`);
    let inside = 0;
    let fairOk = 0;
    let onePerKind = true;
    for (const [longId, orders] of two) {
      const bid = orders.find((o) => o.kind === 0)!;
      const asks = orders.filter((o) => o.kind !== 0);
      const floor = await read<bigint>(vault, makerVaultAbi, 'askFloor', [BigInt(longId)]);
      const cap = await read<bigint>(vault, makerVaultAbi, 'bidCap', [BigInt(longId)]);
      if (bid.price <= cap && asks.every((a) => a.price >= floor && a.price > bid.price)) inside += 1;
      for (const k of [0, 1, 2]) if (orders.filter((o) => o.kind === k).length > 1) onePerKind = false;
      const row = (stA?.series ?? []).find((s: { longId: string }) => s.longId === longId);
      const fair = row?.fair?.fair === undefined ? null : BigInt(row.fair.fair);
      if (fair !== null && bid.price < fair && asks.every((a) => a.price > fair)) fairOk += 1;
    }
    check(inside === two.length, `A: every two-sided quote is inside the vault's bid cap and ask floor, bid under ask (${inside}/${two.length})`);
    check(fairOk === two.length, `A: bid < fair < ask on every two-sided series (${fairOk}/${two.length})`);
    check(onePerKind, 'A: at most one vault order per kind per series');
    const seedSeries = [...seededLive.keys()];
    check(seedSeries.every((id) => (liveA.get(id) ?? []).length <= 3), `A: the seed's vault orders were adopted, not duplicated (${seedSeries.length} series)`);
    check(tA < Number(stA?.session?.close ?? 0), `A: quoting inside the regular session (close ${stA?.session?.close})`);
    const nvdaDeltaA = (stA?.netDelta ?? []).find((r: { ticker: string }) => r.ticker === 'NVDA');
    say(`  /state net delta NVDA: ${nvdaDeltaA?.deltaShares} shares over ${nvdaDeltaA?.positions} position(s)`);

    /* ---------------------------------------------------------------- B */
    step('B. replace discipline: nothing moved, nothing sent');
    const journalCount = () => {
      const db = new Database(env.KEEPER_DB_PATH, { readonly: true });
      const n = (db.prepare("SELECT COUNT(*) AS n FROM v2_txs WHERE kind IN ('mm-place', 'mm-replace', 'mm-cancel')").get() as { n: number }).n;
      db.close();
      return n;
    };
    const beforeB = journalCount();
    await tick(mm);
    const stB = await state(mm);
    const afterB = journalCount();
    check(afterB === beforeB, `B: a tick with no market move sent no place, replace or cancel (${afterB - beforeB} sent: ${JSON.stringify((stB?.lastTxs ?? []).map((t: { what: string }) => t.what))})`);

    /* ---------------------------------------------------------------- C */
    let stC: any;
    if (standIn) {
      step('C. /fair null for TSLA: its quotes are pulled');
      const tslaLiveBefore = [...(await liveBySeries(D))].filter(([id]) => (stB?.series ?? []).some((s: { longId: string; ticker: string }) => s.longId === id && s.ticker === 'TSLA'));
      say(`  TSLA series with live vault orders before: ${tslaLiveBefore.length}`);
      nullTickers.add('TSLA');
      await tick(mm);
      stC = await state(mm);
      const liveC = await liveBySeries(D);
      const tslaIds = new Set((stC?.series ?? []).filter((s: { ticker: string }) => s.ticker === 'TSLA').map((s: { longId: string }) => s.longId));
      const tslaLiveAfter = [...liveC.keys()].filter((id) => tslaIds.has(id));
      const tslaHalts = (stC?.series ?? []).filter((s: { ticker: string; selected: boolean }) => s.ticker === 'TSLA' && s.selected).map((s: { halt: { halt: string } | null }) => s.halt?.halt ?? 'none');
      check(tslaLiveBefore.length > 0 && tslaLiveAfter.length === 0, `C: no live vault order left on TSLA (${tslaLiveBefore.length} series before, ${tslaLiveAfter.length} after)`);
      check(tslaHalts.length > 0 && tslaHalts.every((h: string) => h === 'fair-unavailable'), `C: every selected TSLA series halts fair-unavailable (${[...new Set(tslaHalts)].join(', ')})`);
      check([...liveC].filter(([, o]) => twoSided(o)).length >= 5, 'C: NVDA still quoted on both sides on >= 5 series');
      nullTickers.delete('TSLA');
    } else {
      step('C. skipped: a real pricing service cannot be told to turn TSLA null; the default path covers it');
      stC = await state(mm);
    }

    /* ---------------------------------------------------------------- D */
    step('D. a taker lifts a vault ask: the inventory skews the quotes');
    const liveD0 = await liveBySeries(D);
    const nvdaRows = (stC?.series ?? []).filter((s: { ticker: string; quote: unknown; fair: unknown }) => s.ticker === 'NVDA' && s.quote !== null && s.fair !== null);
    // The series nearest the money with a live vault AskWrite.
    const pick = nvdaRows
      .map((s: { longId: string; fair: { delta: number } }) => ({ row: s, ask: (liveD0.get(s.longId) ?? []).find((o) => o.kind === 2) }))
      .filter((x: { ask: BookOrder | undefined }) => x.ask !== undefined)
      .sort((a: { row: { fair: { delta: number } } }, b: { row: { fair: { delta: number } } }) => Math.abs(a.row.fair.delta - 0.5) - Math.abs(b.row.fair.delta - 0.5))[0] as { row: { longId: string; fair: { delta: number }; quote: { bid: string; ask: string; skew: string } }; ask: BookOrder } | undefined;
    if (pick === undefined) throw new Error('no NVDA series with a live vault AskWrite to lift');
    const longIdD = BigInt(pick.row.longId);
    const bidsBefore = new Map([...liveD0].map(([id, orders]) => [id, orders.find((o) => o.kind === 0)?.price ?? null]));
    const quotesBefore = new Map<string, { bid: bigint | null; ask: bigint }>(
      nvdaRows.map((s: { longId: string; quote: { bid: string | null; ask: string } }) => [s.longId, { bid: s.quote.bid === null ? null : BigInt(s.quote.bid), ask: BigInt(s.quote.ask) }]),
    );
    const cy = getAddress(D.accounts.cy!);
    // INTERFACE_VERSION 8 RETIRES THE DEADLINE-CAP WORKAROUND. Up to v7 this take capped its deadline at
    // `pendingFeeParams().effectiveAt - 1` so a scheduled fee change could not overcharge it: the take paid the
    // fees it was quoted or reverted DeadlinePassed. That was a PROXY for the real concern -- it refused by TIME,
    // which also refuses perfectly good fills -- and v8 states the concern directly with `TakeParams.maxTotalFee`.
    // So the cap, the `pendingFeeParams` read that existed only to feed it, and the deadline arithmetic are gone,
    // and the deadline is now an ordinary one-hour bound.
    const takeAt = await now();
    const takeFrom = await pub.getBlockNumber();
    const deadline = takeAt + 3_600;
    const takeParams = {
      longId: longIdD,
      buying: true,
      orderIds: [pick.ask.id],
      units: pick.ask.units - pick.ask.filled,
      minUnits: 1n,
      limitPrice: pick.ask.price,
      writeToSell: false,
      recipient: cy,
      deadline,
    };
    // The cap is DERIVED from a quote of the same params, never `type(uint128).max`, which would make FeeAboveMax
    // unreachable and turn the protection into decoration. `quoteTake` does not enforce the cap (IOrderBook.sol:137),
    // so the quote is taken with it wide open and its answer sets the real bound. Buying, so the cap is the taker
    // fee alone: the seller fee on an ask hit is the MAKER's (OrderBook quoteTake returns sellerFees as 0 on a buy).
    const [, , quotedTakerFee] = await read<readonly [bigint, bigint, bigint, bigint]>(
      D.contracts.orderBook, orderBookAbi, 'quoteTake', [{ ...takeParams, maxTotalFee: UINT128_MAX }],
    );
    await sendAs(cy, {
      address: D.contracts.orderBook,
      abi: orderBookAbi,
      functionName: 'take',
      args: [{ ...takeParams, maxTotalFee: quotedTakerFee }],
    });
    const [, , detail] = await read<readonly [bigint, bigint, { shorts: bigint }]>(vault, makerVaultAbi, 'exposure', [longIdD]);
    say(`  cy bought ${pick.ask.units - pick.ask.filled} units of ${pick.row.longId} (delta ${pick.row.fair.delta.toFixed(3)}) from vault order ${pick.ask.id} at ${pick.ask.price}; the vault holds ${detail.shorts} shorts`);
    check(detail.shorts > 0n, 'D: the fill left the vault short the series');
    await tick(mm);
    const stD = await state(mm);
    const nvdaDelta = (stD?.netDelta ?? []).find((r: { ticker: string }) => r.ticker === 'NVDA');
    say(`  /state net delta NVDA: ${nvdaDelta?.deltaShares} shares (${nvdaDelta?.deltaUsdg} USDG) over ${nvdaDelta?.positions} position(s)`);
    check(nvdaDelta !== undefined && nvdaDelta.deltaShares < 0, `D: /state reports a negative NVDA net delta (${nvdaDelta?.deltaShares})`);
    check((stD?.recentFills ?? []).some((f: { longId: string; side: string }) => f.longId === pick.row.longId && f.side === 'sell'), 'D: the bot recorded the fill (a sale) in its ledger');
    // The sale is booked at the seller fee the book took (its OrderFilled log), not at the fees read when it was seen.
    const filledLogs = await pub.getContractEvents({ address: D.contracts.orderBook, abi: orderBookAbi, eventName: 'OrderFilled', args: { orderId: pick.ask.id }, fromBlock: takeFrom, toBlock: 'latest' });
    const logFee = filledLogs.reduce((sum, l) => sum + (l.args as { sellerFee: bigint }).sellerFee, 0n);
    const booked = (stD?.recentFills ?? []).find((f: { orderId: string }) => f.orderId === pick.ask.id.toString()) as { fee?: { basis: string; sellerFee?: string } } | undefined;
    check(filledLogs.length >= 1 && booked?.fee?.basis === 'exact' && booked.fee.sellerFee === logFee.toString(), `D: the sale is booked from its OrderFilled log: seller fee ${booked?.fee?.sellerFee ?? '-'} (${booked?.fee?.basis ?? 'no fee record'}) = the log's ${logFee}`);
    const rowsD = (stD?.series ?? []).filter((s: { ticker: string; quote: unknown }) => s.ticker === 'NVDA' && s.quote !== null);
    const skewed = rowsD.filter((s: { quote: { skew: string } }) => BigInt(s.quote.skew) < 0n);
    let raised = 0;
    for (const s of rowsD as Array<{ longId: string; quote: { bid: string | null; ask: string } }>) {
      const before = quotesBefore.get(s.longId);
      if (before !== undefined && BigInt(s.quote.ask) > before.ask && (s.quote.bid === null || before.bid === null || BigInt(s.quote.bid) >= before.bid)) raised += 1;
    }
    check(skewed.length >= 1 && skewed.length === rowsD.length, `D: every quoted NVDA series carries a negative skew (quotes up) (${skewed.length}/${rowsD.length})`);
    check(raised >= 1, `D: the target quotes moved up after the fill on ${raised} series`);
    const liveD = await liveBySeries(D);
    let replacedHigher = 0;
    for (const [id, orders] of liveD) {
      const bid = orders.find((o) => o.kind === 0);
      const before = bidsBefore.get(id);
      if (bid !== undefined && before !== undefined && before !== null && bid.price > before) replacedHigher += 1;
    }
    const replaces = (stD?.lastTxs ?? []).filter((t: { type: string; status: string }) => t.type === 'replace' && t.status === 'confirmed').length;
    check(replacedHigher >= 1 && replaces >= 1, `D: the vault's bids were replaced higher on chain on ${replacedHigher} series (${replaces} replace(s) confirmed)`);
    check([...liveD].filter(([, o]) => twoSided(o)).length >= 5, 'D: still two-sided on >= 5 series');

    /* ---------------------------------------------------------------- E */
    step('E. INTERFACE_VERSION 7: every write ask is fillable whole (collateral + rent), and the daily outflow cap trims bids');
    // E1. RENT. OrderBook._reserveCollateral budgets units x collateralPerUnit PLUS the Clearinghouse's rent and
    // SKIPS a write-on-fill order the maker cannot cover, without reverting. quoteTake plans exactly as take does,
    // so a vault AskWrite whose quote answers fewer than its remaining units is depth that is not there.
    const liveE = await liveBySeries(D);
    const writeAsks = [...liveE].flatMap(([longId, orders]) => orders.filter((o) => o.kind === 2).map((o) => ({ longId: BigInt(longId), o })));
    check(writeAsks.length > 0, `E: the vault advertises ${writeAsks.length} write ask(s) to quote`);
    const tE = await now();
    let fillable = 0;
    const needByAsset = new Map<string, bigint>();
    for (const { longId, o } of writeAsks) {
      const remaining = o.units - o.filled;
      // FOUR return values, not three: INTERFACE_VERSION 8 appended `sellerFees`. Declaring three here was a silent
      // type lie -- only `unitsFilled` is read, so nothing failed, which is exactly why it survived.
      // `maxTotalFee` is wide open because this is a QUOTE and quoteTake does not enforce the cap (IOrderBook.sol:137);
      // the section-D take that actually pays derives a real bound from its own quote.
      const [unitsFilled] = await read<readonly [bigint, bigint, bigint, bigint]>(D.contracts.orderBook, orderBookAbi, 'quoteTake', [
        { longId, buying: true, orderIds: [o.id], units: remaining, minUnits: 1n, limitPrice: o.price, writeToSell: false, recipient: getAddress(D.accounts.cy!), deadline: tE + 600, maxTotalFee: UINT128_MAX },
      ]);
      if (unitsFilled === remaining) fillable += 1;
      else say(`       order ${o.id}: quoteTake fills ${unitsFilled} of ${remaining}`);
      const series = await read<{ mintFeePpm: number; expiry: number; isPut: boolean }>(D.contracts.clearinghouse, clearinghouseAbi, 'series', [longId]);
      const asset = (await read<Address>(D.contracts.clearinghouse, clearinghouseAbi, 'collateralAsset', [longId])).toLowerCase();
      const cpu = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'collateralPerUnit', [longId]);
      needByAsset.set(asset, (needByAsset.get(asset) ?? 0n) + collateralNeeded(remaining, cpu, Number(series.mintFeePpm), remainingLife(Number(series.expiry), tE)));
    }
    check(fillable === writeAsks.length, `E: every advertised write ask fills whole under OrderBook.quoteTake, rent included (${fillable}/${writeAsks.length})`);
    let assetsOk = 0;
    for (const [asset, need] of needByAsset) {
      const free = await read<bigint>(D.contracts.clearinghouse, clearinghouseAbi, 'free', [vault, asset as Address]);
      if (need <= free) assetsOk += 1;
      say(`       ${asset}: the write asks need ${need} (collateral + rent) of ${free} free`);
    }
    check(assetsOk === needByAsset.size, `E: the write asks on each asset fit together in the vault's free collateral (${assetsOk}/${needByAsset.size})`);
    const ppms = await Promise.all([...liveE.keys()].map((id) => read<{ mintFeePpm: number }>(D.contracts.clearinghouse, clearinghouseAbi, 'series', [BigInt(id)])));
    check(ppms.some((s) => Number(s.mintFeePpm) > 0), `E: the devnet's series carry a non-zero mintFeePpm (${[...new Set(ppms.map((s) => Number(s.mintFeePpm)))].join(', ')} ppm), so the rent is really exercised`);

    // E2. THE OUTFLOW CAP. Drop maxDailyOutflow to a third of what the vault's live bids escrow and let the bot
    // re-plan: it must quote SMALLER bids inside what is left, never send a place the cap would refuse.
    const limitsBefore = await read<{ maxSeriesUnits: bigint; maxTotalNotional: bigint; askToleranceBps: number; maxBidBpsOfSpot: number; maxOrderLifetime: number; maxDailyOutflow: bigint }>(vault, makerVaultAbi, 'limits');
    const bidEscrow = [...liveE.values()].flat().filter((o) => o.kind === 0).reduce((sum, o) => sum + (o.price * (o.units - o.filled)) / 100n, 0n);
    const lowCap = bidEscrow / 3n;
    check(bidEscrow > 0n && lowCap > 0n, `E: the vault's live bids escrow ${bidEscrow} USDG base units; the cap goes to ${lowCap}`);
    // E2 AND THE 24 h WARP. Both setLimits calls below go through the admin driver, which for a TREASURY_ADMIN
    // call schedules, WARPS THE CHAIN 86,400 s (roles.json delaysS.TREASURY_ADMIN) and then executes. That warp
    // lands in the middle of a section that asserts a DAILY outflow bucket, so the assertions after it are read
    // against a chain a day older than the one the bids were placed on. What that does to each of them is written
    // out in the ledger entry for this task; the short version is that `outflow()` used/available resets with the
    // day, and any order whose validUntil or expiry fell inside the warp is gone. Do not read the checks below as
    // if the clock had not moved.
    await setVaultLimits(vault, { ...limitsBefore, maxDailyOutflow: lowCap }, 'E2: drop the daily outflow cap');
    const [usedE, availableE] = await read<readonly [bigint, bigint]>(vault, makerVaultAbi, 'outflow');
    say(`  cap ${limitsBefore.maxDailyOutflow} -> ${lowCap}; outflow() used ${usedE}, available ${availableE}`);
    await tick(mm);
    const stOut = await state(mm);
    const outflowState = stOut?.vaultState?.outflow;
    say(`  /state outflow: ${JSON.stringify(outflowState)}`);
    check(BigInt(outflowState?.capUsdg6 ?? -1) === lowCap, `E: /state reads the new cap (${outflowState?.capUsdg6})`);
    check(outflowState?.blocked === true, 'E: the bot reports the cap as binding');
    check(BigInt(outflowState?.plannedThisTickUsdg6 ?? -1n) <= BigInt(outflowState?.budgetThisTickUsdg6 ?? 0n), `E: the tick plans no more bid escrow than the cap allows (${outflowState?.plannedThisTickUsdg6} of ${outflowState?.budgetThisTickUsdg6})`);
    check((stOut?.quoting?.capped ?? []).some((c: { caps: string[] }) => c.caps.includes('outflow')), 'E: at least one series is capped by `outflow`');
    const escrowAfter = [...(await liveBySeries(D)).values()].flat().filter((o) => o.kind === 0).reduce((sum, o) => sum + (o.price * (o.units - o.filled)) / 100n, 0n);
    check(escrowAfter < bidEscrow, `E: the vault's live bid escrow came down (${bidEscrow} -> ${escrowAfter})`);
    const [usedAfter] = await read<readonly [bigint, bigint]>(vault, makerVaultAbi, 'outflow');
    check(usedAfter <= lowCap, `E: the bucket never went past the cap (used ${usedAfter} of ${lowCap}): no place was refused`);
    check((stOut?.lastTxs ?? []).every((t: { status: string }) => t.status !== 'simulation-reverted'), 'E: no vault call was refused on chain');
    // Put the cap back, so the kill switch and the journal checks run against the deployed configuration.
    // This is a SECOND TREASURY_ADMIN call and therefore a second 24 h warp: by the time section F runs the chain
    // is two days past where section E started.
    await setVaultLimits(vault, limitsBefore, 'E2: restore the daily outflow cap');

    /* ---------------------------------------------------------------- F */
    step('F. the kill switch');
    const killUrl = `http://127.0.0.1:${mm.port}/kill`;
    const noAuth = await fetch(killUrl, { method: 'POST' });
    const wrong = await fetch(killUrl, { method: 'POST', headers: { authorization: `Bearer ${randomBytes(32).toString('hex')}` } });
    check(noAuth.status === 401 && wrong.status === 401, `F: /kill without a token and with a wrong token: 401 (${noAuth.status}, ${wrong.status})`);
    check((await liveBySeries(D)).size > 0, 'F: the refused requests cancelled nothing');
    const killed = await fetch(killUrl, { method: 'POST', headers: { authorization: `Bearer ${KILL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'devnet harness' }) });
    const killBody = (await killed.json()) as { done: boolean; cancelled: number; remaining: number; errors: string[] };
    say(`  /kill: ${killed.status} ${JSON.stringify(killBody)}`);
    check(killed.status === 200 && killBody.done && killBody.remaining === 0 && killBody.cancelled > 0, `F: /kill with MM_KILL_TOKEN answered 200 done after cancelling ${killBody.cancelled} order(s)`);
    const tF = await now();
    const leftE = (await vaultOrders(D)).filter((o) => !o.cancelled && o.filled < o.units && (o.kind !== 2 || tF < o.validUntil));
    check(leftE.length === 0, `F: the vault has no order with units left on the book (${leftE.length})`);
    await tick(mm);
    const stE = await state(mm);
    check((await liveBySeries(D)).size === 0, 'F: a tick after the kill placed nothing');
    check(stE?.killed?.reason === 'devnet harness' && (stE?.lastTxs ?? []).every((t: { type: string }) => t.type === 'cancel'), `F: /state is killed and the tick sent no place or replace (${(stE?.lastTxs ?? []).length} tx)`);
    const resumed = await fetch(`http://127.0.0.1:${mm.port}/resume`, { method: 'POST', headers: { authorization: `Bearer ${KILL_TOKEN}` } });
    check(resumed.status === 200, `F: /resume with the token: ${resumed.status}`);
    await tick(mm);
    const liveR = await liveBySeries(D);
    check([...liveR].filter(([, o]) => twoSided(o)).length >= 5, `F: after /resume two-sided quotes are back on >= 5 series (${[...liveR].filter(([, o]) => twoSided(o)).length})`);
    // Leave the book clean.
    const finalKill = await fetch(killUrl, { method: 'POST', headers: { authorization: `Bearer ${KILL_TOKEN}` } });
    const finalBody = (await finalKill.json()) as { done: boolean };
    check(finalKill.status === 200 && finalBody.done && (await liveBySeries(D)).size === 0, 'F: a second kill clears the book again');

    /* ---------------------------------------------------------------- G */
    step('G. journal, gas, alerts');
    await waitFor('an idle bot', async () => !(await health(mm)).tickInFlight, 120_000);
    await mm.close();
    const db = new Database(env.KEEPER_DB_PATH, { readonly: true });
    const txs = db.prepare('SELECT kind, status, COUNT(*) AS n, MAX(CAST(gas_used AS INTEGER)) AS maxGas FROM v2_txs GROUP BY kind, status ORDER BY kind').all() as Array<{ kind: string; status: string; n: number; maxGas: number | null }>;
    say(`  journal: ${txs.map((t) => `${t.kind}/${t.status} ${t.n} (max gas ${t.maxGas})`).join(', ')}`);
    check(txs.some((t) => t.kind === 'mm-place' && t.status === 'success') && txs.some((t) => t.kind === 'mm-replace' && t.status === 'success') && txs.some((t) => t.kind === 'mm-cancel' && t.status === 'success'), 'G: the journal has confirmed places, replaces and cancels');
    check(!txs.some((t) => t.status !== 'success'), 'G: every journalled transaction confirmed (none reverted, pending or dropped)');
    const perCancel = db.prepare("SELECT to_address, gas_used, tx_key FROM v2_txs WHERE kind = 'mm-cancel' AND status = 'success'").all() as Array<{ gas_used: string; tx_key: string }>;
    const cancelOk = perCancel.every((r) => BigInt(r.gas_used) * 10n < (MM_GAS.cancelBase + MM_GAS.cancelEach * BigInt(r.tx_key.split(',').length)) * 9n);
    const placeMax = txs.filter((t) => t.kind === 'mm-place').reduce((m, t) => Math.max(m, t.maxGas ?? 0), 0);
    const replaceMax = txs.filter((t) => t.kind === 'mm-replace').reduce((m, t) => Math.max(m, t.maxGas ?? 0), 0);
    check(BigInt(placeMax) * 10n < MM_GAS.place * 9n && BigInt(replaceMax) * 10n < MM_GAS.replace * 9n && cancelOk, `G: gas used stays under 90 % of the fixed limits (place ${placeMax} / ${MM_GAS.place}, replace ${replaceMax} / ${MM_GAS.replace}, cancels ok: ${cancelOk})`);
    const alerts = db.prepare('SELECT kind, message FROM v2_alerts ORDER BY id').all() as Array<{ kind: string; message: string }>;
    say(`  alerts: ${alerts.map((a) => a.kind).join(', ') || 'none'}`);
    check(alerts.some((a) => a.kind === 'v2_mm_killed'), 'G: v2_mm_killed was raised');
    check(alerts.some((a) => a.kind === 'v2_mm_outflow'), 'G: v2_mm_outflow was raised while the cap was binding');
    check(!alerts.some((a) => a.kind === 'v2_mm_outflow_foreign'), 'G: no v2_mm_outflow_foreign: every base unit of the bucket is this bot\'s own');
    const bad = alerts.filter((a) => a.kind === 'v2_error' || a.kind === 'v2_tx_revert' || a.kind === 'v2_mm_tx_rejected');
    check(bad.length === 0, `G: no v2_error, v2_tx_revert or v2_mm_tx_rejected alert${bad.map((a) => `\n         ${a.kind}: ${a.message}`).join('')}`);
    db.close();
  } finally {
    await mm.close().catch(() => undefined);
    pricing?.server.close();
  }
}

let exitCode = 0;
try {
  await main();
  if (failures.length > 0) {
    say(`\nMM DEVNET FAILED: ${failures.length} check(s)\n  ${failures.join('\n  ')}`);
    exitCode = 1;
  } else {
    say('\nMM DEVNET PASSED');
  }
} catch (error) {
  say(`\nMM DEVNET FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  exitCode = 1;
} finally {
  if (process.env.DEVNET_KEEP !== '1' && process.env.DEVNET_REUSE !== '1') {
    const down = await run(join(DEVNET_DIR, 'down.sh'), [], { DEVNET_PORT: String(PORT) });
    say(down.out.trim() === '' ? `devnet on ${PORT} stopped` : down.out.trim());
  } else {
    say(`devnet left running on ${RPC}`);
  }
}
process.exit(exitCode);
