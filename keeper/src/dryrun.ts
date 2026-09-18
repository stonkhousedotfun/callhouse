/**
 * The keeper, for real, against an anvil fork of Robinhood Chain 4663 — write on fill.
 *
 * WHY THIS FILE EXISTS: a keeper that has never run is a keeper whose first run is Friday night
 * with depositors' collateral. This harness imports the PRODUCTION modules and calls
 * `reconcile()` and `tick()` exactly as index.ts does, against a fork of mainnet state, and
 * drives three weeks through them plus the arm of a fourth:
 *
 *   week 1  UNFILLED. A depositor puts collateral in; the keeper computes the next NYSE Friday
 *           close, creates the option type on the REAL Valorem Clear, ARMS it (`rollOpen`
 *           writes nothing: RollOpen.contractsCount == 0), and authorises one PARTIAL_RESTRICTED
 *           listing at capacity, served from its own /orders with an EMPTY signature. Nobody
 *           fills. The depositor queues while Listed; the exercise timestamp closes deposits;
 *           `lockBook` retires the listing; `rollClose` closes flat (0 written, 0 assigned, the
 *           honest Harvest(1, 0, 0, 0)) and settles that queue. While flat, an instant redeem
 *           works, and a queue joined while Idle is settled by the keeper's own `settleQueue()`.
 *   week 2  FILLED AND EXERCISED. The keeper lists; buyer A fills 2 of N straight from the
 *           keeper's /orders JSON through the real Seaport's `fulfillAdvancedOrder(2, N, "0x")`,
 *           buyer B fills 3 more (gas recorded for both: the first fill opens the claim, the
 *           second tops it up). CallsWritten fires once per fill, `contractsWritten == 5`, and the
 *           vault's ERC-1155 balance of the option is 0 after each fill: written == sold. A
 *           Listed-phase deposit succeeds (decision D8) and checkpoints the premium early
 *           (`sweepFee` then pays the fee to the base unit); the depositor queues while Listed.
 *           At the exercise timestamp spot moves above the strike, buyer A exercises 2 on the
 *           real Clear, `lockBook`, then `rollClose`: assignment 2, ClaimRedeemed, a second
 *           Harvest carrying the strike proceeds fee-free, the queue settled; `completeRedeem`
 *           and `claimUsdg` to the base unit.
 *   week 3  STRANDED. Fills, one exercise (so the claim holds BOTH legs), a queue joined while
 *           Listed, and then the vault is FROZEN on the real USDG by Paxos's ASSET_PROTECTION
 *           role (impersonated). `rollClose` STRANDS: ClaimStranded in the receipt, Idle with the
 *           claim kept, the settling epoch takes its EpochStrandShare, the keeper pages
 *           `claim_stranded`, deposits revert DepositsClosed, `rollOpen` would revert
 *           StillStranded and the keeper never even tries. The keeper's retry timer fires and the
 *           retry REVERTS while the freeze holds (`strand_retry_failed`); after the unfreeze its
 *           next retry lands (StrandedClaimRecovered, Harvest carrying the stranded cycle's
 *           number, the deferred fee swept), the queuer's EpochStrandShare is paid with the rest
 *           of the entry, and the keeper arms the following week normally.
 *   then    the store is closed and reopened, and every row is asserted.
 *
 * WHAT IS REAL: the fork (mainnet state), Valorem Clear (option types, writes inside Seaport's
 * hook, exercise, assignment, redeem, and the freeze-time revert of the redeem), Seaport 1.6
 * (validation, partial fills through the zone hooks, cancellation, counter bumps), NVDA, USDG
 * (and its ASSET_PROTECTION freeze), Multicall3, the vault bytecode (linked and deployed from
 * contracts/out exactly as script/Deploy.s.sol constructs it), and every keeper module. WHAT IS
 * MOCKED, for one stated reason: Chainlink RHNVDA/USD -> src/mocks/MockFeed.sol seeded with the
 * REAL answer at the fork block. The run warps the clock three weeks and moves spot on purpose
 * twice (in the money before an exercise); the real feed would trip the vault's StalePrice gate
 * on the first warp, correctly and uselessly for a rehearsal. ALERT_WEBHOOK is an in-process
 * capture; alerts.ts runs unmodified. Balances are written into token storage (the fork suite's
 * `deal`), because nobody here holds real Stock Tokens.
 *
 * WHAT IS NOT EXERCISED HERE: index.ts's timer loop and signal handling, several exercisers, a
 * guardian cancel, the relist budget, the Valorem fee branch, a reprice after a rally, an
 * anyone-rollClose, and a fill the vault refuses — all in dryrun-extended.ts.
 *
 * HOW TO RUN IT (keeper/README.md "Dry run" has the long form):
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8560 --code-size-limit 98304
 *   (cd contracts && forge build)
 *   pnpm --filter @callhouse/keeper dryrun
 *
 * ENV (all optional):
 *   DRYRUN_RPC           anvil endpoint. Default http://127.0.0.1:8560. Loopback only, chain 4663 only.
 *   DRYRUN_ARTIFACTS     contracts/out. Default ../contracts/out relative to this package
 *   DRYRUN_OUT           where keeper.db, report.md and run.json go. Default ./dryrun-out/<utc>
 *   DRYRUN_DEPOSIT       asset base units the depositor puts in. Default 25e18; within
 *                        [15e18, 45e18] (the run queues 5 + 3 + 4 + 2, redeems 2, sells 5 + 2,
 *                        deposits 5 more under a 50e18 cap). Every figure is derived.
 *   DRYRUN_KEEPER_PK     the hot key to run as. Default: a key derived from a label
 *   DRYRUN_HEALTH_PORT   KEEPER_PORT for the health server. Default 18790
 *
 * Every keeper variable is set by this file before the keeper is imported; a keeper .env is
 * deliberately NOT read (KEEPER_ENV_FILE=/dev/null), so a mainnet key cannot leak into a fork run.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keccak256, parseEventLogs, toHex, type Address, type Hex } from 'viem';
import { clearAbi, seaportAbi, vaultAbi } from './abi.js';
import {
  ACC_PRECISION,
  ADMIN,
  ANYONE,
  BUYER,
  BUYER_B,
  CHAIN_ID,
  CLEAR,
  DEPOSITOR,
  FEE_SAFE,
  GUARDIAN,
  KEEPER,
  LAUNCH_POLICY,
  LOT,
  NVDA,
  RPC,
  SEAPORT,
  USDG,
  VAULT_MIN_LEAD_S,
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
  currentStep,
  deal,
  deployVault,
  exerciseOn,
  expectRevert,
  fillFromOrders,
  forkChain,
  fundActors,
  harvestFee,
  healthClient,
  isFrozen,
  note,
  only,
  preflightFork,
  pub,
  sendTx,
  setFeed,
  setUsdgFrozen,
  step,
  trail,
  vaultHarnessAbi,
  wallet,
  warpAndRefresh,
  writeRunFiles,
} from './dryrun-common.js';
import { nextWeekWindow } from './calendar.js';
// Type-only, erased at runtime: the keeper's state.ts (and config.ts behind it) is still not
// loaded until the environment below has been set. optionType.ts reads config.ts too, so it is
// imported dynamically beside the other production modules.
import type { ListingRow } from './state.js';

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

const OUT = resolve(process.env.DRYRUN_OUT ?? join('dryrun-out', new Date().toISOString().replace(/[:.]/g, '-')));
const DEPOSIT = BigInt(process.env.DRYRUN_DEPOSIT ?? '25000000000000000000');
const HEALTH_PORT = Number(process.env.DRYRUN_HEALTH_PORT ?? '18790');
const DEPOSIT_CAP = 50n * LOT;

/** Week 1: queued while Listed (settled by rollClose), then redeemed instantly, then queued
 *  while Idle (settled by the keeper's settleQueue). */
const QUEUE_W1_LISTED = 5n * LOT;
const REDEEM_W1_INSTANT = 2n * LOT;
const QUEUE_W1_IDLE = 3n * LOT;
/** Week 2: two fills, one deposit while Listed, one queue while Listed, one exercise. */
const FILL_A2 = 2n;
const FILL_B2 = 3n;
const DEPOSIT_LISTED = 5n * LOT;
const QUEUE_W2 = 4n * LOT;
const EXERCISE_W2 = 2n;
/** Week 3: one fill, one queue while Listed, one exercise (both claim legs non-zero), a freeze. */
const FILL_A3 = 2n;
const QUEUE_W3 = 2n * LOT;
const EXERCISE_W3 = 1n;
/** The keeper's stranded-claim retry timer for this run: the schema's floor. */
const RETRY_MS = 1_000;

/*//////////////////////////////////////////////////////////////
                              THE RECORD
//////////////////////////////////////////////////////////////*/

