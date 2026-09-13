/**
 * The K-22 scenarios the three-cycle dry run does not reach, for real, against an anvil fork of
 * Robinhood Chain 4663. One vault, three cycles, every cycle a fresh series on the real Valorem
 * Clear (MockRegistry and MockFeed exactly as in dryrun.ts; the shared plumbing is
 * dryrun-common.ts):
 *
 *   cycle 1  (a) index.ts. The COMPILED keeper (`node dist/index.js`, the Dockerfile's CMD) is
 *            started as a child process on a 5 s poll against the fork. It boots, reconciles,
 *            ticks twice with nothing to write, then — after a deposit lands — writes, approves
 *            and POSTs on its next poll tick. The harness holds that POST open, sends SIGTERM
 *            while the tick is provably in flight, and asserts the process finishes the tick,
 *            closes SQLite, and exits 0 with no -wal/-shm/-journal left beside the database.
 *            The in-process keeper then opens the SAME state.db and carries the week on.
 *            (d) Partial fills, cancel, relist budget. Buyer A fills 7/28 of the listing through
 *            fulfillAdvancedOrder; the guardian cancelListing()s it; the keeper relists the 21
 *            left. Buyer B fills 6/21; the guardian invalidateAllListings(); the keeper relists
 *            15 at the new counter. Buyer A fills 5/15; the guardian cancels again, and the
 *            keeper, with KEEPER_MAX_RELISTS=2 spent and the vault at 3 of 3 listings, relists
 *            nothing — and a fourth approveListing reverts TooManyListings(3, 3).
 *            (b) Several exercisers, several transactions. A exercises 4, B exercises 6, A
 *            exercises 3, each in its own transaction on the real Clear; rollClose publishes 13
 *            of 28 assigned from ONE RollClose, and every leg of the harvest and redeem is exact.
 *   cycle 2  (c) Guardian rollClose. The keeper writes, lists, is filled and locks the book, then
 *            does not tick at expiry. A role-less address calls rollClose: GuardianTooEarly at
 *            expiry and at expiry + 1 h - 1 s, success at exactly expiry + 1 h. The keeper's next
 *            tick reconstructs the close from logs (K-17) with the K-21 columns.
 *   cycle 3  (e) The Valorem fee branch. The Clear's `feeTo` (impersonated) turns the engine fee
 *            on. The keeper refuses to write and alerts; rollOpen reverts ValoremFeeNotAccepted;
 *            after acceptValoremFee(true) the keeper writes through the fee (15 bps of the
 *            collateral, in NVDA), and the exercise pays its own fee (15 bps of the strike, in
 *            USDG). rollClose's claim proceeds are untouched by either fee.
 *
 * HOW TO RUN IT (keeper/README.md has the long form):
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
 *   (cd contracts && forge build)
 *   pnpm --filter @callhouse/keeper dryrun:extended
 *
 * ENV (all optional): DRYRUN_RPC, DRYRUN_ARTIFACTS, DRYRUN_OUT (default ./dryrun-out/extended-<utc>),
 * DRYRUN_DEPOSIT (default 30e18; at least 23e18 so the first listing is 21+ contracts),
 * DRYRUN_HEALTH_PORT (default 18797; the child keeper uses the next port), DRYRUN_KEEPER_PK.
 *
 * Every keeper variable is set here before the keeper is imported or spawned; a keeper .env is
 * deliberately NOT read (KEEPER_ENV_FILE=/dev/null).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getAddress, keccak256, parseEventLogs, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { clearAbi, harvestEvent, registryAbi, rollCloseEvent, seaportAbi, vaultAbi } from './abi.js';
import {
  ADMIN,
  BPS,
  BUYER,
  CHAIN_ID,
  CLEAR,
  DEPOSITOR,
  FEED,
  FEE_SAFE,
  KEEPER,
  LAUNCH_POLICY,
  LOT,
  NVDA,
  ONE_HUNDRED_ETH,
  OVERCALL_FEE,
  RPC,
  SEAPORT,
  USDG,
  ZERO_BYTES32,
  AlertCapture,
  OvercallStub,
  artifact,
  assert,
  assertEq,
  balanceOf,
  clearDelegation,
  clearFeeAbi,
  createFreshSeries,
  currentStep,
  deal,
  deploy,
  deployLinked,
  derivedActor,
  erc20Abi,
  erc20AllowanceAbi,
  expectRevert,
  feedAbi,
  forkChain,
  harvestFee,
  latestTimestamp,
  mineAt,
  mockFeedAbi,
  note,
  pub,
  rpc,
  sendTx,
  setBalance,
  setNextBlockTimestamp,
  step,
  trail,
  vaultQueueAbi,
  wallet,
  warpTo,
} from './dryrun-common.js';
import type { ListingRow } from './state.js';

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.env.DRYRUN_OUT ?? join('dryrun-out', `extended-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const DEPOSIT = BigInt(process.env.DRYRUN_DEPOSIT ?? '30000000000000000000');
const HEALTH_PORT = Number(process.env.DRYRUN_HEALTH_PORT ?? '18797');
const CHILD_PORT = HEALTH_PORT + 1;
/** The schema's minimum poll interval (config.ts POLL_INTERVAL_MS). */
const POLL_INTERVAL_MS = 5_000;
/** The schema's maximum keeper relist budget: 1 first listing + 2 relists = the vault's cap of 3. */
const MAX_RELISTS = 2;
/** Policy.MAX_LISTINGS_PER_CYCLE. */
const MAX_LISTINGS = 3;
/** Valorem's `uint8 public constant feeBps = 15` (recon R4). */
const VALOREM_FEE_BPS = 15n;
const ACC_PRECISION = 10n ** 27n;
const ONE_HOUR = 3_600n;

/** Cycle 1 fills (contracts) and exercises (contracts), in order. */
const FILL_A1 = 7n;
const FILL_B = 6n;
const FILL_A2 = 5n;
const EXERCISE_A1 = 4n;
const EXERCISE_B = 6n;
const EXERCISE_A2 = 3n;
/** Cycle 2 and cycle 3 exercises. */
const EXERCISE_C2 = 4n;
const EXERCISE_C3 = 5n;

const BUYER_A = BUYER;
const BUYER_B = derivedActor('buyer-b');
const GUARDIAN = derivedActor('guardian');
/** Holds no role at all: the "anyone" of Vault.rollClose's NatSpec. */
const ANYONE = derivedActor('anyone');

/*//////////////////////////////////////////////////////////////
                              THE RECORD
//////////////////////////////////////////////////////////////*/

