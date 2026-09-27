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
 * ladders of daily and weekly NVDA and second-market calls (SPCX). The harness warps into the next regular session (10:00 New York)
 * and pushes a fresh feed round per market, then serves a stand-in pricing service: GET /fair prices every series with
 * the pricing service's own Black-Scholes (pricing/bs.ts, trading-time years) at the devnet oracle's spot and a fixed
 * vol, asOf = the head block's time (the real service needs the live option chain, Massive, which cannot follow a warped clock).
 * The MM bot runs in process with a 5-minute poll; the harness drives it with wake() and only ever trades like a user.
 *
 *   0  stale database  the bot's database is seeded as an earlier devnet would have left it: the same addresses,
 *                      another deployment anchor, the vault's order index and the series cursor at this chain's head.
 *                      Trusted, it would adopt none of the seed's orders and scan no series (A would fail); the bot
 *                      must reset it at boot (a warning in its log) and record this chain's anchor
 *   A  quotes          two-sided vault quotes (a Bid and an ask) on >= 5 series, each inside the vault's bid cap and
 *                      ask floor, bid < fair < ask; at most one order per kind per series; the seed's orders adopted
 *   B  discipline      a second tick with nothing moved sends nothing (no replace under MM_REQUOTE_BPS)
 *   C  no fair         /fair answers null for the second market: every one of its vault quotes is pulled, NVDA untouched
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
 * --safe-call: section H INSTEAD of A-G, on its own fresh devnet so no inventory from D skews a quote. The
 * safe-call-selling stack at its defaults (spot-lag floor on), one New York session driven by the clock:
 *   H0 limits       the vault limits (askToleranceBps 0, maxOrderLifetime 300) set through the admin driver
 *   H1 open-grace         09:50, a fresh chain inside the first MM_OPEN_GRACE_S (1800 s): every series halts
 *                         open-grace, nothing is quoted, v2_mm_open_grace pages
 *      pre-open chain     10:02 (after H4's 10:00 row), a /fair chain dated before the 09:30 open: every series refuses it,
 *                         nothing is placed; the halt is fair-before-open, which fairCheckOf judges before fair-stale
 *                         although the chain is also > MM_FAIR_MAX_AGE_S old once open-grace ends
 *   H2 spot-lag floor     10:02, a fresh chain: the floor raises the asks (/state lag.raised) and no ask rests under it
 *   H3 replace-below-floor   an ask pushed under its spot-lag floor on chain is replaced by the next tick
 *   H4 worked example     the worked example's rows (10:00 K 232.50/235/240, 12:00 K 232.50, 14:00 K 232.50) on 16:00 NVDA calls at
 *                         spot 229.03, iv 0.45, askIv 0.495, and the ask/fair band; /state's ask-iv tag
 *   H5 spot-age   a quiet market whose pool corroborates its old print is NOT halted; the Chainlink-only
 *                         market with the same old print is, and pages v2_mm_spot_age
 *   H6 events   an events.json row on the expiry day halts the series event-uncertainty and pages
 *   H7 markouts  a fill on a vault ask shows up in /state's markouts with its +1 and +5 minute marks
 *   H8 write stop    14:30: no AskWrite on the day's series, none placed earlier valid past 14:30; bids carry on
 * The stand-in serves askIv / vega / gamma and the event flag the way pricing/server.ts does (see startPricing).
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
import { quoteTakeAs } from '../quoteTake.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { loadV2Config, type MmConfig } from '../config.js';
import { resolveDevnetPricingUrl } from '../devnet-pricing-url.js';
import { bsDelta, bsGamma, bsPrice, bsVega, sessionOpenOf, tradingYears } from '../pricing/bs.js';
import { EVENT_UNCERTAINTY, eventCalendar, eventsInWindow, type EventCalendar } from '../pricing/short-maturity.js';
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
const SAFE_CALL = process.argv.includes('--safe-call');
/** The stand-in pricing service's vols (the seed prices its asks with the same). */
/**
 * `type(uint128).max` for `TakeParams.maxTotalFee`, i.e. NO cap. Correct for a QUOTE -- `quoteTake` does not
 * enforce the field (IOrderBook.sol:137) -- and WRONG for a take, where it would make `FeeAboveMax` unreachable
 * and turn a real protection into decoration. Every take in this file derives its bound from a quote instead.
 */
const UINT128_MAX = (1n << 128n) - 1n;

/** Seeded vols by ticker; any other market (the devnet's Chainlink-only one, SPCX) takes IV_OTHER. */
const IV: Record<string, number> = { NVDA: 0.55 };
const IV_OTHER = 0.65;

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
 * schedule -> warp -> execute as the impersonated Safe, through `ops/v2/devnet-admin.mjs`.
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
  markets: Array<{ ticker: string; underlying: Address; pool: Address | null }>;
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

/** Knobs only section H (--safe-call) turns on; A-G pass none, and their /fair body is unchanged. */
interface StandInOptions {
  /** Vol per ticker, over IV / IV_OTHER. */
  iv?: Record<string, number>;
  /** A number here is served as /fair's asOf instead of the head's time: a chain dated before the open. */
  asOf?: () => number | null;
  /** askIv = iv x this, beside the Black-Scholes vega and gamma, as pricing/server.ts serves them. */
  askIvMarkup?: number;
  /** An event calendar: /fair then carries `event` and `quality` as pricing/server.ts does (short-maturity.ts). */
  events?: () => EventCalendar | null;
}

function startPricing(D: Devnet, nullTickers: Set<string>, opts: StandInOptions = {}): Promise<{ server: Server; url: string }> {
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
      const input = { type, spot, strike, vol: opts.iv?.[ticker] ?? IV[ticker] ?? IV_OTHER, t } as const;
      const fair = BigInt(Math.round(bsPrice(input) * 1e6));
      const body: Record<string, unknown> = { fair: money(fair), iv: input.vol, delta: bsDelta(input), source: 'model', spot: money(spotRaw), asOf: opts.asOf?.() ?? head };
      if (opts.askIvMarkup !== undefined) {
        Object.assign(body, { askIv: Number((input.vol * opts.askIvMarkup).toFixed(6)), vega: bsVega(input), gamma: bsGamma(input) });
      }
      const calendar = opts.events?.() ?? null;
      if (calendar !== null) {
        // pricing/server.ts serializes the event flag top-level and names an in-window event in quality.reasons.
        const ev = eventsInWindow(calendar.get(ticker) ?? null, head, expiry);
        body.event = { input: ev.input, inWindow: ev.inWindow };
        body.quality = { readiness: 'ready', reasons: ev.inWindow ? [EVENT_UNCERTAINTY] : [], uncertainty: null };
      }
      send(200, body);
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

/*//////////////////////////////////////////////////////////////
          H. SAFE CALL SELLING: --safe-call
//////////////////////////////////////////////////////////////*/

/**
 * Safe call selling, the rows a fresh 1-minute print reproduces (the print-over-30-minutes row would
 * also trip the spot-age halt on a devnet whose pool does not sit at 229.03, so it is not driven here):
 * NVDA calls expiring 16:00 New York, oracle spot = /fair spot = 229.03, iv 0.45, askIv 0.495, launch fees, engine
 * defaults. USDG per share. `v8 ask` is not observable (the bot quotes only the merged ask) and is not checked.
 */
const WORKED_ROWS = [
  { at: '10:00', offsetS: 1_800, strike: 232.5, fair: 1.145, lagFair: 1.5202, floorWrite: 1.6004, ask: 1.907 },
  { at: '10:00', offsetS: 1_800, strike: 235, fair: 0.5841, lagFair: 0.8141, floorWrite: 0.8571, ask: 1.0697 },
  { at: '10:00', offsetS: 1_800, strike: 240, fair: 0.1118, lagFair: 0.1732, floorWrite: 0.1825, ask: 0.2648 },
  { at: '12:00', offsetS: 9_000, strike: 232.5, fair: 0.7632, lagFair: 1.0959, floorWrite: 1.1537, ask: 1.3828 },
  { at: '14:00', offsetS: 16_200, strike: 232.5, fair: 0.3283, lagFair: 0.5754, floorWrite: 0.6058, ask: 0.7698 },
] as const;
const WORKED_SPOT = '229.03';
const WORKED_IV = 0.45;
const WORKED_ASK_IV_MARKUP = 1.1;
/**
 * The bot prices at its head block, which anvil's 1-second block time moves a few seconds past the row's instant
 * while the tick runs; a few seconds out of hours of time value moves a 4-decimal figure by well under 0.5 %.
 */
const WORKED_TOLERANCE = 0.005;
/**
 * MM env keys the section removes so the bot runs at the ENGINE defaults the doc's table is computed at, not the launch
 * proposals ops/v2-env.mjs renders: MM_EXPIRY_WIDEN_BPS 30,000 (default 20,000) widens the 14:00 row, and
 * MM_PULL_MINUTES 60 pulls everything at 14:30, on top of the write stop this section must see alone. The spot-lag,
 * fair-from-session and write-stop keys are removed too, so each takes its default whatever the rendered file says.
 */
const SAFE_CALL_DEFAULTED = ['MM_EXPIRY_WIDEN_BPS', 'MM_PULL_MINUTES', 'MM_SPOT_LAG_BPS', 'MM_SPOT_LAG_STALE_BPS', 'MM_FAIR_FROM_SESSION', 'MM_WRITE_STOP_MINUTES'];

const usd = (raw: string | bigint | null | undefined) => (raw === null || raw === undefined ? null : Number(BigInt(raw)) / 1e6);
const within = (got: number | null, want: number) => got !== null && Math.abs(got - want) <= Math.max(want * WORKED_TOLERANCE, 0.0002);
/** The New York calendar day of a unix time, YYYY-MM-DD (the event calendar's key). */
const nyDay = (unix: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unix * 1000));

async function safeCall(D: Devnet, vault: Address, NVDA: Devnet['markets'][number], SINGLE: Devnet['markets'][number]): Promise<void> {
  const admin = getAddress(D.accounts.admin!);
  const quoter = getAddress(D.accounts.quoter!);
  const cy = getAddress(D.accounts.cy!);

  /* ---------------------------------------------------------------- H0 */
  step('H0. T-MM2-03 limits on this devnet vault (askToleranceBps 0, maxOrderLifetime 300), through the admin driver');
  // The admin has not set these limits on 4663 yet (it needs the Admin Safe), so the devnet vault gets the same two values
  // by the same TREASURY_ADMIN path the Safe batch takes: schedule, the 24 h warp, execute (devnet-admin.mjs).
  const limitsBefore = await read<VaultLimits>(vault, makerVaultAbi, 'limits');
  await setVaultLimits(vault, { ...limitsBefore, askToleranceBps: 0, maxOrderLifetime: 300 }, 'H0: T-MM2-03 limits');
  const limits = await read<VaultLimits>(vault, makerVaultAbi, 'limits');
  check(limits.askToleranceBps === 0 && limits.maxOrderLifetime === 300 && limits.maxDailyOutflow === limitsBefore.maxDailyOutflow,
    `H0: vault limits askToleranceBps ${limitsBefore.askToleranceBps} -> ${limits.askToleranceBps}, maxOrderLifetime ${limitsBefore.maxOrderLifetime} -> ${limits.maxOrderLifetime}, the rest unchanged`);

  // The next FULL session day (a 16:00 close, like the worked example's) at least an hour ahead, so its series can still be created.
  const t0 = await now();
  let close: number | null = null;
  for (let day = Math.floor(t0 / 86_400); close === null && day <= Math.floor(t0 / 86_400) + 10; day += 1) {
    if (!(await read<boolean>(D.contracts.expiryCalendar, expiryCalendarAbi, 'isSessionDay', [day]))) continue;
    const c = Number(await read<bigint>(D.contracts.expiryCalendar, expiryCalendarAbi, 'closeOf', [day]));
    if (sessionOpenOf(c - 60) === c - 23_400 && c - 23_400 - 900 > t0) close = c;
  }
  if (close === null) throw new Error(`no full session day within 10 days of ${t0}`);
  const open = close - 23_400;
  const writeStopAt = close - 1_800 - 3_600;
  say(`  session ${nyDay(open)}: open ${open}, write stop ${writeStopAt}, close/expiry ${close}`);

  /* ---------------------------------------------------------------- series + bot */
  step('H. 09:20: spot 229.03, the §5 series (16:00 NVDA calls 232.50 / 235 / 240), the stand-in and a fresh MM bot');
  await warpTo(open - 600);
  const fresh = async () => {
    await setFeed(['NVDA', '--price', WORKED_SPOT]);
    await setFeed(['--all']);
  };
  await fresh();
  const strikes = new Map<string, number>();
  for (const k of [232.5, 235, 240]) {
    const longId = (await sendAs(admin, { address: D.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'createSeries', args: [NVDA.underlying, false, BigInt(Math.round(k * 1e6)), close] })) as bigint;
    strikes.set(longId.toString(), k);
  }
  say(`  created ${[...strikes].map(([id, k]) => `K ${k}: ${id}`).join(', ')}`);

  let asOfOverride: number | null = null;
  let eventsOverride: EventCalendar | null = null;
  const pricing = await startPricing(D, new Set(), { iv: { NVDA: WORKED_IV }, asOf: () => asOfOverride, askIvMarkup: WORKED_ASK_IV_MARKUP, events: () => eventsOverride });
  const env: Record<string, string> = {
    ...parseEnvFile(join(DEVNET_DIR, 'env', 'mm-bot.env')),
    KEEPER_DB_PATH: join(OUT, 'mm-safe.db'),
    MM_PORT: '0',
    PRICING_URL: pricing.url,
    MM_KILL_TOKEN: KILL_TOKEN,
    POLL_INTERVAL_MS: '300000',
    KEEPER_TX_TIMEOUT_MS: '60000',
    KEEPER_LOG_LEVEL: 'info',
    MM_MAX_TX_PER_TICK: '120',
  };
  const removed = SAFE_CALL_DEFAULTED.filter((k) => k in env).map((k) => `${k}=${env[k]}`);
  for (const k of SAFE_CALL_DEFAULTED) delete env[k];
  say(`  engine defaults for ${SAFE_CALL_DEFAULTED.join(', ')}${removed.length ? ` (the rendered mm-bot.env had ${removed.join(', ')})` : ''}`);
  const config = loadV2Config(env) as MmConfig;
  const t = config.tuning as unknown as Record<string, unknown>;
  say(`  spotLagBps ${t.spotLagBps}, spotLagStaleBps ${t.spotLagStaleBps}, fairFromSession ${t.fairFromSession}, writeStopMinutes ${t.writeStopMinutes}, pullMinutes ${t.pullMinutes}, openGraceS ${t.openGraceS}`);
  const logFile = join(OUT, 'mm-safe.log');
  const log = pino({ level: 'info', base: { service: 'callhouse-mm', mode: 'mm' } }, destination({ dest: logFile, sync: true }));
  const mm = await startMm(config, { log });
  say(`  MM bot port ${mm.port}; log ${logFile}; db ${env.KEEPER_DB_PATH}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = any;
  /** /state rows of the day's NVDA series, keyed by long id. */
  const dayRows = (st: Row): Row[] => (st?.series ?? []).filter((r: Row) => r.ticker === 'NVDA' && Number(r.expiry) === close);
  const liveOn = async (ids: Iterable<string>) => {
    const live = await liveBySeries(D);
    return [...ids].flatMap((id) => live.get(id) ?? []);
  };
  const alertsOf = (kind: string) => {
    const db = new Database(env.KEEPER_DB_PATH!, { readonly: true });
    const rows = db.prepare('SELECT message FROM v2_alerts WHERE kind = ? ORDER BY id').all(kind) as Array<{ message: string }>;
    db.close();
    return rows.map((r) => r.message);
  };
  const at = async (offsetS: number, freshFeed = true) => {
    await warpTo(open + offsetS);
    if (freshFeed) await fresh();
  };

  try {
    await waitFor('the first tick', async () => {
      const h = await health(mm);
      return h.ticks >= 1 && !h.tickInFlight;
    }, 600_000);

    /* ---------------------------------------------------------------- H1 */
    // The market maker does nothing in the first MM_OPEN_GRACE_S (1800 s) of the
    // session. So 09:50 is open-grace for every market whatever the chain says; fair-before-open is driven at 10:02,
    // after the worked example's 10:00 row (the clock only moves forward).
    step(`H1. 09:50, a fresh chain inside the first ${config.tuning.openGraceS} s of the open: every market waits (open-grace, T-OP-309)`);
    await at(1_200);
    await tick(mm);
    const st0 = await state(mm);
    const rows0 = dayRows(st0);
    const grace = rows0.filter((r: Row) => r.halt?.halt === 'open-grace');
    say(`  /state: ${grace.length} of ${rows0.length} day series halted open-grace; e.g. "${grace[0]?.halt?.detail}"`);
    check(rows0.length >= 1 && grace.length === rows0.length, `H1: every day series halts open-grace inside the first ${config.tuning.openGraceS} s (${grace.length} of ${rows0.length})`);
    check((await liveOn(rows0.map((r: Row) => r.longId))).length === 0, 'H1: nothing is quoted on them');
    check(alertsOf('v2_mm_open_grace').length >= 1, 'H1: v2_mm_open_grace paged');

    /* ---------------------------------------------------------------- H4 */
    step('H4. §5 worked example: the rows, the ask/fair band, and the ask-iv tag');
    // The band is over the worked-example strikes, the calls near the money the 1.7-2.4x target is about. The deep OTM ladder
    // strikes also on this expiry sit on the minimum-premium floor (MM_MIN_PREMIUM_USDG6, clampedBy intrinsic-buffer /
    // min-premium), where ask/fair is not a markup at all; they are printed, not banded.
    const ratios: number[] = [];
    const record = async (label: string) => {
      await tick(mm);
      const st = await state(mm);
      for (const r of dayRows(st)) {
        if (r.quote === null || r.fair === null) continue;
        const fair = usd(r.fair.fair)!;
        const ask = usd(r.quote.ask)!;
        const strike = strikes.get(r.longId);
        if (fair > 0 && WORKED_ROWS.some((w) => w.at === label && w.strike === strike)) ratios.push(ask / fair);
        say(`  ${label} K ${strike ?? `(ladder) ${usd(r.strike)}`}: fair ${fair}, lagFair ${usd(r.lag?.lagFair)}, floor.write ${usd(r.lag?.floor?.write)}, ask ${ask} (${(ask / fair).toFixed(2)}x), tags ${JSON.stringify(r.quote.clampedBy)}`);
      }
      return st;
    };
    const checkRows = (st: Row, when: string) => {
      for (const w of WORKED_ROWS.filter((x) => x.at === when)) {
        const r = dayRows(st).find((x: Row) => strikes.get(x.longId) === w.strike);
        if (r === undefined || r.quote === null) {
          check(false, `H4: ${when} K ${w.strike} is priced (${r?.halt?.halt ?? 'no row'}: ${r?.halt?.detail ?? ''})`);
          continue;
        }
        const got = { fair: usd(r.fair.fair), lagFair: usd(r.lag?.lagFair), floorWrite: usd(r.lag?.floor?.write), ask: usd(r.quote.ask) };
        const ok = within(got.fair, w.fair) && within(got.lagFair, w.lagFair) && within(got.floorWrite, w.floorWrite) && within(got.ask, w.ask);
        check(ok, `H4: ${when} K ${w.strike} matches §5 within ${WORKED_TOLERANCE * 100} %: fair ${got.fair}/${w.fair}, lagFair ${got.lagFair}/${w.lagFair}, floor.write ${got.floorWrite}/${w.floorWrite}, ask ${got.ask}/${w.ask}`);
      }
    };
    await at(1_800);
    const st10 = await record('10:00');
    checkRows(st10, '10:00');
    const tagged = dayRows(st10).filter((r: Row) => (r.quote?.clampedBy ?? []).includes('ask-iv'));
    check(tagged.length >= 1, `H4: /state tags ${tagged.length} day quote(s) ask-iv (T-OP-220 raised them by vega x (askIv - iv))`);
    const stateText = JSON.stringify(st10);
    const mtm10 = (st10?.vaults ?? [])[0]?.mtm;
    say(`  /state vaults[0].mtm: ${JSON.stringify(mtm10)}`);
    check(/"mtm"/.test(stateText) && mtm10 !== null && mtm10 !== undefined && 'total' in mtm10 && 'limit' in mtm10, 'H4: /state exposes the mark-to-market plan (T-OP-220 mtmLossStop: realised, unrealised, total, limit)');

    /* ---------------------------------------------------------------- H1 (cont) */
    // 10:02, not 10:05: the 10:00 quotes live maxOrderLifetime (300 s), and a tick in their last second can plan a
    // replace that loses the race to validUntil (the OrderNotLive finding); two minutes early keeps H1-H3 clear of it.
    // The halt is fair-before-open. Once open-grace ends (now >= open + MM_OPEN_GRACE_S, 1800) a chain dated before the
    // open is also more than MM_FAIR_MAX_AGE_S (1800) old, but engine.ts fairCheckOf judges
    // fair-before-open BEFORE fair-stale, so the halt names the cause (a pre-open chain), not its age. That order applies
    // while MM_FAIR_FROM_SESSION=1, which is its default and which this section leaves at the default (SAFE_CALL_DEFAULTED).
    // engine.test.ts covers the rule itself; what H1 proves here is the property: a pre-open chain is never quoted.
    step('H1 (cont). 10:02, a /fair chain dated 09:29:59 (before the open): refused fair-before-open (judged before fair-stale, T-OP-456)');
    asOfOverride = open - 1;
    await at(1_920);
    // The chain's age is logged for the record only: fairCheckOf judges fair-before-open first, whatever the age.
    const chainAge = (await now()) - (open - 1);
    await tick(mm);
    const st1 = await state(mm);
    const rows1 = dayRows(st1);
    const refused = rows1.filter((r: Row) => r.halt?.halt === 'fair-stale' || r.halt?.halt === 'fair-before-open');
    const byHalt = rows1.reduce((m: Record<string, number>, r: Row) => ({ ...m, [r.halt?.halt ?? 'priced']: (m[r.halt?.halt ?? 'priced'] ?? 0) + 1 }), {});
    say(`  /state: ${JSON.stringify(byHalt)} over ${rows1.length} day series; e.g. "${refused[0]?.halt?.detail}"`);
    const expected = 'fair-before-open';
    check(rows1.length >= 1 && rows1.every((r: Row) => r.halt?.halt === expected), `H1: every day series refuses the pre-open chain with ${expected} (chain ${chainAge} s old, fairMaxAgeS ${config.tuning.fairMaxAgeS}, openGraceS ${config.tuning.openGraceS})`);
    check(rows1.length >= 1 && (await liveOn(rows1.map((r: Row) => r.longId))).length === 0, 'H1: nothing is quoted on any day series while its chain predates the open');

    /* ---------------------------------------------------------------- H2 */
    step('H2. 10:02, the chain dated now: the spot-lag floor raises the asks');
    asOfOverride = null;
    await tick(mm);
    const st2 = await state(mm);
    const rows2 = dayRows(st2).filter((r: Row) => r.quote !== null && r.lag);
    const raised = rows2.filter((r: Row) => r.lag.raised === true);
    for (const r of rows2) {
      say(`  K ${strikes.get(r.longId)}: fair ${usd(r.fair?.fair)}, lagFair ${usd(r.lag.lagFair)} (spotQ ${usd(r.lag.spotQ)}, band ${r.lag.bandBps} bps), floor.write ${usd(r.lag.floor.write)}, ask ${usd(r.quote.ask)}, raised ${r.lag.raised}`);
    }
    check(raised.length >= 1, `H2: the spot-lag floor raised the ask on ${raised.length} of ${rows2.length} priced day series`);
    const live2 = await liveOn(rows2.map((r: Row) => r.longId));
    const underFloor = live2.filter((o) => o.kind === 2 && o.price < BigInt(rows2.find((r: Row) => r.longId === o.longId.toString())!.lag.floor.write));
    check(live2.some((o) => o.kind === 2) && underFloor.length === 0, `H2: every live vault AskWrite on those series is at or above its spot-lag floor (${live2.filter((o) => o.kind === 2).length} asks, ${underFloor.length} under)`);

    /* ---------------------------------------------------------------- H3 */
    step('H3. an ask pushed under its spot-lag floor is replaced by the next tick');
    const target = live2.find((o) => o.kind === 2);
    if (target === undefined) throw new Error('H3: no live vault AskWrite to push under its floor');
    const floorW = BigInt(rows2.find((r: Row) => r.longId === target.longId.toString())!.lag.floor.write);
    // The AskWrite's own floor (askFloorOf per ask kind, the read both vault kinds have).
    const vaultFloor = await read<bigint>(vault, makerVaultAbi, 'askFloorOf', [target.longId, true]);
    const low = [((floorW * 7n) / 10n / 100n) * 100n, ((vaultFloor + 99n) / 100n) * 100n].reduce((a, b) => (a > b ? a : b));
    await sendAs(quoter, { address: vault, abi: makerVaultAbi, functionName: 'replace', args: [target.id, low, target.units - target.filled] });
    const pushed = (await liveOn([target.longId.toString()])).find((o) => o.kind === 2)!;
    say(`  order ${target.id} (${target.price}) replaced by the quoter key as ${pushed.id} at ${pushed.price}, under the floor ${floorW}`);
    await tick(mm);
    const replaceLines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('below the spot-lag floor'));
    say(`  log: ${replaceLines[0]?.slice(0, 300) ?? '(none)'}`);
    const after3 = (await liveOn([target.longId.toString()])).find((o) => o.kind === 2);
    check(replaceLines.length >= 1, 'H3: the bot logged a replace of the ask below the spot-lag floor');
    check(after3 !== undefined && after3.id !== pushed.id && after3.price >= floorW, `H3: the ask is back at or above its floor (${after3?.price} >= ${floorW}, order ${after3?.id})`);

    /* ---------------------------------------------------------------- H5 */
    step('H5. 11:05, a quiet market: the pool-corroborated NVDA print is not spot-age halted; the Chainlink-only market is');
    await warpTo(open + 5_400);
    await setFeed(['NVDA', '--pool']);
    await setFeed(['--all']);
    await tick(mm);
    await warpTo(open + 5_700);
    await tick(mm);
    const st5 = await state(mm);
    const halted = (ticker: string) => (st5?.series ?? []).filter((r: Row) => r.ticker === ticker && r.halt?.halt === 'spot-age');
    const nvdaPriced = (st5?.series ?? []).filter((r: Row) => r.ticker === 'NVDA' && r.quote !== null).length;
    say(`  prints 300 s old: NVDA ${halted('NVDA').length} series spot-age (${nvdaPriced} priced), ${SINGLE.ticker} ${halted(SINGLE.ticker).length} series spot-age; e.g. "${halted(SINGLE.ticker)[0]?.halt?.detail}"`);
    check(halted('NVDA').length === 0 && nvdaPriced >= 1, 'H5: NVDA, whose pool corroborates the old print, is not halted spot-age and is still priced');
    check(halted(SINGLE.ticker).length >= 1, `H5: ${SINGLE.ticker}, Chainlink only, is halted spot-age on the same 300 s old print`);
    check(alertsOf('v2_mm_spot_age').some((m) => m.includes(SINGLE.ticker)) && !alertsOf('v2_mm_spot_age').some((m) => m.includes(' NVDA ')), `H5: v2_mm_spot_age paged for ${SINGLE.ticker} only`);

    step('H4 (cont). 12:00 on a 1-minute-old print');
    await at(8_940);
    await warpTo(open + 9_000);
    const st12 = await record('12:00');
    checkRows(st12, '12:00');

    /* ---------------------------------------------------------------- H6 */
    step('H6. 13:00, an events.json row on the expiry day: event-uncertainty and its page');
    await at(12_600);
    eventsOverride = eventCalendar({ NVDA: { events: [{ date: nyDay(close), kind: 'earnings', timing: null }], through: nyDay(close) } });
    await tick(mm);
    const st6 = await state(mm);
    const evHalted = dayRows(st6).filter((r: Row) => r.halt?.halt === 'event-uncertainty');
    say(`  ${evHalted.length} day series halted event-uncertainty; e.g. "${evHalted[0]?.halt?.detail}"; page: ${alertsOf('v2_mm_event_halt')[0] ?? '(none)'}`);
    check(evHalted.length >= 1 && (await liveOn(evHalted.map((r: Row) => r.longId))).filter((o) => o.kind !== 0).length === 0, 'H6: an event row on the expiry day halts its series event-uncertainty and pulls their asks');
    check(alertsOf('v2_mm_event_halt').length >= 1, 'H6: v2_mm_event_halt paged');
    eventsOverride = null;

    step('H4 (cont). 14:00 on a 1-minute-old print');
    await at(16_140);
    await warpTo(open + 16_200);
    const st14 = await record('14:00');
    checkRows(st14, '14:00');
    const band = ratios.length === 0 ? null : { lo: Math.min(...ratios), hi: Math.max(...ratios) };
    say(`  ask/fair over the §5 quotes: ${band === null ? 'none' : `${band.lo.toFixed(2)}x - ${band.hi.toFixed(2)}x`} (${ratios.length} quotes)`);
    check(band !== null && ratios.length === WORKED_ROWS.length && band.lo >= 1.6 && band.hi <= 2.45, `H4: the ask/fair band on the §5 0DTE OTM calls is the doc's 1.7-2.4x (${band?.lo.toFixed(2)}x - ${band?.hi.toFixed(2)}x over ${ratios.length})`);

    /* ---------------------------------------------------------------- H7 */
    step('H7. a buyer lifts a vault ask: /state markouts at +1 and +5 minutes (T-OP-222)');
    const live7 = await liveOn(dayRows(st14).map((r: Row) => r.longId));
    const ask7 = live7.find((o) => o.kind === 2);
    if (ask7 === undefined) throw new Error('H7: no live vault AskWrite to lift');
    const takeAt = await now();
    const takeParams = { longId: ask7.longId, buying: true, orderIds: [ask7.id], units: ask7.units - ask7.filled, minUnits: 1n, limitPrice: ask7.price, writeToSell: false, recipient: cy, deadline: takeAt + 3_600 };
    // quoteTake is simulated as the taker (cy); with no `from` it reverts NotAuthorized.
    const [, , quotedTakerFee] = await quoteTakeAs(pub, D.contracts.orderBook, cy, { ...takeParams, maxTotalFee: UINT128_MAX });
    await sendAs(cy, { address: D.contracts.orderBook, abi: orderBookAbi, functionName: 'take', args: [{ ...takeParams, maxTotalFee: quotedTakerFee }] });
    say(`  cy bought ${takeParams.units} units of ${ask7.longId} (K ${strikes.get(ask7.longId.toString())}) from vault order ${ask7.id} at ${ask7.price}`);
    // The bot dates a fill by the tick that first sees it (mm/fills.ts: `at: head.timestamp`), not by the fill's
    // block. The live bot polls every 15 s (ops/v2/env/mm-bot.env POLL_INTERVAL_MS); this harness polls every 5
    // minutes and ticks on wake(), so it ticks once now, as the live poll would, and measures the checkpoints from
    // the time /state records. Warping first put the record at +90 s and left the +5 minute mark past the last tick.
    await tick(mm);
    const seen = ((await state(mm))?.vaults ?? []).flatMap((v: Row) => v.markouts ?? []).find((m: Row) => m.longId === ask7.longId.toString());
    if (seen === undefined) throw new Error('H7: the tick after the take did not record the fill in /state markouts');
    const fillAt = Number(seen.at);
    say(`  the take's block ~${takeAt}; /state records the fill at ${fillAt} (+${fillAt - takeAt} s)`);
    // With margin: a checkpoint is marked by the first tick at or after it, so +61 / +301 could land a second early.
    for (const offset of [90, 360]) {
      await warpTo(fillAt + offset);
      await fresh();
      await tick(mm);
    }
    const st7 = await state(mm);
    const marks = (st7?.vaults ?? []).flatMap((v: Row) => v.markouts ?? []);
    const mark = marks.find((m: Row) => m.longId === ask7.longId.toString());
    say(`  /state markouts: ${JSON.stringify(mark ?? null).slice(0, 400)}`);
    check(mark !== undefined && mark.marks?.['60s'] !== 'pending' && mark.marks?.['300s'] !== 'pending', `H7: /state lists the fill with its +1 and +5 minute markouts (${JSON.stringify(mark?.marks ?? null).slice(0, 160)})`);

    /* ---------------------------------------------------------------- H8 */
    step('H8. 14:30, the write stop');
    await warpTo(writeStopAt);
    await fresh();
    await tick(mm);
    const st8 = await state(mm);
    const rows8 = dayRows(st8);
    const held = rows8.filter((r: Row) => r.writeHold?.hold === 'write-cutoff');
    say(`  ${held.length} of ${rows8.length} day series writeHold write-cutoff; e.g. "${held[0]?.writeHold?.detail}"`);
    check(held.length >= 1, 'H8: the day series hold their writes (write-cutoff)');
    const dayIds = new Set(rows8.map((r: Row) => r.longId as string));
    const orders8 = (await vaultOrders(D)).filter((o) => dayIds.has(o.longId.toString()));
    const liveWrites = orders8.filter((o) => o.kind === 2 && isLive(o, writeStopAt));
    const lateWrites = orders8.filter((o) => o.kind === 2 && o.validUntil > writeStopAt);
    check(liveWrites.length === 0, `H8: no vault AskWrite is live on the day series at 14:30 (${liveWrites.length})`);
    check(lateWrites.length === 0, `H8: no vault AskWrite ever placed on them is valid past 14:30 (${orders8.filter((o) => o.kind === 2).length} placed today)`);
    check(orders8.some((o) => o.kind === 0 && isLive(o, writeStopAt)), 'H8: the bids carry on after the write stop');

    /* ---------------------------------------------------------------- end */
    step('H. journal and alerts');
    await waitFor('an idle bot', async () => !(await health(mm)).tickInFlight, 120_000);
    const db = new Database(env.KEEPER_DB_PATH!, { readonly: true });
    const alerts = db.prepare('SELECT kind, message FROM v2_alerts ORDER BY id').all() as Array<{ kind: string; message: string }>;
    const txs = db.prepare('SELECT kind, status, COUNT(*) AS n FROM v2_txs GROUP BY kind, status ORDER BY kind').all() as Array<{ kind: string; status: string; n: number }>;
    db.close();
    say(`  journal: ${txs.map((x) => `${x.kind}/${x.status} ${x.n}`).join(', ')}; alerts: ${[...new Set(alerts.map((a) => a.kind))].join(', ') || 'none'}`);
    check(!txs.some((x) => x.status !== 'success'), 'H: every journalled transaction confirmed');
    const bad = alerts.filter((a) => a.kind === 'v2_error' || a.kind === 'v2_tx_revert' || a.kind === 'v2_mm_tx_rejected');
    check(bad.length === 0, `H: no v2_error, v2_tx_revert or v2_mm_tx_rejected alert${bad.map((a) => `\n         ${a.kind}: ${a.message}`).join('')}`);
  } finally {
    await mm.close().catch(() => undefined);
    pricing.server.close();
  }
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
  // The second market is whichever one the devnet registered without a pool (ops/devnet/lib.mjs
  // marketRoles): the registry decides it (SPCX, TSLA before), so no ticker is named here.
  const SINGLE = D.markets.find((m) => m.pool === null) ?? (() => { throw new Error(`${addressesFile} lists no Chainlink-only market`); })();
  if (SAFE_CALL) return safeCall(D, vault, NVDA, SINGLE);

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
    // MM_MAX_SERIES / MM_MAX_SERIES_PER_MARKET are NOT set: config.ts settleSeriesCaps refuses a cap below the
    // registry ladder (30 series per devnet market), which the old 16 / 8 were. Derived from the ladder instead.
    MM_BID_UNITS: '100',
    MM_ASK_UNITS: '100',
    MM_MAX_TX_PER_TICK: '120',
    // A strong skew, so one 100-unit fill moves every NVDA quote past MM_REQUOTE_BPS.
    MM_SKEW_BPS_PER_DELTA_SHARE: '500',
    MM_MAX_SKEW_BPS: '2000',
    MM_REQUOTE_BPS: '300',
    // Sections B and F assume a quote lives until the bot replaces it. The rendered launch env sets
    // MM_MAX_QUOTE_LIFETIME_S=180, so a slow tick on a loaded box let a bid expire and B saw its refresh
    // as a requote, and the two 24 h admin warps of E left F no live order to show the refused /kill cancelled
    // nothing. 0 = no bot lifetime (config.ts); the lifetime rules are section H's (--safe-call), at the vault's 300 s.
    MM_MAX_QUOTE_LIFETIME_S: '0',
    // The harness compares the vault's asks with the stand-in fair (sections A-C); the spot-lag floor would move them by
    // design. It has its own tests (mm/spot-lag.test.ts, planner.test.ts) and is off here, and only here. The write stop
    // and fair-before-open stay on: the warped clock sits at 10:00 New York with the stand-in's asOf at the head.
    MM_SPOT_LAG_BPS: '0',
    MM_SPOT_LAG_STALE_BPS: '0',
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
  // INTERFACE_VERSION 8: the devnet names the account `quoter` (ops/devnet/lib.mjs ROLE_INDEX); `mmQuoter` was v7's.
  say(`  quoter ${getAddress(D.accounts.quoter!)} vault ${vault} port ${mm.port}; log ${join(OUT, 'mm.log')}; db ${env.KEEPER_DB_PATH}`);

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
      // Each ask against its own kind's floor: kind 2 AskWrite is primary, kind 1 AskResale is not.
      const writeFloor = await read<bigint>(vault, makerVaultAbi, 'askFloorOf', [BigInt(longId), true]);
      const resaleFloor = await read<bigint>(vault, makerVaultAbi, 'askFloorOf', [BigInt(longId), false]);
      const cap = await read<bigint>(vault, makerVaultAbi, 'bidCap', [BigInt(longId)]);
      if (bid.price <= cap && asks.every((a) => a.price >= (a.kind === 1 ? resaleFloor : writeFloor) && a.price > bid.price)) inside += 1;
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
    /*
     * A's tick can defer a slot for protocol-cross: the seed's vault quotes are stale against /fair, so the new bid
     * would rest at or above the vault's OWN seed ask, which that same tick cancels (other-asker) or replaces. The
     * guard does not know the cancel lands first, so the bid waits one tick. Resting it on the next tick is that
     * deferral, not a requote. So: the next tick may place ONLY on the series A reported protocol-cross (and nothing
     * else), and the tick after it must send nothing at all, which is B's claim unchanged.
     */
    const deferred = new Set<string>((stA?.series ?? []).filter((s: { halt?: { halt?: string } }) => s.halt?.halt === 'protocol-cross').map((s: { longId: string }) => s.longId));
    if (deferred.size > 0) {
      const db0 = new Database(env.KEEPER_DB_PATH, { readonly: true });
      const head0 = (db0.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM v2_txs').get() as { n: number }).n;
      db0.close();
      await tick(mm);
      const db1 = new Database(env.KEEPER_DB_PATH, { readonly: true });
      const settled = db1.prepare("SELECT kind, tx_key AS key FROM v2_txs WHERE rowid > ? AND kind IN ('mm-place', 'mm-replace', 'mm-cancel') ORDER BY rowid").all(head0) as Array<{ kind: string; key: string }>;
      db1.close();
      const stray = settled.filter((r) => r.kind !== 'mm-place' || !r.key.split(':').some((part) => deferred.has(part)));
      say(`  A deferred ${deferred.size} series for protocol-cross; the settling tick sent ${settled.length}: ${JSON.stringify(settled.map((r) => `${r.kind} ${r.key.slice(-24)}`))}`);
      check(stray.length === 0, `B: the tick after A only rests the slots A deferred for protocol-cross (${settled.length} sent, ${stray.length} elsewhere: ${JSON.stringify(stray.map((r) => r.kind + ' ' + r.key))})`);
    }
    const beforeB = journalCount();
    await tick(mm);
    const stB = await state(mm);
    const afterB = journalCount();
    check(afterB === beforeB, `B: a tick with no market move sent no place, replace or cancel (${afterB - beforeB} sent: ${JSON.stringify((stB?.lastTxs ?? []).map((t: { what: string }) => t.what))})`);

    /* ---------------------------------------------------------------- C */
    let stC: any;
    if (standIn) {
      step(`C. /fair null for ${SINGLE.ticker}: its quotes are pulled`);
      const singleLiveBefore = [...(await liveBySeries(D))].filter(([id]) => (stB?.series ?? []).some((s: { longId: string; ticker: string }) => s.longId === id && s.ticker === SINGLE.ticker));
      say(`  ${SINGLE.ticker} series with live vault orders before: ${singleLiveBefore.length}`);
      nullTickers.add(SINGLE.ticker);
      await tick(mm);
      stC = await state(mm);
      const liveC = await liveBySeries(D);
      const singleIds = new Set((stC?.series ?? []).filter((s: { ticker: string }) => s.ticker === SINGLE.ticker).map((s: { longId: string }) => s.longId));
      const singleLiveAfter = [...liveC.keys()].filter((id) => singleIds.has(id));
      const singleHalts = (stC?.series ?? []).filter((s: { ticker: string; selected: boolean }) => s.ticker === SINGLE.ticker && s.selected).map((s: { halt: { halt: string } | null }) => s.halt?.halt ?? 'none');
      check(singleLiveBefore.length > 0 && singleLiveAfter.length === 0, `C: no live vault order left on ${SINGLE.ticker} (${singleLiveBefore.length} series before, ${singleLiveAfter.length} after)`);
      check(singleHalts.length > 0 && singleHalts.every((h: string) => h === 'fair-unavailable'), `C: every selected ${SINGLE.ticker} series halts fair-unavailable (${[...new Set(singleHalts)].join(', ')})`);
      check([...liveC].filter(([, o]) => twoSided(o)).length >= 5, 'C: NVDA still quoted on both sides on >= 5 series');
      nullTickers.delete(SINGLE.ticker);
    } else {
      step(`C. skipped: a real pricing service cannot be told to turn ${SINGLE.ticker} null; the default path covers it`);
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
    // Simulated as the taker (cy), whose discount the fee carries; with no `from` it reverts NotAuthorized.
    const [, , quotedTakerFee] = await quoteTakeAs(pub, D.contracts.orderBook, cy, { ...takeParams, maxTotalFee: UINT128_MAX });
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
      // Simulated as the buyer (cy); with no `from` it reverts NotAuthorized.
      const buyer = getAddress(D.accounts.cy!);
      const [unitsFilled] = await quoteTakeAs(pub, D.contracts.orderBook, buyer,
        { longId, buying: true, orderIds: [o.id], units: remaining, minUnits: 1n, limitPrice: o.price, writeToSell: false, recipient: buyer, deadline: tE + 600, maxTotalFee: UINT128_MAX });
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
    // The rent rate is the REGISTRY's (v2.fees.mintFeePpm, which up.sh hands DevDeploy), and the v8 launch sets it to 0
    // (allowRent false, in dev.json and tier1.json alike). So the series must carry exactly that; a non-zero one would
    // be a devnet that is not the launch configuration. At 0 the whole-fill check above covers collateral only.
    const registryPpm = Number(JSON.parse(readFileSync(join(DEVNET_DIR, 'tier1.devnet.json'), 'utf8')).v2.fees.mintFeePpm);
    const seen = [...new Set(ppms.map((x) => Number(x.mintFeePpm)))];
    check(seen.length === 1 && seen[0] === registryPpm, `E: the devnet's series carry the registry's mintFeePpm (${seen.join(', ')} ppm; registry ${registryPpm}${registryPpm === 0 ? ': rent off at launch, so the fill check covers collateral only' : ''})`);

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
    // out at length elsewhere; the short version is that `outflow()` used/available resets with the
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
    // Open = not cancelled, units left. NOT liveBySeries: E's two 24 h admin warps take the chain past every
    // validUntil, so nothing is "live" by the clock here, yet /kill still has those orders to cancel. What a refused
    // request must not do is cancel, so compare the open set before and after.
    const openIds = async () => (await vaultOrders(D)).filter((o) => !o.cancelled && o.filled < o.units).map((o) => o.id.toString()).sort().join(',');
    const openBefore = await openIds();
    const noAuth = await fetch(killUrl, { method: 'POST' });
    const wrong = await fetch(killUrl, { method: 'POST', headers: { authorization: `Bearer ${randomBytes(32).toString('hex')}` } });
    check(noAuth.status === 401 && wrong.status === 401, `F: /kill without a token and with a wrong token: 401 (${noAuth.status}, ${wrong.status})`);
    const openAfter = await openIds();
    check(openBefore !== '' && openAfter === openBefore, `F: the refused requests cancelled nothing (${openAfter.split(',').filter(Boolean).length} of ${openBefore.split(',').filter(Boolean).length} vault orders still open)`);
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