const record = {
  harness: 'dryrun',
  startedAt: new Date().toISOString(),
  rpc: RPC,
  clientVersion: '',
  chainId: 0,
  forkBlock: '',
  deposit: DEPOSIT.toString(),
  keeperConfig: {} as Record<string, unknown>,
  actors: trail.actors,
  addresses: trail.addresses,
  blocks: {} as Record<string, string>,
  cycle1: {} as Record<string, unknown>,
  cycle2: {} as Record<string, unknown>,
  cycle3: {} as Record<string, unknown>,
  cycle4: {} as Record<string, unknown>,
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
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/*//////////////////////////////////////////////////////////////
                                MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dbPath = join(OUT, 'keeper.db');
  assert(DEPOSIT >= 15n * LOT && DEPOSIT <= 45n * LOT, `DRYRUN_DEPOSIT must be within [15e18, 45e18], got ${DEPOSIT}`);

  /* ---------- 0. preflight ---------- */

  await step('preflight: this is an anvil fork of 4663 on a loopback RPC', async () => {
    Object.assign(record, await preflightFork());
    await fundActors({ keeper: KEEPER, admin: ADMIN, feeSafe: FEE_SAFE, guardian: GUARDIAN, depositor: DEPOSITOR, buyerA: BUYER, buyerB: BUYER_B, anyone: ANYONE });
  });

  /* ---------- 1. deploy ---------- */

  const { vault, feed, answer, vaultDeployBlock } = await step('deploy MockFeed (seeded with the real answer), both libraries and the linked Vault; grant KEEPER_ROLE and GUARDIAN_ROLE', async () => {
    const deployment = await deployVault(DEPOSIT_CAP, 'Callhouse NVDA (dry run)');
    record.blocks.vaultDeployBlock = deployment.vaultDeployBlock.toString();
    return deployment;
  });
  const V = { address: vault, abi: vaultAbi } as const;
  const Q = { address: vault, abi: vaultHarnessAbi } as const;

  /* ---------- 2. the environment, and then — only then — the keeper ---------- */

  const alerts = new AlertCapture();
  await alerts.start();

  process.env.KEEPER_ENV_FILE = '/dev/null';
  process.env.RH_RPC = RPC;
  delete process.env.RH_RPC_2;
  process.env.CHAIN_ID = String(CHAIN_ID);
  process.env.VAULT = vault;
  process.env.KEEPER_PK = process.env.DRYRUN_KEEPER_PK ?? keccak256(toHex('callhouse-dryrun:keeper'));
  process.env.KEEPER_DB_PATH = dbPath;
  process.env.KEEPER_PORT = String(HEALTH_PORT);
  process.env.KEEPER_LOG_LEVEL = process.env.KEEPER_LOG_LEVEL ?? 'info';
  process.env.KEEPER_FALLBACK_DIR = join(OUT, 'fallback');
  process.env.KEEPER_RETRY_STRANDED_MS = String(RETRY_MS);
  process.env.ALERT_WEBHOOK = alerts.url;
  // The fork warps time by weeks, so Cboe's live delayed chain never lists the fork's expiries and
  // vol mode would (correctly) skip every week. The rehearsal pins the fixed rule it asserts.
  process.env.KEEPER_PRICING_MODE = 'fixed';
  // The keeper's own defaults price and time the week; a shell override would break the
  // "priced at the fill floor plus the default margin" and "next NYSE Friday" assertions. The vol
  // keys do nothing in fixed mode, but an out-of-range value left in the shell would abort boot.
  for (const key of [
    'KEEPER_UNIT_PRICE_USDG6',
    'KEEPER_PREMIUM_MARGIN_BPS',
    'KEEPER_STRIKE_OTM_BPS',
    'KEEPER_ARM_LEAD_S',
    'KEEPER_NYSE_HOLIDAYS',
    'ALERT_WEBHOOK_TOKEN',
    'KEEPER_TARGET_DELTA',
    'KEEPER_PRICE_EDGE_BPS',
    'KEEPER_STRIKE_BAND_BUFFER_BPS',
    'KEEPER_VOL_URL',
    'KEEPER_VOL_ROOT',
    'KEEPER_VOL_MAX_AGE_S',
    'KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS',
    'KEEPER_VOL_TIMEOUT_MS',
    'KEEPER_VOL_MAX_BYTES',
    'KEEPER_VOL_REPRICE_UP_BPS',
  ]) {
    delete process.env[key];
  }

  // The production modules. config.ts validates the environment above the moment this runs.
  const roll = await import('./roll.js');
  const { store, KeeperStore } = await import('./state.js');
  const policy = await import('./policy.js');
  const seaport = await import('./seaport.js');
  const { optionIdFor, targetStrike6, weeklyTuple } = await import('./optionType.js');
  const { startHealthServer } = await import('./health.js');
  const { config } = await import('./config.js');
  const { account } = await import('./clients.js');
  assertAddr(account.address, KEEPER.address, 'the keeper module derived the harness keeper address');
  assertAddr(config.VAULT ?? '(unset)', vault, 'keeper config VAULT');
  record.keeperConfig = {
    strikeOtmBps: config.KEEPER_STRIKE_OTM_BPS,
    premiumMarginBps: config.KEEPER_PREMIUM_MARGIN_BPS,
    armLeadS: config.KEEPER_ARM_LEAD_S,
    retryStrandedMs: config.KEEPER_RETRY_STRANDED_MS,
    pollIntervalMs: config.POLL_INTERVAL_MS,
  };
  assertEq(config.KEEPER_RETRY_STRANDED_MS, RETRY_MS, 'the retry timer is the run’s');

  const healthServer = startHealthServer();
  const health = healthClient(HEALTH_PORT);
  const stopServers = (): void => {
    healthServer.close();
    alerts.stop();
  };

  const dumpDb = (): Record<string, unknown> => ({
    counts: store.counts(),
    cycles: store.recentCycles(10),
    listings: store.db.prepare('SELECT order_hash, cycle_number, seq, option_id, contracts, unit_price6, gross_usdg6, end_time, counter, status, approve_tx, cancel_tx, seaport_total_filled, seaport_total_size, seaport_cancelled FROM listings ORDER BY cycle_number, seq').all(),
    txs: store.recentTxs(60),
    alerts: store.recentAlerts(60).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, delivered: a.delivered })),
    meta: store.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
  });
  const keeperTxs = () => store.db.prepare('SELECT kind, cycle_number, status, hash FROM txs ORDER BY created_at, rowid').all() as Array<{ kind: string; cycle_number: number | null; status: string; hash: string }>;
  const txKinds = () => keeperTxs().map((t) => `${t.cycle_number ?? '-'}:${t.kind}:${t.status}`);
  const onlyListingFor = (cycleNumber: number, seq: number): ListingRow => {
    const row = store.listingsForCycle(cycleNumber).find((r) => r.seq === seq);
    assert(row !== undefined, `cycle ${cycleNumber} listing seq ${seq}`);
    return row;
  };
  const receiptOf = (hash: string | null) => {
    assert(hash !== null, 'a transaction hash is on record');
    return pub.getTransactionReceipt({ hash: hash as Hex });
  };
  const readPolicy = () => policy.readPolicy();
  const spotUsdg = () => pub.readContract({ ...V, functionName: 'spotUsdg' });
  const optionBalance = (holder: Address, id: bigint) => pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [holder, id] });
  const orderStatus = (hash: string) => pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getOrderStatus', args: [hash as Hex] });

  /**
   * What an Idle tick that arms a week must have done, checked against the vault, the Clear,
   * Seaport, /orders and the keeper's own store: the next NYSE Friday close from the block the
   * tick saw, the option type created (or reused) on the real Clear at spot + KEEPER_STRIKE_OTM_BPS
   * rounded to a whole USDG, `rollOpen(id)` writing nothing, and ONE listing at capacity priced
   * at the fill floor plus KEEPER_PREMIUM_MARGIN_BPS. Returns the listing row and the week.
   */
  /**
   * What the next Idle tick must arm, derived BEFORE the tick from the head block and the feed
   * exactly as the keeper derives it, so the tick can be checked against a prediction rather
   * than against its own output. `existedBefore` is true when the tuple already exists on the
   * Clear (an earlier run on the same fork created it): the keeper then reuses it and sends no
   * newOptionType, which is the designed behaviour, not a miss.
   */
  const expectedArm = async () => {
    const blockTs = (await pub.getBlock({ blockTag: 'latest' })).timestamp;
    const window = nextWeekWindow(Number(blockTs), config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
    assert(window.exerciseTs >= Number(blockTs) + VAULT_MIN_LEAD_S, 'the window respects the vault’s MIN_LEAD');
    const [p, spot] = await Promise.all([readPolicy(), spotUsdg()]);
    for (const key of Object.keys(LAUNCH_POLICY) as Array<keyof typeof LAUNCH_POLICY>) {
      assertEq(p[key], LAUNCH_POLICY[key], `vault.policy().${key} = Policy.launchDefaults().${key}`);
    }
    const strike = targetStrike6(spot, config.KEEPER_STRIKE_OTM_BPS);
    const tuple = weeklyTuple(NVDA, USDG, strike, window.exerciseTs, window.expiryTs);
    const optionId = optionIdFor(tuple);
    const existedBefore = (await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'tokenType', args: [optionId] })) === 1;
    return { window, p, spot, strike, optionId, existedBefore };
  };

  const assertArmed = async (cycleNumber: number, expected: Awaited<ReturnType<typeof expectedArm>>, rec: Record<string, unknown>, alertsFrom: number) => {
    const { window, p, spot, strike, optionId, existedBefore } = expected;

    // The vault: armed on exactly that id, nothing written.
    assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Listed, 'phase Listed');
    assertEq(await pub.readContract({ ...V, functionName: 'cycleNumber' }), cycleNumber, 'vault.cycleNumber');
    assertEq(await pub.readContract({ ...V, functionName: 'optionId' }), optionId, 'vault.optionId == the id derived from the tuple');
    assertEq(await pub.readContract({ ...V, functionName: 'cycleStrikeUsdg' }), strike, 'vault.cycleStrikeUsdg == round(spot x 1.05) to a whole USDG');
    assertEq(BigInt(await pub.readContract({ ...V, functionName: 'cycleExerciseTs' })), BigInt(window.exerciseTs), 'vault.cycleExerciseTs == the next NYSE Friday 16:00 ET');
    assertEq(BigInt(await pub.readContract({ ...V, functionName: 'cycleExpiryTs' })), BigInt(window.expiryTs), 'vault.cycleExpiryTs == exercise + 24 h');
    assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), 0n, 'no claim at the arm');
    assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), 0n, 'nothing written at the arm');
    assertEq(await optionBalance(vault, optionId), 0n, 'the vault holds no option tokens at the arm');
    const [strikeMinBand, strikeMaxBand] = [(spot * (10_000n + p.minOtmBps)) / 10_000n, (spot * (10_000n + p.maxOtmBps)) / 10_000n];
    assert(strike >= strikeMinBand && strike <= strikeMaxBand, `strike ${strike} inside the band [${strikeMinBand}, ${strikeMaxBand}]`);

    // The Clear: the type exists with exactly the tuple, and the keeper's derivation of its id holds.
    assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'tokenType', args: [optionId] }), 1, 'clear.tokenType(id) == Option');
    const o = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'option', args: [optionId] });
    assertAddr(o.underlyingAsset, NVDA, 'option.underlyingAsset');
    assertEq(o.underlyingAmount, LOT, 'option.underlyingAmount == one lot');
    assertAddr(o.exerciseAsset, USDG, 'option.exerciseAsset');
    assertEq(o.exerciseAmount, strike, 'option.exerciseAmount == the strike');
    assertEq(o.exerciseTimestamp, window.exerciseTs, 'option.exerciseTimestamp');
    assertEq(o.expiryTimestamp, window.expiryTs, 'option.expiryTimestamp');

    // The keeper's transactions: newOptionType (with its NewOptionType log naming the id) unless
    // the tuple already existed, rollOpen (RollOpen.contractsCount == 0), approveListing
    // (ListingApproved).
    const cycle = store.getCycle(cycleNumber);
    assert(cycle !== null, `cycle row ${cycleNumber}`);
    assertEq(cycle.status, 'open', 'cycle row status');
    assertEq(cycle.option_id, optionId.toString(), 'row option_id');
    assertEq(cycle.strike_usdg6, strike.toString(), 'row strike');
    assertEq(cycle.exercise_ts, window.exerciseTs, 'row exercise_ts');
    assertEq(cycle.expiry_ts, window.expiryTs, 'row expiry_ts');
    assertEq(cycle.contracts, 0, 'row contracts: 0 sold at the arm');
    assert(cycle.roll_open_tx !== null, 'roll_open_tx recorded');
    // newOptionType is recorded without a cycle (the number is the vault's, known only after
    // rollOpen), so the newest one is this week's.
    const creations = keeperTxs().filter((t) => t.kind === 'newOptionType');
    const created = creations[creations.length - 1];
    let newOptionTypeTx: string | null = null;
    if (existedBefore) {
      note(`the tuple already existed on the Clear (an earlier run on this fork); the keeper reused it and created nothing`);
    } else {
      assert(created !== undefined && created.status === 'success', 'the keeper created the option type on the real Clear (newOptionType confirmed)');
      const createdReceipt = await receiptOf(created.hash);
      assert(createdReceipt.blockNumber > (await receiptOf(cycle.roll_open_tx)).blockNumber - 2n, 'the creation is this tick’s');
      const newType = only(parseEventLogs({ abi: clearAbi, eventName: 'NewOptionType', logs: createdReceipt.logs }), CLEAR, 'NewOptionType');
      assertEq(newType.args.optionId, optionId, 'NewOptionType.optionId == the derived id');
      assertEq(newType.args.exerciseAmount, strike, 'NewOptionType.exerciseAmount');
      newOptionTypeTx = created.hash;
    }
    const openReceipt = await receiptOf(cycle.roll_open_tx);
    const opened = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollOpen', logs: openReceipt.logs }), vault, 'RollOpen');
    assertEq(opened.args.cycleNumber, cycleNumber, 'RollOpen.cycleNumber');
    assertEq(opened.args.optionId, optionId, 'RollOpen.optionId');
    assertEq(BigInt(opened.args.contractsCount), 0n, 'RollOpen.contractsCount == 0: the arm writes nothing');
    assertEq(opened.args.strikeUsdg, strike, 'RollOpen.strikeUsdg');
    assertEq(allFrom(parseEventLogs({ abi: vaultAbi, eventName: 'CallsWritten', logs: openReceipt.logs }), vault).length, 0, 'no CallsWritten at the arm');

    // The listing: one row, at capacity, priced at the fill floor plus the margin, authorised on
    // the real Seaport, served from /orders in the shape the vault checked.
    const rows = store.listingsForCycle(cycleNumber);
    assertEq(rows.length, 1, 'one listing row for the cycle');
    const row = rows[0];
    assert(row !== undefined, 'listing row');
    assertEq(row.status, 'approved', 'listing status');
    assertEq(row.seq, 1, 'seq 1');
    const totalAssets = await pub.readContract({ ...V, functionName: 'totalAssets' });
    const capacity = capacityOf(totalAssets, 0n, p);
    assertEq(BigInt(row.contracts), capacity, `listed the whole capacity: Policy.maxContracts(${totalAssets}) - 0 = ${capacity}`);
    assertEq(BigInt(row.contracts), policy.capacity(totalAssets, 0n, p), 'the keeper’s own capacity() agrees');
    const priced = policy.priceListing({ policy: p, spotUsdg6: spot, strikeUsdg6: strike, contracts: capacity, feesEnabled: false, feeBps: 15 });
    assert(priced.ok, 'the keeper’s pricing rule accepts the week');
    const floorUnit = policy.fillFloorUnit6(spot, capacity, p, false, 15);
    assertEq(priced.floorUnit6, floorUnit, 'the fill floor per contract: ceil(minPremium(spot, N) / N), fee off');
    assertEq(BigInt(row.unit_price6), policy.withPremiumMargin(floorUnit, config.KEEPER_PREMIUM_MARGIN_BPS), `unit price = ceil(floor x (10000 + ${config.KEEPER_PREMIUM_MARGIN_BPS}) / 10000)`);
    assertEq(BigInt(row.unit_price6), priced.unitPrice6, 'the keeper priced by its own rule');
    assert(BigInt(row.unit_price6) * capacity >= (spot * capacity * p.minPremiumBps) / 10_000n, 'the gross clears Policy.minPremium at this spot');
    assert(BigInt(row.unit_price6) <= strike, 'unit <= strike (UnitPriceExceedsStrike)');
    assertEq(BigInt(row.gross_usdg6), BigInt(row.unit_price6) * capacity, 'gross == unit x N, so gross % N == 0');
    assertEq(row.end_time, window.exerciseTs, 'endTime == cycleExerciseTs');
    assertEq(row.signature, '0x', 'the row carries the EMPTY signature');
    assertEq(row.counter, (await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] })).toString(), 'built at the live Seaport counter');
    const components = seaport.componentsFromJson(JSON.parse(row.components_json) as never);
    assertEq(seaport.localOrderHash(components).toLowerCase(), row.order_hash.toLowerCase(), 'the local struct hash reproduces the stored hash');
    assertEq((await pub.readContract({ ...V, functionName: 'listingHash' })).toLowerCase(), row.order_hash.toLowerCase(), 'vault.listingHash == the stored hash');
    assertEq(await pub.readContract({ ...V, functionName: 'listingAmount' }), capacity, 'vault.listingAmount');
    assertEq(await pub.readContract({ ...V, functionName: 'listingGrossUsdg' }), BigInt(row.gross_usdg6), 'vault.listingGrossUsdg');
    assertEq(await pub.readContract({ ...V, functionName: 'listingsThisCycle' }), 1, 'listingsThisCycle 1');
    const [isValidated, isCancelled, totalFilled, totalSize] = await orderStatus(row.order_hash);
    assertEq(isValidated, true, 'seaport.getOrderStatus(hash).isValidated: the order is live on the real Seaport');
    assertEq(isCancelled, false, 'not cancelled');
    assertEq(totalFilled, 0n, 'nothing filled');
    assertEq(totalSize, 0n, 'untouched');
    assert(row.approve_tx !== null, 'approve_tx recorded');
    const approved = only(parseEventLogs({ abi: vaultAbi, eventName: 'ListingApproved', logs: (await receiptOf(row.approve_tx)).logs }), vault, 'ListingApproved');
    assertEq(approved.args.orderHash.toLowerCase(), row.order_hash.toLowerCase(), 'ListingApproved.orderHash');
    assertEq(approved.args.amount, capacity, 'ListingApproved.amount');
    assertEq(approved.args.grossUsdg, BigInt(row.gross_usdg6), 'ListingApproved.grossUsdg');
    assertEq(approved.args.seq, 1, 'ListingApproved.seq');
    const served = await health.orders();
    assertEq(served.length, 1, '/orders serves exactly one order');
    const entry = served[0];
    assert(entry !== undefined, '/orders[0]');
    assertEq(entry.orderHash.toLowerCase(), row.order_hash.toLowerCase(), '/orders serves the authorised hash');
    assertServedShape(entry, { vault, optionId, contracts: capacity, unitPrice6: BigInt(row.unit_price6), endTime: BigInt(window.exerciseTs) });
    assertEq(entry.remainingContracts, capacity.toString(), '/orders remainingContracts == the whole size');
    assertEq(entry.status, 'approved', '/orders status');
    assert(existsSync(join(OUT, 'fallback', `${row.order_hash}.json`)), 'the payload was mirrored to KEEPER_FALLBACK_DIR');
    assertEq(alerts.since(alertsFrom).join(','), 'roll_open,listing', 'alerts: the arm and the listing, in order');
    const armAlert = alerts.last('roll_open');
    assertEq(armAlert.data.cycleNumber as number, cycleNumber, 'roll_open alert cycle');
    assertEq(String(armAlert.data.capacity), capacity.toString(), 'roll_open alert capacity: planned on the vault as it is now');
    assertEq(String(armAlert.data.exerciseTs), String(window.exerciseTs), 'roll_open alert exerciseTs');
    note(`cycle ${cycleNumber}: option ${optionId.toString().slice(0, 12)}… strike ${strike} USDG6, close ${window.closeDay} (exercise ${window.exerciseTs}, expiry ${window.expiryTs}); listed ${capacity} at ${row.unit_price6} USDG6 (floor ${floorUnit}), spot ${spot}`);

    Object.assign(rec, {
      optionId: optionId.toString(),
      strikeUsdg6: strike.toString(),
      spotAtArmUsdg6: spot.toString(),
      exerciseTimestamp: window.exerciseTs,
      expiryTimestamp: window.expiryTs,
      closeDay: window.closeDay,
      listed: capacity.toString(),
      unitPrice6: row.unit_price6,
      floorUnit6: floorUnit.toString(),
      gross6: row.gross_usdg6,
      orderHash: row.order_hash,
      newOptionTypeTx,
      optionTypeReused: existedBefore,
      rollOpenTx: cycle.roll_open_tx,
      approveTx: row.approve_tx,
    });
    return { row, window, optionId, strike, capacity, unit: BigInt(row.unit_price6) };
  };

  /** The keeper's lockBook tick: Exercisable, the live listing retired everywhere. */
  const assertLocked = async (cycleNumber: number, row: ListingRow, rec: Record<string, unknown>) => {
    assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Exercisable, 'phase Exercisable');
    const cycle = store.getCycle(cycleNumber);
    assert(cycle !== null && cycle.lock_tx !== null, 'lock_tx recorded');
    assertEq(cycle.status, 'locked', 'cycle status locked');
    const receipt = await receiptOf(cycle.lock_tx);
    only(parseEventLogs({ abi: vaultAbi, eventName: 'BookLocked', logs: receipt.logs }), vault, 'BookLocked');
    const invalidated = only(parseEventLogs({ abi: vaultAbi, eventName: 'AllListingsInvalidated', logs: receipt.logs }), vault, 'AllListingsInvalidated');
    const cancelled = only(parseEventLogs({ abi: vaultAbi, eventName: 'ListingCancelled', logs: receipt.logs }), vault, 'ListingCancelled');
    assertEq(cancelled.args.orderHash.toLowerCase(), row.order_hash.toLowerCase(), 'lockBook killed the live listing');
    assertEq(invalidated.args.newCounter, await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getCounter', args: [vault] }), 'the Seaport counter moved (a bump, not a cancel)');
    assert(invalidated.args.newCounter !== BigInt(row.counter), 'the counter is no longer the one the order was built at');
    assertEq(await pub.readContract({ ...V, functionName: 'listingHash' }), ZERO_BYTES32, 'vault.listingHash cleared');
    assertEq((await orderStatus(row.order_hash))[1], false, 'Seaport isCancelled stays false on a counter bump');
    const dead = store.getListing(row.order_hash);
    assert(dead !== null, 'listing row');
    assert(dead.status === 'expired' || dead.status === 'filled', `the listing row is terminal (${dead.status})`);
    assertEq((await health.orders()).length, 0, '/orders serves nothing after lockBook');
    assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'deposits closed while Exercisable');
    rec.lockTx = cycle.lock_tx;
    rec.counterAfterLock = invalidated.args.newCounter.toString();
  };

  try {
    /* ---------- 3. boot ---------- */

    await step('keeper boot: reconcile() against the fresh vault', async () => {
      await roll.reconcile();
      const snap = roll.getLastSnapshot();
      assert(snap !== null, 'reconcile produced no snapshot');
      assertEq(snap.phase, roll.Phase.Idle, 'phase');
      assertEq(snap.hasKeeperRole, true, 'keeper role');
      assertEq(snap.isStranded, false, 'not stranded');
      assertEq(snap.valoremFeesEnabled, false, 'the real Clear’s fee switch is off');
      assertEq(alerts.kinds().length, 0, 'no alert on a clean boot');
      const h = await health.get('/health');
      assertEq(h.status, 200, 'GET /health');
      record.health.afterBoot = h.body;
      note(`GET /health -> ${h.status} ${String(h.body.status)}`);
    });

    /* =====================================================================================
       WEEK 1: unfilled
       ===================================================================================== */

    await step(`week 1: the depositor puts ${DEPOSIT} NVDA wei in`, async () => {
      assert((await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] })) >= DEPOSIT, 'deposits are open');
      await deal(NVDA, DEPOSITOR.address, DEPOSIT);
      await approve('NVDA.approve(vault)', DEPOSITOR, NVDA, vault, DEPOSIT);
      await sendTx('vault.deposit', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT, DEPOSITOR.address] }),
      );
      assertEq(await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] }), DEPOSIT, 'first deposit is 1:1');
      assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), DEPOSIT, 'totalAssets');
    });

    const week1 = await step('week 1, tick #1 (Idle): newOptionType on the real Clear -> rollOpen (arm only) -> approveListing at capacity -> /orders', async () => {
      const expected = await expectedArm();
      await roll.tick();
      return assertArmed(1, expected, record.cycle1, 0);
    });

    await step('week 1, tick #2 (Listed, nobody has filled): nothing changes', async () => {
      const txsBefore = txKinds().length;
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(txKinds().length, txsBefore, 'no transaction');
      assertEq(alerts.received.length, alertsBefore, 'no alert');
      const row = store.getListing(week1.row.order_hash);
      assert(row !== null, 'row');
      assertEq(row.status, 'approved', 'still approved');
      assertEq(row.seaport_total_filled, '0', 'Seaport: nothing filled');
      assertEq((await health.orders()).length, 1, '/orders still serves it');
    });

    await step(`week 1: the depositor queues ${QUEUE_W1_LISTED} shares while Listed`, async () => {
      const epoch = await pub.readContract({ ...V, functionName: 'epochId' });
      assertEq(epoch, 1n, 'epoch 1: the constructor starts there');
      const { receipt } = await sendTx(`vault.queueRedeem(${QUEUE_W1_LISTED}) (depositor)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'queueRedeem', args: [QUEUE_W1_LISTED] }),
      );
      const ev = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'QueueRedeem', logs: receipt.logs }), vault, 'QueueRedeem');
      assertEq(ev.args.shares, QUEUE_W1_LISTED, 'QueueRedeem.shares');
      assertEq(ev.args.epochId, 1n, 'QueueRedeem.epochId');
      assertEq(await pub.readContract({ ...V, functionName: 'queuedShares' }), QUEUE_W1_LISTED, 'queuedShares');
      assertEq(await pub.readContract({ ...V, functionName: 'balanceOf', args: [vault] }), QUEUE_W1_LISTED, 'the vault escrows the shares on itself');
      assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), DEPOSIT, 'nothing is burned until settlement');
      assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), false, 'the queue is the only exit while a call is open');
      assertEq(await pub.readContract({ ...Q, functionName: 'previewRedeem', args: [QUEUE_W1_LISTED] }), 0n, 'previewRedeem quotes 0: no instant path');
      await expectRevert('completeRedeem before the epoch settles', 'EpochNotSettled', () =>
        pub.simulateContract({ account: DEPOSITOR, address: vault, abi: vaultHarnessAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
      );
      record.cycle1.queueListed = { shares: QUEUE_W1_LISTED.toString(), epoch: '1', tx: receipt.transactionHash };
    });

    await step('week 1: warp to the exercise timestamp; deposits close on the clock; tick #3 -> lockBook', async () => {
      await warpAndRefresh(BigInt(week1.window.exerciseTs), 'week-1 exerciseTimestamp', feed, answer);
      // The deposit gate keys on the timestamp, not the phase: the vault is still Listed but the
      // exercise window has opened, so new money is refused before anyone can mint against a
      // NAV that an exercise could collapse (Vault._depositRefused reason 2).
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Listed, 'still Listed before the tick');
      assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'maxDeposit quotes 0 once the exercise window is open');
      await expectRevert('deposit after the exercise window opened (vault still Listed)', 'DepositsClosed', () =>
        pub.simulateContract({ account: DEPOSITOR, address: vault, abi: vaultAbi, functionName: 'deposit', args: [LOT, DEPOSITOR.address] }),
      );
      const alertsBefore = alerts.received.length;
      await roll.tick();
      await assertLocked(1, week1.row, record.cycle1);
      assertEq(store.getListing(week1.row.order_hash)?.status ?? null, 'expired', 'the unfilled listing row is expired');
      assertEq(alerts.received.length, alertsBefore, 'lockBook raises no alert');
    });

    await step('week 1: warp past expiry; tick #4 -> rollClose flat: 0 written, 0 assigned, Harvest(1, 0, 0, 0), the Listed queue settled', async () => {
      await warpAndRefresh(BigInt(week1.window.expiryTs), 'week-1 expiryTimestamp', feed, answer);
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'phase Idle');
      const cycle = store.getCycle(1);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'roll_close_tx recorded');
      assertEq(cycle.status, 'closed', 'closed');
      const receipt = await receiptOf(cycle.roll_close_tx);
      const rc = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
      assertEq(rc.args.cycleNumber, 1, 'RollClose.cycleNumber');
      assertEq(rc.args.assetsReturned, 0n, 'RollClose.assetsReturned 0: nothing was ever written');
      assertEq(rc.args.usdgFromAssignment, 0n, 'RollClose.usdgFromAssignment 0');
      assertEq(rc.args.contractsAssignedCount, 0n, 'RollClose.contractsAssignedCount 0');
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      assertEq(hv.args.grossUsdg, 0n, 'Harvest.gross 0: the honest zero of an unfilled week');
      assertEq(hv.args.feeUsdg, 0n, 'Harvest.fee 0');
      assertEq(hv.args.netUsdg, 0n, 'Harvest.net 0');
      assertEq(allFrom(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), vault).length, 0, 'no claim to redeem: no ClaimRedeemed');
      assertEq(allFrom(parseEventLogs({ abi: vaultAbi, eventName: 'ClaimStranded', logs: receipt.logs }), vault).length, 0, 'nothing stranded');
      assertEq(allFrom(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'FeeSwept', logs: receipt.logs }), vault).length, 0, 'no fee to sweep');
      // The queue joined while Listed settles inside rollClose, priced like an instant redemption
      // (virtual share included): q x (idle + 1) / (supply + 1).
      const settled = only(parseEventLogs({ abi: vaultAbi, eventName: 'QueueSettled', logs: receipt.logs }), vault, 'QueueSettled');
      const payout = (QUEUE_W1_LISTED * (DEPOSIT + 1n)) / (DEPOSIT + 1n);
      assertEq(settled.args.epochId, 1n, 'QueueSettled.epochId 1');
      assertEq(settled.args.shares, QUEUE_W1_LISTED, 'QueueSettled.shares');
      assertEq(settled.args.assets, payout, `QueueSettled.assets = ${QUEUE_W1_LISTED} x (${DEPOSIT} + 1) / (${DEPOSIT} + 1) = ${payout}`);
      assertEq(settled.args.usdgOut, 0n, 'QueueSettled.usdgOut 0: no premium this week');
      assertEq(await pub.readContract({ ...V, functionName: 'epochId' }), 2n, 'epoch advanced');
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), payout, 'reservedAssets');
      assertEq(await pub.readContract({ ...V, functionName: 'optionId' }), 0n, 'the armed type is forgotten');
      assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), 0n, 'no claim');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), 0n, 'nothing written');
      assertEq(await pub.readContract({ ...V, functionName: 'isStranded' }), false, 'not stranded');
      assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), true, 'flat');
      assertEq(await balanceOf(USDG, vault), 0n, 'no premium, no proceeds');
      // The keeper's row and alert.
      assertEq(cycle.contracts, 0, 'row contracts 0 sold');
      assertEq(cycle.gross_usdg6, '0', 'gross 0');
      assertEq(cycle.fee_usdg6, '0', 'fee 0');
      assertEq(cycle.net_usdg6, '0', 'net 0');
      assertEq(cycle.contracts_assigned, 0, 'contracts_assigned 0');
      assertEq(cycle.assets_returned, '0', 'assets_returned 0 (a known zero, not NULL)');
      assertEq(cycle.usdg_from_assignment, '0', 'usdg_from_assignment 0');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_close', 'one roll_close alert');
      assertEq(alerts.latest().message, 'cycle 1 closed unfilled: 0 USDG harvested.', 'the unfilled wording');
      const tape = ((await health.get('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 1);
      assert(tape !== undefined, '/cycles serves cycle 1');
      assertEq(tape.premium_gross_usdg6 as string, '0', '/cycles premium 0');
      assertEq(tape.strike_proceeds_usdg6 as string, '0', '/cycles strike proceeds 0');
      record.cycle1.rollCloseTx = cycle.roll_close_tx;
      record.cycle1.contracts = '0';
      record.cycle1.harvest = { gross: '0', fee: '0', net: '0', assetsReturned: '0', usdgFromAssignment: '0', contractsAssigned: 0 };
      record.cycle1.queueListed = { ...(record.cycle1.queueListed as Record<string, unknown>), payoutAssets: payout.toString(), usdgOut: '0' };
      const h = await health.get('/health');
      assertEq(h.status, 200, '/health after a full cycle');
      record.health.afterCycle1 = h.body;
    });

    await step('week 1, flat: completeRedeem pays the Listed queue; an instant redeem works; a queue joined while Idle is settled by the keeper’s settleQueue()', async () => {
      const payout = BigInt((record.cycle1.queueListed as { payoutAssets: string }).payoutAssets);
      const nvdaBefore = await balanceOf(NVDA, DEPOSITOR.address);
      const { receipt: done } = await sendTx('vault.completeRedeem (depositor, epoch 1)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
      );
      const completed = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'CompleteRedeem', logs: done.logs }), vault, 'CompleteRedeem');
      assertEq(completed.args.shares, QUEUE_W1_LISTED, 'CompleteRedeem.shares');
      assertEq(completed.args.assets, payout, 'CompleteRedeem.assets');
      assertEq(completed.args.usdgOut, 0n, 'CompleteRedeem.usdgOut');
      assertEq((await balanceOf(NVDA, DEPOSITOR.address)) - nvdaBefore, payout, 'NVDA delivered');
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'the epoch drained');

      // Instant redemption, only while flat: shares x (totalAssets + 1) / (supply + 1).
      const supply = await pub.readContract({ ...V, functionName: 'totalSupply' });
      const assets = await pub.readContract({ ...V, functionName: 'totalAssets' });
      assertEq(supply, DEPOSIT - QUEUE_W1_LISTED, 'supply after the settled queue');
      assertEq(assets, DEPOSIT - payout, 'totalAssets after the settled queue');
      const expectedOut = (REDEEM_W1_INSTANT * (assets + 1n)) / (supply + 1n);
      assertEq(await pub.readContract({ ...Q, functionName: 'previewRedeem', args: [REDEEM_W1_INSTANT] }), expectedOut, 'previewRedeem quotes the instant payout');
      const { receipt: redeemed } = await sendTx(`vault.redeem(${REDEEM_W1_INSTANT}) (depositor, instant)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'redeem', args: [REDEEM_W1_INSTANT, DEPOSITOR.address, DEPOSITOR.address] }),
      );
      const withdrew = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'Withdraw', logs: redeemed.logs }), vault, 'Withdraw');
      assertEq(withdrew.args.shares, REDEEM_W1_INSTANT, 'Withdraw.shares');
      assertEq(withdrew.args.assets, expectedOut, `Withdraw.assets = ${REDEEM_W1_INSTANT} x (${assets} + 1) / (${supply} + 1)`);
      assertEq((await balanceOf(NVDA, DEPOSITOR.address)) - nvdaBefore, payout + expectedOut, 'NVDA delivered instantly');

      // A queue joined while Idle: the keeper's next tick settles it (permissionless
      // settleQueue), re-reads the vault, and only then plans week 2 on what is left.
      const { receipt: queued } = await sendTx(`vault.queueRedeem(${QUEUE_W1_IDLE}) (depositor, while Idle)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'queueRedeem', args: [QUEUE_W1_IDLE] }),
      );
      const ev = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'QueueRedeem', logs: queued.logs }), vault, 'QueueRedeem');
      assertEq(ev.args.epochId, 2n, 'QueueRedeem.epochId 2');
      record.cycle1.instantRedeem = { shares: REDEEM_W1_INSTANT.toString(), assets: expectedOut.toString(), tx: redeemed.transactionHash };
      record.cycle1.queueIdle = { shares: QUEUE_W1_IDLE.toString(), epoch: '2', tx: queued.transactionHash };
    });

    /* =====================================================================================
       WEEK 2: filled and exercised
       ===================================================================================== */

    const week2 = await step('week 2, tick #5 (Idle, shares queued): settleQueue() -> a fresh snapshot -> newOptionType -> rollOpen -> approveListing', async () => {
      const supplyBefore = await pub.readContract({ ...V, functionName: 'totalSupply' });
      const idleBefore = await pub.readContract({ ...V, functionName: 'idleAssets' });
      const staleCapacity = capacityOf(await pub.readContract({ ...V, functionName: 'totalAssets' }), 0n, await readPolicy());
      const alertsBefore = alerts.received.length;
      const expected = await expectedArm();
      await roll.tick();
      // settleQueue first, by the keeper, permissionlessly.
      const settleTx = keeperTxs().find((t) => t.kind === 'settleQueue');
      assert(settleTx !== undefined && settleTx.status === 'success', 'the keeper sent settleQueue');
      const settled = only(parseEventLogs({ abi: vaultAbi, eventName: 'QueueSettled', logs: (await receiptOf(settleTx.hash)).logs }), vault, 'QueueSettled');
      const payout = (QUEUE_W1_IDLE * (idleBefore + 1n)) / (supplyBefore + 1n);
      assertEq(settled.args.epochId, 2n, 'QueueSettled.epochId 2');
      assertEq(settled.args.shares, QUEUE_W1_IDLE, 'QueueSettled.shares');
      assertEq(settled.args.assets, payout, `QueueSettled.assets = ${QUEUE_W1_IDLE} x (${idleBefore} + 1) / (${supplyBefore} + 1)`);
      assertEq(settled.args.usdgOut, 0n, 'QueueSettled.usdgOut 0');
      assertEq(alerts.since(alertsBefore)[0] ?? null, 'queue_settled', 'the settlement is announced first');
      assertEq(String(alerts.last('queue_settled').data.epochId), '2', 'queue_settled alert epoch');
      // Then the week, planned on the vault AFTER the settlement: the reserve is out of NAV.
      const armed = await assertArmed(2, expected, record.cycle2, alertsBefore + 1);
      assert(armed.capacity < staleCapacity, `capacity ${armed.capacity} is less than the ${staleCapacity} a stale (pre-settlement) snapshot would have planned`);
      // settleQueue is filed under the vault's cycle number at the time (the last closed week);
      // newOptionType under none, because the number is the vault's and known only at rollOpen.
      assertEq(txKinds().slice(-4).join(','), '1:settleQueue:success,-:newOptionType:success,2:rollOpen:success,2:approveListing:success', 'the tick’s four transactions, in order');
      record.cycle1.queueIdle = { ...(record.cycle1.queueIdle as Record<string, unknown>), settleTx: settleTx.hash, payoutAssets: payout.toString(), usdgOut: '0' };
      // Collect the settled queue so the reserve is empty for the rest of the run.
      await sendTx('vault.completeRedeem (depositor, epoch 2)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
      );
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'the epoch drained');
      return armed;
    });
    const optionId2 = week2.optionId;
    const strike2 = week2.strike;
    const N2 = week2.capacity;
    const unit2 = week2.unit;
    assert(N2 >= FILL_A2 + FILL_B2 + 1n, `${N2} listed leaves room for ${FILL_A2} + ${FILL_B2} fills and a remainder`);

    const fills2: Array<Record<string, unknown>> = [];
    await step(`week 2: buyer A fills ${FILL_A2}/${N2} on the real Seaport from /orders (the first fill opens the claim); tick #6 -> fill`, async () => {
      const served = await health.order(week2.row.order_hash);
      const fill = await fillFromOrders('buyer A', BUYER, vault, served, FILL_A2);
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), FILL_A2, 'contractsWritten == 2 == sold');
      assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), FILL_A2 * LOT, 'two lots behind the claim');
      assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), DEPOSIT - QUEUE_W1_LISTED - REDEEM_W1_INSTANT - QUEUE_W1_IDLE, 'writing moves collateral, it does not lose it');
      fills2.push({ buyer: 'A', contracts: FILL_A2.toString(), numerator: FILL_A2.toString(), denominator: N2.toString(), tx: fill.hash, block: fill.block.toString(), gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString(), opensClaim: true });
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(alerts.since(alertsBefore).join(','), 'fill', 'the keeper published the fill');
      assertEq(String(alerts.last('fill').data.filled), FILL_A2.toString(), 'fill alert: contracts filled');
      assertEq(String(alerts.last('fill').data.sold), FILL_A2.toString(), 'fill alert: sold so far');
      const row = store.getListing(week2.row.order_hash);
      assert(row !== null, 'row');
      assertEq(row.status, 'partial', 'listing partial');
      assertEq(store.getCycle(2)?.contracts ?? null, Number(FILL_A2), 'the cycle row tracks the sold count');
      const entry = await health.order(week2.row.order_hash);
      assertEq(entry.filledContracts, FILL_A2.toString(), '/orders filledContracts');
      assertEq(entry.remainingContracts, (N2 - FILL_A2).toString(), '/orders remainingContracts');
      assertEq(entry.status, 'partial', '/orders status partial');
      record.cycle2.claimKey = fill.claimKey.toString();
    });

    await step(`week 2: buyer B fills ${FILL_B2}/${N2} more (a top-up of the same claim); tick #7 -> fill`, async () => {
      const claimBefore = await pub.readContract({ ...V, functionName: 'claimKey' });
      const served = await health.order(week2.row.order_hash);
      const fill = await fillFromOrders('buyer B', BUYER_B, vault, served, FILL_B2);
      assertEq(fill.claimKey, claimBefore, 'the real Clear topped up the same claim');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), FILL_A2 + FILL_B2, 'contractsWritten == 5 == the sum of the two fills');
      const claim = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimBefore] });
      assertEq(claim.amountWritten, (FILL_A2 + FILL_B2) * LOT, 'claim.amountWritten sums the two writes (1e18-scaled)');
      assertEq(await balanceOf(USDG, vault), unit2 * (FILL_A2 + FILL_B2), 'the vault holds both premiums');
      fills2.push({ buyer: 'B', contracts: FILL_B2.toString(), numerator: FILL_B2.toString(), denominator: N2.toString(), tx: fill.hash, block: fill.block.toString(), gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString(), opensClaim: false });
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(alerts.since(alertsBefore).join(','), 'fill', 'the keeper published the second fill');
      assertEq(String(alerts.last('fill').data.sold), (FILL_A2 + FILL_B2).toString(), 'fill alert: 5 sold so far');
      assertEq(store.getListing(week2.row.order_hash)?.status ?? null, 'partial', 'still partial');
      assertEq((await health.order(week2.row.order_hash)).remainingContracts, (N2 - FILL_A2 - FILL_B2).toString(), '/orders remaining');
      record.cycle2.fills = fills2;
      record.cycle2.contracts = (FILL_A2 + FILL_B2).toString();
    });

    const listedDeposit = await step(`week 2: a deposit of ${DEPOSIT_LISTED} while Listed succeeds (D8) and checkpoints the premium; sweepFee pays the fee`, async () => {
      const [supply, assets, accBefore, dustBefore, p] = await Promise.all([
        pub.readContract({ ...V, functionName: 'totalSupply' }),
        pub.readContract({ ...V, functionName: 'totalAssets' }),
        pub.readContract({ ...V, functionName: 'accUsdgPerShare' }),
        pub.readContract({ ...Q, functionName: 'usdgDust' }),
        readPolicy(),
      ]);
      const room = await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] });
      assertEq(room, DEPOSIT_CAP - assets, 'maxDeposit = cap - totalAssets while Listed');
      const premium = unit2 * (FILL_A2 + FILL_B2);
      const fee = harvestFee(premium, 0n, p.protocolFeeBps);
      await deal(NVDA, DEPOSITOR.address, DEPOSIT_LISTED);
      await approve('NVDA.approve(vault)', DEPOSITOR, NVDA, vault, DEPOSIT_LISTED);
      const { receipt } = await sendTx(`vault.deposit(${DEPOSIT_LISTED}) (depositor, while Listed)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT_LISTED, DEPOSITOR.address] }),
      );
      const deposited = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'Deposit', logs: receipt.logs }), vault, 'Deposit');
      const expectedShares = (DEPOSIT_LISTED * (supply + 1n)) / (assets + 1n);
      assertEq(deposited.args.shares, expectedShares, `shares = ${DEPOSIT_LISTED} x (${supply} + 1) / (${assets} + 1): the short call is valued at zero`);
      // The deposit checkpointed the premium: Harvest(2, premium, fee, net) inside the deposit.
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest (deposit checkpoint)');
      assertEq(hv.args.cycleNumber, 2, 'Harvest.cycleNumber');
      assertEq(hv.args.grossUsdg, premium, 'Harvest.gross == the two premiums');
      assertEq(hv.args.feeUsdg, fee, `Harvest.fee = floor(premium x ${p.protocolFeeBps} / 10000)`);
      assertEq(hv.args.netUsdg, premium - fee, 'Harvest.net');
      const accAfter = await pub.readContract({ ...V, functionName: 'accUsdgPerShare' });
      // Distributor._distributeUsdg: the pot is the net plus whatever dust the last distribution
      // could not index, and the index moves by floor(pot x 1e27 / supply BEFORE the mint).
      assertEq(accAfter - accBefore, ((premium - fee + dustBefore) * ACC_PRECISION) / supply, 'index delta = floor((net + carried dust) x 1e27 / supply BEFORE the mint): new shares cannot claim earlier premium');
      assertEq(await pub.readContract({ ...Q, functionName: 'pendingFeeUsdg' }), fee, 'the fee is pending: a checkpoint makes no external call');
      // Anyone sweeps it.
      const feeSafeBefore = await balanceOf(USDG, FEE_SAFE.address);
      const { receipt: swept } = await sendTx('vault.sweepFee() (anyone)', ANYONE, () =>
        wallet.writeContract({ account: ANYONE, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'sweepFee' }),
      );
      const feeSwept = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'FeeSwept', logs: swept.logs }), vault, 'FeeSwept');
      assertAddr(feeSwept.args.feeRecipient, FEE_SAFE.address, 'FeeSwept.feeRecipient');
      assertEq(feeSwept.args.amount, fee, 'FeeSwept.amount to the base unit');
      assertEq((await balanceOf(USDG, FEE_SAFE.address)) - feeSafeBefore, fee, 'the fee Safe received it');
      assertEq(await pub.readContract({ ...Q, functionName: 'pendingFeeUsdg' }), 0n, 'nothing pending');
      await expectRevert('a second sweepFee', 'NothingToClaim', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultHarnessAbi, functionName: 'sweepFee' }),
      );
      // Capacity grew with NAV; the live listing still offers its remainder, so nothing relists.
      const txsBefore = txKinds().length;
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(txKinds().length, txsBefore, 'tick #8: no transaction (the listing is partially filled, not sold out)');
      assertEq(alerts.received.length, alertsBefore, 'no alert');
      assertEq((await health.order(week2.row.order_hash)).remainingContracts, (N2 - FILL_A2 - FILL_B2).toString(), '/orders remaining unchanged');
      record.cycle2.listedDeposit = { assets: DEPOSIT_LISTED.toString(), shares: expectedShares.toString(), tx: receipt.transactionHash, checkpointHarvest: { gross: premium.toString(), fee: fee.toString(), net: (premium - fee).toString() }, sweepFeeTx: swept.transactionHash, feeSwept: fee.toString() };
      return { premium, fee, indexDelta1: accAfter - accBefore, sharesBefore: supply, shares: expectedShares };
    });

    await step(`week 2: the depositor queues ${QUEUE_W2} shares while Listed (epoch 3)`, async () => {
      const { receipt } = await sendTx(`vault.queueRedeem(${QUEUE_W2}) (depositor)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'queueRedeem', args: [QUEUE_W2] }),
      );
      const ev = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'QueueRedeem', logs: receipt.logs }), vault, 'QueueRedeem');
      assertEq(ev.args.epochId, 3n, 'QueueRedeem.epochId 3');
      record.cycle2.queue = { sharesQueued: QUEUE_W2.toString(), epoch: '3', queueTx: receipt.transactionHash };
    });

    await step('week 2: warp to the exercise timestamp; spot moves above the strike; tick #9 -> lockBook', async () => {
      await warpAndRefresh(BigInt(week2.window.exerciseTs), 'week-2 exerciseTimestamp', feed, answerAbove(strike2, 5n));
      const spot = await spotUsdg();
      assert(spot > strike2, `spot ${spot} above strike ${strike2}: in the money`);
      assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'deposits closed on the clock');
      await roll.tick();
      await assertLocked(2, week2.row, record.cycle2);
      assertEq(store.getListing(week2.row.order_hash)?.status ?? null, 'expired', 'the partially filled listing is expired');
      record.cycle2.itmSpotUsdg6 = spot.toString();
    });

    const exercised2 = await step(`week 2: buyer A exercises ${EXERCISE_W2} on the real Clear inside the window`, async () => {
      const done = await exerciseOn('buyer A', BUYER, vault, optionId2, EXERCISE_W2, strike2);
      assertEq(done.feesEnabled, false, 'the fee switch is off');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), EXERCISE_W2, 'vault.contractsAssigned() == 2');
      assertEq(await pub.readContract({ ...V, functionName: 'claimedExerciseProceeds' }), EXERCISE_W2 * strike2, 'the claim holds 2 x strike of USDG');
      assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), (FILL_A2 + FILL_B2 - EXERCISE_W2) * LOT, 'three lots still locked');
      assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'deposits stay closed: Exercisable, and unredeemed strike proceeds in the claim');
      record.cycle2.exercise = { by: 'A', contracts: EXERCISE_W2.toString(), tx: done.hash, debitUsdg6: done.debit.toString(), clearFee: done.fee.toString() };
      record.cycle2.contractsExercised = EXERCISE_W2.toString();
      return done;
    });

    const closed2 = await step('week 2: warp past expiry; tick #10 -> rollClose: assignment 2, ClaimRedeemed, Harvest with the strike proceeds fee-free, the queue settled', async () => {
      await warpAndRefresh(BigInt(week2.window.expiryTs), 'week-2 expiryTimestamp', feed, answerAbove(strike2, 5n));
      const written = FILL_A2 + FILL_B2;
      const [supplyBefore, accBefore, epochBefore, vaultNvdaBefore, vaultUsdgBefore, feeSafeBefore, dustBefore, p] = await Promise.all([
        pub.readContract({ ...V, functionName: 'totalSupply' }),
        pub.readContract({ ...V, functionName: 'accUsdgPerShare' }),
        pub.readContract({ ...V, functionName: 'epochId' }),
        balanceOf(NVDA, vault),
        balanceOf(USDG, vault),
        balanceOf(USDG, FEE_SAFE.address),
        pub.readContract({ ...Q, functionName: 'usdgDust' }),
        readPolicy(),
      ]);
      assertEq(epochBefore, 3n, 'epoch 3 is the one settling');
      const keeperSnap = await roll.snapshot();
      assertEq(await roll.contractsAssignedAt(keeperSnap), EXERCISE_W2, "the keeper's own pre-close read of the real Clear: 2");
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'phase Idle');
      const cycle = store.getCycle(2);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'roll_close_tx recorded');
      assertEq(cycle.status, 'closed', 'closed');
      const receipt = await receiptOf(cycle.roll_close_tx);
      const rc = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
      assertEq(rc.args.cycleNumber, 2, 'RollClose.cycleNumber');
      assertEq(rc.args.assetsReturned, (written - EXERCISE_W2) * LOT, 'RollClose.assetsReturned = the unassigned lots');
      assertEq(rc.args.usdgFromAssignment, EXERCISE_W2 * strike2, 'RollClose.usdgFromAssignment = 2 x strike');
      assertEq(rc.args.contractsAssignedCount, EXERCISE_W2, 'RollClose.contractsAssignedCount 2');
      const redeemedByClear = only(parseEventLogs({ abi: clearAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), CLEAR, "the Clear's ClaimRedeemed");
      assertAddr(redeemedByClear.args.redeemer, vault, 'the vault redeemed its own claim');
      assertEq(redeemedByClear.args.exerciseAmountRedeemed, EXERCISE_W2 * strike2, 'Clear.ClaimRedeemed.exerciseAmountRedeemed');
      assertEq(redeemedByClear.args.underlyingAmountRedeemed, (written - EXERCISE_W2) * LOT, 'Clear.ClaimRedeemed.underlyingAmountRedeemed');
      const redeemed = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), vault, "the vault's ClaimRedeemed");
      assertEq(redeemed.args.claimKey, BigInt(record.cycle2.claimKey as string), 'ClaimRedeemed.claimKey');
      // This Harvest carries ONLY the strike proceeds: the premium was checkpointed at the
      // deposit, so gross == usdgFromAssignment, fee-free.
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      assertEq(hv.args.grossUsdg, EXERCISE_W2 * strike2, 'Harvest.gross = the strike proceeds alone');
      assertEq(hv.args.feeUsdg, 0n, 'Harvest.fee 0: strike proceeds are principal, never fee’d');
      assertEq(hv.args.netUsdg, EXERCISE_W2 * strike2, 'Harvest.net');
      assertEq(allFrom(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'FeeSwept', logs: receipt.logs }), vault).length, 0, 'nothing to sweep: the fee went at the checkpoint');
      assertEq(await balanceOf(USDG, FEE_SAFE.address), feeSafeBefore, 'fee Safe unchanged by the close');
      // The distribution and the queue.
      const accAfter = await pub.readContract({ ...V, functionName: 'accUsdgPerShare' });
      const indexDelta = accAfter - accBefore;
      assertEq(indexDelta, ((EXERCISE_W2 * strike2 + dustBefore) * ACC_PRECISION) / supplyBefore, `index delta = floor((strike proceeds + ${dustBefore} carried dust) x 1e27 / supply), escrow included`);
      const settled = only(parseEventLogs({ abi: vaultAbi, eventName: 'QueueSettled', logs: receipt.logs }), vault, 'QueueSettled');
      const idleAfterRedeem = vaultNvdaBefore + rc.args.assetsReturned;
      const payoutAssets = (QUEUE_W2 * (idleAfterRedeem + 1n)) / (supplyBefore + 1n);
      const escrowUsdg = (QUEUE_W2 * indexDelta) / ACC_PRECISION;
      assertEq(settled.args.epochId, 3n, 'QueueSettled.epochId');
      assertEq(settled.args.shares, QUEUE_W2, 'QueueSettled.shares');
      assertEq(settled.args.assets, payoutAssets, `QueueSettled.assets = ${QUEUE_W2} x (${idleAfterRedeem} + 1) / (${supplyBefore} + 1)`);
      assertEq(settled.args.usdgOut, escrowUsdg, "QueueSettled.usdgOut = the escrow's own accrual over the close: 4e18 x indexDelta / 1e27");
      assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), supplyBefore - QUEUE_W2, 'the escrow was burned');
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), payoutAssets, 'reservedAssets');
      assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), escrowUsdg, 'usdgReservedForQueue');
      assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), 0n, 'claim redeemed');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), 0n, 'contractsWritten zeroed');
      assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), true, 'flat again');
      assertEq(await balanceOf(NVDA, vault), idleAfterRedeem, 'the vault NVDA: never written + returned');
      assertEq(await balanceOf(USDG, vault), vaultUsdgBefore + EXERCISE_W2 * strike2, 'vault USDG grew by the strike proceeds');
      // The keeper's row sums BOTH Harvests of the cycle; the fee is the checkpoint's.
      const premium = listedDeposit.premium;
      const gross = premium + EXERCISE_W2 * strike2;
      assertEq(cycle.contracts, Number(written), 'row contracts 5 sold');
      assertEq(cycle.gross_usdg6, gross.toString(), 'gross_usdg6 = premium + strike proceeds, summed over two Harvest events');
      assertEq(cycle.fee_usdg6, listedDeposit.fee.toString(), 'fee_usdg6 = the checkpoint fee on the premium only');
      assertEq(cycle.net_usdg6, (gross - listedDeposit.fee).toString(), 'net_usdg6');
      assertEq(cycle.contracts_assigned, Number(EXERCISE_W2), 'contracts_assigned 2, from the RollClose event');
      assertEq(cycle.assets_returned, rc.args.assetsReturned.toString(), 'assets_returned');
      assertEq(cycle.usdg_from_assignment, rc.args.usdgFromAssignment.toString(), 'usdg_from_assignment');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_close', 'one roll_close alert');
      const last = alerts.latest();
      assertEq(
        last.message,
        `cycle 2 closed: premium ${roll.formatUsdg(premium)} USDG (fee ${roll.formatUsdg(listedDeposit.fee)}), strike proceeds ${roll.formatUsdg(EXERCISE_W2 * strike2)} USDG from ${EXERCISE_W2} contracts assigned; ${roll.formatUsdg(gross - listedDeposit.fee)} USDG to depositors.`,
        'the assigned-week wording: premium and strike proceeds apart',
      );
      assertEq(String(last.data.contractsAssignedSource), 'RollClose', 'the count came from the event');
      assertEq(Number(last.data.contractsAssignedFromClaim), Number(EXERCISE_W2), "the keeper's own pre-read inside the tick agreed");
      assertEq(String(last.data.premiumUsdg), roll.formatUsdg(premium), 'data.premiumUsdg');
      assertEq(String(last.data.strikeProceedsUsdg), roll.formatUsdg(EXERCISE_W2 * strike2), 'data.strikeProceedsUsdg');
      const tape = ((await health.get('/cycles')).body.cycles as Array<Record<string, unknown>>).find((c) => c.cycle_number === 2);
      assert(tape !== undefined, '/cycles serves cycle 2');
      assertEq(tape.premium_gross_usdg6 as string, premium.toString(), '/cycles premium_gross_usdg6');
      assertEq(tape.strike_proceeds_usdg6 as string, (EXERCISE_W2 * strike2).toString(), '/cycles strike_proceeds_usdg6');
      record.cycle2.rollCloseTx = cycle.roll_close_tx;
      record.cycle2.harvest = {
        gross: gross.toString(),
        fee: listedDeposit.fee.toString(),
        net: (gross - listedDeposit.fee).toString(),
        premium: premium.toString(),
        usdgFromAssignment: (EXERCISE_W2 * strike2).toString(),
        assetsReturned: rc.args.assetsReturned.toString(),
        contractsAssigned: Number(EXERCISE_W2),
        harvestEvents: 2,
        keeperPreReadBeforeTick: EXERCISE_W2.toString(),
      };
      record.cycle2.queue = { ...(record.cycle2.queue as Record<string, unknown>), payoutAssets: payoutAssets.toString(), escrowUsdg: escrowUsdg.toString(), indexDelta: indexDelta.toString() };
      record.health.afterCycle2 = (await health.get('/health')).body;
      return { payoutAssets, escrowUsdg, indexDelta, supplyBefore };
    });

    await step('week 2: completeRedeem and claimUsdg to the base unit; sweepFee has nothing left', async () => {
      const [previewAssets, previewUsdg] = await pub.readContract({ ...V, functionName: 'previewCompleteRedeem', args: [DEPOSITOR.address] });
      assertEq(previewAssets, closed2.payoutAssets, 'previewCompleteRedeem.assets');
      assertEq(previewUsdg, closed2.escrowUsdg, 'previewCompleteRedeem.usdgOut');
      const nvdaBefore = await balanceOf(NVDA, DEPOSITOR.address);
      const usdgBefore = await balanceOf(USDG, DEPOSITOR.address);
      const { receipt } = await sendTx('vault.completeRedeem (depositor, epoch 3)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
      );
      const done = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'CompleteRedeem', logs: receipt.logs }), vault, 'CompleteRedeem');
      assertEq(done.args.assets, closed2.payoutAssets, 'CompleteRedeem.assets');
      assertEq(done.args.usdgOut, closed2.escrowUsdg, 'CompleteRedeem.usdgOut');
      assertEq((await balanceOf(NVDA, DEPOSITOR.address)) - nvdaBefore, closed2.payoutAssets, 'NVDA delivered');
      assertEq((await balanceOf(USDG, DEPOSITOR.address)) - usdgBefore, closed2.escrowUsdg, "the escrow's USDG delivered");
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'reserve drained');
      assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), 0n, 'USDG reserve drained');
      // The shares that stayed: the checkpoint's index move on the pre-mint balance, and the
      // close's index move on what was left after the queue.
      const sharesLeft = await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] });
      assertEq(sharesLeft, closed2.supplyBefore - QUEUE_W2, 'shares left');
      const claimable = await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
      const expectedClaimable = (listedDeposit.sharesBefore * listedDeposit.indexDelta1) / ACC_PRECISION + (sharesLeft * closed2.indexDelta) / ACC_PRECISION;
      assertEq(claimable, expectedClaimable, 'claimable = floor(pre-mint shares x delta1 / 1e27) + floor(shares left x delta2 / 1e27)');
      const { receipt: claimed } = await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
      );
      const ev = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'ClaimUsdg', logs: claimed.logs }), vault, 'ClaimUsdg');
      assertEq(ev.args.amount, claimable, 'ClaimUsdg.amount == claimableUsdg');
      assertEq((await balanceOf(USDG, DEPOSITOR.address)) - usdgBefore, closed2.escrowUsdg + claimable, 'USDG received: the escrow leg plus the claim');
      assertEq(await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] }), 0n, 'nothing left to claim');
      await expectRevert('sweepFee with nothing pending', 'NothingToClaim', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultHarnessAbi, functionName: 'sweepFee' }),
      );
      // Where every base unit of the week's USDG went.
      const remainder = await balanceOf(USDG, vault);
      const [dust, unallocated, accounted] = await Promise.all([
        pub.readContract({ ...Q, functionName: 'usdgDust' }),
        pub.readContract({ ...Q, functionName: 'usdgUnallocated' }),
        pub.readContract({ ...Q, functionName: 'usdgAccounted' }),
      ]);
      const gross = listedDeposit.premium + EXERCISE_W2 * strike2;
      assertEq(listedDeposit.fee + closed2.escrowUsdg + claimable + remainder, gross, 'fee + escrow + claim + remainder = premium + strike proceeds');
      assertEq(accounted, remainder, 'the remainder sits inside usdgAccounted: it can never be re-harvested as premium');
      assertEq(unallocated, 0n, 'nothing was received while the supply was zero');
      assert(dust <= remainder, 'the index dust is inside the remainder');
      note(`completeRedeem paid ${closed2.payoutAssets} NVDA wei + ${roll.formatUsdg(closed2.escrowUsdg)} USDG; claimUsdg paid ${roll.formatUsdg(claimable)}; fee ${roll.formatUsdg(listedDeposit.fee)}; ${remainder} base unit(s) left (dust ${dust})`);
      record.cycle2.queue = { ...(record.cycle2.queue as Record<string, unknown>), completeRedeemTx: receipt.transactionHash, assetsOut: closed2.payoutAssets.toString(), usdgOut: closed2.escrowUsdg.toString() };
      record.cycle2.claimed = claimable.toString();
      record.cycle2.claimTx = claimed.transactionHash;
      record.cycle2.usdgLeftInVault = { remainder: remainder.toString(), usdgDust: dust.toString() };
      record.cycle2.final = {
        totalSupply: (await pub.readContract({ ...V, functionName: 'totalSupply' })).toString(),
        idleAssets: (await pub.readContract({ ...V, functionName: 'idleAssets' })).toString(),
        depositorShares: sharesLeft.toString(),
        depositorNvda: (await balanceOf(NVDA, DEPOSITOR.address)).toString(),
      };
    });

    /* =====================================================================================
       WEEK 3: stranded by a USDG freeze
       ===================================================================================== */

    const week3 = await step('week 3, tick #11 (Idle, flat): newOptionType -> rollOpen -> approveListing', async () => {
      const alertsBefore = alerts.received.length;
      const expected = await expectedArm();
      await roll.tick();
      return assertArmed(3, expected, record.cycle3, alertsBefore);
    });
    const optionId3 = week3.optionId;
    const strike3 = week3.strike;
    const N3 = week3.capacity;
    const unit3 = week3.unit;
    assert(N3 >= FILL_A3 + 1n, `${N3} listed leaves room for a ${FILL_A3} fill`);

    await step(`week 3: buyer A fills ${FILL_A3}/${N3}; tick #12 -> fill; the depositor queues ${QUEUE_W3} while Listed (epoch 4)`, async () => {
      const served = await health.order(week3.row.order_hash);
      const fill = await fillFromOrders('buyer A', BUYER, vault, served, FILL_A3);
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(alerts.since(alertsBefore).join(','), 'fill', 'fill published');
      assertEq(store.getCycle(3)?.contracts ?? null, Number(FILL_A3), 'cycle row sold count');
      const { receipt } = await sendTx(`vault.queueRedeem(${QUEUE_W3}) (depositor)`, DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'queueRedeem', args: [QUEUE_W3] }),
      );
      const ev = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'QueueRedeem', logs: receipt.logs }), vault, 'QueueRedeem');
      assertEq(ev.args.epochId, 4n, 'QueueRedeem.epochId 4');
      record.cycle3.fills = [{ buyer: 'A', contracts: FILL_A3.toString(), numerator: FILL_A3.toString(), denominator: N3.toString(), tx: fill.hash, block: fill.block.toString(), gasUsed: fill.gasUsed.toString(), premium: fill.premium.toString(), opensClaim: true }];
      record.cycle3.contracts = FILL_A3.toString();
      record.cycle3.claimKey = fill.claimKey.toString();
      record.cycle3.queue = { sharesQueued: QUEUE_W3.toString(), epoch: '4', queueTx: receipt.transactionHash };
    });

    await step(`week 3: warp to the exercise timestamp; spot above the strike; tick #13 -> lockBook; buyer A exercises ${EXERCISE_W3} of ${FILL_A3} (both claim legs non-zero)`, async () => {
      await warpAndRefresh(BigInt(week3.window.exerciseTs), 'week-3 exerciseTimestamp', feed, answerAbove(strike3, 5n));
      await roll.tick();
      await assertLocked(3, week3.row, record.cycle3);
      const done = await exerciseOn('buyer A', BUYER, vault, optionId3, EXERCISE_W3, strike3);
      assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), (FILL_A3 - EXERCISE_W3) * LOT, 'one lot still locked');
      assertEq(await pub.readContract({ ...V, functionName: 'claimedExerciseProceeds' }), EXERCISE_W3 * strike3, 'one strike of USDG in the claim');
      record.cycle3.exercise = { by: 'A', contracts: EXERCISE_W3.toString(), tx: done.hash, debitUsdg6: done.debit.toString() };
      record.cycle3.contractsExercised = EXERCISE_W3.toString();
    });

    const stranded = await step('week 3: warp past expiry; Paxos freezes the vault on USDG (impersonated ASSET_PROTECTION); tick #14 -> rollClose STRANDS the claim', async () => {
      await warpAndRefresh(BigInt(week3.window.expiryTs), 'week-3 expiryTimestamp', feed, answerAbove(strike3, 5n));
      const freezeTx = await setUsdgFrozen(vault, true);
      assertEq(await isFrozen(vault), true, 'USDG.isFrozen(vault)');
      const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
      const [supplyBefore, vaultUsdgBefore, vaultNvdaBefore, feeSafeBefore, p] = await Promise.all([
        pub.readContract({ ...V, functionName: 'totalSupply' }),
        balanceOf(USDG, vault),
        balanceOf(NVDA, vault),
        balanceOf(USDG, FEE_SAFE.address),
        readPolicy(),
      ]);
      const premium = unit3 * FILL_A3;
      const fee = harvestFee(premium, 0n, p.protocolFeeBps);
      const alertsBefore = alerts.received.length;
      const txsBefore = txKinds().length;
      await roll.tick();
      assertEq(txKinds().length, txsBefore + 1, 'one transaction: rollClose');
      const cycle = store.getCycle(3);
      assert(cycle !== null && cycle.roll_close_tx !== null, 'roll_close_tx recorded');
      assertEq(cycle.status, 'stranded', 'the row says stranded');
      assertEq(cycle.strand_gen, '1', 'strand_gen 1');
      const receipt = await receiptOf(cycle.roll_close_tx);
      // The receipt: a zero-leg RollClose, ClaimStranded, the premium harvested, no ClaimRedeemed,
      // the fee NOT swept (the vault is frozen on USDG), the queue settled with its strand share.
      const rc = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
      assertEq(rc.args.assetsReturned, 0n, 'RollClose.assetsReturned 0: nothing came home');
      assertEq(rc.args.usdgFromAssignment, 0n, 'RollClose.usdgFromAssignment 0');
      assertEq(rc.args.contractsAssignedCount, EXERCISE_W3, 'RollClose.contractsAssignedCount 1: read before the failed redeem');
      const strand = only(parseEventLogs({ abi: vaultAbi, eventName: 'ClaimStranded', logs: receipt.logs }), vault, 'ClaimStranded');
      assertEq(strand.args.cycleNumber, 3, 'ClaimStranded.cycleNumber');
      assertEq(strand.args.claimKey, claimKey, 'ClaimStranded.claimKey');
      assertEq(strand.args.gen, 1n, 'ClaimStranded.gen 1');
      assertEq(allFrom(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), vault).length, 0, 'no ClaimRedeemed: the redeem reverted inside the Clear');
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      assertEq(hv.args.grossUsdg, premium, 'Harvest.gross = the premium that sat idle');
      assertEq(hv.args.feeUsdg, fee, 'Harvest.fee on the premium');
      assertEq(allFrom(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'FeeSwept', logs: receipt.logs }), vault).length, 0, 'no FeeSwept: the frozen vault cannot pay the fee, and the close does not depend on it');
      assertEq(await pub.readContract({ ...Q, functionName: 'pendingFeeUsdg' }), fee, 'the fee stays pending');
      assertEq(await balanceOf(USDG, FEE_SAFE.address), feeSafeBefore, 'fee Safe unchanged');
      assertEq(await balanceOf(USDG, vault), vaultUsdgBefore, 'no USDG moved under the freeze');
      const settled = only(parseEventLogs({ abi: vaultAbi, eventName: 'QueueSettled', logs: receipt.logs }), vault, 'QueueSettled');
      const idle = vaultNvdaBefore;
      const payoutAssets = (QUEUE_W3 * (idle + 1n)) / (supplyBefore + 1n);
      assertEq(settled.args.epochId, 4n, 'QueueSettled.epochId 4');
      assertEq(settled.args.assets, payoutAssets, `QueueSettled.assets = ${QUEUE_W3} x (${idle} + 1) / (${supplyBefore} + 1): priced on the IDLE balance, the claim at nothing`);
      const share = only(parseEventLogs({ abi: vaultAbi, eventName: 'EpochStrandShare', logs: receipt.logs }), vault, 'EpochStrandShare');
      const wad = (1_000_000_000_000_000_000n * QUEUE_W3) / supplyBefore;
      assertEq(share.args.epochId, 4n, 'EpochStrandShare.epochId');
      assertEq(share.args.gen, 1n, 'EpochStrandShare.gen');
      assertEq(share.args.wad, wad, `EpochStrandShare.wad = 1e18 x ${QUEUE_W3} / ${supplyBefore}: the epoch's pro-rata share of the stranded claim`);
      // The vault: Idle with the claim kept, everything shut that should be.
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'phase Idle even though the redeem failed');
      assertEq(await pub.readContract({ ...V, functionName: 'isStranded' }), true, 'isStranded');
      assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), claimKey, 'the claim is kept');
      assertEq(await pub.readContract({ ...V, functionName: 'optionId' }), optionId3, 'and the type with it');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), FILL_A3, 'and the count that shuts the instant path');
      assertEq(await pub.readContract({ ...V, functionName: 'strandGen' }), 1n, 'generation 1 open');
      assertEq(await pub.readContract({ ...V, functionName: 'lastResolvedGen' }), 0n, 'unresolved');
      assertEq(await pub.readContract({ ...V, functionName: 'strandedRemainingWad' }), 1_000_000_000_000_000_000n - wad, 'live shares own the rest of the claim');
      assertEq(await pub.readContract({ ...V, functionName: 'epochStrandWad', args: [4n] }), wad, 'epochStrandWad[4]');
      assertEq(await pub.readContract({ ...V, functionName: 'epochStrandGen', args: [4n] }), 1n, 'epochStrandGen[4]');
      assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), (FILL_A3 - EXERCISE_W3) * LOT, 'the stranded claim still reads as locked collateral');
      assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), false, 'instant path shut');
      assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'deposits shut');
      await expectRevert('deposit while stranded', 'DepositsClosed', () =>
        pub.simulateContract({ account: DEPOSITOR, address: vault, abi: vaultAbi, functionName: 'deposit', args: [LOT, DEPOSITOR.address] }),
      );
      await expectRevert('retryStrandedClaim while the freeze holds (anyone)', 'StillStranded', () =>
        pub.simulateContract({ account: ANYONE, address: vault, abi: vaultHarnessAbi, functionName: 'retryStrandedClaim' }),
      );
      // rollOpen over it would revert StillStranded: proven with a fresh type at the same strike.
      const headTs = (await pub.getBlock({ blockTag: 'latest' })).timestamp;
      const nextWindow = nextWeekWindow(Number(headTs), config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
      const { receipt: typed } = await sendTx('clear.newOptionType (harness, a type the keeper would arm next)', ANYONE, () =>
        wallet.writeContract({ account: ANYONE, chain: forkChain, address: CLEAR, abi: clearAbi, functionName: 'newOptionType', args: [NVDA, LOT, USDG, strike3, nextWindow.exerciseTs, nextWindow.expiryTs] }),
      );
      const nextId = only(parseEventLogs({ abi: clearAbi, eventName: 'NewOptionType', logs: typed.logs }), CLEAR, 'NewOptionType').args.optionId;
      await expectRevert('rollOpen over a stranded claim (keeper key)', 'StillStranded', () =>
        pub.simulateContract({ account: KEEPER, address: vault, abi: vaultAbi, functionName: 'rollOpen', args: [nextId] }),
      );
      // The keeper: the row, the roll_close wording, and the page.
      assertEq(cycle.contracts_assigned, Number(EXERCISE_W3), 'contracts_assigned 1');
      assertEq(cycle.assets_returned, '0', 'assets_returned 0 (a stranded close reports zero legs)');
      assertEq(cycle.usdg_from_assignment, '0', 'usdg_from_assignment 0');
      assertEq(cycle.gross_usdg6, premium.toString(), 'gross_usdg6 = the premium harvest so far');
      assertEq(alerts.since(alertsBefore).join(','), 'roll_close,claim_stranded', 'the close, then the page');
      assertEq(
        alerts.last('roll_close').message,
        `cycle 3 closed: ${roll.formatUsdg(premium)} USDG harvested, ${roll.formatUsdg(premium - fee)} to depositors. The claim could NOT be redeemed and is stranded: its legs are paid by retryStrandedClaim.`,
        'the stranded wording',
      );
      assertEq(alerts.last('roll_close').data.stranded as boolean, true, 'data.stranded');
      const page = alerts.last('claim_stranded');
      assertEq(page.severity, 'error', 'claim_stranded is an error');
      assertEq(String(page.data.gen), '1', 'claim_stranded gen');
      assertEq(String(page.data.claimKey), claimKey.toString(), 'claim_stranded claimKey');
      assertEq(String(page.data.tx), cycle.roll_close_tx, 'claim_stranded tx');
      // /state and /health report from the snapshot a tick takes BEFORE it acts, so the stranded
      // flag reaches them on the next tick (asserted there).
      record.cycle3.strand = {
        freezeTx,
        rollCloseTx: cycle.roll_close_tx,
        gen: '1',
        claimKey: claimKey.toString(),
        epochStrandShare: { epoch: '4', wad: wad.toString() },
        strandedRemainingWad: (1_000_000_000_000_000_000n - wad).toString(),
        harvestAtClose: { gross: premium.toString(), fee: fee.toString(), net: (premium - fee).toString() },
        pendingFee: fee.toString(),
        nextTypeRefused: nextId.toString(),
      };
      record.cycle3.queue = { ...(record.cycle3.queue as Record<string, unknown>), payoutAssets: payoutAssets.toString(), escrowUsdg: settled.args.usdgOut.toString(), strandWad: wad.toString() };
      return { claimKey, wad, payoutAssets, escrowUsdg: settled.args.usdgOut, premium, fee, supplyBefore };
    });

    await step('week 3, tick #15 (Idle, stranded): no arm attempted; the retry timer fires and retryStrandedClaim reverts StillStranded -> strand_retry_failed; tick #16 inside the timer does nothing', async () => {
      const txsBefore = txKinds().length;
      const alertsBefore = alerts.received.length;
      await roll.tick();
      assertEq(txKinds().length, txsBefore, 'no transaction: no newOptionType, no rollOpen, no retry sent');
      assertEq(alerts.since(alertsBefore).join(','), 'strand_retry_failed', 'the retry was simulated, reverted, and reported as such');
      const failed = alerts.last('strand_retry_failed');
      assertEq(failed.severity, 'warn', 'a warn, not a page');
      assert(failed.message.includes('StillStranded'), 'the alert names the hook answer');
      assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'still Idle');
      assertEq(await pub.readContract({ ...V, functionName: 'cycleNumber' }), 3, 'no cycle 4');
      assert(store.getCycle(4) === null, 'no cycle 4 row');
      const state = (await health.get('/state')).body.vault as { stranded: boolean; strandGen: string };
      assertEq(state.stranded, true, '/state stranded (from this tick’s snapshot)');
      assertEq(state.strandGen, '1', '/state strandGen');
      assertEq(String((await health.get('/health')).body.status), 'ok', '/health stays 200 ok: a strand is not a wedged loop');
      await roll.tick();
      assertEq(txKinds().length, txsBefore, 'tick #16: still nothing sent');
      assertEq(alerts.received.length, alertsBefore + 1, 'tick #16: inside the retry timer, nothing more is reported');
    });

    const recovered = await step('week 3: Paxos unfreezes; the timer elapses; tick #17 -> retryStrandedClaim lands: StrandedClaimRecovered, Harvest for cycle 3, the deferred fee swept', async () => {
      const unfreezeTx = await setUsdgFrozen(vault, false);
      assertEq(await isFrozen(vault), false, 'unfrozen');
      await sleep(RETRY_MS + 200);
      const [vaultNvdaBefore, vaultUsdgBefore, feeSafeBefore, accBefore, supply, dustBefore] = await Promise.all([
        balanceOf(NVDA, vault),
        balanceOf(USDG, vault),
        balanceOf(USDG, FEE_SAFE.address),
        pub.readContract({ ...V, functionName: 'accUsdgPerShare' }),
        pub.readContract({ ...V, functionName: 'totalSupply' }),
        pub.readContract({ ...Q, functionName: 'usdgDust' }),
      ]);
      const alertsBefore = alerts.received.length;
      await roll.tick();
      const retryTx = keeperTxs().find((t) => t.kind === 'retryStrandedClaim');
      assert(retryTx !== undefined && retryTx.status === 'success', 'the keeper sent retryStrandedClaim');
      const receipt = await receiptOf(retryTx.hash);
      const assetsReturned = (FILL_A3 - EXERCISE_W3) * LOT;
      const usdgReturned = EXERCISE_W3 * strike3;
      const queueAssets = (assetsReturned * stranded.wad) / 1_000_000_000_000_000_000n;
      const queueUsdg = (usdgReturned * stranded.wad) / 1_000_000_000_000_000_000n;
      const rec = only(parseEventLogs({ abi: vaultAbi, eventName: 'StrandedClaimRecovered', logs: receipt.logs }), vault, 'StrandedClaimRecovered');
      assertEq(rec.args.gen, 1n, 'StrandedClaimRecovered.gen');
      assertEq(rec.args.assets, assetsReturned, 'StrandedClaimRecovered.assets = the unassigned lot');
      assertEq(rec.args.usdgOut, usdgReturned, 'StrandedClaimRecovered.usdgOut = one strike');
      assertEq(rec.args.queueWad, stranded.wad, "StrandedClaimRecovered.queueWad = the epoch's share");
      const redeemed = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), vault, 'ClaimRedeemed');
      assertEq(redeemed.args.claimKey, stranded.claimKey, 'ClaimRedeemed.claimKey');
      only(parseEventLogs({ abi: clearAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), CLEAR, "the Clear's ClaimRedeemed");
      const hv = only(parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
      assertEq(hv.args.cycleNumber, 3, "the retry's Harvest carries the STRANDED cycle's number");
      assertEq(hv.args.grossUsdg, usdgReturned - queueUsdg, "Harvest.gross = the live shares' part of the strike leg");
      assertEq(hv.args.feeUsdg, 0n, 'Harvest.fee 0: strike proceeds, fee-free');
      const swept = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'FeeSwept', logs: receipt.logs }), vault, 'FeeSwept');
      assertEq(swept.args.amount, stranded.fee, 'the fee deferred by the freeze is swept now, to the base unit');
      assertEq((await balanceOf(USDG, FEE_SAFE.address)) - feeSafeBefore, stranded.fee, 'the fee Safe received it');
      assertEq(await pub.readContract({ ...Q, functionName: 'pendingFeeUsdg' }), 0n, 'nothing pending');
      // The vault: resolved, flat, the queue's share reserved, the rest to live shares.
      assertEq(await pub.readContract({ ...V, functionName: 'isStranded' }), false, 'resolved');
      assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), 0n, 'claim redeemed');
      assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), 0n, 'contractsWritten zeroed');
      assertEq(await pub.readContract({ ...V, functionName: 'lastResolvedGen' }), 1n, 'generation 1 resolved');
      assertEq(await pub.readContract({ ...V, functionName: 'strandedRemainingWad' }), 0n, 'strandedRemainingWad 0');
      const s = await pub.readContract({ ...V, functionName: 'strands', args: [1n] });
      assertEq(s[0], assetsReturned, 'strands[1].assetsIn');
      assertEq(s[1], usdgReturned, 'strands[1].usdgIn');
      assertEq(s[2], stranded.wad, 'strands[1].wadLeft');
      assertEq(s[3], queueAssets, 'strands[1].assetsLeft = assetsIn x wad / 1e18');
      assertEq(s[4], queueUsdg, 'strands[1].usdgLeft = usdgIn x wad / 1e18');
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), stranded.payoutAssets + queueAssets, "reservedAssets = the epoch's idle slice + its claim share");
      assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), stranded.escrowUsdg + queueUsdg, 'usdgReservedForQueue');
      assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), true, 'flat again');
      assertEq((await balanceOf(NVDA, vault)) - vaultNvdaBefore, assetsReturned, 'the unassigned lot is back');
      assertEq((await balanceOf(USDG, vault)) - vaultUsdgBefore, usdgReturned - stranded.fee, 'the strike leg landed, less the fee that finally left');
      const accAfter = await pub.readContract({ ...V, functionName: 'accUsdgPerShare' });
      assertEq(accAfter - accBefore, ((usdgReturned - queueUsdg + dustBefore) * ACC_PRECISION) / supply, `index delta = floor((the live shares' strike part + ${dustBefore} carried dust) x 1e27 / supply)`);
      // The keeper: the row closed with the whole cycle summed, and the recovery announced.
      const cycle = store.getCycle(3);
      assert(cycle !== null, 'row');
      assertEq(cycle.status, 'closed', 'recovered: closed');
      assertEq(cycle.retry_tx, retryTx.hash, 'retry_tx');
      assertEq(cycle.strand_gen, '1', 'strand_gen kept');
      assertEq(cycle.gross_usdg6, (stranded.premium + usdgReturned - queueUsdg).toString(), 'gross_usdg6 = the premium harvest at the close + the retry harvest, summed over cycle 3');
      assertEq(cycle.fee_usdg6, stranded.fee.toString(), 'fee on the premium only');
      // The row records the LIVE SHARES' part (recoveryLegs): premium = gross - proceeds must
      // come out as the close-time premium, not as premium minus the queue's share of the redeem.
      assertEq(cycle.assets_returned, (assetsReturned - queueAssets).toString(), 'assets_returned = live shares (full redeem minus queueWad)');
      assertEq(cycle.usdg_from_assignment, (usdgReturned - queueUsdg).toString(), 'usdg_from_assignment = live shares (Harvest.gross of the retry)');
      assertEq(alerts.since(alertsBefore).join(','), 'strand_recovered', 'the recovery announced; nothing armed in the same tick');
      const announced = alerts.last('strand_recovered');
      assertEq(String(announced.data.gen), '1', 'strand_recovered gen');
      assertEq(String(announced.data.assets), assetsReturned.toString(), 'strand_recovered assets');
      assertEq(announced.data.witnessedLive as boolean, true, 'witnessed by this keeper');
      assertEq((await health.get('/state')).body.phase as string, 'Idle', '/state Idle');
      record.cycle3.recovery = { unfreezeTx, retryTx: retryTx.hash, assets: assetsReturned.toString(), usdgOut: usdgReturned.toString(), queueWad: stranded.wad.toString(), queueAssets: queueAssets.toString(), queueUsdg: queueUsdg.toString(), harvest: { gross: (usdgReturned - queueUsdg).toString(), fee: '0' }, feeSwept: stranded.fee.toString() };
      record.cycle3.rollCloseTx = (record.cycle3.strand as { rollCloseTx: string }).rollCloseTx;
      record.cycle3.harvest = {
        gross: cycle.gross_usdg6,
        fee: cycle.fee_usdg6,
        net: cycle.net_usdg6,
        premium: stranded.premium.toString(),
        usdgFromAssignment: usdgReturned.toString(),
        assetsReturned: assetsReturned.toString(),
        contractsAssigned: cycle.contracts_assigned,
        harvestEvents: 2,
      };
      return { queueAssets, queueUsdg, indexDelta: accAfter - accBefore };
    });

    await step("week 3: the queuer's completeRedeem pays the idle slice, the escrow's USDG and its EpochStrandShare (StrandShareSettled); claimUsdg the rest", async () => {
      const [previewAssets, previewUsdg] = await pub.readContract({ ...V, functionName: 'previewCompleteRedeem', args: [DEPOSITOR.address] });
      assertEq(previewAssets, stranded.payoutAssets + recovered.queueAssets, 'previewCompleteRedeem.assets = idle slice + claim share');
      assertEq(previewUsdg, stranded.escrowUsdg + recovered.queueUsdg, 'previewCompleteRedeem.usdgOut = escrow + claim share');
      const nvdaBefore = await balanceOf(NVDA, DEPOSITOR.address);
      const usdgBefore = await balanceOf(USDG, DEPOSITOR.address);
      const { receipt } = await sendTx('vault.completeRedeem (depositor, epoch 4 + strand share)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultHarnessAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
      );
      const entry = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'QueueEntrySettled', logs: receipt.logs }), vault, 'QueueEntrySettled');
      assertEq(entry.args.epochId, 4n, 'QueueEntrySettled.epochId');
      assertEq(entry.args.assets, stranded.payoutAssets, 'QueueEntrySettled.assets: the idle slice');
      const share = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'StrandShareSettled', logs: receipt.logs }), vault, 'StrandShareSettled');
      assertEq(share.args.gen, 1n, 'StrandShareSettled.gen');
      assertEq(share.args.wad, stranded.wad, 'StrandShareSettled.wad');
      assertEq(share.args.assets, recovered.queueAssets, 'StrandShareSettled.assets: the last owner takes exactly what is left');
      assertEq(share.args.usdgOut, recovered.queueUsdg, 'StrandShareSettled.usdgOut');
      const done = only(parseEventLogs({ abi: vaultHarnessAbi, eventName: 'CompleteRedeem', logs: receipt.logs }), vault, 'CompleteRedeem');
      assertEq(done.args.shares, QUEUE_W3, 'CompleteRedeem.shares');
      assertEq(done.args.assets, stranded.payoutAssets + recovered.queueAssets, 'CompleteRedeem.assets');
      assertEq(done.args.usdgOut, stranded.escrowUsdg + recovered.queueUsdg, 'CompleteRedeem.usdgOut');
      assertEq((await balanceOf(NVDA, DEPOSITOR.address)) - nvdaBefore, done.args.assets, 'NVDA delivered');
      assertEq((await balanceOf(USDG, DEPOSITOR.address)) - usdgBefore, done.args.usdgOut, 'USDG delivered');
      assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'reserve drained');
      assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), 0n, 'USDG reserve drained');
      const s = await pub.readContract({ ...V, functionName: 'strands', args: [1n] });
      assertEq(s[2] + s[3] + s[4], 0n, 'the generation drained to zero: no dust');
      assertEq(await pub.readContract({ ...V, functionName: 'owedStrandWad', args: [DEPOSITOR.address] }), 0n, 'nothing staged');
      const sharesLeft = await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] });
      const claimable = await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
      assert(claimable > 0n, 'the shares that stayed earned the premium and the live part of the strike leg');
      await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
      );
      assertEq(await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] }), 0n, 'claimed');
      assertEq(await pub.readContract({ ...V, functionName: 'maxDeposit', args: [DEPOSITOR.address] }) > 0n, true, 'deposits are open again');
      record.cycle3.queue = { ...(record.cycle3.queue as Record<string, unknown>), completeRedeemTx: receipt.transactionHash, assetsOut: done.args.assets.toString(), usdgOut: done.args.usdgOut.toString(), strandAssets: recovered.queueAssets.toString(), strandUsdg: recovered.queueUsdg.toString() };
      record.cycle3.claimed = claimable.toString();
      record.cycle3.final = {
        totalSupply: (await pub.readContract({ ...V, functionName: 'totalSupply' })).toString(),
        idleAssets: (await pub.readContract({ ...V, functionName: 'idleAssets' })).toString(),
        depositorShares: sharesLeft.toString(),
        depositorNvda: (await balanceOf(NVDA, DEPOSITOR.address)).toString(),
      };
    });

    /* =====================================================================================
       WEEK 4: the keeper arms the following week normally
       ===================================================================================== */

    await step('week 4, tick #18 (Idle, resolved): the keeper arms the following week normally', async () => {
      const alertsBefore = alerts.received.length;
      const expected = await expectedArm();
      await roll.tick();
      const armed = await assertArmed(4, expected, record.cycle4, alertsBefore);
      assertEq(await pub.readContract({ ...V, functionName: 'strandGen' }), 1n, 'generation 1 stays resolved');
      assertEq(await pub.readContract({ ...V, functionName: 'isStranded' }), false, 'not stranded');
      note(`week 4 armed: ${armed.capacity} contracts at ${armed.unit} USDG6`);
      record.health.afterCycle4 = (await health.get('/health')).body;
      record.health.state = (await health.get('/state')).body;
      record.health.cycles = (await health.get('/cycles')).body;
    });

    /* ---------- what the keeper remembers, after a restart ---------- */

    await step('close the store, reopen the same file: every row is still there', async () => {
      assertEq(
        alerts.kinds().join(','),
        [
          'roll_open', 'listing', 'roll_close',
          'queue_settled', 'roll_open', 'listing', 'fill', 'fill', 'roll_close',
          'roll_open', 'listing', 'fill', 'roll_close', 'claim_stranded', 'strand_retry_failed', 'strand_recovered',
          'roll_open', 'listing',
        ].join(','),
        'every alert, in order, nothing else',
      );
      // newOptionType is absent for a week whose tuple an earlier run on this fork had created.
      const reused = [record.cycle1, record.cycle2, record.cycle3, record.cycle4].filter((c) => c.optionTypeReused === true).length;
      assertEq(
        txKinds().filter((t) => !t.includes(':newOptionType:')).join(','),
        [
          '1:rollOpen:success', '1:approveListing:success', '1:lockBook:success', '1:rollClose:success',
          '1:settleQueue:success', '2:rollOpen:success', '2:approveListing:success', '2:lockBook:success', '2:rollClose:success',
          '3:rollOpen:success', '3:approveListing:success', '3:lockBook:success', '3:rollClose:success', '3:retryStrandedClaim:success',
          '4:rollOpen:success', '4:approveListing:success',
        ].join(','),
        'every keeper transaction, in order',
      );
      assertEq(txKinds().filter((t) => t === '-:newOptionType:success').length, 4 - reused, `one newOptionType per week the fork had not seen (${reused} reused)`);
      assertEq(store.recentCycles(10).map((c) => `${c.cycle_number}:${c.status}`).join(','), '4:open,3:closed,2:closed,1:closed', 'cycle rows');
      assertEq(store.db.prepare('SELECT status FROM listings ORDER BY cycle_number').all().map((r) => (r as { status: string }).status).join(','), 'expired,expired,expired,approved', 'listing rows');
      const metaKeys = (store.db.prepare('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>).map((m) => m.key);
      assert(metaKeys.includes('strand_alerted:1') && metaKeys.includes('strand_retry_ms') && metaKeys.includes('clear_fees_enabled') && metaKeys.includes('last_heartbeat_ms'), `meta keys: ${metaKeys.join(',')}`);
      const before = dumpDb();
      record.blocks.lastBlock = (await pub.getBlockNumber({ cacheTime: 0 })).toString();
      record.health.final = (await health.get('/health')).body;
      stopServers();
      store.close();
      const reopened = new KeeperStore(dbPath);
      try {
        const counts = reopened.counts();
        assertEq(JSON.stringify(counts), JSON.stringify((before as { counts: unknown }).counts), 'row counts after reopen');
        assertEq(JSON.stringify(counts), JSON.stringify({ cycles: 4, listings: 4, txs: 20 - reused, alerts: 18, meta: metaKeys.length }), 'row counts after three weeks and an arm');
        const gross3 = (record.cycle3.harvest as { gross: string }).gross;
        const gross2 = (record.cycle2.harvest as { gross: string }).gross;
        assertEq(
          reopened.recentCycles(10).map((c) => `${c.cycle_number}:${c.status}:${c.gross_usdg6 ?? 'null'}`).join(','),
          `4:open:null,3:closed:${gross3},2:closed:${gross2},1:closed:0`,
          'every cycle row, with its gross, survives the reopen',
        );
        assertEq(
          reopened.db.prepare('SELECT status FROM listings ORDER BY cycle_number').all().map((r) => (r as { status: string }).status).join(','),
          'expired,expired,expired,approved',
          'every listing row survives the reopen',
        );
        note(`keeper.db rows after reopen: ${JSON.stringify(counts)}`);
      } finally {
        reopened.close();
      }
      record.db = before;
    });

    record.wallClockMs = Date.now() - startedMs;
    writeReport();
    process.stdout.write(`\nDRY RUN PASSED in ${(record.wallClockMs / 1000).toFixed(1)}s. Report: ${join(OUT, 'report.md')}\n`);
  } catch (error) {
    record.stoppedAt = currentStep();
    record.error = error instanceof Error ? error.message : String(error);
    record.wallClockMs = Date.now() - startedMs;
    try {
      record.db = dumpDb();
    } catch {
      /* the store may already be closed */
    }
    stopServers();
    writeReport();
    throw error;
  }
}

function writeReport(): void {
  writeRunFiles(OUT, 'Dry run', record, [
    ['keeperConfig', 'Keeper configuration under test'],
    ['cycle1', 'Week 1 (unfilled; queue while Listed; instant redeem and settleQueue while flat)'],
    ['cycle2', 'Week 2 (two fills of 2 + 3; a Listed deposit; queue while Listed; 2 exercised)'],
    ['cycle3', 'Week 3 (a fill, one exercised, queue while Listed; USDG freeze -> stranded -> retry -> recovered)'],
    ['cycle4', 'Week 4 (armed normally after the recovery)'],
  ]);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`\nDRY RUN FAILED at "${currentStep()}": ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`Partial report: ${join(OUT, 'report.md')}\n`);
    process.exit(1);
  });
