/**
 * The scenarios the three-week dry run does not reach, for real, against an anvil fork of
 * Robinhood Chain 4663 — write on fill. One vault, three cycles, every option type created by
 * the keeper on the real Valorem Clear (MockFeed exactly as in dryrun.ts; the shared plumbing
 * is dryrun-common.ts), with a NON-default deposit (30e18):
 *
 *   cycle 1  (a) index.ts. The COMPILED keeper (`node dist/index.js`, the Dockerfile's CMD) is
 *            started as a child process on a 5 s poll against the fork. It boots, reconciles,
 *            ticks twice with nothing to sell, then — after a deposit lands — creates the option
 *            type, arms and lists on its next poll tick. The harness holds the tick's `roll_open`
 *            alert delivery open, sends SIGTERM while the tick is provably in flight, and asserts
 *            the process finishes the tick (the listing is authorised AFTER the signal), closes
 *            SQLite, and exits 0 with no -wal/-shm/-journal left beside the database. The
 *            in-process keeper then opens the SAME keeper.db and carries the week on.
 *            (d) Partial fills, a guardian cancel, a REPRICE, a refused fill, the budget. Buyer A
 *            fills 7/28 through `fulfillAdvancedOrder`; the guardian `cancelListing`s; the keeper
 *            relists the 21 left (a role-less cancel is refused). Buyer B fills 6/21. The feed
 *            RALLIES 1.5%: an eth_call of a fill of the live listing now reverts
 *            PremiumBelowFloorAtFill(gross, floor), decoded by name through the merged Seaport +
 *            vault ABI; the keeper's next tick cancels and re-approves at the new floor (the
 *            third and last authorisation), and a fill at the new price succeeds. The guardian
 *            `haltWrites`: the same eth_call reverts WritesAreHalted; the admin unhalts. The
 *            guardian `invalidateAllListings`; the keeper retires the row and, with the budget
 *            spent, lists nothing; a fourth `approveListing` reverts TooManyListings(3, 3).
 *            (b) Several exercisers, several transactions. A exercises 3, B 4, A 2, each in its
 *            own transaction on the real Clear; `rollClose` publishes 9 of 14 assigned from ONE
 *            RollClose, and every leg of the harvest is exact.
 *   cycle 2  (c) Anyone `rollClose`. The keeper lists, is filled in full and locks the book, then
 *            does not tick at expiry. A role-less address calls rollClose: GuardianTooEarly at
 *            expiry and at expiry + 1 h - 1 s, success at exactly expiry + 1 h. The keeper's next
 *            tick reconstructs the close from logs, with the assignment split.
 *   cycle 3  (e) The Valorem fee branch. The Clear's `feeTo` (impersonated) turns the engine fee
 *            on: the keeper reports the flip and refuses to arm; `rollOpen` reverts
 *            ValoremFeeNotAccepted(15). After `acceptValoremFee(true)` the keeper arms and prices
 *            the listing with the fee valued at spot; a fill pays it (the write pulls collateral
 *            plus 15 bps in NVDA), the exercise pays its own fee (15 bps of the strike, in USDG),
 *            and `rollClose`'s claim proceeds are untouched by either.
 *
 * HOW TO RUN IT (keeper/README.md has the long form):
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8560 --code-size-limit 98304
 *   (cd contracts && forge build)
 *   pnpm --filter @callhouse/keeper dryrun:extended
 *
 * ENV (all optional): DRYRUN_RPC (default http://127.0.0.1:8560), DRYRUN_ARTIFACTS, DRYRUN_OUT
 * (default ./dryrun-out/extended-<utc>), DRYRUN_DEPOSIT (default 30e18; within [23e18, 45e18] so
 * the first listing is 21+ contracts and the cap holds), DRYRUN_HEALTH_PORT (default 18790; the
 * child keeper uses the next port), DRYRUN_KEEPER_PK.
 *
 * Every keeper variable is set here before the keeper is imported or spawned; a keeper .env is
 * deliberately NOT read (KEEPER_ENV_FILE=/dev/null).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { encodeFunctionData, getAddress, keccak256, parseEventLogs, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { clearAbi, harvestEvent, rollCloseEvent, seaportAbi, vaultAbi } from './abi.js';
import {
  ADMIN,
  ANYONE,
  BPS,
  BUYER,
  BUYER_B,
  CHAIN_ID,
  CLEAR,
  DEPOSITOR,
  FEE_SAFE,
  GUARDIAN,
  KEEPER,
  LOT,
  MAX_LISTINGS,
  NVDA,
  ONE_HUNDRED_ETH,
  RPC,
  SEAPORT,
  USDG,
  VALOREM_FEE_BPS,
  ZERO_BYTES32,
  AlertCapture,
  allFrom,
  answerAbove,
  approve,
  assert,
  assertAddr,
  assertEq,
  assertServedShape,
  balanceOf,
  capacityOf,
  clearFeeAbi,
  currentStep,
  deal,
  deployVault,
  erc20Abi,
  exerciseOn,
  expectRevert,
  fillFromOrders,
  forkChain,
  fundActors,
  harvestFee,
  healthClient,
  latestTimestamp,
  mineAt,
  note,
  only,
  preflightFork,
  pub,
  rpc,
  sendTx,
  setBalance,
  setFeed,
  setNextBlockTimestamp,
  simulateFill,
  step,
  trail,
  vaultHarnessAbi,
  wallet,
  warpAndRefresh,
  writeRunFiles,
} from './dryrun-common.js';
import type { ListingRow } from './state.js';

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.env.DRYRUN_OUT ?? join('dryrun-out', `extended-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const DEPOSIT = BigInt(process.env.DRYRUN_DEPOSIT ?? '30000000000000000000');
const HEALTH_PORT = Number(process.env.DRYRUN_HEALTH_PORT ?? '18790');
const CHILD_PORT = HEALTH_PORT + 1;
const DEPOSIT_CAP = 50n * LOT;
/** The schema's minimum poll interval (config.ts POLL_INTERVAL_MS). */
const POLL_INTERVAL_MS = 5_000;
const ONE_HOUR = 3_600n;

/** Cycle 1 fills and exercises, in order. */
const FILL_A1 = 7n;
const FILL_B1 = 6n;
const FILL_B2 = 1n;
const EXERCISE_A1 = 3n;
const EXERCISE_B = 4n;
const EXERCISE_A2 = 2n;
/** Cycle 2 and cycle 3 fills and exercises. */
const EXERCISE_C2 = 4n;
const FILL_C3 = 5n;
const EXERCISE_C3 = 2n;
/** The rally that makes the live listing unfillable at the fill floor without pulling the
 *  strike inside the band floor: above KEEPER_PREMIUM_MARGIN_BPS (100), below the ~194 bps at
 *  which a 5%-OTM strike meets a 3% band floor. */
const RALLY_BPS = 150n;

const BUYER_A = BUYER;

/*//////////////////////////////////////////////////////////////
                              THE RECORD
//////////////////////////////////////////////////////////////*/

const record = {
  harness: 'dryrun-extended',
  startedAt: new Date().toISOString(),
  rpc: RPC,
  clientVersion: '',
  chainId: 0,
  forkBlock: '',
  deposit: DEPOSIT.toString(),
  actors: trail.actors,
  addresses: trail.addresses,
  blocks: {} as Record<string, string>,
  indexTs: {} as Record<string, unknown>,
  relist: {} as Record<string, unknown>,
  exercisers: {} as Record<string, unknown>,
  guardianClose: {} as Record<string, unknown>,
  valoremFee: {} as Record<string, unknown>,
  harnessTxs: trail.harnessTxs,
  steps: trail.steps,
  alerts: trail.alerts,
  health: {} as Record<string, unknown>,
  db: {} as Record<string, unknown>,
  stoppedAt: null as string | null,
  error: null as string | null,
  wallClockMs: 0,
};

const startedMs = Date.now();

/*//////////////////////////////////////////////////////////////
                        THE KEEPER, AS A PROCESS
//////////////////////////////////////////////////////////////*/

interface KeeperLogLine {
  time: number;
  level: string;
  msg: string;
  mod?: string;
  [key: string]: unknown;
}

/** `node dist/index.js`, with its JSON log lines parsed as they arrive. */
class KeeperProcess {
  readonly lines: KeeperLogLine[] = [];
  readonly raw: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private wake: Array<() => void> = [];
  private done = false;