const record = {
  startedAt: new Date().toISOString(),
  rpc: RPC,
  clientVersion: '',
  chainId: 0,
  forkBlock: '',
  deposit: DEPOSIT.toString(),
  actors: trail.actors,
  addresses: trail.addresses,
  indexTs: {} as Record<string, unknown>,
  relist: {} as Record<string, unknown>,
  exercisers: {} as Record<string, unknown>,
  guardianClose: {} as Record<string, unknown>,
  valoremFee: {} as Record<string, unknown>,
  harnessTxs: trail.harnessTxs,
  steps: trail.steps,
  stubRequests: trail.stubRequests,
  alerts: trail.alerts,
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
  assert(DEPOSIT >= 23n * LOT && DEPOSIT <= 50n * LOT, `DRYRUN_DEPOSIT must be within [23e18, 50e18] (the first listing needs ${FILL_A1 + FILL_B + FILL_A2}+ contracts; the cap is 50)`);

  /* ---------- 0. the production artefact, then preflight ---------- */

  await step('build the production keeper: tsc -p tsconfig.json -> dist/index.js (the Dockerfile CMD)', async () => {
    execFileSync(join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: PACKAGE_DIR, stdio: 'inherit' });
    assert(existsSync(join(PACKAGE_DIR, 'dist', 'index.js')), 'dist/index.js was built');
    note(`built ${join(PACKAGE_DIR, 'dist', 'index.js')}`);
  });

  await step('preflight: this is an anvil fork of 4663', async () => {
    const clientVersion = await rpc<string>('web3_clientVersion');
    assert(clientVersion.toLowerCase().includes('anvil'), `${RPC} is not anvil (reports "${clientVersion}"). This script writes storage and warps time.`);
    const chainId = await pub.getChainId();
    assertEq(chainId, CHAIN_ID, 'chain id');
    let forkBlock = 'unknown';
    try {
      const info = await rpc<{ forkConfig?: { forkBlockNumber?: number } }>('anvil_nodeInfo');
      if (info.forkConfig?.forkBlockNumber !== undefined) forkBlock = String(info.forkConfig.forkBlockNumber);
    } catch {
      /* older anvil */
    }
    if (forkBlock === 'unknown') forkBlock = (await pub.getBlockNumber()).toString();
    record.clientVersion = clientVersion;
    record.chainId = chainId;
    record.forkBlock = forkBlock;
    note(`anvil ${clientVersion}, fork block ${forkBlock}, head timestamp ${await latestTimestamp()}`);
    const actors = { keeper: KEEPER, admin: ADMIN, feeSafe: FEE_SAFE, guardian: GUARDIAN, anyone: ANYONE, depositor: DEPOSITOR, buyerA: BUYER_A, buyerB: BUYER_B };
    for (const [label, actor] of Object.entries(actors)) {
      await setBalance(actor.address, ONE_HUNDRED_ETH);
      await clearDelegation(actor.address);
      trail.actors[label] = actor.address;
    }
  });

  /* ---------- 1. deploy ---------- */

  const { registry, feed, vault, realAnswer } = await step('deploy MockRegistry, MockFeed, both libraries and the linked Vault; grant KEEPER_ROLE and GUARDIAN_ROLE', async () => {
    const [, answer] = await pub.readContract({ address: FEED, abi: feedAbi, functionName: 'latestRoundData' });
    note(`real Chainlink answer at the fork block: ${answer} (8 dp)`);
    const mockRegistry = artifact('MockRegistry.sol/MockRegistry.json');
    const registryAddr = await deploy('MockRegistry', ADMIN, mockRegistry.abi, mockRegistry.bytecode.object, [NVDA, USDG, CLEAR]);
    const mockFeed = artifact('MockFeed.sol/MockFeed.json');
    const feedAddr = await deploy('MockFeed', ADMIN, mockFeed.abi, mockFeed.bytecode.object, [8, answer, 'RHNVDA / USD (dry-run mirror of the real answer)']);
    const vaultAddr = await deployLinked('Vault', ADMIN, artifact('Vault.sol/Vault.json'), [
      {
        asset: NVDA,
        usdg: USDG,
        clear: CLEAR,
        seaport: SEAPORT,
        registry: registryAddr,
        priceFeed: feedAddr,
        maxPriceAge: 4 * 86_400,
        overcallFeeRecipient: OVERCALL_FEE,
        conduitKey: ZERO_BYTES32,
        seaportZone: '0x0000000000000000000000000000000000000000',
        admin: ADMIN.address,
        feeRecipient: FEE_SAFE.address,
        depositCap: 50n * LOT,
        name: 'Callhouse NVDA (extended dry run)',
        symbol: 'cNVDA',
      },
    ]);
    const [keeperRole, guardianRole] = await Promise.all([
      pub.readContract({ address: vaultAddr, abi: vaultAbi, functionName: 'KEEPER_ROLE' }),
      pub.readContract({ address: vaultAddr, abi: vaultAbi, functionName: 'GUARDIAN_ROLE' }),
    ]);
    await sendTx('grantRole(KEEPER_ROLE, keeper)', ADMIN, () =>
      wallet.writeContract({ account: ADMIN, chain: forkChain, address: vaultAddr, abi: vaultAbi, functionName: 'grantRole', args: [keeperRole, KEEPER.address] }),
    );
    await sendTx('grantRole(GUARDIAN_ROLE, guardian)', ADMIN, () =>
      wallet.writeContract({ account: ADMIN, chain: forkChain, address: vaultAddr, abi: vaultAbi, functionName: 'grantRole', args: [guardianRole, GUARDIAN.address] }),
    );
    for (const [who, role] of [[ANYONE.address, keeperRole], [ANYONE.address, guardianRole], [GUARDIAN.address, keeperRole]] as const) {
      assertEq(await pub.readContract({ address: vaultAddr, abi: vaultAbi, functionName: 'hasRole', args: [role, who] }), false, `${who} does not hold ${role}`);
    }
    return { registry: registryAddr, feed: feedAddr, vault: vaultAddr, realAnswer: answer };
  });
  const deployment = { vault, feed, registry, answer: realAnswer };
  const V = { address: vault, abi: vaultAbi } as const;
  const Q = { address: vault, abi: vaultQueueAbi } as const;

  /* ---------- 2. stubs and the keeper environment (the child gets the same) ---------- */

  const stub = new OvercallStub();
  const alerts = new AlertCapture();
  await stub.start();
  await alerts.start();

  const keeperEnv: Record<string, string> = {
    KEEPER_ENV_FILE: '/dev/null',
    RH_RPC: RPC,
    CHAIN_ID: String(CHAIN_ID),
    REGISTRY: registry,
    VAULT: vault,
    KEEPER_PK: process.env.DRYRUN_KEEPER_PK ?? keccak256(toHex('callhouse-dryrun:keeper')),
    KEEPER_DB_PATH: dbPath,
    KEEPER_FALLBACK_DIR: join(OUT, 'fallback'),
    OVERCALL_ORDERS_URL: `${stub.url}/api/orders`,
    OVERCALL_MARKET: 'NVDA',
    OVERCALL_MAX_ATTEMPTS: '2',
    ALERT_WEBHOOK: alerts.url,
    POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
    KEEPER_MAX_RELISTS: String(MAX_RELISTS),
  };
  const unsetForKeeper = ['RH_RPC_2', 'KEEPER_UNIT_PRICE_USDG6', 'PREMIUM_MARGIN_BPS', 'OVERCALL_API_KEY'];
  for (const key of unsetForKeeper) delete process.env[key];
  Object.assign(process.env, keeperEnv, { KEEPER_PORT: String(HEALTH_PORT), KEEPER_LOG_LEVEL: process.env.KEEPER_LOG_LEVEL ?? 'info' });

  // seaport.ts loads config, clients and logger — but NOT state.ts — so the database file stays
  // untouched by this process until the child has exited. The stub needs the keeper's own hash.
  const seaport = await import('./seaport.js');
  stub.hashOf = (components) => seaport.localOrderHash(seaport.componentsFromJson(components as never));

  let healthServer: { close: () => void } | null = null;
  const stopServers = (): void => {
    healthServer?.close();
    stub.stop();
    alerts.stop();
  };

  const only = <T extends { address: Address }>(events: readonly T[], at: Address, what: string): T => {
    const matching = events.filter((e) => e.address.toLowerCase() === at.toLowerCase());
    assertEq(matching.length, 1, `exactly one ${what} event from ${at}`);
    const found = matching[0];
    assert(found !== undefined, what);
    return found;
  };
  const posts = () => stub.requests.filter((r) => r.startsWith('POST')).length;
  const deletes = () => stub.requests.filter((r) => r.startsWith('DELETE')).length;
  const orderStatus = async (hash: string) => {
    const [isValidated, isCancelled, totalFilled, totalSize] = await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getOrderStatus', args: [hash as Hex] });
    return { isValidated, isCancelled, totalFilled, totalSize };
  };
  const optionBalance = (holder: Address, optionId: bigint) => pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [holder, optionId] });

  let child: KeeperProcess | null = null;

  try {
    /* =====================================================================================
       CYCLE 1 (a): index.ts — the real process, its poll loop, and SIGTERM mid-tick
       ===================================================================================== */

    const series1 = await step('cycle 1: a fresh five-rung series on the real Clear; the vault holds nothing yet', async () => {
      const series = await createFreshSeries(deployment, 1, record.indexTs);
      assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), 0n, 'no deposits yet');
      assertEq(await pub.readContract({ address: registry, abi: registryAbi, functionName: 'isWritingOpen' }), true, 'writing open');
      return series;
    });

    const proc = await step(`index.ts: spawn node dist/index.js (POLL_INTERVAL_MS=${POLL_INTERVAL_MS}); boot, reconcile, two idle poll ticks`, async () => {
      // The deposit's balance and approval are staged now, so that later only the deposit itself
      // has to land between two poll ticks.
      await deal(NVDA, DEPOSITOR.address, DEPOSIT);
      await sendTx('NVDA.approve(vault)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: NVDA, abi: erc20Abi, functionName: 'approve', args: [vault, DEPOSIT] }),
      );
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
      const idle = (l: KeeperLogLine) => l.msg === 'no write this tick' && l.reason === 'no-idle-collateral';
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
      const body = (await response.json()) as { status: string; lastHeartbeat: string | null; vault: { phase: string | null; registryCycleNumber: number | null }; keeper: { address: string } };
      assertEq(response.status, 200, "the child's GET /health");
      assertEq(body.keeper.address, KEEPER.address, "the child's keeper address");
      assertEq(body.vault.phase, 'Idle', "the child's view of the vault phase");
      assertEq(body.vault.registryCycleNumber, 1, "the child's view of the registry cycle");
      assert(body.lastHeartbeat !== null, 'the poll loop has beaten');
      assertEq(posts(), 0, 'nothing posted while there was nothing to write');
      record.indexTs.pid = spawned.pid;
      record.indexTs.idleTickGapMs = t2.time - t1.time;
      record.indexTs.childHealth = body;
      note(`two idle ticks ${t2.time - t1.time} ms apart; /health ${body.status}`);
      return keeper;
    });

    const inFlight = await step('index.ts: a deposit lands; the next poll tick writes, approves and POSTs; SIGTERM while the POST is held open', async () => {
      const gate = stub.holdNextPost();
      await sendTx('vault.deposit', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT, DEPOSITOR.address] }),
      );
      await gate.arrived;
      assertEq(proc.child.exitCode, null, 'alive when the POST arrives');
      // How many idle polls ran before the deposit landed depends on the RPC's speed; what
      // cannot vary is that every tick but the last found nothing to write, and that each tick
      // started at least one poll interval after the previous one.
      const ticksAtSignal = proc.count((l) => l.msg === 'tick');
      const idleTicks = proc.count((l) => l.msg === 'no write this tick' && l.reason === 'no-idle-collateral');
      assert(idleTicks >= 2, `at least the two idle ticks already seen (${idleTicks})`);
      assertEq(ticksAtSignal, idleTicks + 1, 'every tick before this one was idle; this one is the work');
      const tickTimes = proc.lines.filter((l) => l.msg === 'tick').map((l) => l.time);
      for (let i = 1; i < tickTimes.length; i += 1) {
        const gap = (tickTimes[i] ?? 0) - (tickTimes[i - 1] ?? 0);
        assert(gap >= POLL_INTERVAL_MS, `tick ${i + 1} started ${gap} ms after tick ${i} (>= ${POLL_INTERVAL_MS})`);
      }
      record.indexTs.ticksBeforeSignal = ticksAtSignal;
      record.indexTs.idleTicks = idleTicks;
      assertEq(proc.count((l) => l.msg === 'transaction confirmed' && l.kind === 'rollOpen'), 1, 'rollOpen confirmed inside the tick');
      assertEq(proc.count((l) => l.msg === 'transaction confirmed' && l.kind === 'approveListing'), 1, 'approveListing confirmed inside the tick');
      assertEq(proc.count((l) => l.msg === 'listing published to Overcall'), 0, 'the POST has not returned');
      const linesAtSignal = proc.lines.length;
      assert(proc.child.kill('SIGTERM'), 'SIGTERM delivered');
      note(`SIGTERM sent to pid ${proc.child.pid} with the POST held (line ${linesAtSignal})`);
      await proc.waitFor('"waiting for the in-flight tick"', (l) => l.msg === 'waiting for the in-flight tick');
      // Two more seconds with the tick blocked: the process must still be there.
      await sleep(2_000);
      assertEq(proc.child.exitCode, null, 'still alive 2 s after SIGTERM: it is waiting for the tick, not dying mid-transaction');
      assertEq(proc.count((l) => l.msg === 'stopped'), 0, 'not stopped while the tick is in flight');
      gate.release();
      const exit = await proc.exited;
      return { exit, linesAtSignal, ticksAtSignal };
    });

    await step('index.ts: exit 0 after the in-flight tick; SQLite closed cleanly; the file reopens with every row', async () => {
      assertEq(inFlight.exit.code, 0, 'exit code');
      assertEq(inFlight.exit.signal, null, 'exited on its own, not killed by the signal');
      const iSignal = proc.index((l) => l.msg === 'shutting down' && l.signal === 'SIGTERM');
      const iWait = proc.index((l) => l.msg === 'waiting for the in-flight tick');
      const iPublished = proc.index((l) => l.msg === 'listing published to Overcall');
      const iStopped = proc.index((l) => l.msg === 'stopped');
      assert(iSignal >= inFlight.linesAtSignal, 'the shutdown line follows the signal');
      assert(iSignal < iWait && iWait < iPublished && iPublished < iStopped, `order: shutting down (${iSignal}) < waiting (${iWait}) < published (${iPublished}) < stopped (${iStopped})`);
      assertEq(iStopped, proc.lines.length - 1, '"stopped" is the last line');
      assertEq(proc.count((l) => l.msg === 'tick'), inFlight.ticksAtSignal, 'no tick started after SIGTERM');
      assertEq(proc.count((l) => l.level === 'error' || l.level === 'fatal'), 0, 'no error lines');
      assertEq(posts(), 1, 'one POST');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        assertEq(existsSync(`${dbPath}${suffix}`), false, `no ${suffix} file beside the database after close`);
      }

      // Reopen with a fresh connection, independent of the keeper's own store.
      const raw = new Database(dbPath);
      try {
        assertEq(String(raw.pragma('integrity_check', { simple: true })), 'ok', 'PRAGMA integrity_check');
        assertEq(String(raw.pragma('journal_mode', { simple: true })), 'wal', 'the file is still in WAL mode');
        const counts = Object.fromEntries(['cycles', 'listings', 'txs', 'alerts', 'meta'].map((t) => [t, (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
        assertEq(JSON.stringify(counts), JSON.stringify({ cycles: 1, listings: 1, txs: 2, alerts: 2, meta: 2 }), 'rows written by the process');
        const cycle = raw.prepare('SELECT * FROM cycles WHERE cycle_number = 1').get() as { status: string; roll_open_tx: string | null; contracts: number };
        assertEq(cycle.status, 'open', 'cycle 1 open');
        assert(cycle.roll_open_tx !== null, 'roll_open_tx');
        const listing = raw.prepare('SELECT * FROM listings WHERE cycle_number = 1').get() as { status: string; api_status: string | null; posted_at: number | null; order_hash: string; contracts: string };
        assertEq(listing.status, 'posted', 'the listing row reached posted: the held POST completed after SIGTERM');
        assertEq(listing.api_status, 'open', 'book status from the 201');
        assert(listing.posted_at !== null, 'posted_at stamped');
        const txs = raw.prepare('SELECT kind, status FROM txs ORDER BY created_at, rowid').all() as Array<{ kind: string; status: string }>;
        assertEq(txs.map((t) => `${t.kind}:${t.status}`).join(','), 'rollOpen:success,approveListing:success', 'txs');
        const alertRows = raw.prepare('SELECT kind, delivered FROM alerts ORDER BY id').all() as Array<{ kind: string; delivered: number }>;
        assertEq(alertRows.map((a) => `${a.kind}:${a.delivered}`).join(','), 'boot:1,roll_open:1', 'alerts, both delivered');
        const meta = raw.prepare('SELECT key, value FROM meta ORDER BY key').all() as Array<{ key: string; value: string }>;
        assertEq(meta.map((m) => m.key).join(','), 'last_heartbeat_ms,skip_reason:1', 'meta');
        assertEq(meta.find((m) => m.key === 'skip_reason:1')?.value ?? null, 'no-idle-collateral', 'the idle ticks remembered why');
        const listingHash = await pub.readContract({ ...V, functionName: 'listingHash' });
        assertEq(listingHash.toLowerCase(), listing.order_hash.toLowerCase(), 'the vault authorised the hash the process stored');
        assertEq(await pub.readContract({ ...V, functionName: 'phase' }), 1, 'vault Listed');
        record.indexTs.exit = inFlight.exit;
        record.indexTs.rowsAfterExit = counts;
        record.indexTs.orderHash = listing.order_hash;
        record.indexTs.contracts = listing.contracts;
        record.indexTs.logOrder = { shuttingDown: iSignal, waitingForTick: iWait, listingPublished: iPublished, stopped: iStopped, lines: proc.lines.length };
      } finally {
        raw.close();
      }
      assertEq(existsSync(`${dbPath}-wal`), false, 'no -wal after the harness closed its own connection');
      writeFileSync(join(OUT, 'keeper-process.log'), `${proc.raw.join('\n')}\n`);
      note(`exit ${String(inFlight.exit.code)}; log order shutting-down ${iSignal} < waiting ${iWait} < published ${iPublished} < stopped ${iStopped}; no -wal/-shm/-journal`);
    });
    child = null;

    /* ---------- the in-process keeper takes the same database ---------- */

    const roll = await import('./roll.js');
    const { store, KeeperStore } = await import('./state.js');
    const policy = await import('./policy.js');
    const { startHealthServer } = await import('./health.js');
    const { account } = await import('./clients.js');
    assert(account.address === KEEPER.address, 'the keeper module derived the harness keeper address');
    healthServer = startHealthServer();
    const health = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`http://127.0.0.1:${HEALTH_PORT}${path}`);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const served = async () => (await health('/orders')).body.orders as Array<{ orderHash: string; signature: string; parameters: Record<string, unknown> }>;
    const keeperTxs = () => store.db.prepare('SELECT kind, cycle_number, status FROM txs ORDER BY created_at, rowid').all() as Array<{ kind: string; cycle_number: number; status: string }>;
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

    /**
     * A buyer fills `numerator/denominator` of `listed` on the REAL Seaport via
     * fulfillAdvancedOrder, from the payload the keeper's own GET /orders serves. Every leg exact.
     */
    const fillFromOrders = async (who: string, buyer: PrivateKeyAccount, listed: ListingRow, numerator: bigint): Promise<{ hash: Hex; toVault: bigint; toOvercall: bigint }> => {
      const denominator = BigInt(listed.contracts);
      const entry = (await served()).find((o) => o.orderHash.toLowerCase() === listed.order_hash.toLowerCase());
      assert(entry !== undefined, `/orders serves ${listed.order_hash}`);
      const p = entry.parameters as {
        offerer: string; zone: string; orderType: number; startTime: string; endTime: string; zoneHash: string; salt: string; conduitKey: string; totalOriginalConsiderationItems: string;
        offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
        consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
      };
      const parameters = {
        offerer: getAddress(p.offerer),
        zone: getAddress(p.zone),
        offer: p.offer.map((o) => ({ itemType: o.itemType, token: getAddress(o.token), identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount) })),
        consideration: p.consideration.map((c) => ({ itemType: c.itemType, token: getAddress(c.token), identifierOrCriteria: BigInt(c.identifierOrCriteria), startAmount: BigInt(c.startAmount), endAmount: BigInt(c.endAmount), recipient: getAddress(c.recipient) })),
        orderType: p.orderType,
        startTime: BigInt(p.startTime),
        endTime: BigInt(p.endTime),
        zoneHash: p.zoneHash as Hex,
        salt: BigInt(p.salt),
        conduitKey: p.conduitKey as Hex,
        totalOriginalConsiderationItems: BigInt(p.totalOriginalConsiderationItems),
      };
      const vaultLegTotal = BigInt(listed.to_vault6);
      const overcallLegTotal = BigInt(listed.to_overcall6);
      assertEq((vaultLegTotal * numerator) % denominator, 0n, 'the vault leg divides exactly (per-contract split x contracts)');
      assertEq((overcallLegTotal * numerator) % denominator, 0n, 'the Overcall leg divides exactly');
      const toVault = (vaultLegTotal * numerator) / denominator;
      const toOvercall = (overcallLegTotal * numerator) / denominator;
      const gross = toVault + toOvercall;
      const optionId = BigInt(listed.option_id);

      const buyerUsdgBefore = await balanceOf(USDG, buyer.address);
      await deal(USDG, buyer.address, buyerUsdgBefore + gross);
      await sendTx(`USDG.approve(seaport) (${who})`, buyer, () =>
        wallet.writeContract({ account: buyer, chain: forkChain, address: USDG, abi: erc20Abi, functionName: 'approve', args: [SEAPORT, gross] }),
      );
      const [vaultBefore, overcallBefore, buyerOptBefore, vaultOptBefore] = await Promise.all([
        balanceOf(USDG, vault),
        balanceOf(USDG, OVERCALL_FEE),
        optionBalance(buyer.address, optionId),
        optionBalance(vault, optionId),
      ]);
      const { hash, receipt } = await sendTx(`seaport.fulfillAdvancedOrder ${numerator}/${denominator} (${who})`, buyer, () =>
        wallet.writeContract({
          account: buyer,
          chain: forkChain,
          address: SEAPORT,
          abi: seaportAbi,
          functionName: 'fulfillAdvancedOrder',
          args: [{ parameters, numerator, denominator, signature: entry.signature as Hex, extraData: '0x' }, [], ZERO_BYTES32, buyer.address],
        }),
      );
      const fulfilled = only(parseEventLogs({ abi: seaportAbi, eventName: 'OrderFulfilled', logs: receipt.logs }), SEAPORT, 'OrderFulfilled');
      assertEq(fulfilled.args.orderHash.toLowerCase(), listed.order_hash.toLowerCase(), 'OrderFulfilled.orderHash');
      assertEq(fulfilled.args.offer[0]?.amount ?? null, numerator, `OrderFulfilled offer: ${numerator} contracts`);
      assertEq(fulfilled.args.consideration[0]?.amount ?? null, toVault, 'OrderFulfilled consideration[0]: the vault leg');
      assertEq(fulfilled.args.consideration[1]?.amount ?? null, toOvercall, "OrderFulfilled consideration[1]: Overcall's leg");
      assertEq((await balanceOf(USDG, vault)) - vaultBefore, toVault, "the vault's leg landed");
      assertEq((await balanceOf(USDG, OVERCALL_FEE)) - overcallBefore, toOvercall, "Overcall's leg landed");
      assertEq(await balanceOf(USDG, buyer.address), buyerUsdgBefore, 'the buyer paid exactly the fraction');
      assertEq((await optionBalance(buyer.address, optionId)) - buyerOptBefore, numerator, 'the buyer received the contracts');
      assertEq(vaultOptBefore - (await optionBalance(vault, optionId)), numerator, 'the vault inventory fell by the same');
      const status = await orderStatus(listed.order_hash);
      assert(status.totalSize > 0n && status.totalFilled * denominator === numerator * status.totalSize, `Seaport records ${status.totalFilled}/${status.totalSize} = ${numerator}/${denominator}`);
      note(`${who} filled ${numerator}/${denominator}: vault +${toVault}, Overcall +${toOvercall}; Seaport status ${status.totalFilled}/${status.totalSize}`);
      return { hash, toVault, toOvercall };
    };

    /** A buyer exercises `amount` on the REAL Clear; the Clear's fee switch is read live. Every leg exact. */
    const exercise = async (who: string, buyer: PrivateKeyAccount, optionId: bigint, amount: bigint, strike: bigint, claimKey: bigint) => {
      const [feesEnabled, feeBps] = await Promise.all([
        pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }),
        pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' }),
      ]);
      const rx = strike * amount;
      let fee = 0n;
      if (feesEnabled) {
        fee = (rx * BigInt(feeBps)) / BPS;
        if (fee === 0n) fee = 1n;
      }
      const debit = rx + fee;
      const [buyerUsdg, buyerNvda, buyerOpt, clearUsdg, clearNvda, feeLedger, claimBefore] = await Promise.all([
        balanceOf(USDG, buyer.address),
        balanceOf(NVDA, buyer.address),
        optionBalance(buyer.address, optionId),
        balanceOf(USDG, CLEAR),
        balanceOf(NVDA, CLEAR),
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] }),
        pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimKey] }),
      ]);
      await deal(USDG, buyer.address, buyerUsdg + debit);
      await sendTx(`USDG.approve(clear) (${who})`, buyer, () =>
        wallet.writeContract({ account: buyer, chain: forkChain, address: USDG, abi: erc20Abi, functionName: 'approve', args: [CLEAR, debit] }),
      );
      const { hash, receipt } = await sendTx(`clear.exercise(optionId, ${amount}) (${who})`, buyer, () =>
        wallet.writeContract({ account: buyer, chain: forkChain, address: CLEAR, abi: clearAbi, functionName: 'exercise', args: [optionId, amount] }),
      );
      const ev = only(parseEventLogs({ abi: clearAbi, eventName: 'OptionsExercised', logs: receipt.logs }), CLEAR, 'OptionsExercised');
      assertEq(ev.args.exerciser.toLowerCase(), buyer.address.toLowerCase(), 'OptionsExercised.exerciser');
      assertEq(ev.args.amount, amount, 'OptionsExercised.amount');
      assertEq(await balanceOf(USDG, buyer.address), buyerUsdg, `the Clear pulled exactly ${rx} + fee ${fee}`);
      assertEq((await balanceOf(NVDA, buyer.address)) - buyerNvda, amount * LOT, 'delivery');
      assertEq(buyerOpt - (await optionBalance(buyer.address, optionId)), amount, 'option tokens burned');
      assertEq((await balanceOf(USDG, CLEAR)) - clearUsdg, debit, 'strike USDG plus any fee sits in the Clear');
      assertEq(clearNvda - (await balanceOf(NVDA, CLEAR)), amount * LOT, 'the Clear released the underlying');
      assertEq((await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] })) - feeLedger, fee, "the Clear's USDG fee ledger moved by exactly the fee");
      const claimAfter = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimKey] });
      assertEq(claimAfter.amountExercised - claimBefore.amountExercised, amount * LOT, "the vault's claim absorbed this exercise (the vault is the option type's sole writer)");
      note(`${who} exercised ${amount}: debit ${rx} + fee ${fee}; claim.amountExercised ${claimAfter.amountExercised}`);
      return { hash, rx, fee, debit, feesEnabled, feeBps };
    };

    /** The RollClose and Harvest a close receipt carries, parsed once. */
    const closeEvents = (receipt: TransactionReceipt) => {
      const rc = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
      const hv = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      const redeemed = only(parseEventLogs({ abi: clearAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), CLEAR, "the Clear's ClaimRedeemed");
      return { rc: rc.args, hv: hv.args, redeemed: redeemed.args };
    };

    /* =====================================================================================
       CYCLE 1 (d): partial fills, cancel, invalidate, relist budget
       ===================================================================================== */

    const listing1 = await step('the in-process keeper opens the same state.db: reconcile(); tick -> visible', async () => {
      assertEq(JSON.stringify(store.counts()), JSON.stringify(record.indexTs.rowsAfterExit), 'the keeper store sees exactly what the process wrote');
      await roll.reconcile();
      const row = onlyListingFor(1, 1);
      assertEq(row.status, 'posted', 'reconcile keeps the posted row (Seaport: validated, unfilled)');
      await roll.tick();
      const after = listingRow(row.order_hash);
      assertEq(after.status, 'visible', 'visible');
      const policyNow = await policy.readPolicy();
      for (const key of Object.keys(LAUNCH_POLICY) as Array<keyof typeof LAUNCH_POLICY>) {
        assertEq(policyNow[key], LAUNCH_POLICY[key], `vault.policy().${key}`);
      }
      const expected = policy.maxContracts(DEPOSIT, LOT, policyNow);
      assertEq(BigInt(after.contracts), expected, 'the process wrote the whole deposit at 95% utilisation');
      assertEq(after.option_id, series1.ids[0]?.toString() ?? '', 'the nearest in-band rung');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'listingsThisCycle 1');
      assert(expected >= FILL_A1 + FILL_B + FILL_A2 + 1n, `${expected} contracts leave inventory after all three fills`);
      record.relist.contractsWritten = after.contracts;
      record.relist.strikeUsdg6 = store.getCycle(1)?.strike_usdg6 ?? null;
      record.relist.listing1 = { orderHash: after.order_hash, contracts: after.contracts, unitPrice6: after.unit_price6, toVault6: after.to_vault6, counter: after.counter };
      return after;
    });
    const optionId1 = BigInt(listing1.option_id);
    const written1 = BigInt(listing1.contracts);
    const strike1 = BigInt(store.getCycle(1)?.strike_usdg6 ?? '0');
    const premiumLegs1: bigint[] = [];

    /** After a guardian cancel/invalidate, the keeper's next tick: retire the dead row, relist the rest. */
    const expectRelist = async (dead: ListingRow, seq: number, relistsUsed: number) => {
      const postsBefore = posts();
      const deletesBefore = deletes();
      const inventory = await optionBalance(vault, optionId1);
      await roll.tick();
      const fresh = onlyListingFor(1, seq);
      assertEq(fresh.status, 'posted', `relist seq ${seq} posted`);
      assertEq(BigInt(fresh.contracts), inventory, `relist sized by clear.balanceOf(vault): ${inventory}`);
      const [p, spot] = await Promise.all([policy.readPolicy(), pub.readContract({ ...V, functionName: 'spotUsdg' })]);
      const expectedPrice = policy.relistUnitPrice6(BigInt(dead.unit_price6), policy.minUnitPrice6(spot, p), 0);
      assertEq(fresh.unit_price6, expectedPrice.toString(), 'relist price = max(previous ask, live floor)');
      assertEq(fresh.unit_price6, dead.unit_price6, 'spot has not moved, so the previous ask stands');
      const split = seaport.splitPremium(expectedPrice, inventory);
      assertEq(fresh.to_vault6, split.toVault6.toString(), 'vault leg');
      assertEq(fresh.to_overcall6, split.toOvercall6.toString(), 'Overcall leg');
      assertEq(fresh.counter, (await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] })).toString(), 'signed at the live Seaport counter');
      assertEq((await pub.readContract({ ...V, functionName: 'listingHash' })).toLowerCase(), fresh.order_hash.toLowerCase(), 'the vault authorised the relist');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), seq, `listingsThisCycle ${seq}`);
      assertEq(store.getCycle(1)?.relists_used ?? -1, relistsUsed, `relists_used ${relistsUsed}`);
      assertEq(posts(), postsBefore + 1, 'one POST');
      // The dead listing must leave the keeper's own book: its row is retired and /orders
      // stops offering it.
      const deadAfter = listingRow(dead.order_hash);
      assertEq(deadAfter.status, 'cancelled', `the cancelled/invalidated listing seq ${dead.seq} is retired (was ${dead.status})`);
      assertEq(deletes(), deletesBefore + 1, 'the book is told the dead listing is gone');
      const offered = (await served()).map((o) => o.orderHash.toLowerCase());
      assertEq(offered.join(','), fresh.order_hash.toLowerCase(), '/orders offers only the listing the vault authorises');
      await roll.tick();
      assertEq(listingRow(fresh.order_hash).status, 'visible', 'relist visible in the book');
      return fresh;
    };

    await step(`cycle 1: buyer A fills ${FILL_A1}/${written1} of listing 1 (fulfillAdvancedOrder); tick -> partial`, async () => {
      const fill = await fillFromOrders('buyer A', BUYER_A, listing1, FILL_A1);
      premiumLegs1.push(fill.toVault);
      await roll.tick();
      const row = listingRow(listing1.order_hash);
      const status = await orderStatus(listing1.order_hash);
      assertEq(row.status, 'partial', 'partial');
      assertEq(row.seaport_total_filled, status.totalFilled.toString(), 'row mirrors Seaport totalFilled');
      assertEq(row.seaport_total_size, status.totalSize.toString(), 'row mirrors Seaport totalSize');
      assertEq((await served()).length, 1, '/orders still offers the partially filled listing');
      record.relist.fillA1 = { tx: fill.hash, toVault: fill.toVault.toString(), toOvercall: fill.toOvercall.toString(), seaportStatus: `${status.totalFilled}/${status.totalSize}` };
    });

    const listing2 = await step('cycle 1: the guardian cancelListing()s listing 1; tick -> relist 1', async () => {
      const components = seaport.componentsFromJson(JSON.parse(listing1.components_json) as never);
      const { hash, receipt } = await sendTx('vault.cancelListing(listing 1) (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'cancelListing', args: [components] }),
      );
      const cancelled = only(parseEventLogs({ abi: vaultAbi, eventName: 'ListingCancelled', logs: receipt.logs }), vault, 'ListingCancelled');
      assertEq(cancelled.args.orderHash.toLowerCase(), listing1.order_hash.toLowerCase(), 'ListingCancelled.orderHash');
      assertEq((await orderStatus(listing1.order_hash)).isCancelled, true, 'Seaport isCancelled');
      assertEq(await pub.readContract({ ...V, functionName: 'listingHash' }), ZERO_BYTES32, 'vault listingHash cleared');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'a cancel does not refund the budget');
      await expectRevert('anyone cancelListing', 'AccessControlUnauthorizedAccount', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultAbi, functionName: 'cancelListing', args: [components] }),
      );
      const fresh = await expectRelist(listingRow(listing1.order_hash), 2, 1);
      assertEq(BigInt(fresh.contracts), written1 - FILL_A1, `${written1} - ${FILL_A1} left to sell`);
      record.relist.cancel1Tx = hash;
      record.relist.listing2 = { orderHash: fresh.order_hash, contracts: fresh.contracts, unitPrice6: fresh.unit_price6, toVault6: fresh.to_vault6, counter: fresh.counter };
      return fresh;
    });

    await step(`cycle 1: buyer B fills ${FILL_B}/${written1 - FILL_A1} of listing 2; tick -> partial`, async () => {
      const fill = await fillFromOrders('buyer B', BUYER_B, listing2, FILL_B);
      premiumLegs1.push(fill.toVault);
      await roll.tick();
      assertEq(listingRow(listing2.order_hash).status, 'partial', 'partial');
      record.relist.fillB = { tx: fill.hash, toVault: fill.toVault.toString(), toOvercall: fill.toOvercall.toString() };
    });

    const listing3 = await step('cycle 1: the guardian invalidateAllListings(); tick -> relist 2 at the new counter', async () => {
      const counterBefore = await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] });
      const { hash, receipt } = await sendTx('vault.invalidateAllListings() (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'invalidateAllListings' }),
      );
      const invalidated = only(parseEventLogs({ abi: vaultAbi, eventName: 'AllListingsInvalidated', logs: receipt.logs }), vault, 'AllListingsInvalidated');
      const counterAfter = await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] });
      assertEq(invalidated.args.newCounter, counterAfter, 'AllListingsInvalidated.newCounter = Seaport getCounter(vault)');
      assert(counterAfter > counterBefore, 'the counter moved forward');
      const statusAfter = await orderStatus(listing2.order_hash);
      assertEq(statusAfter.isCancelled, false, 'a counter bump does NOT set isCancelled — the row must be retired from the vault state, not from Seaport');
      assertEq(await pub.readContract({ ...V, functionName: 'listingHash' }), ZERO_BYTES32, 'vault listingHash cleared');
      const fresh = await expectRelist(listingRow(listing2.order_hash), 3, 2);
      assertEq(BigInt(fresh.contracts), written1 - FILL_A1 - FILL_B, 'what is left to sell');
      assertEq(fresh.counter, counterAfter.toString(), 'relist 2 signed at the bumped counter');
      record.relist.invalidateTx = hash;
      record.relist.counterBefore = counterBefore.toString();
      record.relist.counterAfter = counterAfter.toString();
      record.relist.listing3 = { orderHash: fresh.order_hash, contracts: fresh.contracts, unitPrice6: fresh.unit_price6, toVault6: fresh.to_vault6, counter: fresh.counter };
      return fresh;
    });

    await step(`cycle 1: buyer A fills ${FILL_A2}/${written1 - FILL_A1 - FILL_B} of listing 3; the guardian cancels it; tick -> no relist (budget spent); a fourth approveListing reverts TooManyListings`, async () => {
      const fill = await fillFromOrders('buyer A', BUYER_A, listing3, FILL_A2);
      premiumLegs1.push(fill.toVault);
      await roll.tick();
      assertEq(listingRow(listing3.order_hash).status, 'partial', 'partial');
      const components = seaport.componentsFromJson(JSON.parse(listing3.components_json) as never);
      const { hash } = await sendTx('vault.cancelListing(listing 3) (guardian)', GUARDIAN, () =>
        wallet.writeContract({ account: GUARDIAN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'cancelListing', args: [components] }),
      );
      const txsBefore = keeperTxs().length;
      const postsBefore = posts();
      const deletesBefore = deletes();
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'the keeper sent nothing: KEEPER_MAX_RELISTS=2 is spent');
      assertEq(posts(), postsBefore, 'no POST');
      assertEq(store.listingsForCycle(1).length, 3, 'three listing rows, no fourth');
      assertEq(store.getCycle(1)?.relists_used ?? -1, MAX_RELISTS, 'relists_used stays at the budget');
      assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), MAX_LISTINGS, 'the vault has authorised 3 of 3');
      assertEq(listingRow(listing3.order_hash).status, 'cancelled', 'the cancelled listing is retired even when nothing replaces it');
      assertEq(deletes(), deletesBefore + 1, 'and the book is told');
      assertEq((await served()).length, 0, '/orders offers nothing');
      const inventory = await optionBalance(vault, optionId1);
      assertEq(inventory, written1 - FILL_A1 - FILL_B - FILL_A2, 'unsold inventory stays in the vault');

      // The vault's own cap, independent of the keeper's budget: a fourth authorisation, built by
      // the keeper's own order builder at the live counter, from the keeper key.
      const fourth = seaport.buildOrderComponents({
        offerer: vault,
        optionId: optionId1,
        contracts: inventory,
        unitPrice6: BigInt(listing3.unit_price6),
        endTime: BigInt(listing3.end_time),
        counter: await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] }),
      });
      const args = await expectRevert('a fourth approveListing (keeper key)', 'TooManyListings', () =>
        pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'approveListing', args: [fourth] }),
      );
      assertEq(Number(args[0]), MAX_LISTINGS, 'TooManyListings.authorised = 3');
      assertEq(Number(args[1]), MAX_LISTINGS, 'TooManyListings.max = 3');
      record.relist.fillA2 = { tx: fill.hash, toVault: fill.toVault.toString(), toOvercall: fill.toOvercall.toString() };
      record.relist.cancel3Tx = hash;
      record.relist.unsoldInventory = inventory.toString();
      record.relist.fourthApproval = `TooManyListings(${String(args[0])}, ${String(args[1])})`;
    });

    await step('cycle 1: warp to exerciseTimestamp; tick -> lockBook', async () => {
      await warpTo(series1.exercise, 'cycle-1 exerciseTimestamp');
      const deletesBefore = deletes();
      await roll.tick();
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Exercisable, 'phase');
      assertEq(store.getCycle(1)?.status ?? null, 'locked', 'locked');
      assertEq(deletes(), deletesBefore, 'nothing live left to retire');
      assertEq(store.listingsForCycle(1).map((r) => r.status).join(','), 'cancelled,cancelled,cancelled', 'every row terminal');
    });

    const exercised1 = await step(`cycle 1: spot above the strike; buyer A exercises ${EXERCISE_A1}, buyer B ${EXERCISE_B}, buyer A ${EXERCISE_A2} — three transactions on the real Clear`, async () => {
      await sendTx('MockFeed.setAnswer (strike + 5 USD)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [strike1 * 100n + 5n * 100_000_000n] }),
      );
      const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
      assert(claimKey !== 0n, 'claim open');
      assertEq(await optionBalance(BUYER_A.address, optionId1), FILL_A1 + FILL_A2, 'buyer A holds both of its fills');
      assertEq(await optionBalance(BUYER_B.address, optionId1), FILL_B, 'buyer B holds its fill');
      const steps: Array<{ who: string; buyer: PrivateKeyAccount; amount: bigint }> = [
        { who: 'buyer A', buyer: BUYER_A, amount: EXERCISE_A1 },
        { who: 'buyer B', buyer: BUYER_B, amount: EXERCISE_B },
        { who: 'buyer A', buyer: BUYER_A, amount: EXERCISE_A2 },
      ];
      const txs: Array<Record<string, string>> = [];
      let cumulative = 0n;
      for (const s of steps) {
        const done = await exercise(s.who, s.buyer, optionId1, s.amount, strike1, claimKey);
        assertEq(done.feesEnabled, false, 'the live chain has the Clear fee off');
        cumulative += s.amount;
        assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), cumulative, `vault.contractsAssigned() = ${cumulative} after ${s.who}`);
        txs.push({ who: s.who, amount: s.amount.toString(), tx: done.hash, debit: done.debit.toString() });
      }
      const total = EXERCISE_A1 + EXERCISE_B + EXERCISE_A2;
      const position = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'position', args: [claimKey] });
      assertEq(position.underlyingAmount, (written1 - total) * LOT, 'position.underlyingAmount: the unassigned lots');
      assertEq(position.exerciseAmount, total * strike1, 'position.exerciseAmount: every exercise, summed');
      assertEq(await pub.readContract({ ...V, functionName: 'claimedExerciseProceeds' }), total * strike1, 'vault.claimedExerciseProceeds()');
      record.exercisers.transactions = txs;
      record.exercisers.claimKey = claimKey.toString();
      return { claimKey, total };
    });

    await step(`cycle 1: warp to expiryTimestamp; tick -> rollClose: ${EXERCISE_A1 + EXERCISE_B + EXERCISE_A2} assigned from three exercises by two exercisers`, async () => {
      await warpTo(series1.expiry, 'cycle-1 expiryTimestamp');
      await sendTx('MockFeed.setAnswer (refresh updatedAt)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [strike1 * 100n + 5n * 100_000_000n] }),
      );
      const E = exercised1.total;
      const premium = premiumLegs1.reduce((a, b) => a + b, 0n);
      const [vaultUsdgBefore, vaultNvdaBefore, feeSafeBefore, dustBefore, supply, accBefore] = await Promise.all([
        balanceOf(USDG, vault),
        balanceOf(NVDA, vault),
        balanceOf(USDG, FEE_SAFE.address),
        pub.readContract({ ...Q, functionName: 'usdgDust' }),
        pub.readContract({ ...V, functionName: 'totalSupply' }),
        pub.readContract({ ...V, functionName: 'accUsdgPerShare' }),
      ]);
      assertEq(vaultUsdgBefore, premium, 'the vault holds exactly the three fills\' vault legs');
      assertEq(vaultNvdaBefore, DEPOSIT - written1 * LOT, 'the vault holds what it did not write');
      const preRead = await roll.contractsAssignedAt(await roll.snapshot());
      assertEq(preRead, E, "the keeper's pre-close read");

      await roll.tick();
      const cycle = store.getCycle(1);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'closed by the keeper');
      assertEq(cycle.status, 'closed', 'status');
      const receipt = await pub.getTransactionReceipt({ hash: cycle.roll_close_tx as Hex });
      const { rc, hv, redeemed } = closeEvents(receipt);
      assertEq(rc.cycleNumber, 1, 'RollClose.cycleNumber');
      assertEq(rc.contractsAssignedCount, E, `RollClose.contractsAssignedCount = ${E}`);
      assertEq(rc.assetsReturned, (written1 - E) * LOT, 'RollClose.assetsReturned = the unassigned lots');
      assertEq(rc.usdgFromAssignment, E * strike1, 'RollClose.usdgFromAssignment = every exercise x strike');
      const allCloses = await pub.getLogs({ address: vault, event: rollCloseEvent, args: { cycleNumber: 1 }, fromBlock: 0n, toBlock: receipt.blockNumber });
      assertEq(allCloses.length, 1, 'exactly one RollClose for cycle 1 on chain');
      assertEq(redeemed.exerciseAmountRedeemed, E * strike1, 'Clear.ClaimRedeemed.exerciseAmountRedeemed');
      assertEq(redeemed.underlyingAmountRedeemed, (written1 - E) * LOT, 'Clear.ClaimRedeemed.underlyingAmountRedeemed');
      assertEq(hv.grossUsdg, premium + E * strike1, 'Harvest.gross = the three premium legs + strike proceeds');
      const { protocolFeeBps } = await policy.readPolicy();
      const fee = harvestFee(hv.grossUsdg, rc.usdgFromAssignment, protocolFeeBps);
      assertEq(hv.feeUsdg, fee, 'Harvest.fee on the premium only');
      assertEq(fee, (premium * protocolFeeBps) / BPS, 'fee = floor(premium legs x 500 / 10000)');
      assertEq(hv.netUsdg, hv.grossUsdg - fee, 'Harvest.net');
      const harvestLogs = await pub.getLogs({ address: vault, event: harvestEvent, args: { cycleNumber: 1 }, fromBlock: 0n, toBlock: receipt.blockNumber });
      assertEq(harvestLogs.length, 1, 'one Harvest for cycle 1');
      assertEq((await balanceOf(USDG, FEE_SAFE.address)) - feeSafeBefore, fee, 'fee swept');
      assertEq(await balanceOf(NVDA, vault), vaultNvdaBefore + rc.assetsReturned, 'the vault NVDA: never written + returned');
      assertEq(await balanceOf(NVDA, vault), DEPOSIT - E * LOT, 'the vault is down exactly the assigned lots');
      assertEq(await balanceOf(NVDA, BUYER_A.address), (EXERCISE_A1 + EXERCISE_A2) * LOT, 'buyer A took delivery twice');
      assertEq(await balanceOf(NVDA, BUYER_B.address), EXERCISE_B * LOT, 'buyer B took delivery once');
      assertEq(await optionBalance(vault, optionId1), written1 - FILL_A1 - FILL_B - FILL_A2, 'the unsold contracts are still in the vault (worthless after expiry)');

      // The keeper's row, alert and tape.
      assertEq(cycle.gross_usdg6, hv.grossUsdg.toString(), 'gross_usdg6');
      assertEq(cycle.fee_usdg6, fee.toString(), 'fee_usdg6');
      assertEq(cycle.net_usdg6, hv.netUsdg.toString(), 'net_usdg6');
      assertEq(cycle.contracts_assigned, Number(E), 'contracts_assigned');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment');
      assertEq(cycle.relists_used, MAX_RELISTS, 'relists_used');
      const last = alerts.received[alerts.received.length - 1];
      assert(last !== undefined && last.kind === 'roll_close', 'roll_close alert');
      assertEq(
        last.message,
        `cycle 1 closed: premium ${roll.formatUsdg(premium)} USDG (fee ${roll.formatUsdg(fee)}), strike proceeds ${roll.formatUsdg(E * strike1)} USDG from ${E} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors.`,
        'roll_close message',
      );
      const data = last.data as Record<string, unknown>;
      assertEq(data.contractsAssigned as number, Number(E), 'data.contractsAssigned');
      assertEq(data.contractsAssignedSource as string, 'RollClose', 'data.contractsAssignedSource');
      assertEq(data.contractsAssignedFromClaim as number, Number(E), "data.contractsAssignedFromClaim: the keeper's own pre-read inside the tick");
      assertEq(data.premiumUsdg as string, roll.formatUsdg(premium), 'data.premiumUsdg');
      assertEq(data.strikeProceedsUsdg as string, roll.formatUsdg(E * strike1), 'data.strikeProceedsUsdg');
      assertEq(data.assetsReturned as string, rc.assetsReturned.toString(), 'data.assetsReturned');
      const tape = ((await health('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 1);
      assert(tape !== undefined, '/cycles serves cycle 1');
      assertEq(tape.premium_gross_usdg6 as string, premium.toString(), '/cycles premium_gross_usdg6');
      assertEq(tape.strike_proceeds_usdg6 as string, (E * strike1).toString(), '/cycles strike_proceeds_usdg6');

      // The depositor, sole holder: credited floor(pot x 1e27 / supply) x supply / 1e27.
      const accAfter = await pub.readContract({ ...V, functionName: 'accUsdgPerShare' });
      const pot = hv.netUsdg + dustBefore;
      assertEq(accAfter - accBefore, (pot * ACC_PRECISION) / supply, 'index delta');
      const claimable = await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
      assertEq(claimable, (supply * (accAfter - accBefore)) / ACC_PRECISION, 'claimable = the whole credited pot');
      const depositorUsdg = await balanceOf(USDG, DEPOSITOR.address);
      await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
      );
      assertEq((await balanceOf(USDG, DEPOSITOR.address)) - depositorUsdg, claimable, 'claimed exactly');
      record.exercisers.rollCloseTx = cycle.roll_close_tx;
      record.exercisers.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.exercisers.harvest = { premium: premium.toString(), gross: hv.grossUsdg.toString(), fee: fee.toString(), net: hv.netUsdg.toString(), depositorClaimed: claimable.toString() };
      record.exercisers.alert = last.message;
      note(`RollClose(1, ${rc.assetsReturned}, ${rc.usdgFromAssignment}, ${rc.contractsAssignedCount}); gross ${hv.grossUsdg} fee ${fee} net ${hv.netUsdg}`);
    });

    /* =====================================================================================
       CYCLE 2 (c): nobody but "anyone" closes; the keeper reconciles from logs
       ===================================================================================== */

    const cycle2 = await step('cycle 2: fresh series; tick -> rollOpen + list; tick -> visible; buyer B fills all; tick -> filled', async () => {
      const series = await createFreshSeries(deployment, 2, record.guardianClose);
      const idle = await pub.readContract({ ...V, functionName: 'idleAssets' });
      await roll.tick();
      const row = onlyListingFor(2, 1);
      const cycle = store.getCycle(2);
      assert(cycle !== null && cycle.roll_open_tx !== null, 'the keeper opened cycle 2');
      assertEq(BigInt(row.contracts), policy.maxContracts(idle, LOT, await policy.readPolicy()), 'sized on the idle left after cycle 1');
      await roll.tick();
      assertEq(listingRow(row.order_hash).status, 'visible', 'visible');
      const fill = await fillFromOrders('buyer B', BUYER_B, row, BigInt(row.contracts));
      stub.markFilled(row.order_hash, fill.toVault.toString());
      await roll.tick();
      assertEq(listingRow(row.order_hash).status, 'filled', 'filled');
      record.guardianClose.contracts = row.contracts;
      record.guardianClose.strikeUsdg6 = cycle.strike_usdg6;
      record.guardianClose.fillTx = fill.hash;
      return { series, row, toVault: fill.toVault, strike: BigInt(cycle.strike_usdg6 ?? '0'), optionId: BigInt(row.option_id) };
    });

    await step(`cycle 2: warp to exerciseTimestamp; tick -> lockBook; spot above strike; buyer B exercises ${EXERCISE_C2}`, async () => {
      await warpTo(cycle2.series.exercise, 'cycle-2 exerciseTimestamp');
      await roll.tick();
      assertEq(store.getCycle(2)?.status ?? null, 'locked', 'locked by the keeper');
      await sendTx('MockFeed.setAnswer (strike + 5 USD)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [cycle2.strike * 100n + 5n * 100_000_000n] }),
      );
      const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
      const done = await exercise('buyer B', BUYER_B, cycle2.optionId, EXERCISE_C2, cycle2.strike, claimKey);
      record.guardianClose.exerciseTx = done.hash;
    });

    const guardianClose = await step('cycle 2: warp past expiry; the keeper does NOT tick; a role-less rollClose reverts GuardianTooEarly at expiry and at expiry + 1 h - 1 s', async () => {
      const expiry = cycle2.series.expiry;
      const openAt = expiry + ONE_HOUR;
      await warpTo(expiry, 'cycle-2 expiryTimestamp');
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
      assertEq(hv.grossUsdg, cycle2.toVault + rc.usdgFromAssignment, 'Harvest.gross');
      const { protocolFeeBps } = await policy.readPolicy();
      assertEq(hv.feeUsdg, (cycle2.toVault * protocolFeeBps) / BPS, 'Harvest.fee on the premium only');
      assertEq(hv.netUsdg, hv.grossUsdg - hv.feeUsdg, 'Harvest.net');
      assertEq((await balanceOf(NVDA, vault)) - vaultNvdaBefore, rc.assetsReturned, 'collateral back');
      assertEq(store.getCycle(2)?.status ?? null, 'locked', "the keeper's row still says locked: it has not seen the close");
      assertEq(store.latestTxForCycle('rollClose', 2) === null, true, 'no keeper rollClose transaction for cycle 2');
      record.guardianClose.rollCloseTx = hash;
      record.guardianClose.rollCloseBlock = receipt.blockNumber.toString();
      record.guardianClose.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.guardianClose.harvest = { gross: hv.grossUsdg.toString(), fee: hv.feeUsdg.toString(), net: hv.netUsdg.toString() };
      return { hash, rc, hv };
    });

    await step('cycle 2: the keeper ticks and reconstructs the close from chain logs (K-17), with the K-21 columns; reconcile() again changes nothing', async () => {
      const alertsBefore = alerts.received.length;
      const txsBefore = keeperTxs().length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'the keeper sent nothing');
      const cycle = store.getCycle(2);
      assert(cycle !== null, 'row');
      const { rc, hv, hash } = closedByAnyone;
      assertEq(cycle.status, 'closed', 'closed from logs');
      assertEq(cycle.roll_close_tx, hash, "roll_close_tx = anyone's transaction");
      assertEq(cycle.gross_usdg6, hv.grossUsdg.toString(), 'gross from the Harvest log');
      assertEq(cycle.fee_usdg6, hv.feeUsdg.toString(), 'fee');
      assertEq(cycle.net_usdg6, hv.netUsdg.toString(), 'net');
      assertEq(cycle.contracts_assigned, Number(rc.contractsAssignedCount), 'contracts_assigned from the RollClose log');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned from the RollClose log');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment from the RollClose log');
      assert(cycle.roll_open_tx !== null && cycle.lock_tx !== null, "the keeper's own open and lock hashes are kept");
      assertEq(listingRow(cycle2.row.order_hash).status, 'filled', 'the filled listing stays filled');
      assertEq(alerts.received.length, alertsBefore + 1, 'one alert');
      const last = alerts.received[alerts.received.length - 1];
      assert(last !== undefined && last.kind === 'roll_close', 'roll_close');
      const premium = hv.grossUsdg - rc.usdgFromAssignment;
      assertEq(premium, cycle2.toVault, 'premium = the fill');
      assertEq(
        last.message,
        `cycle 2 closed: premium ${roll.formatUsdg(premium)} USDG (fee ${roll.formatUsdg(hv.feeUsdg)}), strike proceeds ${roll.formatUsdg(rc.usdgFromAssignment)} USDG from ${EXERCISE_C2} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors. The close ran without this keeper witnessing it; reconstructed from chain logs.`,
        'the unwitnessed roll_close message',
      );
      const data = last.data as Record<string, unknown>;
      assertEq(data.witnessedLive as boolean, false, 'data.witnessedLive');
      assertEq(data.tx as string, hash, 'data.tx');
      assertEq(data.premiumUsdg as string, roll.formatUsdg(premium), 'data.premiumUsdg');
      assertEq(data.strikeProceedsUsdg as string, roll.formatUsdg(rc.usdgFromAssignment), 'data.strikeProceedsUsdg');
      assertEq(data.assetsReturned as string, rc.assetsReturned.toString(), 'data.assetsReturned');
      assertEq(data.contractsAssigned as number, Number(EXERCISE_C2), 'data.contractsAssigned');
      assertEq(data.contractsAssignedSource === undefined, true, 'no resolver on the log path: the count is the log itself');
      const tape = ((await health('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 2);
      assert(tape !== undefined, '/cycles serves cycle 2');
      assertEq(tape.premium_gross_usdg6 as string, premium.toString(), '/cycles premium_gross_usdg6');
      assertEq(tape.strike_proceeds_usdg6 as string, rc.usdgFromAssignment.toString(), '/cycles strike_proceeds_usdg6');
      assertEq(tape.roll_close_tx as string, hash, '/cycles roll_close_tx');

      const rowBefore = JSON.stringify({ ...store.getCycle(2), updated_at: 0 });
      await roll.reconcile();
      await roll.tick();
      assertEq(alerts.received.length, alertsBefore + 1, 'reconcile() and another tick raise nothing more');
      assertEq(JSON.stringify({ ...store.getCycle(2), updated_at: 0 }), rowBefore, 'the row is unchanged');
      record.guardianClose.keeperRow = { status: cycle.status, gross: cycle.gross_usdg6, fee: cycle.fee_usdg6, net: cycle.net_usdg6, contractsAssigned: cycle.contracts_assigned, assetsReturned: cycle.assets_returned, usdgFromAssignment: cycle.usdg_from_assignment };
      record.guardianClose.alert = last.message;
    });

    /* =====================================================================================
       CYCLE 3 (e): the Valorem engine fee, on
       ===================================================================================== */

    const feeOn = await step("cycle 3: the Clear's feeTo (impersonated) turns the engine fee on; fresh series", async () => {
      const feeTo = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeTo' });
      assertEq(getAddress(feeTo), getAddress(OVERCALL_FEE), 'feeTo is the Overcall fee key (recon R4)');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }), false, 'fees off on the live chain');
      assertEq(BigInt(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' })), VALOREM_FEE_BPS, 'feeBps 15');
      await rpc('anvil_impersonateAccount', [feeTo]);
      await setBalance(feeTo, ONE_HUNDRED_ETH);
      const { hash, receipt } = await sendTx('clear.setFeesEnabled(true) (feeTo, impersonated)', { address: feeTo }, () =>
        wallet.writeContract({ account: feeTo, chain: forkChain, address: CLEAR, abi: clearFeeAbi, functionName: 'setFeesEnabled', args: [true], gas: 200_000n }),
      );
      await rpc('anvil_stopImpersonatingAccount', [feeTo]);
      const switched = only(parseEventLogs({ abi: clearFeeAbi, eventName: 'FeeSwitchUpdated', logs: receipt.logs }), CLEAR, 'FeeSwitchUpdated');
      assertEq(switched.args.enabled, true, 'FeeSwitchUpdated.enabled');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }), true, 'fees on');
      const series = await createFreshSeries(deployment, 3, record.valoremFee);
      record.valoremFee.feeSwitchTx = hash;
      return { series };
    });

    await step('cycle 3: tick refuses to write (valorem-fees-enabled) and alerts; rollOpen simulates ValoremFeeNotAccepted(15)', async () => {
      const txsBefore = keeperTxs().length;
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(keeperTxs().length, txsBefore, 'no transaction');
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'still Idle');
      assertEq(store.getCycle(3) === null, true, 'no cycle row: not handled, only deferred');
      assertEq(store.getMeta('skip_reason:3'), 'valorem-fees-enabled', 'the reason is remembered for the end-of-window row');
      assertEq(alerts.received.length, alertsBefore + 1, 'one alert');
      const last = alerts.received[alerts.received.length - 1];
      assert(last !== undefined, 'alert');
      assertEq(last.kind, 'valorem_fees_enabled', 'kind');
      assertEq(last.severity, 'warn', 'severity');
      assertEq(last.message, `Valorem turned its engine fee on (${VALOREM_FEE_BPS} bps). The vault will not write until an admin calls acceptValoremFee(true).`, 'message');
      const state = (await health('/state')).body.vault as { valoremFeesEnabled: boolean; valoremFeeAccepted: boolean };
      assertEq(state.valoremFeesEnabled, true, '/state valoremFeesEnabled');
      assertEq(state.valoremFeeAccepted, false, '/state valoremFeeAccepted');

      const [cycle, p, spot, idle] = await Promise.all([policy.readCycle(), policy.readPolicy(), pub.readContract({ ...V, functionName: 'spotUsdg' }), pub.readContract({ ...V, functionName: 'idleAssets' })]);
      const plan = await policy.pickWrite({ cycle, rungs: await policy.readRungs(cycle), policy: p, idleAssets: idle, spotUsdg6: spot, readLastFill: async () => null });
      assert(plan.ok, 'the picker would write');
      const args = await expectRevert('rollOpen (keeper key) with the fee on and not accepted', 'ValoremFeeNotAccepted', () =>
        pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'rollOpen', args: [plan.optionId, plan.contracts] }),
      );
      assertEq(BigInt(args[0] as number), VALOREM_FEE_BPS, 'ValoremFeeNotAccepted.feeBps = 15');
      record.valoremFee.refusedAlert = last.message;
      record.valoremFee.rollOpenRevert = `ValoremFeeNotAccepted(${String(args[0])})`;
    });

    const listed3 = await step('cycle 3: admin acceptValoremFee(true); tick -> rollOpen pays the write fee in NVDA; lists', async () => {
      await sendTx('vault.acceptValoremFee(true) (admin)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'acceptValoremFee', args: [true] }),
      );
      assertEq(await pub.readContract({ ...V, functionName: 'valoremFeeAccepted' }), true, 'accepted');
      const [idle, vaultNvda, clearNvda, ledger] = await Promise.all([
        pub.readContract({ ...V, functionName: 'idleAssets' }),
        balanceOf(NVDA, vault),
        balanceOf(NVDA, CLEAR),
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }),
      ]);
      const expectedContracts = policy.maxContracts(idle, LOT, await policy.readPolicy());
      await roll.tick();
      const cycle = store.getCycle(3);
      assert(cycle !== null && cycle.roll_open_tx !== null, 'the keeper wrote');
      assertEq(BigInt(cycle.contracts ?? 0), expectedContracts, 'sized on idle as usual');
      const collateral = expectedContracts * LOT;
      let writeFee = (collateral * VALOREM_FEE_BPS) / BPS;
      if (writeFee === 0n) writeFee = 1n;
      assertEq(vaultNvda - (await balanceOf(NVDA, vault)), collateral + writeFee, 'the vault paid collateral + 15 bps of it');
      assertEq((await balanceOf(NVDA, CLEAR)) - clearNvda, collateral + writeFee, 'the Clear received both');
      assertEq((await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] })) - ledger, writeFee, "the Clear's NVDA fee ledger moved by exactly the write fee");
      assertEq(await pub.readContract({ address: NVDA, abi: erc20AllowanceAbi, functionName: 'allowance', args: [vault, CLEAR] }), 0n, 'no standing allowance to the Clear');
      const row = onlyListingFor(3, 1);
      assertEq(row.status, 'posted', 'listed in the same tick');
      assertEq(BigInt(row.contracts), expectedContracts, 'the whole write');
      record.valoremFee.contracts = row.contracts;
      record.valoremFee.writeFeeNvdaWei = writeFee.toString();
      record.valoremFee.rollOpenTx = cycle.roll_open_tx;
      note(`wrote ${expectedContracts} contracts; write fee ${writeFee} NVDA wei`);
      return { row, writeFee, strike: BigInt(cycle.strike_usdg6 ?? '0'), optionId: BigInt(row.option_id) };
    });

    await step(`cycle 3: fill; lock; spot above strike; buyer A exercises ${EXERCISE_C3} paying the exercise fee; expiry; tick -> rollClose`, async () => {
      await roll.tick();
      const fill = await fillFromOrders('buyer A', BUYER_A, listed3.row, BigInt(listed3.row.contracts));
      stub.markFilled(listed3.row.order_hash, fill.toVault.toString());
      await roll.tick();
      assertEq(listingRow(listed3.row.order_hash).status, 'filled', 'filled');
      await warpTo(feeOn.series.exercise, 'cycle-3 exerciseTimestamp');
      await roll.tick();
      assertEq(store.getCycle(3)?.status ?? null, 'locked', 'locked');
      await sendTx('MockFeed.setAnswer (strike + 5 USD)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [listed3.strike * 100n + 5n * 100_000_000n] }),
      );
      const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
      const done = await exercise('buyer A', BUYER_A, listed3.optionId, EXERCISE_C3, listed3.strike, claimKey);
      assertEq(done.feesEnabled, true, 'the exercise ran with the fee on');
      let expectedFee = (EXERCISE_C3 * listed3.strike * VALOREM_FEE_BPS) / BPS;
      if (expectedFee === 0n) expectedFee = 1n;
      assertEq(done.fee, expectedFee, 'exercise fee = 15 bps of the strike USDG');
      assert(done.fee > 0n, 'a non-zero fee was paid');

      await warpTo(feeOn.series.expiry, 'cycle-3 expiryTimestamp');
      await sendTx('MockFeed.setAnswer (refresh updatedAt)', ADMIN, () =>
        wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [listed3.strike * 100n + 5n * 100_000_000n] }),
      );
      const [ledgerNvda, ledgerUsdg, vaultNvdaBefore] = await Promise.all([
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }),
        pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] }),
        balanceOf(NVDA, vault),
      ]);
      await roll.tick();
      const cycle = store.getCycle(3);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'the keeper closed');
      const receipt = await pub.getTransactionReceipt({ hash: cycle.roll_close_tx as Hex });
      const { rc, hv } = closeEvents(receipt);
      const written = BigInt(listed3.row.contracts);
      assertEq(rc.contractsAssignedCount, EXERCISE_C3, 'RollClose.contractsAssignedCount');
      assertEq(rc.assetsReturned, (written - EXERCISE_C3) * LOT, 'RollClose.assetsReturned: every unassigned lot, the write fee not netted');
      assertEq(rc.usdgFromAssignment, EXERCISE_C3 * listed3.strike, 'RollClose.usdgFromAssignment: exactly strike x assigned, the exercise fee not netted');
      assertEq((await balanceOf(NVDA, vault)) - vaultNvdaBefore, rc.assetsReturned, 'collateral back');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [NVDA] }), ledgerNvda, 'redeem charges no NVDA fee');
      assertEq(await pub.readContract({ address: CLEAR, abi: clearFeeAbi, functionName: 'feeBalance', args: [USDG] }), ledgerUsdg, 'redeem charges no USDG fee');
      assertEq(hv.grossUsdg, fill.toVault + rc.usdgFromAssignment, 'Harvest.gross');
      const { protocolFeeBps } = await policy.readPolicy();
      assertEq(hv.feeUsdg, (fill.toVault * protocolFeeBps) / BPS, 'protocol fee on the premium only');
      assertEq(cycle.gross_usdg6, hv.grossUsdg.toString(), 'gross_usdg6');
      assertEq(cycle.contracts_assigned, Number(EXERCISE_C3), 'contracts_assigned');
      assertEq(cycle.assets_returned, rc.assetsReturned.toString(), 'assets_returned');
      assertEq(cycle.usdg_from_assignment, rc.usdgFromAssignment.toString(), 'usdg_from_assignment');
      const last = alerts.received[alerts.received.length - 1];
      assert(last !== undefined && last.kind === 'roll_close', 'roll_close');
      assertEq(
        last.message,
        `cycle 3 closed: premium ${roll.formatUsdg(fill.toVault)} USDG (fee ${roll.formatUsdg(hv.feeUsdg)}), strike proceeds ${roll.formatUsdg(rc.usdgFromAssignment)} USDG from ${EXERCISE_C3} contracts assigned; ${roll.formatUsdg(hv.netUsdg)} USDG to depositors.`,
        'roll_close message',
      );
      record.valoremFee.exerciseTx = done.hash;
      record.valoremFee.exerciseFeeUsdg6 = done.fee.toString();
      record.valoremFee.rollCloseTx = cycle.roll_close_tx;
      record.valoremFee.rollClose = { contractsAssignedCount: rc.contractsAssignedCount.toString(), assetsReturned: rc.assetsReturned.toString(), usdgFromAssignment: rc.usdgFromAssignment.toString() };
      record.valoremFee.harvest = { gross: hv.grossUsdg.toString(), fee: hv.feeUsdg.toString(), net: hv.netUsdg.toString() };
      record.valoremFee.alert = last.message;
    });

    /* ---------- what the keeper remembers ---------- */

    await step('close the store, reopen the same file: every row is there', async () => {
      const expectedAlerts = 'boot,roll_open,roll_close,roll_open,roll_close,valorem_fees_enabled,roll_open,roll_close';
      assertEq(alerts.kinds().join(','), expectedAlerts, 'every alert, in order, nothing else');
      const txs = keeperTxs();
      assertEq(
        txs.map((t) => `${t.cycle_number}:${t.kind}:${t.status}`).join(','),
        [
          '1:rollOpen:success', '1:approveListing:success', '1:approveListing:success', '1:approveListing:success', '1:lockBook:success', '1:rollClose:success',
          '2:rollOpen:success', '2:approveListing:success', '2:lockBook:success',
          '3:rollOpen:success', '3:approveListing:success', '3:lockBook:success', '3:rollClose:success',
        ].join(','),
        'every keeper transaction: cycle 2 has no rollClose of its own',
      );
      const metaKeys = (store.db.prepare('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>).map((m) => m.key);
      const bookPolls = metaKeys.filter((k) => k.startsWith('book_poll_ms:')).length;
      assertEq(bookPolls, 5, 'one book poll per listing (5)');
      assertEq(metaKeys.filter((k) => !k.startsWith('book_poll_ms:')).join(','), 'last_heartbeat_ms,skip_reason:1,skip_reason:3', 'meta');
      const before = store.counts();
      assertEq(JSON.stringify(before), JSON.stringify({ cycles: 3, listings: 5, txs: 13, alerts: 8, meta: 8 }), 'row counts');
      record.db = {
        counts: before,
        cycles: store.recentCycles(10),
        listings: store.db.prepare('SELECT order_hash, cycle_number, seq, contracts, unit_price6, to_vault6, counter, status, api_status, approve_tx, seaport_total_filled, seaport_total_size, seaport_cancelled FROM listings ORDER BY cycle_number, seq').all(),
        txs: store.recentTxs(50),
        alerts: store.recentAlerts(50).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, delivered: a.delivered })),
      };
      stopServers();
      healthServer = null;
      store.close();
      const reopened = new KeeperStore(dbPath);
      try {
        assertEq(JSON.stringify(reopened.counts()), JSON.stringify(before), 'identical after reopen');
      } finally {
        reopened.close();
      }
      for (const suffix of ['-wal', '-shm']) assertEq(existsSync(`${dbPath}${suffix}`), false, `no ${suffix} after the final close`);
      note(`state.db rows: ${JSON.stringify(before)}`);
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

/*//////////////////////////////////////////////////////////////
                              THE REPORT
//////////////////////////////////////////////////////////////*/

function writeReport(): void {
  const json = JSON.stringify(record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  writeFileSync(join(OUT, 'run.json'), json);
  const lines: string[] = [];
  const section = (title: string, body: Record<string, unknown>) => {
    lines.push('', `### ${title}`, '');
    for (const [k, v] of Object.entries(body)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)) : String(v)}`);
  };
  lines.push(`# Extended dry run ${record.startedAt}`, '');
  lines.push(`- result: ${record.error ? `**FAILED at "${record.stoppedAt}"**: ${record.error}` : '**passed**'}`);
  lines.push(`- wall clock: ${(record.wallClockMs / 1000).toFixed(1)}s`);
  lines.push(`- anvil: ${record.clientVersion}, chain ${record.chainId}, fork block ${record.forkBlock}, rpc ${record.rpc}`);
  lines.push(`- deposit: ${record.deposit}`);
  section('Actors', record.actors);
  section('Deployed on the fork', record.addresses);
  section('(a) index.ts: the compiled process, poll loop, SIGTERM mid-tick', record.indexTs);
  section('(d) partial fills, cancel, invalidate, relist budget', record.relist);
  section('(b) several exercisers, several transactions', record.exercisers);
  section('(c) guardian rollClose and K-17 reconciliation', record.guardianClose);
  section('(e) the Valorem engine fee', record.valoremFee);
  lines.push('', '### Harness transactions', '', '| step | by | tx | block | gas |', '|---|---|---|---|---|');
  for (const t of record.harnessTxs) lines.push(`| ${t.label} | \`${t.by.slice(0, 10)}…\` | \`${t.hash}\` | ${t.block} | ${t.gasUsed} |`);
  lines.push('', '### state.db', '', '```json', JSON.stringify(record.db, null, 1), '```');
  lines.push('', '### Alerts captured at ALERT_WEBHOOK, in order', '');
  for (const a of record.alerts) lines.push(`- [${a.severity}] **${a.kind}**: ${a.message}`);
  lines.push('', '### Requests the Overcall stub received, in order', '');
  for (const r of record.stubRequests) lines.push(`- \`${r}\``);
  lines.push('', '### Steps', '');
  for (const s of record.steps) {
    lines.push(`- ${s.step} (${s.ms} ms)`);
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  writeFileSync(join(OUT, 'report.md'), `${lines.join('\n')}\n`);
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