  constructor(readonly child: ChildProcess) {
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        this.raw.push(line);
        try {
          this.lines.push(JSON.parse(line) as KeeperLogLine);
        } catch {
          /* not a pino line; kept in raw */
        }
        at = buffer.indexOf('\n');
      }
      this.poke();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.raw.push(`[stderr] ${chunk.toString('utf8')}`);
      this.poke();
    });
    this.exited = new Promise((done) => {
      child.on('exit', (code, signal) => {
        this.done = true;
        this.poke();
        done({ code, signal });
      });
    });
  }

  private poke(): void {
    for (const wake of this.wake.splice(0)) wake();
  }

  index(predicate: (line: KeeperLogLine) => boolean, from = 0): number {
    for (let i = from; i < this.lines.length; i += 1) {
      const line = this.lines[i];
      if (line !== undefined && predicate(line)) return i;
    }
    return -1;
  }

  count(predicate: (line: KeeperLogLine) => boolean): number {
    return this.lines.filter(predicate).length;
  }

  /** Resolves with the index of the `nth` (1-based) matching line; fails on exit or timeout. */
  async waitFor(what: string, predicate: (line: KeeperLogLine) => boolean, nth = 1, timeoutMs = 240_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let seen = 0;
      for (let i = 0; i < this.lines.length; i += 1) {
        const line = this.lines[i];
        if (line !== undefined && predicate(line)) {
          seen += 1;
          if (seen === nth) return i;
        }
      }
      if (this.done) throw new Error(`keeper process exited before logging ${what}\n${this.raw.slice(-20).join('\n')}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for the keeper to log ${what}\n${this.raw.slice(-20).join('\n')}`);
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, Math.min(left, 1_000));
        this.wake.push(() => {
          clearTimeout(timer);
          wake();
        });
      });
    }
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/*//////////////////////////////////////////////////////////////
                                MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dbPath = join(OUT, 'keeper.db');
  assert(DEPOSIT >= 23n * LOT && DEPOSIT <= 45n * LOT, `DRYRUN_DEPOSIT must be within [23e18, 45e18] (the first listing needs ${FILL_A1 + FILL_B1 + FILL_B2}+ contracts; the cap is 50), got ${DEPOSIT}`);

  /* ---------- 0. the production artefact, then preflight ---------- */

  await step('build the production keeper: tsc -p tsconfig.json -> dist/index.js (the Dockerfile CMD)', async () => {
    execFileSync(join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: PACKAGE_DIR, stdio: 'inherit' });
    assert(existsSync(join(PACKAGE_DIR, 'dist', 'index.js')), 'dist/index.js was built');
    note(`built ${join(PACKAGE_DIR, 'dist', 'index.js')}`);
  });

  await step('preflight: this is an anvil fork of 4663 on a loopback RPC', async () => {
    Object.assign(record, await preflightFork());
    await fundActors({ keeper: KEEPER, admin: ADMIN, feeSafe: FEE_SAFE, guardian: GUARDIAN, anyone: ANYONE, depositor: DEPOSITOR, buyerA: BUYER_A, buyerB: BUYER_B });
  });

  /* ---------- 1. deploy ---------- */

  const { vault, feed, answer, vaultDeployBlock } = await step('deploy MockFeed, both libraries and the linked Vault; grant KEEPER_ROLE and GUARDIAN_ROLE', async () => {
    const deployment = await deployVault(DEPOSIT_CAP, 'Callhouse NVDA (extended dry run)');
    record.blocks.vaultDeployBlock = deployment.vaultDeployBlock.toString();
    return deployment;
  });
  const V = { address: vault, abi: vaultAbi } as const;
  const Q = { address: vault, abi: vaultHarnessAbi } as const;

  /* ---------- 2. the alert capture and the keeper environment (the child gets the same) ---------- */

  const alerts = new AlertCapture();
  await alerts.start();

  const keeperEnv: Record<string, string> = {
    KEEPER_ENV_FILE: '/dev/null',
    RH_RPC: RPC,
    CHAIN_ID: String(CHAIN_ID),
    VAULT: vault,
    KEEPER_PK: process.env.DRYRUN_KEEPER_PK ?? keccak256(toHex('callhouse-dryrun:keeper')),
    KEEPER_DB_PATH: dbPath,
    KEEPER_FALLBACK_DIR: join(OUT, 'fallback'),
    ALERT_WEBHOOK: alerts.url,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
  };
  const unsetForKeeper = ['RH_RPC_2', 'KEEPER_UNIT_PRICE_USDG6', 'KEEPER_PREMIUM_MARGIN_BPS', 'KEEPER_STRIKE_OTM_BPS', 'KEEPER_ARM_LEAD_S', 'KEEPER_NYSE_HOLIDAYS', 'KEEPER_RETRY_STRANDED_MS', 'ALERT_WEBHOOK_TOKEN'];
  for (const key of unsetForKeeper) delete process.env[key];
  Object.assign(process.env, keeperEnv, { KEEPER_PORT: String(HEALTH_PORT), KEEPER_LOG_LEVEL: process.env.KEEPER_LOG_LEVEL ?? 'info' });

  let healthServer: { close: () => void } | null = null;
  const stopServers = (): void => {
    healthServer?.close();
    alerts.stop();
  };

  const orderStatus = async (hash: string) => {
    const [isValidated, isCancelled, totalFilled, totalSize] = await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getOrderStatus', args: [hash as Hex] });
    return { isValidated, isCancelled, totalFilled, totalSize };
  };
  const optionBalance = (holder: Address, optionId: bigint) => pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [holder, optionId] });
  const counterOf = () => pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] });

  let child: KeeperProcess | null = null;

  try {
    /* =====================================================================================
       CYCLE 1 (a): index.ts — the real process, its poll loop, and SIGTERM mid-tick
       ===================================================================================== */

    const proc = await step(`index.ts: spawn node dist/index.js (POLL_INTERVAL_MS=${POLL_INTERVAL_MS}); boot, reconcile, two idle poll ticks (nothing to sell)`, async () => {
      // The deposit's balance and approval are staged now, so that later only the deposit itself
      // has to land between two poll ticks.
      await deal(NVDA, DEPOSITOR.address, DEPOSIT);
      await approve('NVDA.approve(vault)', DEPOSITOR, NVDA, vault, DEPOSIT);
      assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), 0n, 'no deposits yet');
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !unsetForKeeper.includes(key)) childEnv[key] = value;
      Object.assign(childEnv, keeperEnv, { KEEPER_PORT: String(CHILD_PORT), KEEPER_LOG_LEVEL: 'debug' });
      const spawned = spawn(process.execPath, ['dist/index.js'], { cwd: PACKAGE_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const keeper = new KeeperProcess(spawned);
      child = keeper;
      note(`keeper pid ${spawned.pid}`);

      await keeper.waitFor('"callhouse keeper starting"', (l) => l.msg === 'callhouse keeper starting');
      const boot = keeper.lines[keeper.index((l) => l.msg === 'callhouse keeper starting')];
      assert(boot !== undefined, 'boot line');
      assertEq(boot.pollIntervalMs as number, POLL_INTERVAL_MS, 'the process runs on the configured poll interval');
      assertEq(String(boot.db), dbPath, 'the process opened the harness database path');
      await keeper.waitFor('"reconciled against chain state"', (l) => l.msg === 'reconciled against chain state');
      const idle = (l: KeeperLogLine) => l.msg === 'not arming this tick' && l.reason === 'no-capacity';
      const firstIdle = await keeper.waitFor('the first idle tick', idle, 1);
      const secondIdle = await keeper.waitFor('the second idle tick', idle, 2);
      const ticks = keeper.lines.filter((l) => l.msg === 'tick');
      assertEq(ticks.length, 2, 'exactly two ticks so far');
      const [t1, t2] = ticks;
      assert(t1 !== undefined && t2 !== undefined, 'two tick lines');
      assert(t2.time - t1.time >= POLL_INTERVAL_MS, `the second tick waited out the poll interval (${t2.time - t1.time} ms >= ${POLL_INTERVAL_MS})`);
      assert(firstIdle < secondIdle, 'ordered');
      assertEq(alerts.kinds().join(','), 'boot', 'index.ts sent its boot alert');
      assertEq(alerts.received[0]?.message ?? null, `keeper online for ${vault}`, 'boot alert message');

      const response = await fetch(`http://127.0.0.1:${CHILD_PORT}/health`);
      const body = (await response.json()) as { status: string; lastHeartbeat: string | null; vault: { phase: string | null; stranded: boolean | null }; keeper: { address: string; hasKeeperRole: boolean | null } };
      assertEq(response.status, 200, "the child's GET /health");
      assertAddr(body.keeper.address, KEEPER.address, "the child's keeper address");
      assertEq(body.keeper.hasKeeperRole, true, "the child holds KEEPER_ROLE");
      assertEq(body.vault.phase, 'Idle', "the child's view of the vault phase");
      assertEq(body.vault.stranded, false, 'not stranded');
      assert(body.lastHeartbeat !== null, 'the poll loop has beaten');
      assertEq(keeper.count((l) => l.msg === 'transaction submitted'), 0, 'nothing sent while there was nothing to sell');
      record.indexTs.pid = spawned.pid;
      record.indexTs.idleTickGapMs = t2.time - t1.time;
      record.indexTs.childHealth = body;
      note(`two idle ticks ${t2.time - t1.time} ms apart; /health ${body.status}`);
      return keeper;
    });

    const inFlight = await step('index.ts: a deposit lands; the next poll tick creates the type, arms, and alerts roll_open; SIGTERM while that delivery is held open', async () => {
      const gate = alerts.holdNext('roll_open');
      await sendTx('vault.deposit', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT, DEPOSITOR.address] }),
      );
      await gate.arrived;
      assertEq(proc.child.exitCode, null, 'alive when the roll_open delivery arrives');
      // How many idle polls ran before the deposit landed depends on the RPC's speed; what
      // cannot vary is that every tick but the last found nothing to sell, and that each tick
      // started at least one poll interval after the previous one.
      const ticksAtSignal = proc.count((l) => l.msg === 'tick');
      const idleTicks = proc.count((l) => l.msg === 'not arming this tick' && l.reason === 'no-capacity');
      assert(idleTicks >= 2, `at least the two idle ticks already seen (${idleTicks})`);
      assertEq(ticksAtSignal, idleTicks + 1, 'every tick before this one was idle; this one is the work');
      const tickTimes = proc.lines.filter((l) => l.msg === 'tick').map((l) => l.time);
      for (let i = 1; i < tickTimes.length; i += 1) {
        const gap = (tickTimes[i] ?? 0) - (tickTimes[i - 1] ?? 0);
        assert(gap >= POLL_INTERVAL_MS, `tick ${i + 1} started ${gap} ms after tick ${i} (>= ${POLL_INTERVAL_MS})`);
      }
      record.indexTs.ticksBeforeSignal = ticksAtSignal;
      record.indexTs.idleTicks = idleTicks;
      assertEq(proc.count((l) => l.msg === 'transaction confirmed' && l.kind === 'newOptionType'), 1, 'newOptionType confirmed inside the tick');
      assertEq(proc.count((l) => l.msg === 'transaction confirmed' && l.kind === 'rollOpen'), 1, 'rollOpen confirmed inside the tick');
      assertEq(proc.count((l) => l.msg === 'transaction submitted' && l.kind === 'approveListing'), 0, 'the listing has NOT been authorised yet: the tick is blocked on the held alert');
      const linesAtSignal = proc.lines.length;
      assert(proc.child.kill('SIGTERM'), 'SIGTERM delivered');
      note(`SIGTERM sent to pid ${proc.child.pid} with the roll_open delivery held (line ${linesAtSignal})`);
      await proc.waitFor('"waiting for the in-flight tick"', (l) => l.msg === 'waiting for the in-flight tick');
      // Two more seconds with the tick blocked: the process must still be there. (alerts.ts
      // aborts a delivery after 10 s, so the hold stays well inside that.)
      await sleep(2_000);
      assertEq(proc.child.exitCode, null, 'still alive 2 s after SIGTERM: it is waiting for the tick, not dying mid-transaction');
      assertEq(proc.count((l) => l.msg === 'stopped'), 0, 'not stopped while the tick is in flight');
      gate.release();
      const exit = await proc.exited;
      return { exit, linesAtSignal, ticksAtSignal };
    });

    await step('index.ts: the listing was authorised AFTER the signal; exit 0; SQLite closed cleanly; the file reopens with every row', async () => {
      assertEq(inFlight.exit.code, 0, 'exit code');
      assertEq(inFlight.exit.signal, null, 'exited on its own, not killed by the signal');
      const iSignal = proc.index((l) => l.msg === 'shutting down' && l.signal === 'SIGTERM');
      const iWait = proc.index((l) => l.msg === 'waiting for the in-flight tick');
      const iApproved = proc.index((l) => l.msg === 'transaction confirmed' && l.kind === 'approveListing');
      const iStopped = proc.index((l) => l.msg === 'stopped');
      assert(iSignal >= inFlight.linesAtSignal, 'the shutdown line follows the signal');
      assert(iSignal < iWait && iWait < iApproved && iApproved < iStopped, `order: shutting down (${iSignal}) < waiting (${iWait}) < approveListing confirmed (${iApproved}) < stopped (${iStopped})`);
      assertEq(iStopped, proc.lines.length - 1, '"stopped" is the last line');
      assertEq(proc.count((l) => l.msg === 'tick'), inFlight.ticksAtSignal, 'no tick started after SIGTERM');
      assertEq(proc.count((l) => l.level === 'error' || l.level === 'fatal'), 0, 'no error lines');
      assertEq(alerts.kinds().join(','), 'boot,roll_open,listing', 'the held roll_open completed after the signal, then the listing');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        assertEq(existsSync(`${dbPath}${suffix}`), false, `no ${suffix} file beside the database after close`);
      }

      // Reopen with a fresh connection, independent of the keeper's own store.
      const raw = new Database(dbPath);
      try {
        assertEq(String(raw.pragma('integrity_check', { simple: true })), 'ok', 'PRAGMA integrity_check');
        assertEq(String(raw.pragma('journal_mode', { simple: true })), 'wal', 'the file is still in WAL mode');
        const counts = Object.fromEntries(['cycles', 'listings', 'txs', 'alerts', 'meta'].map((t) => [t, (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
        assertEq(JSON.stringify(counts), JSON.stringify({ cycles: 1, listings: 1, txs: 3, alerts: 3, meta: 5 }), 'rows written by the process');
        const cycle = raw.prepare('SELECT * FROM cycles WHERE cycle_number = 1').get() as { status: string; roll_open_tx: string | null; contracts: number };
        assertEq(cycle.status, 'open', 'cycle 1 open');
        assert(cycle.roll_open_tx !== null, 'roll_open_tx');
        assertEq(cycle.contracts, 0, 'nothing sold');
        const listing = raw.prepare('SELECT * FROM listings WHERE cycle_number = 1').get() as { status: string; order_hash: string; contracts: string; signature: string };
        assertEq(listing.status, 'approved', 'the listing row reached approved: the tick completed after SIGTERM');
        assertEq(listing.signature, '0x', 'the empty signature');
        const txs = raw.prepare('SELECT kind, status FROM txs ORDER BY created_at, rowid').all() as Array<{ kind: string; status: string }>;
        assertEq(txs.map((t) => `${t.kind}:${t.status}`).join(','), 'newOptionType:success,rollOpen:success,approveListing:success', 'txs');
        const alertRows = raw.prepare('SELECT kind, delivered FROM alerts ORDER BY id').all() as Array<{ kind: string; delivered: number }>;
        assertEq(alertRows.map((a) => `${a.kind}:${a.delivered}`).join(','), 'boot:1,roll_open:1,listing:1', 'alerts, all delivered');
        const meta = raw.prepare('SELECT key, value FROM meta ORDER BY key').all() as Array<{ key: string; value: string }>;
        assertEq(meta.map((m) => m.key).filter((k) => !k.startsWith('skip_reason:')).join(','), 'clear_fees_enabled,last_heartbeat_ms,week_armed_ts,week_target_ts', 'meta');
        assertEq(meta.filter((m) => m.key.startsWith('skip_reason:')).map((m) => m.value).join(','), 'no-capacity', 'the idle ticks remembered why');
        const listingHash = await pub.readContract({ ...V, functionName: 'listingHash' });
        assertEq(listingHash.toLowerCase(), listing.order_hash.toLowerCase(), 'the vault authorised the hash the process stored');
        assertEq(await pub.readContract({ ...V, functionName: 'phase' }), 1, 'vault Listed');
        record.indexTs.exit = inFlight.exit;
        record.indexTs.rowsAfterExit = counts;
        record.indexTs.orderHash = listing.order_hash;
        record.indexTs.contracts = listing.contracts;
        record.indexTs.logOrder = { shuttingDown: iSignal, waitingForTick: iWait, approveListingConfirmed: iApproved, stopped: iStopped, lines: proc.lines.length };
      } finally {
        raw.close();
      }
      assertEq(existsSync(`${dbPath}-wal`), false, 'no -wal after the harness closed its own connection');
      writeFileSync(join(OUT, 'keeper-process.log'), `${proc.raw.join('\n')}\n`);
      note(`exit ${String(inFlight.exit.code)}; log order shutting-down ${iSignal} < waiting ${iWait} < approveListing ${iApproved} < stopped ${iStopped}; no -wal/-shm/-journal`);
    });
    child = null;

    /* ---------- the in-process keeper takes the same database ---------- */

    const roll = await import('./roll.js');
    const { store, KeeperStore } = await import('./state.js');
    const policy = await import('./policy.js');
    const seaport = await import('./seaport.js');
    const { config } = await import('./config.js');
    const { account } = await import('./clients.js');
    const { startHealthServer } = await import('./health.js');
    assertAddr(account.address, KEEPER.address, 'the keeper module derived the harness keeper address');
    healthServer = startHealthServer();
    const health = healthClient(HEALTH_PORT);
    const keeperTxs = () => store.db.prepare('SELECT kind, cycle_number, status, hash FROM txs ORDER BY created_at, rowid').all() as Array<{ kind: string; cycle_number: number | null; status: string; hash: string }>;
    const listingRow = (hash: string): ListingRow => {
      const row = store.getListing(hash);
      assert(row !== null, `listing row ${hash}`);
      return row;
    };
    const onlyListingFor = (cycleNumber: number, seq: number): ListingRow => {
      const row = store.listingsForCycle(cycleNumber).find((r) => r.seq === seq);
      assert(row !== undefined, `cycle ${cycleNumber} listing seq ${seq}`);
      return row;
    };
    const receiptOf = (hash: string | null) => {
      assert(hash !== null, 'a transaction hash is on record');
      return pub.getTransactionReceipt({ hash: hash as Hex });
    };
    const spotUsdg = () => pub.readContract({ ...V, functionName: 'spotUsdg' });
    /** The unit price the keeper's own rule produces for `contracts` at the live spot and fee state. */
    const expectedUnit = async (contracts: bigint) => {
      const [p, spot, feesEnabled, feeBps, strike] = await Promise.all([
        policy.readPolicy(),
        spotUsdg(),
        pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }),
        pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' }),
        pub.readContract({ ...V, functionName: 'cycleStrikeUsdg' }),
      ]);
      const priced = policy.priceListing({ policy: p, spotUsdg6: spot, strikeUsdg6: strike, contracts, feesEnabled, feeBps });
      assert(priced.ok, 'the keeper’s pricing rule accepts the size');
      return { unit: priced.unitPrice6, floorUnit: priced.floorUnit6, spot, p, feesEnabled, feeBps };
    };
    /** The RollClose and Harvest a close receipt carries, parsed once. */
    const closeEvents = (receipt: TransactionReceipt) => {
      const rc = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      const redeemed = only(parseEventLogs({ abi: clearAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), CLEAR, "the Clear's ClaimRedeemed");
      return { rc: rc.args, hv: hv.args, redeemed: redeemed.args };
    };

    /* =====================================================================================
       CYCLE 1 (d): partial fills, a guardian cancel, a reprice, a refused fill, the budget
       ===================================================================================== */

    const listing1 = await step('the in-process keeper opens the same keeper.db: reconcile(); tick -> nothing to do', async () => {
      assertEq(JSON.stringify(store.counts()), JSON.stringify(record.indexTs.rowsAfterExit), 'the keeper store sees exactly what the process wrote');
      await roll.reconcile();
      const row = onlyListingFor(1, 1);
      assertEq(row.status, 'approved', 'reconcile keeps the approved row (Seaport: validated, unfilled)');
      const txsBefore = keeperTxs().length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'nothing to send');
      const p = await policy.readPolicy();
      const expected = capacityOf(DEPOSIT, 0n, p);
      assertEq(BigInt(row.contracts), expected, `the process listed the whole capacity: ${expected}`);
      assert(expected >= FILL_A1 + FILL_B1 + FILL_B2 + 1n, `${expected} contracts leave a remainder after all three fills`);
      const { unit } = await expectedUnit(expected);
      assertEq(BigInt(row.unit_price6), unit, 'priced by the keeper’s rule at the live spot');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'listingsThisCycle 1');
      const served = await health.order(row.order_hash);
      assertServedShape(served, { vault, optionId: BigInt(row.option_id), contracts: expected, unitPrice6: unit, endTime: BigInt(row.end_time) });
      record.relist.strikeUsdg6 = store.getCycle(1)?.strike_usdg6 ?? null;
      record.relist.listing1 = { orderHash: row.order_hash, contracts: row.contracts, unitPrice6: row.unit_price6, counter: row.counter };
      return row;
    });
    const optionId1 = BigInt(listing1.option_id);
    const N1 = BigInt(listing1.contracts);
    const strike1 = BigInt(store.getCycle(1)?.strike_usdg6 ?? '0');
    const premiums1: bigint[] = [];

    await step(`cycle 1: buyer A fills ${FILL_A1}/${N1} of listing 1 (fulfillAdvancedOrder); tick -> partial`, async () => {
      const fill = await fillFromOrders('buyer A', BUYER_A, vault, await health.order(listing1.order_hash), FILL_A1);
      premiums1.push(fill.premium);
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(alerts.since(alertsBefore).join(','), 'fill', 'fill published');
      const row = listingRow(listing1.order_hash);
      const status = await orderStatus(listing1.order_hash);
      assertEq(row.status, 'partial', 'partial');
      assertEq(row.seaport_total_filled, status.totalFilled.toString(), 'row mirrors Seaport totalFilled');
      assertEq(row.seaport_total_size, status.totalSize.toString(), 'row mirrors Seaport totalSize');
      assertEq((await health.orders()).length, 1, '/orders still offers the partially filled listing');
      assertEq((await health.order(listing1.order_hash)).remainingContracts, (N1 - FILL_A1).toString(), '/orders remaining');
      record.relist.fillA1 = { tx: fill.hash, gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString(), seaportStatus: `${status.totalFilled}/${status.totalSize}`, opensClaim: true };
    });

    const listing2 = await step('cycle 1: the guardian cancelListing()s listing 1 (a role-less cancel is refused); tick -> the keeper relists the remainder (2 of 3)', async () => {
      const components = seaport.componentsFromJson(JSON.parse(listing1.components_json) as never);
      await expectRevert('anyone cancelListing', 'AccessControlUnauthorizedAccount', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultAbi, functionName: 'cancelListing', args: [components] }),
      );
      const { hash, receipt } = await sendTx('vault.cancelListing(listing 1) (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'cancelListing', args: [components] }),
      );
      const cancelled = only(parseEventLogs({ abi: vaultAbi, eventName: 'ListingCancelled', logs: receipt.logs }), vault, 'ListingCancelled');
      assertEq(cancelled.args.orderHash.toLowerCase(), listing1.order_hash.toLowerCase(), 'ListingCancelled.orderHash');
      assertEq((await orderStatus(listing1.order_hash)).isCancelled, true, 'Seaport isCancelled');
      assertEq(await pub.readContract({ ...V, functionName: 'listingHash' }), ZERO_BYTES32, 'vault listingHash cleared');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'a cancel does not refund the budget');
      const alertsBefore = alerts.received.length;
      await roll.tick();
      const fresh = onlyListingFor(1, 2);
      assertEq(fresh.status, 'approved', 'relist seq 2 approved');
      const p = await policy.readPolicy();
      const capacity = capacityOf(await pub.readContract({ ...V, functionName: 'totalAssets' }), FILL_A1, p);
      assertEq(BigInt(fresh.contracts), capacity, `relist sized to the remaining capacity: ${N1} - ${FILL_A1} = ${capacity}`);
      assertEq(fresh.unit_price6, listing1.unit_price6, 'spot has not moved, so the same price');
      assertEq(fresh.counter, (await counterOf()).toString(), 'built at the live Seaport counter');
      assertEq((await pub.readContract({ ...V, functionName: 'listingHash' })).toLowerCase(), fresh.order_hash.toLowerCase(), 'the vault authorised the relist');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 2, 'listingsThisCycle 2');
      assertEq(store.getCycle(1)?.relists_used ?? -1, 1, 'relists_used 1');
      assertEq(listingRow(listing1.order_hash).status, 'cancelled', 'the cancelled row is retired');
      assertEq(listingRow(listing1.order_hash).seaport_total_filled, FILL_A1.toString(), 'the partial fill is kept on the dead row');
      assertEq((await health.orders()).map((o) => o.orderHash.toLowerCase()).join(','), fresh.order_hash.toLowerCase(), '/orders offers only the listing the vault authorises');
      assertEq(alerts.since(alertsBefore).join(','), 'listing', 'the relist is announced');
      record.relist.cancel1Tx = hash;
      record.relist.listing2 = { orderHash: fresh.order_hash, contracts: fresh.contracts, unitPrice6: fresh.unit_price6, counter: fresh.counter };
      return fresh;
    });

    await step(`cycle 1: buyer B fills ${FILL_B1}/${BigInt(listing2.contracts)} of listing 2; tick -> partial`, async () => {
      const fill = await fillFromOrders('buyer B', BUYER_B, vault, await health.order(listing2.order_hash), FILL_B1);
      premiums1.push(fill.premium);
      await roll.tick();
      assertEq(listingRow(listing2.order_hash).status, 'partial', 'partial');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), FILL_A1 + FILL_B1, 'contractsWritten == 13 across two listings, one claim');
      record.relist.fillB1 = { tx: fill.hash, gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString() };
    });

    const listing3 = await step(`cycle 1: REPRICE — the feed rallies ${RALLY_BPS} bps; a fill of listing 2 now reverts PremiumBelowFloorAtFill (eth_call, decoded by name); tick -> cancel + re-approve at the new floor (3 of 3); a fill at the new price succeeds`, async () => {
      const rallied = (answer * (BPS + RALLY_BPS)) / BPS;
      await setFeed(feed, rallied, `+${RALLY_BPS} bps rally`);
      const spot = await spotUsdg();
      const p = await policy.readPolicy();
      const bandFloor = (spot * (BPS + p.minOtmBps)) / BPS;
      assert(strike1 >= bandFloor, `the strike ${strike1} is still at or above the band floor ${bandFloor}: a reprice, not a dead week`);
      // The web page's pre-flight, from here: the hook's own error through the merged ABI.
      const served2 = await health.order(listing2.order_hash);
      const sim = await simulateFill(BUYER_B, served2, 1n);
      assert(!sim.ok, 'the fill is refused');
      assertEq(sim.errorName, 'PremiumBelowFloorAtFill', 'decoded by name through the 92-error ABI');
      const [gross, floor] = sim.args as [bigint, bigint];
      assertEq(gross, BigInt(listing2.unit_price6), 'PremiumBelowFloorAtFill.grossUsdg = one contract at the old ask');
      assertEq(floor, policy.fillFloorUsdg6(spot, 1n, p, false, 15), 'PremiumBelowFloorAtFill.floorUsdg = minPremium(spot, 1) at the NEW spot');
      note(`eth_call of a 1-contract fill: PremiumBelowFloorAtFill(${gross}, ${floor})`);
      // The keeper's mirror of the same check says the same.
      const verdict = policy.fillVerdict(spot, { grossUsdg6: BigInt(listing2.gross_usdg6), amount: BigInt(listing2.contracts), strikeUsdg6: strike1 }, p, false, 15);
      assert(!verdict.fillable && verdict.reason === 'premium-below-floor', 'the keeper’s fillVerdict: premium-below-floor');
      const alertsBefore = alerts.received.length;
      const txsBefore = keeperTxs().length;
      await roll.tick();
      assertEq(keeperTxs().slice(txsBefore).map((t) => `${t.kind}:${t.status}`).join(','), 'cancelListing:success,approveListing:success', 'cancel, then re-approve, in one tick');
      const fresh = onlyListingFor(1, 3);
      assertEq(fresh.status, 'approved', 'seq 3 approved');
      assertEq(BigInt(fresh.contracts), BigInt(listing2.contracts) - FILL_B1, 'sized to what is left');
      const { unit, floorUnit } = await expectedUnit(BigInt(fresh.contracts));
      assertEq(BigInt(fresh.unit_price6), unit, 'repriced at the NEW fill floor plus the margin');
      assert(BigInt(fresh.unit_price6) > BigInt(listing2.unit_price6), `the ask rose: ${listing2.unit_price6} -> ${fresh.unit_price6} (floor ${floorUnit})`);
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), MAX_LISTINGS, 'listingsThisCycle 3: the budget is spent');
      assertEq(store.getCycle(1)?.relists_used ?? -1, 2, 'relists_used 2');
      assertEq(listingRow(listing2.order_hash).status, 'cancelled', 'the repriced row is retired');
      assertEq((await orderStatus(listing2.order_hash)).isCancelled, true, 'cancelled on Seaport');
      assertEq(alerts.since(alertsBefore).join(','), 'listing', 'the reprice is announced');
      const served3 = await health.order(fresh.order_hash);
      const accepted = await simulateFill(BUYER_B, served3, 1n, { fund: true });
      assert(accepted.ok, `a funded fill of the repriced listing passes: ${accepted.ok ? '' : `${accepted.errorName}: ${accepted.message}`}`);
      const fill = await fillFromOrders('buyer B', BUYER_B, vault, served3, FILL_B2);
      assertEq(fill.premium, unit * FILL_B2, 'paid the new price');
      premiums1.push(fill.premium);
      await roll.tick();
      assertEq(listingRow(fresh.order_hash).status, 'partial', 'partial');
      record.relist.rally = { bps: RALLY_BPS.toString(), answer: rallied.toString(), spotUsdg6: spot.toString(), simulatedRevert: `PremiumBelowFloorAtFill(${gross}, ${floor})` };
      record.relist.listing3 = { orderHash: fresh.order_hash, contracts: fresh.contracts, unitPrice6: fresh.unit_price6, floorUnit6: floorUnit.toString(), counter: fresh.counter };
      record.relist.fillB2 = { tx: fill.hash, gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString() };
      return fresh;
    });

    await step('cycle 1: the guardian haltWrites(): the fill eth_call reverts WritesAreHalted; the admin unhalts', async () => {
      await sendTx('vault.haltWrites() (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'haltWrites' }),
      );
      const served3 = await health.order(listing3.order_hash);
      const sim = await simulateFill(BUYER_A, served3, 1n, { fund: true });
      assert(!sim.ok, 'the hook refuses under a halt');
      assertEq(sim.errorName, 'WritesAreHalted', 'decoded by name: WritesAreHalted');
      note('eth_call of a 1-contract fill under the halt: WritesAreHalted()');
      const txsBefore = keeperTxs().length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'the keeper sends nothing under a halt');
      await expectRevert('guardian unhaltWrites', 'AccessControlUnauthorizedAccount', () =>
        pub.simulateContract({ account: GUARDIAN, address: vault, abi: vaultAbi, functionName: 'unhaltWrites' }),
      );
      await sendTx('vault.unhaltWrites() (admin)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'unhaltWrites' }),
      );
      const again = await simulateFill(BUYER_A, served3, 1n, { fund: true });
      assert(again.ok, `fillable again: ${again.ok ? '' : `${again.errorName}: ${again.message}`}`);
      record.relist.halt = { simulatedRevert: 'WritesAreHalted()' };
    });

    await step('cycle 1: the guardian invalidateAllListings(); tick -> the row is retired and nothing is relisted (budget spent); a fourth approveListing reverts TooManyListings(3, 3)', async () => {
      const counterBefore = await counterOf();
      const { hash, receipt } = await sendTx('vault.invalidateAllListings() (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'invalidateAllListings' }),
      );
      const invalidated = only(parseEventLogs({ abi: vaultAbi, eventName: 'AllListingsInvalidated', logs: receipt.logs }), vault, 'AllListingsInvalidated');
      const counterAfter = await counterOf();
      assertEq(invalidated.args.newCounter, counterAfter, 'AllListingsInvalidated.newCounter = Seaport getCounter(vault)');
      assert(counterAfter > counterBefore, 'the counter moved forward');
      assertEq((await orderStatus(listing3.order_hash)).isCancelled, false, 'a counter bump does NOT set isCancelled — the row must be retired from the vault state, not from Seaport');
      assertEq(await pub.readContract({ ...V, functionName: 'listingHash' }), ZERO_BYTES32, 'vault listingHash cleared');
      const txsBefore = keeperTxs().length;
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'the keeper sent nothing: the vault’s three listings are spent');
      assertEq(alerts.received.length, alertsBefore, 'no alert');
      assertEq(listingRow(listing3.order_hash).status, 'cancelled', 'the invalidated row is retired although Seaport never set isCancelled');
      assertEq(store.listingsForCycle(1).length, 3, 'three listing rows, no fourth');
      assertEq((await health.orders()).length, 0, '/orders offers nothing');
      assertEq(await optionBalance(vault, optionId1), 0n, 'the vault holds no option tokens: nothing unsold exists');
      // The vault's own cap, independent of the keeper: a fourth authorisation, built by the
      // keeper's own order builder at the live counter, from the keeper key.
      const p = await policy.readPolicy();
      const capacity = capacityOf(await pub.readContract({ ...V, functionName: 'totalAssets' }), FILL_A1 + FILL_B1 + FILL_B2, p);
      const fourth = seaport.buildOrderComponents({ vault, optionId: optionId1, contracts: capacity, unitPrice6: BigInt(listing3.unit_price6), endTime: BigInt(listing3.end_time), counter: counterAfter });
      const args = await expectRevert('a fourth approveListing (keeper key)', 'TooManyListings', () =>
        pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'approveListing', args: [fourth] }),
      );
      assertEq(Number(args[0]), MAX_LISTINGS, 'TooManyListings.authorised = 3');
      assertEq(Number(args[1]), MAX_LISTINGS, 'TooManyListings.max = 3');
      record.relist.invalidateTx = hash;
      record.relist.counterBefore = counterBefore.toString();
      record.relist.counterAfter = counterAfter.toString();
      record.relist.fourthApproval = `TooManyListings(${String(args[0])}, ${String(args[1])})`;
      record.relist.contractsSold = (FILL_A1 + FILL_B1 + FILL_B2).toString();
    });

    const window1 = { exercise: BigInt(store.getCycle(1)?.exercise_ts ?? 0), expiry: BigInt(store.getCycle(1)?.expiry_ts ?? 0) };
    await step('cycle 1: warp to the exercise timestamp; tick -> lockBook', async () => {
      await warpAndRefresh(window1.exercise, 'cycle-1 exerciseTimestamp', feed, answerAbove(strike1, 5n));
      await roll.tick();
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Exercisable, 'phase');
      assertEq(store.getCycle(1)?.status ?? null, 'locked', 'locked');
      assertEq(store.listingsForCycle(1).map((r) => r.status).join(','), 'cancelled,cancelled,cancelled', 'every row terminal');
    });

    const exercised1 = await step(`cycle 1: buyer A exercises ${EXERCISE_A1}, buyer B ${EXERCISE_B}, buyer A ${EXERCISE_A2} — three transactions on the real Clear`, async () => {
      const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
      assert(claimKey !== 0n, 'claim open');
      assertEq(await optionBalance(BUYER_A.address, optionId1), FILL_A1, 'buyer A holds its fill');
      assertEq(await optionBalance(BUYER_B.address, optionId1), FILL_B1 + FILL_B2, 'buyer B holds both of its fills');
      const steps: Array<{ who: string; buyer: PrivateKeyAccount; amount: bigint }> = [
        { who: 'buyer A', buyer: BUYER_A, amount: EXERCISE_A1 },
        { who: 'buyer B', buyer: BUYER_B, amount: EXERCISE_B },
        { who: 'buyer A', buyer: BUYER_A, amount: EXERCISE_A2 },
      ];
      const txs: Array<Record<string, string>> = [];
      let cumulative = 0n;
      for (const s of steps) {
        const done = await exerciseOn(s.who, s.buyer, vault, optionId1, s.amount, strike1);
        assertEq(done.feesEnabled, false, 'the live chain has the Clear fee off');
        cumulative += s.amount;
        assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), cumulative, `vault.contractsAssigned() = ${cumulative} after ${s.who}`);
        txs.push({ who: s.who, amount: s.amount.toString(), tx: done.hash, debit: done.debit.toString() });
      }
      const total = EXERCISE_A1 + EXERCISE_B + EXERCISE_A2;
      const written = FILL_A1 + FILL_B1 + FILL_B2;
      const position = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'position', args: [claimKey] });
      assertEq(position.underlyingAmount, (written - total) * LOT, 'position.underlyingAmount: the unassigned lots');
      assertEq(position.exerciseAmount, total * strike1, 'position.exerciseAmount: every exercise, summed');
      record.exercisers.transactions = txs;
      record.exercisers.claimKey = claimKey.toString();
      return { claimKey, total, written };
    });

    await step(`cycle 1: warp past expiry; tick -> rollClose: ${EXERCISE_A1 + EXERCISE_B + EXERCISE_A2} of ${FILL_A1 + FILL_B1 + FILL_B2} assigned from three exercises by two exercisers`, async () => {
      await warpAndRefresh(window1.expiry, 'cycle-1 expiryTimestamp', feed, answerAbove(strike1, 5n));
      const E = exercised1.total;
      const premium = premiums1.reduce((a, b) => a + b, 0n);
      const [vaultUsdgBefore, vaultNvdaBefore, feeSafeBefore, p] = await Promise.all([balanceOf(USDG, vault), balanceOf(NVDA, vault), balanceOf(USDG, FEE_SAFE.address), policy.readPolicy()]);
      assertEq(vaultUsdgBefore, premium, "the vault holds exactly the three fills' premiums");
      assertEq(vaultNvdaBefore, DEPOSIT - exercised1.written * LOT, 'the vault holds what it did not write');
      assertEq(await roll.contractsAssignedAt(await roll.snapshot()), E, "the keeper's pre-close read");
      const alertsBefore = alerts.received.length;
      await roll.tick();
      const cycle = store.getCycle(1);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'closed by the keeper');
      assertEq(cycle.status, 'closed', 'status');
      const receipt = await receiptOf(cycle.roll_close_tx);
      const { rc, hv, redeemed } = closeEvents(receipt);
      assertEq(rc.cycleNumber, 1, 'RollClose.cycleNumber');
      assertEq(rc.contractsAssignedCount, E, `RollClose.contractsAssignedCount = ${E}`);
      assertEq(rc.assetsReturned, (exercised1.written - E) * LOT, 'RollClose.assetsReturned = the unassigned lots');
      assertEq(rc.usdgFromAssignment, E * strike1, 'RollClose.usdgFromAssignment = every exercise x strike');
      const allCloses = await pub.getLogs({ address: vault, event: rollCloseEvent, args: { cycleNumber: 1 }, fromBlock: vaultDeployBlock, toBlock: receipt.blockNumber });
      assertEq(allCloses.length, 1, 'exactly one RollClose for cycle 1 on chain');
      assertEq(redeemed.exerciseAmountRedeemed, E * strike1, 'Clear.ClaimRedeemed.exerciseAmountRedeemed');
      assertEq(redeemed.underlyingAmountRedeemed, (exercised1.written - E) * LOT, 'Clear.ClaimRedeemed.underlyingAmountRedeemed');
      assertEq(hv.grossUsdg, premium + E * strike1, 'Harvest.gross = the three premiums + strike proceeds');
      const fee = harvestFee(hv.grossUsdg, rc.usdgFromAssignment, p.protocolFeeBps);
      assertEq(hv.feeUsdg, fee, 'Harvest.fee on the premium only');
      assertEq(fee, (premium * p.protocolFeeBps) / BPS, 'fee = floor(premiums x 500 / 10000)');
      assertEq(hv.netUsdg, hv.grossUsdg - fee, 'Harvest.net');
      const harvestLogs = await pub.getLogs({ address: vault, event: harvestEvent, args: { cycleNumber: 1 }, fromBlock: vaultDeployBlock, toBlock: receipt.blockNumber });
      assertEq(harvestLogs.length, 1, 'one Harvest for cycle 1: no deposit checkpointed it early');
      assertEq((await balanceOf(USDG, FEE_SAFE.address)) - feeSafeBefore, fee, 'fee swept in the close');
      assertEq(await balanceOf(NVDA, vault), DEPOSIT - E * LOT, 'the vault is down exactly the assigned lots');
      assertEq(await balanceOf(NVDA, BUYER_A.address), (EXERCISE_A1 + EXERCISE_A2) * LOT, 'buyer A took delivery twice');
      assertEq(await balanceOf(NVDA, BUYER_B.address), EXERCISE_B * LOT, 'buyer B took delivery once');
      assertEq(await optionBalance(vault, optionId1), 0n, 'no unsold option token ever existed in the vault');
      // The keeper's row, alert and tape.
      assertEq(cycle.contracts, Number(exercised1.written), 'contracts = sold = written');
      assertEq(cycle.gross_usdg6, hv.grossUsdg.toString(), 'gross_usdg6');
      assertEq(cycle.fee_usdg6, fee.toString(), 'fee_usdg6');
      assertEq(cycle.net_usdg6, hv.netUsdg.toString(), 'net_usdg6');
      assertEq(cycle.contracts_assigned, Number(E), 'contracts_assigned');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment');
      assertEq(cycle.relists_used, 2, 'relists_used');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_close', 'roll_close');
      const last = alerts.latest();
      assertEq(
        last.message,
        `cycle 1 closed: premium ${roll.formatUsdg(premium)} USDG (fee ${roll.formatUsdg(fee)}), strike proceeds ${roll.formatUsdg(E * strike1)} USDG from ${E} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors.`,
        'roll_close message',
      );
      assertEq(String(last.data.contractsAssignedSource), 'RollClose', 'data.contractsAssignedSource');
      assertEq(Number(last.data.contractsAssignedFromClaim), Number(E), "data.contractsAssignedFromClaim: the keeper's own pre-read inside the tick");
      const tape = ((await health.get('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 1);
      assert(tape !== undefined, '/cycles serves cycle 1');
      assertEq(tape.premium_gross_usdg6 as string, premium.toString(), '/cycles premium_gross_usdg6');
      assertEq(tape.strike_proceeds_usdg6 as string, (E * strike1).toString(), '/cycles strike_proceeds_usdg6');
      const claimable = await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
      await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
      );
      assertEq(await balanceOf(USDG, DEPOSITOR.address), claimable, 'claimed exactly');
      record.exercisers.rollCloseTx = cycle.roll_close_tx;
      record.exercisers.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.exercisers.harvest = { premium: premium.toString(), gross: hv.grossUsdg.toString(), fee: fee.toString(), net: hv.netUsdg.toString(), depositorClaimed: claimable.toString() };
      record.exercisers.alert = last.message;
      note(`RollClose(1, ${rc.assetsReturned}, ${rc.usdgFromAssignment}, ${rc.contractsAssignedCount}); gross ${hv.grossUsdg} fee ${fee} net ${hv.netUsdg}`);
    });

    /* =====================================================================================
       CYCLE 2 (c): nobody but "anyone" closes; the keeper reconciles from logs
       ===================================================================================== */

    const cycle2 = await step('cycle 2: tick -> newOptionType + rollOpen + list; buyer B fills the whole listing; tick -> filled (nothing more to sell)', async () => {
      const idle = await pub.readContract({ ...V, functionName: 'idleAssets' });
      const alertsBefore = alerts.received.length;
      await roll.tick();
      const row = onlyListingFor(2, 1);
      const cycle = store.getCycle(2);
      assert(cycle !== null && cycle.roll_open_tx !== null, 'the keeper opened cycle 2');
      const p = await policy.readPolicy();
      assertEq(BigInt(row.contracts), capacityOf(idle, 0n, p), 'sized on what cycle 1 left');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_open,listing', 'armed and listed');
      const fill = await fillFromOrders('buyer B', BUYER_B, vault, await health.order(row.order_hash), BigInt(row.contracts));
      await roll.tick();
      assertEq(listingRow(row.order_hash).status, 'filled', 'filled');
      assertEq((await health.orders()).length, 0, '/orders offers nothing: sold out');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'no relist: capacity is exhausted');
      record.guardianClose.contracts = row.contracts;
      record.guardianClose.strikeUsdg6 = cycle.strike_usdg6;
      record.guardianClose.fillTx = fill.hash;
      record.guardianClose.fillGasUsed = fill.gasUsed.toString();
      return { row, premium: fill.premium, strike: BigInt(cycle.strike_usdg6 ?? '0'), optionId: BigInt(row.option_id), exercise: BigInt(cycle.exercise_ts ?? 0), expiry: BigInt(cycle.expiry_ts ?? 0) };
    });

    await step(`cycle 2: warp to the exercise timestamp; tick -> lockBook; spot above the strike; buyer B exercises ${EXERCISE_C2}`, async () => {
      await warpAndRefresh(cycle2.exercise, 'cycle-2 exerciseTimestamp', feed, answerAbove(cycle2.strike, 5n));
      await roll.tick();
      assertEq(store.getCycle(2)?.status ?? null, 'locked', 'locked by the keeper');
      const done = await exerciseOn('buyer B', BUYER_B, vault, cycle2.optionId, EXERCISE_C2, cycle2.strike);
      record.guardianClose.exerciseTx = done.hash;
    });

    const guardianClose = await step('cycle 2: warp past expiry; the keeper does NOT tick; a role-less rollClose reverts GuardianTooEarly at expiry and at expiry + 1 h - 1 s', async () => {
      const expiry = cycle2.expiry;
      const openAt = expiry + ONE_HOUR;
      await warpAndRefresh(expiry, 'cycle-2 expiryTimestamp', feed, answerAbove(cycle2.strike, 5n));
      const now = await latestTimestamp();
      assert(now >= expiry && now < openAt, `head ${now} is past expiry ${expiry} and before ${openAt}`);
      const early = await expectRevert('rollClose by anyone, just past expiry', 'GuardianTooEarly', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultAbi, functionName: 'rollClose' }),
      );
      assertEq(BigInt(early[0] as number), openAt, 'GuardianTooEarly.allowedAt = cycleExpiryTs + 1 hour');
      const lastSecond = await mineAt(openAt - 1n);
      const boundary = await expectRevert('rollClose by anyone at expiry + 1 h - 1 s', 'GuardianTooEarly', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultAbi, functionName: 'rollClose', blockNumber: lastSecond }),
      );
      assertEq(BigInt(boundary[0] as number), openAt, 'the same allowedAt one second early');
      // The keeper key is not held to the hour (Vault.rollClose): it could close now. It does not tick.
      await pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'rollClose', blockNumber: lastSecond });
      note('the keeper key would pass the same simulation at expiry + 1 h - 1 s; it is simply not ticking');
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Exercisable, 'still Exercisable');
      record.guardianClose.expiry = Number(expiry);
      record.guardianClose.openAt = Number(openAt);
      return { openAt };
    });

    const closedByAnyone = await step('cycle 2: anyone rollClose()s at exactly expiry + 1 hour', async () => {
      await setNextBlockTimestamp(guardianClose.openAt);
      const vaultNvdaBefore = await balanceOf(NVDA, vault);
      const { hash, receipt } = await sendTx('vault.rollClose() (anyone, no role)', ANYONE, () =>
        wallet.writeContract({ account: ANYONE, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'rollClose', gas: 2_000_000n }),
      );
      const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
      assertEq(block.timestamp, guardianClose.openAt, 'mined at exactly cycleExpiryTs + 1 hour');
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'Idle');
      const { rc, hv } = closeEvents(receipt);
      const written = BigInt(cycle2.row.contracts);
      assertEq(rc.cycleNumber, 2, 'RollClose.cycleNumber');
      assertEq(rc.contractsAssignedCount, EXERCISE_C2, 'RollClose.contractsAssignedCount');
      assertEq(rc.assetsReturned, (written - EXERCISE_C2) * LOT, 'RollClose.assetsReturned');
      assertEq(rc.usdgFromAssignment, EXERCISE_C2 * cycle2.strike, 'RollClose.usdgFromAssignment');
      assertEq(hv.grossUsdg, cycle2.premium + rc.usdgFromAssignment, 'Harvest.gross');
      const { protocolFeeBps } = await policy.readPolicy();
      assertEq(hv.feeUsdg, (cycle2.premium * protocolFeeBps) / BPS, 'Harvest.fee on the premium only');
      assertEq(hv.netUsdg, hv.grossUsdg - hv.feeUsdg, 'Harvest.net');
      assertEq((await balanceOf(NVDA, vault)) - vaultNvdaBefore, rc.assetsReturned, 'collateral back');
      assertEq(store.getCycle(2)?.status ?? null, 'locked', "the keeper's row still says locked: it has not seen the close");
      assert(store.latestTxForCycle('rollClose', 2) === null, 'no keeper rollClose transaction for cycle 2');
      record.guardianClose.rollCloseTx = hash;
      record.guardianClose.rollCloseBlock = receipt.blockNumber.toString();
      record.guardianClose.rollCloseGasUsed = receipt.gasUsed.toString();
      record.guardianClose.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.guardianClose.harvest = { gross: hv.grossUsdg.toString(), fee: hv.feeUsdg.toString(), net: hv.netUsdg.toString() };
      return { hash, rc, hv };
    });

    const feeOn = await step("cycle 3 begins while the keeper is still down: the Clear's feeTo (impersonated) turns the engine fee on", async () => {
      const feeTo = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeTo' });
      assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }), false, 'fees off on the live chain');
      assertEq(BigInt(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' })), VALOREM_FEE_BPS, 'feeBps 15');
      await setBalance(feeTo, ONE_HUNDRED_ETH);
      await rpc('anvil_impersonateAccount', [feeTo]);
      const { hash, receipt } = await sendTx('clear.setFeesEnabled(true) (feeTo, impersonated)', { address: feeTo }, () =>
        rpc<Hex>('eth_sendTransaction', [{ from: feeTo, to: CLEAR, data: encodeFunctionData({ abi: clearFeeAbi, functionName: 'setFeesEnabled', args: [true] }), gas: toHex(200_000n) }]),
      );
      await rpc('anvil_stopImpersonatingAccount', [feeTo]);
      const switched = only(parseEventLogs({ abi: clearAbi, eventName: 'FeeSwitchUpdated', logs: receipt.logs }), CLEAR, 'FeeSwitchUpdated');
      assertEq(switched.args.enabled, true, 'FeeSwitchUpdated.enabled');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }), true, 'fees on');
      record.valoremFee.feeSwitchTx = hash;
      return { feeTo };
    });

    await step('cycle 2: the keeper ticks: it reconstructs the close from chain logs (with the assignment split), reports the fee flip, and refuses to arm; reconcile() again changes nothing', async () => {
      const alertsBefore = alerts.received.length;
      const txsBefore = keeperTxs().length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'the keeper sent nothing: the close was somebody else’s, and the fee is on');
      const cycle = store.getCycle(2);
      assert(cycle !== null, 'row');
      const { rc, hv, hash } = closedByAnyone;
      assertEq(cycle.status, 'closed', 'closed from logs');
      assertEq(cycle.roll_close_tx, hash, "roll_close_tx = anyone's transaction");
      assertEq(cycle.gross_usdg6, hv.grossUsdg.toString(), 'gross from the Harvest log');
      assertEq(cycle.fee_usdg6, hv.feeUsdg.toString(), 'fee');
      assertEq(cycle.net_usdg6, hv.netUsdg.toString(), 'net');
      assertEq(cycle.contracts, Number(cycle2.row.contracts), 'contracts sold, from the CallsWritten sum');
      assertEq(cycle.contracts_assigned, Number(rc.contractsAssignedCount), 'contracts_assigned from the RollClose log');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned from the RollClose log');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment from the RollClose log');
      assert(cycle.roll_open_tx !== null && cycle.lock_tx !== null, "the keeper's own open and lock hashes are kept");
      assertEq(listingRow(cycle2.row.order_hash).status, 'filled', 'the filled listing stays filled');
      assertEq(alerts.since(alertsBefore).join(','), 'fee_switch,valorem_fees_enabled,roll_close', 'the flip (a state change), the standing condition, then the reconstructed close');
      const last = alerts.last('roll_close');
      const premium = hv.grossUsdg - rc.usdgFromAssignment;
      assertEq(premium, cycle2.premium, 'premium = the fill');
      assertEq(
        last.message,
        `cycle 2 closed: premium ${roll.formatUsdg(premium)} USDG (fee ${roll.formatUsdg(hv.feeUsdg)}), strike proceeds ${roll.formatUsdg(rc.usdgFromAssignment)} USDG from ${EXERCISE_C2} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors. The close ran without this keeper witnessing it; reconstructed from chain logs.`,
        'the unwitnessed roll_close message',
      );
      assertEq(last.data.witnessedLive as boolean, false, 'data.witnessedLive');
      assertEq(last.data.tx as string, hash, 'data.tx');
      assertEq(last.data.contractsAssignedSource === undefined, true, 'no resolver on the log path: the count is the log itself');
      const tape = ((await health.get('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 2);
      assert(tape !== undefined, '/cycles serves cycle 2');
      assertEq(tape.premium_gross_usdg6 as string, premium.toString(), '/cycles premium_gross_usdg6');
      assertEq(tape.roll_close_tx as string, hash, '/cycles roll_close_tx');
      const rowBefore = JSON.stringify({ ...store.getCycle(2), updated_at: 0 });
      await roll.reconcile();
      await roll.tick();
      assertEq(alerts.received.length, alertsBefore + 3, 'reconcile() and another tick raise nothing more (the fee condition is inside its cooldown)');
      assertEq(keeperTxs().length, txsBefore, 'and send nothing');
      assertEq(JSON.stringify({ ...store.getCycle(2), updated_at: 0 }), rowBefore, 'the row is unchanged');
      record.guardianClose.keeperRow = { status: cycle.status, gross: cycle.gross_usdg6, fee: cycle.fee_usdg6, net: cycle.net_usdg6, contracts: cycle.contracts, contractsAssigned: cycle.contracts_assigned, assetsReturned: cycle.assets_returned, usdgFromAssignment: cycle.usdg_from_assignment };
      record.guardianClose.alert = last.message;
    });

    /* =====================================================================================
       CYCLE 3 (e): the Valorem engine fee, on
       ===================================================================================== */

    await step('cycle 3: with the fee on and not accepted the keeper keeps refusing to arm; rollOpen simulates ValoremFeeNotAccepted(15)', async () => {
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'still Idle');
      assert(store.getCycle(3) === null, 'no cycle row: not handled, only deferred');
      const skip = store.db.prepare("SELECT value FROM meta WHERE key LIKE 'skip_reason:%' ORDER BY key DESC LIMIT 1").get() as { value: string } | undefined;
      assertEq(skip?.value ?? null, 'valorem-fees-enabled', 'the reason is remembered');
      const refused = alerts.last('valorem_fees_enabled');
      assertEq(refused.severity, 'warn', 'severity');
      assertEq(refused.message, `Valorem's engine fee is on (${VALOREM_FEE_BPS} bps). The vault will not arm or fill until an admin calls acceptValoremFee(true).`, 'message');
      const flipped = alerts.last('fee_switch');
      assertEq(flipped.data.feesEnabled as boolean, true, 'fee_switch data.feesEnabled');
      assertEq(flipped.data.feeAccepted as boolean, false, 'fee_switch data.feeAccepted');
      const state = (await health.get('/state')).body.vault as { valoremFeesEnabled: boolean; valoremFeeAccepted: boolean };
      assertEq(state.valoremFeesEnabled, true, '/state valoremFeesEnabled');
      assertEq(state.valoremFeeAccepted, false, '/state valoremFeeAccepted');
      // The vault's own gate, on the type the keeper would arm: the tuple at the live spot.
      const { nextWeekWindow } = await import('./calendar.js');
      const { targetStrike6 } = await import('./optionType.js');
      const headTs = (await pub.getBlock({ blockTag: 'latest' })).timestamp;
      const window = nextWeekWindow(Number(headTs), config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
      const strike = targetStrike6(await spotUsdg(), config.KEEPER_STRIKE_OTM_BPS);
      const { receipt: typed } = await sendTx('clear.newOptionType (harness, the tuple the keeper would arm)', ANYONE, () =>
        wallet.writeContract({ account: ANYONE, chain: forkChain, address: CLEAR, abi: clearAbi, functionName: 'newOptionType', args: [NVDA, LOT, USDG, strike, window.exerciseTs, window.expiryTs] }),
      );
      const id = only(parseEventLogs({ abi: clearAbi, eventName: 'NewOptionType', logs: typed.logs }), CLEAR, 'NewOptionType').args.optionId;
      const args = await expectRevert('rollOpen (keeper key) with the fee on and not accepted', 'ValoremFeeNotAccepted', () =>
        pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'rollOpen', args: [id] }),
      );
      assertEq(BigInt(args[0] as number), VALOREM_FEE_BPS, 'ValoremFeeNotAccepted.feeBps = 15');
      note(`feeTo ${feeOn.feeTo} flipped the switch; the keeper deferred the week with reason valorem-fees-enabled`);
      record.valoremFee.refusedAlert = refused.message;
      record.valoremFee.rollOpenRevert = `ValoremFeeNotAccepted(${String(args[0])})`;
    });

    const listed3 = await step('cycle 3: admin acceptValoremFee(true); tick -> the keeper arms (reusing the tuple) and prices the listing with the fee valued at spot', async () => {
      await sendTx('vault.acceptValoremFee(true) (admin)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'acceptValoremFee', args: [true] }),
      );
      assertEq(await pub.readContract({ ...V, functionName: 'valoremFeeAccepted' }), true, 'accepted');
      const idle = await pub.readContract({ ...V, functionName: 'idleAssets' });
      const alertsBefore = alerts.received.length;
      await roll.tick();
      const cycle = store.getCycle(3);
      assert(cycle !== null && cycle.roll_open_tx !== null, 'the keeper armed');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_open,listing', 'armed and listed; the standing fee condition cleared');
      assertEq(keeperTxs().slice(-2).map((t) => t.kind).join(','), 'rollOpen,approveListing', 'no newOptionType: the tuple the harness created is the one the keeper derived, and it reused it');
      const row = onlyListingFor(3, 1);
      const p = await policy.readPolicy();
      const capacity = capacityOf(idle, 0n, p);
      assertEq(BigInt(row.contracts), capacity, 'sized on idle as usual');
      const { unit, floorUnit, spot } = await expectedUnit(capacity);
      assertEq(BigInt(row.unit_price6), unit, 'priced with the engine fee valued at spot on top of the premium floor');
      const floorNoFee = policy.fillFloorUnit6(spot, capacity, p, false, 15);
      assert(floorUnit > floorNoFee, `the fee lifts the floor: ${floorNoFee} -> ${floorUnit} per contract`);
      const feeAsset = policy.engineFeeAsset(capacity, true, 15);
      assertEq(policy.fillFloorUsdg6(spot, capacity, p, true, 15), policy.fillFloorUsdg6(spot, capacity, p, false, 15) + (feeAsset * spot) / LOT, 'fillFloor = minPremium + fee x spot / LOT, as ValoremLib.writeOnFill');
      record.valoremFee.contracts = row.contracts;
      record.valoremFee.unitPrice6 = row.unit_price6;
      record.valoremFee.floorUnit6 = floorUnit.toString();
      record.valoremFee.floorUnitWithoutFee6 = floorNoFee.toString();
      record.valoremFee.rollOpenTx = cycle.roll_open_tx;
      return { row, strike: BigInt(cycle.strike_usdg6 ?? '0'), optionId: BigInt(row.option_id), exercise: BigInt(cycle.exercise_ts ?? 0), expiry: BigInt(cycle.expiry_ts ?? 0) };
    });

    await step(`cycle 3: buyer A fills ${FILL_C3} (the write pulls collateral + 15 bps in NVDA); lock; buyer A exercises ${EXERCISE_C3} paying the exercise fee; expiry; tick -> rollClose with neither fee netted`, async () => {
      const [vaultNvda, clearNvda, ledgerNvdaBefore] = await Promise.all([
        balanceOf(NVDA, vault),
        balanceOf(NVDA, CLEAR),
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }),
      ]);
      const fill = await fillFromOrders('buyer A', BUYER_A, vault, await health.order(listed3.row.order_hash), FILL_C3);
      const collateral = FILL_C3 * LOT;
      let writeFee = (collateral * VALOREM_FEE_BPS) / BPS;
      if (writeFee === 0n) writeFee = 1n;
      assertEq(vaultNvda - (await balanceOf(NVDA, vault)), collateral + writeFee, 'the vault paid collateral + 15 bps of it');
      assertEq((await balanceOf(NVDA, CLEAR)) - clearNvda, collateral + writeFee, 'the Clear received both');
      assertEq((await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] })) - ledgerNvdaBefore, writeFee, "the Clear's NVDA fee ledger moved by exactly the write fee");
      assertEq(await pub.readContract({ address: NVDA, abi: erc20Abi, functionName: 'allowance', args: [vault, CLEAR] }), 0n, 'no standing allowance to the Clear');
      await roll.tick();
      await warpAndRefresh(listed3.exercise, 'cycle-3 exerciseTimestamp', feed, answerAbove(listed3.strike, 5n));
      await roll.tick();
      assertEq(store.getCycle(3)?.status ?? null, 'locked', 'locked');
      const done = await exerciseOn('buyer A', BUYER_A, vault, listed3.optionId, EXERCISE_C3, listed3.strike);
      assertEq(done.feesEnabled, true, 'the exercise ran with the fee on');
      let expectedFee = (EXERCISE_C3 * listed3.strike * VALOREM_FEE_BPS) / BPS;
      if (expectedFee === 0n) expectedFee = 1n;
      assertEq(done.fee, expectedFee, 'exercise fee = 15 bps of the strike USDG');
      await warpAndRefresh(listed3.expiry, 'cycle-3 expiryTimestamp', feed, answerAbove(listed3.strike, 5n));
      const [ledgerNvda, ledgerUsdg, vaultNvdaBefore] = await Promise.all([
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }),
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] }),
        balanceOf(NVDA, vault),
      ]);
      await roll.tick();
      const cycle = store.getCycle(3);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'the keeper closed');
      const receipt = await receiptOf(cycle.roll_close_tx);
      const { rc, hv } = closeEvents(receipt);
      assertEq(rc.contractsAssignedCount, EXERCISE_C3, 'RollClose.contractsAssignedCount');
      assertEq(rc.assetsReturned, (FILL_C3 - EXERCISE_C3) * LOT, 'RollClose.assetsReturned: every unassigned lot, the write fee not netted');
      assertEq(rc.usdgFromAssignment, EXERCISE_C3 * listed3.strike, 'RollClose.usdgFromAssignment: exactly strike x assigned, the exercise fee not netted');
      assertEq((await balanceOf(NVDA, vault)) - vaultNvdaBefore, rc.assetsReturned, 'collateral back');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }), ledgerNvda, 'redeem charges no NVDA fee');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] }), ledgerUsdg, 'redeem charges no USDG fee');
      assertEq(hv.grossUsdg, fill.premium + rc.usdgFromAssignment, 'Harvest.gross');
      const { protocolFeeBps } = await policy.readPolicy();
      assertEq(hv.feeUsdg, (fill.premium * protocolFeeBps) / BPS, 'protocol fee on the premium only');
      assertEq(cycle.contracts, Number(FILL_C3), 'contracts');
      assertEq(cycle.contracts_assigned, Number(EXERCISE_C3), 'contracts_assigned');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment');
      const last = alerts.latest();
      assertEq(last.kind, 'roll_close', 'roll_close');
      assertEq(
        last.message,
        `cycle 3 closed: premium ${roll.formatUsdg(fill.premium)} USDG (fee ${roll.formatUsdg(hv.feeUsdg)}), strike proceeds ${roll.formatUsdg(rc.usdgFromAssignment)} USDG from ${EXERCISE_C3} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors.`,
        'roll_close message',
      );
      record.valoremFee.fillTx = fill.hash;
      record.valoremFee.fillGasUsed = fill.gasUsed.toString();
      record.valoremFee.premium = fill.premium.toString();
      record.valoremFee.writeFeeNvdaWei = writeFee.toString();
      record.valoremFee.exerciseTx = done.hash;
      record.valoremFee.exerciseFeeUsdg6 = done.fee.toString();
      record.valoremFee.rollCloseTx = cycle.roll_close_tx;
      record.valoremFee.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.valoremFee.harvest = { gross: hv.grossUsdg.toString(), fee: hv.feeUsdg.toString(), net: hv.netUsdg.toString() };
      record.valoremFee.alert = last.message;
    });

    /* ---------- what the keeper remembers ---------- */

    await step('close the store, reopen the same file: every row is there', async () => {
      const expectedAlerts = [
        'boot', 'roll_open', 'listing',
        'fill', 'listing', 'fill', 'listing', 'fill', 'roll_close',
        'roll_open', 'listing', 'fill',
        'fee_switch', 'valorem_fees_enabled', 'roll_close',
        'roll_open', 'listing', 'fill', 'roll_close',
      ].join(',');
      assertEq(alerts.kinds().join(','), expectedAlerts, 'every alert, in order, nothing else');
      const txs = keeperTxs();
      assertEq(
        txs.map((t) => `${t.cycle_number ?? '-'}:${t.kind}:${t.status}`).join(','),
        [
          '-:newOptionType:success', '1:rollOpen:success', '1:approveListing:success',
          '1:approveListing:success', '1:cancelListing:success', '1:approveListing:success', '1:lockBook:success', '1:rollClose:success',
          '-:newOptionType:success', '2:rollOpen:success', '2:approveListing:success', '2:lockBook:success',
          '3:rollOpen:success', '3:approveListing:success', '3:lockBook:success', '3:rollClose:success',
        ].join(','),
        'every keeper transaction: cycle 2 has no rollClose of its own; cycle 3 reused a tuple',
      );
      const before = store.counts();
      assertEq(JSON.stringify(before), JSON.stringify({ cycles: 3, listings: 5, txs: 16, alerts: 19, meta: before.meta }), 'row counts');
      record.blocks.lastBlock = (await pub.getBlockNumber()).toString();
      record.health.final = (await health.get('/health')).body;
      record.health.state = (await health.get('/state')).body;
      record.db = {
        counts: before,
        cycles: store.recentCycles(10),
        listings: store.db.prepare('SELECT order_hash, cycle_number, seq, option_id, contracts, unit_price6, gross_usdg6, end_time, counter, status, approve_tx, cancel_tx, seaport_total_filled, seaport_total_size, seaport_cancelled FROM listings ORDER BY cycle_number, seq').all(),
        txs: store.recentTxs(50),
        alerts: store.recentAlerts(50).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, delivered: a.delivered })),
        meta: store.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
      };
      stopServers();
      healthServer = null;
      store.close();
      const reopened = new KeeperStore(dbPath);
      try {
        assertEq(JSON.stringify(reopened.counts()), JSON.stringify(before), 'identical after reopen');
        assertEq(reopened.recentCycles(10).map((c) => `${c.cycle_number}:${c.status}:${c.contracts_assigned}`).join(','), '3:closed:2,2:closed:4,1:closed:9', 'every cycle row');
      } finally {
        reopened.close();
      }
      for (const suffix of ['-wal', '-shm']) assertEq(existsSync(`${dbPath}${suffix}`), false, `no ${suffix} after the final close`);
      note(`keeper.db rows: ${JSON.stringify(before)}`);
    });

    record.wallClockMs = Date.now() - startedMs;
    writeReport();
    process.stdout.write(`\nEXTENDED DRY RUN PASSED in ${(record.wallClockMs / 1000).toFixed(1)}s. Report: ${join(OUT, 'report.md')}\n`);
  } catch (error) {
    record.stoppedAt = currentStep();
    record.error = error instanceof Error ? error.message : String(error);
    record.wallClockMs = Date.now() - startedMs;
    const running = child as KeeperProcess | null;
    if (running !== null) {
      writeFileSync(join(OUT, 'keeper-process.log'), `${running.raw.join('\n')}\n`);
      if (running.child.exitCode === null) running.child.kill('SIGKILL');
    }
    stopServers();
    writeReport();
    throw error;
  }
}

function writeReport(): void {
  writeRunFiles(OUT, 'Extended dry run', record, [
    ['indexTs', '(a) index.ts: the compiled process, poll loop, SIGTERM mid-tick'],
    ['relist', '(d) partial fills, guardian cancel, reprice after a rally, refused fills, the budget'],
    ['exercisers', '(b) several exercisers, several transactions'],
    ['guardianClose', '(c) anyone rollClose and the reconciliation from logs'],
    ['valoremFee', '(e) the Valorem engine fee'],
  ]);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`\nEXTENDED DRY RUN FAILED at "${currentStep()}": ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`Partial report: ${join(OUT, 'report.md')}\n`);
    process.exit(1);
  });
