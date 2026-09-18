/**
 * The factory market: one AccountFactory, its WriterAccount clones, one process (Tier 1 of the
 * multi-market expansion). This is the whole keeper for every market but the closed pooled vault:
 * a factory-only process (no VAULT) runs `assertSoloWiring()` at boot and `tickSolo()` every
 * POLL_INTERVAL_MS, and nothing in roll.ts is ever entered.
 *
 * WHAT THE FACTORY NEEDS FROM A KEEPER, and nothing more (contracts/src/solo/AccountFactory.sol):
 *
 *   setWeek(strike, exerciseTs, baseExpiryTs, ask)   once a week, KEEPER_ROLE. Pins the terms
 *        every account lists on: every lot of every account sells at the SAME strike and the SAME
 *        ask this week. There is no per-account pricing and no reprice: an account's `list()`
 *        copies the week into its own storage (listedStrikeUsdg, listedAskUsdg) and a later
 *        setWeek does not move a listed lot. `askUsdg > strikeUsdg` reverts on chain.
 *   listFor(owner)                                    per pending account, KEEPER_ROLE. Calls the
 *        account's `list()`: option type on Clear, ValoremLib.open (band check at the feed's spot),
 *        one Seaport order per lot. The owner can call `list()` too; the keeper does it so a
 *        deposit made on Tuesday is on the book by Tuesday's next tick.
 *   settle()                                          per live account after its expiry, anyone.
 *
 * HOW THE WEEK IS PRICED. The factory has no vault, so there is no `spotUsdg()` view to ask and no
 * `totalAssets()` to size against. Each week is priced for ONE contract, from the same inputs the
 * accounts will check at the list and at every fill:
 *
 *   spot     feed.ts: `latestRoundData()` on PRICE_FEED, refused when older than the factory's
 *            `maxPriceAge()` at the head block's clock, normalised exactly like
 *            Policy.normalizeSpot. A stale feed is a skipped week (`stale-oracle`), as it is for
 *            the vault: the accounts' own gate would refuse the list anyway.
 *   policy   `factory.policy()` (minOtmBps, maxOtmBps, minPremiumBps, ...): the band and the
 *            premium floor are the factory's, read every tick, never hard-coded. The first factory
 *            keeper carried 40 bps in the source; an admin `setPolicy` would have silently made
 *            every fill revert PremiumBelowFloorAtFill.
 *   fixed    strike = spot × (1 + KEEPER_STRIKE_OTM_BPS/1e4) rounded DOWN to a whole USDG, and it
 *            must sit inside [spot × (1 + minOtm), spot × (1 + maxOtm)] or the week is skipped
 *            (`strike-outside-band`) before any gas is spent. Note that on a token under ~25 USDG
 *            a 5% strike rounded down lands below a 3% floor: the registry's per-market
 *            `strikeOtmBps` is where that is tuned, not here.
 *   vol      the pooled machinery (vol.ts, policy.ts), unchanged: the chain for the week's close
 *            day (roll.loadVol, throttled by VOL_MIN_REFETCH_MS), checkVolMarket, the strike at
 *            KEEPER_TARGET_DELTA (strikeForDelta) clamped into the buffered band
 *            (clampStrikeToBand), then the fair value at that strike lifted by KEEPER_PRICE_EDGE_BPS
 *            (priceListing with contracts = 1). Any `vol-*` reason SKIPS the week, alerts once,
 *            and is retried next tick; it never falls back to fixed. Nothing touches Cboe in
 *            fixed mode.
 *   ask      priceListing's answer, i.e. max(fill floor for one contract with
 *            KEEPER_PREMIUM_MARGIN_BPS, vol: fair × (1 + edge)), then lifted to
 *            KEEPER_MIN_ASK_USDG6 if that is higher (`min-ask`), then capped at the strike. The
 *            min-ask exists because the first factory keeper floored the ask at 1 USDG: on a $25
 *            token that is 4% a week, which no buyer pays; the registry sets 0.10 USDG per
 *            market and the config default stays 1 USDG so the live NVDA keeper does not change.
 *
 * WHEN. A week is set when the factory has none (`week.id == 0`) or the current one's base expiry
 * has passed (Saturday 16:00 ET); the window is calendar.nextWeekWindow with KEEPER_ARM_LEAD_S,
 * the same clock the vault uses. Between those moments every tick lists pending accounts (while
 * the week's close is still over MIN_LEAD away, otherwise their `list()` would revert) and
 * settles expired ones. Each `listFor` is SIMULATED first: the first factory keeper sent
 * `listFor(pendingAt(0))` up to 25 times a tick, so one account that could not list (idle assets
 * under a lot, writes halted) burnt 25 reverts of gas a minute. Nothing is sent while
 * `factory.writesHalted()`.
 *
 * V1 RUN-OFF (SOLO_WIND_DOWN=1, ADR-10). The factory has been frozen (guardian `setWritesHalted`,
 * admin `setDepositCap(0)`) and its listed weeks are left to expire. The tick then sends neither
 * `setWeek` nor `listFor`: a fresh week on a frozen factory is a market on /state nobody can list
 * into, and every list would revert WritesAreHalted anyway. It still settles every expired account,
 * because that is what hands an owner their collateral back, and it still raises the health alerts.
 * Once the factory has nothing live and nothing pending it says `v1_drained`, once: the fact is kept
 * in the meta table (`solo_v1_drained:<factory>`), so a restart does not say it again.
 *
 * THE SETTLE GUARD (both modes). `settle()` redeems a sold account's Valorem claim with a caught
 * call, and a redeem the token issuers refuse does not fail the settle: it zeroes `listedExpiryTs`
 * and keeps the claim for good (a second settle() reverts TooEarly; the account has no other
 * redeem). So before sending settle() for an account with `claimKey() != 0`, the keeper reads the
 * six transfer gates of ops/runbooks/v1-runoff.md step 8 (`settle_safe`) in one multicall, and holds
 * the settle while any is true or any read fails: `v1_settle_held` (warn) once per account per
 * reason, retried every tick, sent normally on the first tick they are all false again. An account
 * with `claimKey() == 0` sold nothing, has no redeem, and settles regardless. Details at
 * `readSettleSafety`.
 *
 * MEMORY. The last pricing record and the last skip reason live in the meta table
 * (`solo_last_pricing`, `solo_last_skip`, `solo_skip_reason:<exerciseTs>`), so /state shows them
 * and a restart does not re-alert a week it already reported (`solo_alerted:<exerciseTs>:<reason>`).
 * Every transaction is in the txs table under its own kind (setWeek, listFor, settle).
 *
 * THE CONTRACT CALLS ARE THE SAME as the first factory keeper's: week, setWeek, pendingCount,
 * pendingAt, listFor, liveCount, liveAt, owner, settle. What changed is where the numbers come from,
 * and the reads in front of settle (claimKey, USDG paused/isFrozen, the Stock Token's paused and
 * its registry's isBlocked).
 */
import type { Address, ContractFunctionParameters, Hash, TransactionReceipt } from 'viem';
import { clearAbi, stockRegistryAbi, stockTokenAbi, usdgGateAbi } from './abi.js';
import { alert, clearAlert } from './alerts.js';
import { describeInstant, nextWeekWindow, type WeekWindow } from './calendar.js';
import { account, publicClient, walletClient } from './clients.js';
import { BPS, USDG_ONE, config } from './config.js';
import { FeedError, readFeedSpot, type FeedSpot } from './feed.js';
import { log } from './logger.js';
import {
  DELTA_AT_STRIKE_TOLERANCE,
  clampStrikeToBand,
  priceListing,
  strikeBand,
  type NoWrite,
  type PolicyParams,
  type PricingMode,
  type PricingRecord,
  type StrikeContext,
} from './policy.js';
import { describeError, formatEth, formatUsdg, loadVol, revertName } from './roll.js';
import { bigintReplacer, store, type TxKind } from './state.js';
import { checkVolMarket, strikeForDelta, type DeltaStrike, type VolContext, type VolSettings } from './vol.js';

/*//////////////////////////////////////////////////////////////
                              ABI
//////////////////////////////////////////////////////////////*/

/** The factory surface the keeper reads and writes. Hand-written, like solo.ts always was; the
 *  full artifact is ops/abis/AccountFactory.json. */
export const factoryAbi = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'usdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'clear', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'seaport', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'priceFeed', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'conduitKey', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'KEEPER_ROLE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'policy',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'minOtmBps', type: 'uint16' },
      { name: 'maxOtmBps', type: 'uint16' },
      { name: 'minPremiumBps', type: 'uint16' },
      { name: 'maxUtilizationBps', type: 'uint16' },
      { name: 'protocolFeeBps', type: 'uint16' },
      { name: 'maxContractsCap', type: 'uint64' },
    ],
  },
  { type: 'function', name: 'maxPriceAge', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'writesHalted', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'depositCap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pendingCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pendingAt', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'liveCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'liveAt', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'listFor', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  {
    type: 'function',
    name: 'week',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'id', type: 'uint32' },
      { name: 'strikeUsdg', type: 'uint256' },
      { name: 'exerciseTs', type: 'uint40' },
      { name: 'baseExpiryTs', type: 'uint40' },
      { name: 'askUsdg', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'setWeek',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strikeUsdg', type: 'uint256' },
      { name: 'exerciseTs', type: 'uint40' },
      { name: 'baseExpiryTs', type: 'uint40' },
      { name: 'askUsdg', type: 'uint256' },
    ],
    outputs: [],
  },
  { type: 'error', name: 'BadWeek', inputs: [] },
  { type: 'error', name: 'AskAboveStrike', inputs: [{ name: 'ask', type: 'uint256' }, { name: 'strike', type: 'uint256' }] },
  { type: 'error', name: 'NoAccount', inputs: [] },
  { type: 'error', name: 'AccessControlUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }, { name: 'neededRole', type: 'bytes32' }] },
] as const;

/** The WriterAccount surface the keeper touches, plus the reverts `list()` and `settle()` raise
 *  so a skipped account is logged by name rather than by selector. */
export const accountAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'requestedLots', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'listedLots', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'listedExpiryTs', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint40' }] },
  { type: 'function', name: 'claimKey', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'error', name: 'NotAuthorized', inputs: [] },
  { type: 'error', name: 'NoWeek', inputs: [] },
  { type: 'error', name: 'WritesAreHalted', inputs: [] },
  { type: 'error', name: 'AlreadyListed', inputs: [] },
  { type: 'error', name: 'StillOpen', inputs: [] },
  { type: 'error', name: 'NothingToList', inputs: [] },
  { type: 'error', name: 'TooManyLots', inputs: [] },
  { type: 'error', name: 'InsufficientIdle', inputs: [] },
  { type: 'error', name: 'BadLot', inputs: [] },
  { type: 'error', name: 'TooEarly', inputs: [] },
] as const;

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

/** `factory.week()`. `id == 0` means no week has ever been set. */
export interface SoloWeek {
  id: number;
  strikeUsdg6: bigint;
  exerciseTs: number;
  baseExpiryTs: number;
  askUsdg6: bigint;
}

/** Everything a tick reads from chain before it decides anything; /health and /state serve the
 *  last one. The factory analogue of roll.ChainSnapshot, and much shorter: a factory has no phase,
 *  no cycle and no book of its own. */
export interface SoloSnapshot {
  at: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /** Head-block lag against the wall clock, in seconds. */
  rpcLagSeconds: number;
  keeperBalanceWei: bigint;
  hasKeeperRole: boolean;
  week: SoloWeek;
  pendingCount: number;
  liveCount: number;
  writesHalted: boolean;
  policy: PolicyParams;
  /** `factory.maxPriceAge()`, the feed staleness limit every list and fill applies. */
  maxPriceAge: number;
  feesEnabled: boolean;
  feeBps: number;
  /** The feed at this block, or null with the reason it could not be priced on. */
  spot: FeedSpot | null;
  spotError: string | null;
}

let lastSnapshot: SoloSnapshot | null = null;

export function getSoloSnapshot(): SoloSnapshot | null {
  return lastSnapshot;
}

/** Set when a solo tick begins, cleared in its finally; /health reads it exactly as it reads
 *  roll.getTickStartedAt, so a listFor waiting on its receipt is not mistaken for a wedged loop. */
let tickStartedAt: number | null = null;

export function getSoloTickStartedAt(): number | null {
  return tickStartedAt;
}

/** The most listFor transactions one tick sends. The first factory keeper's cap, kept: a burst of
 *  deposits is listed over a few ticks rather than in one long-running one. */
export const MAX_LISTS_PER_TICK = 25;

/** The most settle transactions one tick sends. */
export const MAX_SETTLES_PER_TICK = 50;

/** ValoremLib.MIN_LEAD: `list()` reverts ExerciseTooSoon inside the last hour before the close. */
const MIN_LEAD_S = 3_600;

const LAST_PRICING_KEY = 'solo_last_pricing';
const LAST_SKIP_KEY = 'solo_last_skip';
const SKIP_REASON_KEY = (exerciseTs: number) => `solo_skip_reason:${exerciseTs}`;
const ALERTED_KEY = (exerciseTs: number, reason: string) => `solo_alerted:${exerciseTs}:${reason}`;
const WEEK_TARGET_KEY = 'solo_week_target_ts';
const WEEK_SET_KEY = 'solo_week_set_ts';
/** Keyed by factory, so a database that outlives its factory cannot silence the next one. */
const DRAINED_KEY = (factory: Address) => `solo_v1_drained:${factory.toLowerCase()}`;

/*//////////////////////////////////////////////////////////////
                            SNAPSHOT
//////////////////////////////////////////////////////////////*/

function factoryAddress(): Address {
  if (config.FACTORY === undefined) throw new Error('FACTORY is not configured');
  return config.FACTORY;
}

export async function soloSnapshot(): Promise<SoloSnapshot> {
  const factory = factoryAddress();
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const [week, pendingCount, liveCount, writesHalted, policyRaw, maxPriceAge, keeperRole, feesEnabled, feeBps, keeperBalanceWei] =
    await Promise.all([
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'week' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'pendingCount' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'liveCount' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'writesHalted' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'policy' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'maxPriceAge' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'KEEPER_ROLE' }),
      publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feesEnabled' }),
      publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feeBps' }),
      publicClient.getBalance({ address: account.address }),
    ]);
  const hasKeeperRole = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'hasRole',
    args: [keeperRole, account.address],
  });
  const policy = policyFromTuple(policyRaw);
  const spot = await readSpot(Number(maxPriceAge), Number(block.timestamp));

  const snap: SoloSnapshot = {
    at: Date.now(),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    rpcLagSeconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(block.timestamp)),
    keeperBalanceWei,
    hasKeeperRole,
    week: { id: week[0], strikeUsdg6: week[1], exerciseTs: Number(week[2]), baseExpiryTs: Number(week[3]), askUsdg6: week[4] },
    pendingCount: Number(pendingCount),
    liveCount: Number(liveCount),
    writesHalted,
    policy,
    maxPriceAge: Number(maxPriceAge),
    feesEnabled,
    feeBps: Number(feeBps),
    spot: spot.value,
    spotError: spot.error,
  };
  lastSnapshot = snap;
  return snap;
}

/** `factory.policy()` as PolicyParams; exported for the quote CLI. */
export function policyFromTuple(raw: readonly [number, number, number, number, number, bigint]): PolicyParams {
  return {
    minOtmBps: BigInt(raw[0]),
    maxOtmBps: BigInt(raw[1]),
    minPremiumBps: BigInt(raw[2]),
    maxUtilizationBps: BigInt(raw[3]),
    protocolFeeBps: BigInt(raw[4]),
    maxContractsCap: BigInt(raw[5]),
  };
}

/** A refused feed (stale, zero) is a fact of the snapshot, like `spotUsdg()` reverting on the
 *  vault: the accounts' own gate would refuse the same list. An RPC failure is not: it propagates
 *  and the tick is retried, because the block read that preceded it succeeded on the same client. */
async function readSpot(maxPriceAge: number, nowSeconds: number): Promise<{ value: FeedSpot | null; error: string | null }> {
  try {
    return { value: await readFeedSpot(config.PRICE_FEED, maxPriceAge, nowSeconds), error: null };
  } catch (error) {
    if (error instanceof FeedError) return { value: null, error: error.message };
    throw error;
  }
}

/*//////////////////////////////////////////////////////////////
                          BOOT WIRING
//////////////////////////////////////////////////////////////*/

/**
 * Refuse to run against a factory that is not the one this config describes: `asset`, `priceFeed`,
 * `usdg`, `clear` and `seaport` must all match the environment. The feed matters most here: the
 * keeper prices every week from PRICE_FEED, and the accounts check every list and fill against
 * `factory.priceFeed()`; a keeper pricing NVDA weeks on TSLA's feed would set a strike outside the
 * band at every arm. A mismatch exits 1 with the list, like roll.assertWiring. A missing
 * KEEPER_ROLE is an alert, not an exit: settle() is permissionless, so the process is still useful.
 */
export async function assertSoloWiring(): Promise<void> {
  const factory = factoryAddress();
  const [asset, priceFeed, usdg, clear, seaport, keeperRole] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'asset' }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'priceFeed' }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'usdg' }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'clear' }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'seaport' }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'KEEPER_ROLE' }),
  ]);

  const mismatches: string[] = [];
  const check = (name: string, onChain: string, configured: string) => {
    if (onChain.toLowerCase() !== configured.toLowerCase()) {
      mismatches.push(`${name}: factory says ${onChain}, config says ${configured}`);
    }
  };
  check('asset (ASSET)', asset, config.ASSET);
  check('priceFeed (PRICE_FEED)', priceFeed, config.PRICE_FEED);
  check('usdg (USDG)', usdg, config.USDG);
  check('clear (CLEARINGHOUSE)', clear, config.CLEARINGHOUSE);
  check('seaport (SEAPORT)', seaport, config.SEAPORT);
  if (mismatches.length > 0) {
    throw new Error(
      `Keeper config does not match the deployed factory at ${factory} (market ${config.KEEPER_MARKET}):\n  ${mismatches.join('\n  ')}\n` +
        'Fix the environment (ops/keeper-env.sh renders it from the registry). A week priced on the wrong feed is refused by every account.',
    );
  }

  const hasRole = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'hasRole',
    args: [keeperRole, account.address],
  });
  if (!hasRole) {
    await alert(
      'keeper_role',
      `keeper ${account.address} does not hold KEEPER_ROLE on ${config.KEEPER_MARKET} factory ${factory}; it can settle but not setWeek or listFor`,
      { keeper: account.address, factory },
      { force: true },
    );
  }
  log.boot.info({ factory, market: config.KEEPER_MARKET, priceFeed, asset, hasKeeperRole: hasRole }, 'factory wiring verified');
}

/*//////////////////////////////////////////////////////////////
                          THE DECISION
//////////////////////////////////////////////////////////////*/

export interface SoloPlanInput {
  /** `factory.policy()`. */
  policy: PolicyParams;
  /** feed.ts's spot for one lot, USDG base units. */
  spotUsdg6: bigint;
  feesEnabled: boolean;
  feeBps: number | bigint;
  /** The pre-fetched chain (vol mode). Absent in vol mode is `vol-unavailable`, never fixed. */
  vol?: VolContext | null;
  /** SEAMS for tests: each stands in for its KEEPER_* key; `undefined` reads the environment. */
  pricingMode?: PricingMode;
  strikeOtmBps?: number;
  premiumMarginBps?: number;
  minAskUsdg6?: bigint;
  targetDelta?: number;
  priceEdgeBps?: number;
  strikeBandBufferBps?: number;
  volMaxAgeS?: number;
  volMaxSpotDivergenceBps?: number;
  /** `undefined` reads KEEPER_UNIT_PRICE_USDG6, `null` is "no override". */
  unitPriceOverride6?: bigint | null;
}

export interface SoloWeekPlan {
  ok: true;
  strikeUsdg6: bigint;
  askUsdg6: bigint;
  /** True when KEEPER_MIN_ASK_USDG6 sat above the strike and the ask was capped at it. */
  cappedAtStrike: boolean;
  bandLowUsdg6: bigint;
  bandHighUsdg6: bigint;
  /** The same record policy.ts writes for a vault listing, for /state and the alert. */
  pricing: PricingRecord;
}

export type SoloPlanResult = SoloWeekPlan | NoWrite;

/** fixed mode: spot lifted by `otmBps`, rounded DOWN to a whole USDG. Down, not half up as the
 *  vault's targetStrike6: a factory week is one strike for every account all week, and the lower
 *  whole dollar is the one a buyer sees quoted. The band check is the caller's. */
export function fixedStrikeDown6(spotUsdg6: bigint, otmBps: number | bigint): bigint {
  return ((spotUsdg6 * (BPS + BigInt(otmBps))) / BPS / USDG_ONE) * USDG_ONE;
}

/**
 * The week's strike and ask, or a named refusal. Pure: the chain reads are in the snapshot and the
 * chain fetch in `loadVol`, so the quote CLI and the tests drive this with the same inputs.
 *
 *   1. strike: fixed, spot + KEEPER_STRIKE_OTM_BPS rounded down to a whole USDG, inside the band;
 *      vol, the KEEPER_TARGET_DELTA strike clamped into the buffered band (as planWeek).
 *   2. ask: policy.priceListing for ONE contract on the factory's policy: the fill floor with the
 *      margin, lifted in vol mode to the fair value with the edge (fresh data only; the arm has no
 *      previous listing to fall back on), never above the strike (`premium-above-strike` skips).
 *   3. KEEPER_MIN_ASK_USDG6: the ask is lifted to it if lower (`min-ask`), then capped at the
 *      strike, because `setWeek` reverts AskAboveStrike and a 1 USDG floor on a sub-dollar token
 *      is exactly that case.
 */
export function planSoloWeek(input: SoloPlanInput): SoloPlanResult {
  const { policy, spotUsdg6 } = input;
  if (spotUsdg6 === 0n) return { ok: false, reason: 'spot-zero', detail: {} };
  const mode = input.pricingMode ?? config.KEEPER_PRICING_MODE;
  const { lo, hi } = strikeBand(spotUsdg6, policy);

  let strikeUsdg6: bigint;
  let strikeContext: StrikeContext | undefined;

  if (mode === 'fixed') {
    const otmBps = input.strikeOtmBps ?? config.KEEPER_STRIKE_OTM_BPS;
    strikeUsdg6 = fixedStrikeDown6(spotUsdg6, otmBps);
    if (strikeUsdg6 === 0n || strikeUsdg6 < lo || strikeUsdg6 > hi) {
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: {
          strikeUsdg6: strikeUsdg6.toString(),
          spotUsdg6: spotUsdg6.toString(),
          bandLowUsdg6: lo.toString(),
          bandHighUsdg6: hi.toString(),
          strikeOtmBps: String(otmBps),
          minOtmBps: policy.minOtmBps.toString(),
          maxOtmBps: policy.maxOtmBps.toString(),
          why: 'spot + KEEPER_STRIKE_OTM_BPS rounded down to a whole USDG is outside the factory band',
        },
      };
    }
  } else {
    const targetDelta = input.targetDelta ?? config.KEEPER_TARGET_DELTA;
    let picked: DeltaStrike;
    try {
      const market = checkVolMarket(input.vol, spotUsdg6, volSettings(input));
      if (!market.ok) return market;
      picked = strikeForDelta(market.quotes, targetDelta, market.ratio);
      if (!picked.ok) return { ok: false, reason: picked.reason, detail: { ...picked.detail, expiry: market.expiry } };
    } catch (error) {
      // Nothing in the chain may throw a tick: any surprise in untrusted data is a skipped week.
      const message = error instanceof Error ? error.message : String(error);
      log.solo.warn({ err: message }, 'market data threw while pricing; treating it as inconsistent');
      return { ok: false, reason: 'vol-inconsistent', detail: { why: 'the market data could not be evaluated', error: message.slice(0, 200) } };
    }
    const bufferBps = input.strikeBandBufferBps ?? config.KEEPER_STRIKE_BAND_BUFFER_BPS;
    const clamp = clampStrikeToBand(picked.strikeUsdg6, spotUsdg6, policy, bufferBps);
    if (!clamp.ok) {
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: {
          deltaStrikeUsdg6: picked.strikeUsdg6.toString(),
          spotUsdg6: spotUsdg6.toString(),
          bandLowUsdg6: lo.toString(),
          bandHighUsdg6: hi.toString(),
          bandBufferBps: String(bufferBps),
          why: 'the buffered band holds no whole USDG',
        },
      };
    }
    strikeUsdg6 = clamp.strikeUsdg6;
    if (strikeUsdg6 < lo || strikeUsdg6 > hi) {
      // Unreachable by construction of the clamp; checked rather than assumed, as the list gate is.
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: { strikeUsdg6: strikeUsdg6.toString(), bandLowUsdg6: lo.toString(), bandHighUsdg6: hi.toString(), spotUsdg6: spotUsdg6.toString() },
      };
    }
    strikeContext = { targetDelta, deltaStrikeUsdg6: picked.strikeUsdg6.toString(), strikeClamped: clamp.clamped, bandBufferBps: bufferBps };
  }

  const priced = priceListing({
    policy,
    spotUsdg6,
    strikeUsdg6,
    contracts: 1n,
    feesEnabled: input.feesEnabled,
    feeBps: input.feeBps,
    premiumMarginBps: input.premiumMarginBps,
    unitPriceOverride6: input.unitPriceOverride6,
    vol: input.vol,
    previousFairUnit6: null,
    strikeContext,
    pricingMode: mode,
    targetDelta: input.targetDelta,
    priceEdgeBps: input.priceEdgeBps,
    volMaxAgeS: input.volMaxAgeS,
    volMaxSpotDivergenceBps: input.volMaxSpotDivergenceBps,
  });
  if (!priced.ok) return priced;

  if (mode === 'vol') {
    const { deltaAtStrike, targetDelta } = priced.pricing;
    if (priced.pricing.volPath !== 'fresh') {
      return { ok: false, reason: 'vol-unavailable', detail: { why: 'the week must be priced on fresh market data' } };
    }
    if (
      priced.pricing.strikeClamped === null &&
      deltaAtStrike !== null &&
      targetDelta !== null &&
      !(Math.abs(deltaAtStrike - targetDelta) <= DELTA_AT_STRIKE_TOLERANCE)
    ) {
      return {
        ok: false,
        reason: 'vol-inconsistent',
        detail: {
          why: 'the delta at the chosen strike is far from the target',
          strikeUsdg6: strikeUsdg6.toString(),
          deltaAtStrike: String(deltaAtStrike),
          targetDelta: String(targetDelta),
          tolerance: String(DELTA_AT_STRIKE_TOLERANCE),
        },
      };
    }
  }

  // The market floor, and the one cap the factory enforces (AskAboveStrike).
  let askUsdg6 = priced.unitPrice6;
  const pricing: PricingRecord = { ...priced.pricing };
  const minAsk = input.minAskUsdg6 ?? config.KEEPER_MIN_ASK_USDG6;
  if (minAsk > askUsdg6) {
    askUsdg6 = minAsk;
    pricing.priceSource = 'min-ask';
  }
  let cappedAtStrike = false;
  if (askUsdg6 > strikeUsdg6) {
    askUsdg6 = strikeUsdg6;
    cappedAtStrike = true;
  }
  pricing.unitPrice6 = askUsdg6.toString();

  log.solo.info(
    {
      mode,
      strikeUsdg6: strikeUsdg6.toString(),
      askUsdg6: askUsdg6.toString(),
      priceSource: pricing.priceSource,
      floorUnit6: pricing.floorUnit6,
      marginUnit6: pricing.marginUnit6,
      minAskUsdg6: minAsk.toString(),
      fairUnit6: pricing.fairUnit6,
      deltaAtStrike: pricing.deltaAtStrike,
      strikeClamped: pricing.strikeClamped,
      cappedAtStrike,
      bandLowUsdg6: lo.toString(),
      bandHighUsdg6: hi.toString(),
      spotUsdg6: spotUsdg6.toString(),
    },
    'planned the factory week',
  );
  return { ok: true, strikeUsdg6, askUsdg6, cappedAtStrike, bandLowUsdg6: lo, bandHighUsdg6: hi, pricing };
}

function volSettings(input: { volMaxAgeS?: number; volMaxSpotDivergenceBps?: number }): VolSettings {
  return {
    maxAgeS: input.volMaxAgeS ?? config.KEEPER_VOL_MAX_AGE_S,
    maxDivergenceBps: input.volMaxSpotDivergenceBps ?? config.KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS,
    expectedRoot: config.KEEPER_VOL_ROOT,
    holidays: config.KEEPER_NYSE_HOLIDAYS,
  };
}

/*//////////////////////////////////////////////////////////////
                            THE WEEK
//////////////////////////////////////////////////////////////*/

/** The week the keeper would set next, from the head block's clock. Exported for /state. */
export function nextSoloWindow(snap: Pick<SoloSnapshot, 'blockTimestamp'>): WeekWindow {
  return nextWeekWindow(Number(snap.blockTimestamp), config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
}

/** Is the factory's current week still the one accounts should list on? */
export function weekIsCurrent(week: SoloWeek, nowSeconds: number): boolean {
  return week.id !== 0 && nowSeconds < week.baseExpiryTs;
}

async function ensureWeek(snap: SoloSnapshot): Promise<void> {
  const factory = factoryAddress();
  const now = Number(snap.blockTimestamp);
  if (weekIsCurrent(snap.week, now)) return;

  const window = nextSoloWindow(snap);
  await noteWeekRollover(window);
  if (snap.week.id !== 0 && snap.week.exerciseTs === window.exerciseTs) return; // already this window
  if (!snap.hasKeeperRole) {
    // setWeek is onlyRole(KEEPER_ROLE); the boot alert already said so. Nothing to simulate.
    await rememberSkip(window, 'no-keeper-role', { keeper: account.address });
    return;
  }
  if (snap.spot === null) {
    await rememberSkip(window, snap.spotError?.startsWith('stale') ? 'stale-oracle' : 'spot-unavailable', { error: snap.spotError ?? 'unknown' });
    return;
  }

  // vol mode fetches the chain once per decision (throttled inside loadVol); fixed mode never does.
  const vol = config.KEEPER_PRICING_MODE === 'vol' ? await loadVol(window.closeDay, now) : null;
  const plan = planSoloWeek({ policy: snap.policy, spotUsdg6: snap.spot.spotUsdg6, feesEnabled: snap.feesEnabled, feeBps: snap.feeBps, vol });
  if (!plan.ok) {
    await rememberSkip(window, plan.reason, plan.detail);
    return;
  }

  const args = [plan.strikeUsdg6, window.exerciseTs, window.expiryTs, plan.askUsdg6] as const;
  let sim;
  try {
    sim = await publicClient.simulateContract({ address: factory, abi: factoryAbi, functionName: 'setWeek', args, account });
  } catch (error) {
    const reason = describeError(error);
    await alert('tx_revert', `setWeek would revert: ${reason}`, { kind: 'setWeek', reason }, { dedupeKey: 'setWeek' });
    log.solo.error({ reason }, 'setWeek simulation reverted; not sending');
    await rememberSkip(window, 'setweek-reverts', { error: reason.slice(0, 200) });
    return;
  }
  const receipt = await sendAndConfirm('setWeek', () => walletClient.writeContract(sim.request));
  if (receipt === null) return;

  const record = {
    weekId: snap.week.id + 1,
    exerciseTs: window.exerciseTs,
    expiryTs: window.expiryTs,
    friday: window.friday,
    closeDay: window.closeDay,
    strikeUsdg6: plan.strikeUsdg6.toString(),
    askUsdg6: plan.askUsdg6.toString(),
    cappedAtStrike: plan.cappedAtStrike,
    pricing: plan.pricing,
    tx: receipt.transactionHash,
    block: receipt.blockNumber.toString(),
    at: new Date().toISOString(),
  };
  store.setMeta(LAST_PRICING_KEY, JSON.stringify(record, bigintReplacer));
  store.setMeta(WEEK_SET_KEY, String(window.exerciseTs));
  store.setMeta(LAST_SKIP_KEY, JSON.stringify({ exerciseTs: window.exerciseTs, reason: null, at: new Date().toISOString() }));
  await alert(
    'week_set',
    `${config.KEEPER_MARKET} week of ${window.friday}: strike ${formatUsdg(plan.strikeUsdg6)} USDG, ask ${formatUsdg(plan.askUsdg6)} USDG per lot (${pricingPhrase(plan.pricing)}); close ${describeInstant(window.exerciseTs)}`,
    { ...record, pricing: pricingSummary(plan.pricing) },
    { force: true },
  );
}

/** Persist a refusal and alert it once per (week, reason), across restarts. */
async function rememberSkip(window: WeekWindow, reason: string, detail: Record<string, string>): Promise<void> {
  store.setMeta(SKIP_REASON_KEY(window.exerciseTs), reason);
  store.setMeta(
    LAST_SKIP_KEY,
    JSON.stringify({ exerciseTs: window.exerciseTs, closeDay: window.closeDay, friday: window.friday, reason, detail, at: new Date().toISOString() }),
  );
  log.solo.warn({ exerciseTs: window.exerciseTs, closeDay: window.closeDay, reason, ...detail }, 'not setting the week');
  const alertedKey = ALERTED_KEY(window.exerciseTs, reason);
  if (store.getMeta(alertedKey) !== null) return;
  // Marked only once the alert is out (or logged with no webhook): a failed delivery is retried
  // on the alert module's own five-minute clock, not forgotten because the marker was written.
  const delivered = await alert(
    'cycle_not_created',
    `${config.KEEPER_MARKET} week of ${window.friday}: not setting the factory week (${reason}); retried every tick`,
    { exerciseTs: window.exerciseTs, closeDay: window.closeDay, reason, ...detail },
    { dedupeKey: `${window.exerciseTs}:${reason}` },
  );
  if (delivered) store.setMeta(alertedKey, new Date().toISOString());
}

/** A Friday went by without a week being set for it: said once, when the target moves on. */
async function noteWeekRollover(window: WeekWindow): Promise<void> {
  const previous = store.getMetaNumber(WEEK_TARGET_KEY);
  if (previous !== null && previous < window.exerciseTs && store.getMetaNumber(WEEK_SET_KEY) !== previous) {
    const reason = store.getMeta(SKIP_REASON_KEY(previous)) ?? 'unknown';
    await alert(
      'cycle_not_created',
      `${config.KEEPER_MARKET}: the week closing ${describeInstant(previous)} passed without a factory week (${reason}).`,
      { exerciseTs: previous, reason },
      { dedupeKey: String(previous), force: true },
    );
  }
  if (previous !== window.exerciseTs) store.setMeta(WEEK_TARGET_KEY, String(window.exerciseTs));
}

/*//////////////////////////////////////////////////////////////
                         LIST AND SETTLE
//////////////////////////////////////////////////////////////*/

let haltLogged = false;

/**
 * `listFor` every pending account, at most MAX_LISTS_PER_TICK a tick, each simulated first. The
 * addresses are read BEFORE any transaction: `_pending` is swap-removed as each account lists, so
 * walking it by index while it shrinks skips every other account.
 */
async function listPending(snap: SoloSnapshot): Promise<void> {
  if (snap.pendingCount === 0) return;
  const factory = factoryAddress();
  if (snap.writesHalted) {
    if (!haltLogged) {
      log.solo.warn({ pending: snap.pendingCount }, 'factory.writesHalted(): not listing anything until the guardian lifts it');
      haltLogged = true;
    }
    return;
  }
  haltLogged = false;
  if (!snap.hasKeeperRole) return; // listFor is onlyRole(KEEPER_ROLE): every simulation would revert
  if (snap.week.id === 0) return; // NoWeek
  const now = Number(snap.blockTimestamp);
  if (now + MIN_LEAD_S >= snap.week.exerciseTs) {
    log.solo.debug({ pending: snap.pendingCount, exerciseTs: snap.week.exerciseTs }, 'inside MIN_LEAD of the close; pending accounts wait for the next week');
    return;
  }

  const count = Math.min(snap.pendingCount, MAX_LISTS_PER_TICK);
  const writers = await Promise.all(
    Array.from({ length: count }, (_, i) => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'pendingAt', args: [BigInt(i)] })),
  );
  for (const writer of writers) {
    const owner = await publicClient.readContract({ address: writer, abi: accountAbi, functionName: 'owner' });
    let sim;
    try {
      sim = await publicClient.simulateContract({ address: factory, abi: factoryAbi, functionName: 'listFor', args: [owner], account });
    } catch (error) {
      // Not an alert: an account that cannot list this tick (InsufficientIdle after a withdrawal,
      // a lot request its balance no longer covers) is its owner's to fix, and the next tick asks
      // again. The first factory keeper sent these anyway and paid for each revert.
      log.solo.info({ writer, owner, revert: revertName(error) ?? describeError(error).slice(0, 160) }, 'listFor would revert; skipped this tick');
      continue;
    }
    const receipt = await sendAndConfirm('listFor', () => walletClient.writeContract(sim.request), { writer, owner });
    if (receipt !== null) log.solo.info({ writer, owner, tx: receipt.transactionHash, weekId: snap.week.id }, 'listed');
  }
}

/** `settle()` every live account whose pinned expiry has passed, simulated first (TooEarly is the
 *  usual answer six days out of seven), and never while the settle guard holds it. Addresses are
 *  read before any send: `_live` is swap-removed on settle, like `_pending` on list. */
async function settleExpired(snap: SoloSnapshot): Promise<void> {
  if (snap.liveCount === 0) {
    dropGoneHolds([]);
    return;
  }
  const factory = factoryAddress();
  const now = Number(snap.blockTimestamp);
  const writers = await Promise.all(
    Array.from({ length: snap.liveCount }, (_, i) => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'liveAt', args: [BigInt(i)] })),
  );
  dropGoneHolds(writers);
  let sent = 0;
  /** Resolved at the first account that is due, once per tick; null when the read failed. */
  let registry: Address | null | undefined;
  for (const writer of writers) {
    if (sent >= MAX_SETTLES_PER_TICK) break;
    const expiry = Number(await publicClient.readContract({ address: writer, abi: accountAbi, functionName: 'listedExpiryTs' }));
    if (expiry === 0 || now < expiry) continue; // TooEarly, without the simulation
    if (registry === undefined) registry = await readStockRegistry();
    const safety = await readSettleSafety(writer, registry);
    if (safety.hold.length > 0) {
      await holdSettle(writer, expiry, safety);
      continue; // nothing simulated, nothing sent
    }
    releaseHold(writer, safety);
    let sim;
    try {
      sim = await publicClient.simulateContract({ address: writer, abi: accountAbi, functionName: 'settle', account });
    } catch (error) {
      log.solo.info({ writer, revert: revertName(error) ?? describeError(error).slice(0, 160) }, 'settle would revert; skipped this tick');
      continue;
    }
    sent += 1;
    const receipt = await sendAndConfirm('settle', () => walletClient.writeContract(sim.request), { writer });
    if (receipt !== null) log.solo.info({ writer, tx: receipt.transactionHash }, 'settled');
  }
}

/*//////////////////////////////////////////////////////////////
                         THE SETTLE GUARD
//////////////////////////////////////////////////////////////*/

/**
 * One gate `settle()`'s Valorem redeem needs open. The redeem moves USDG and the Stock Token from
 * the Clear to the account, so it reverts while any of these is true, and a reverted redeem inside
 * settle() strands the claim (callhouse-contracts docs/V1-RUNOFF.md). The same six reads, in the
 * same order and under the same labels, as `settle_safe` in ops/runbooks/v1-runoff.md step 8:
 *
 *   USDG.paused             usdg_paused           USDG `paused()`
 *   USDG.isFrozen(account)  usdg_frozen           USDG `isFrozen(account)`
 *   USDG.isFrozen(Clear)    clear_usdg_frozen     USDG `isFrozen(CLEARINGHOUSE)`
 *   ASSET.paused            asset_paused          Stock Token `paused()` (its own pause or its registry's)
 *   isBlocked(account)      asset_blocked         registry `isBlocked(account)`
 *   isBlocked(Clear)        clear_asset_blocked   registry `isBlocked(CLEARINGHOUSE)`
 *
 * The registry is `ASSET.ACCESS_CONTROLLED_REGISTRY()`, the address the token itself asks: on
 * NVDA the beacon in its EIP-1967 slot, which is how the runbook finds `STOCK_REG` (0xe10b…2b00).
 */
const SETTLE_GATES = [
  { read: 'USDG.paused', reason: 'usdg_paused' },
  { read: 'USDG.isFrozen(account)', reason: 'usdg_frozen' },
  { read: 'USDG.isFrozen(Clear)', reason: 'clear_usdg_frozen' },
  { read: 'ASSET.paused', reason: 'asset_paused' },
  { read: 'isBlocked(account)', reason: 'asset_blocked' },
  { read: 'isBlocked(Clear)', reason: 'clear_asset_blocked' },
] as const;

export type SettleGateRead = (typeof SETTLE_GATES)[number]['read'];
/** A gate that is shut, or `read_failed`: a read that did not answer counts as shut, never as open. */
export type SettleHoldReason = (typeof SETTLE_GATES)[number]['reason'] | 'read_failed';

export interface SettleSafety {
  /** `account.claimKey()`; null when it did not answer. */
  claimKey: bigint | null;
  /** Each gate by its runbook label: true (shut), false (open), null (the read failed). */
  gates: Record<SettleGateRead, boolean | null>;
  /** The reads that did not answer, by label (`claimKey` and `ACCESS_CONTROLLED_REGISTRY` included). */
  failedReads: string[];
  /** Why settle() is held, in gate order with `read_failed` last. Empty: send it. Always empty when
   *  `claimKey == 0`: nothing was sold, so there is no redeem to fail. */
  hold: SettleHoldReason[];
}

/** `ASSET.ACCESS_CONTROLLED_REGISTRY()`, or null when it did not answer (the blocklist reads then
 *  count as failed for every sold account due this tick). */
async function readStockRegistry(): Promise<Address | null> {
  try {
    return await publicClient.readContract({ address: config.ASSET, abi: stockTokenAbi, functionName: 'ACCESS_CONTROLLED_REGISTRY' });
  } catch (error) {
    log.solo.warn({ asset: config.ASSET, err: describeError(error).slice(0, 160) }, 'ACCESS_CONTROLLED_REGISTRY() did not answer; the blocklist reads count as failed this tick');
    return null;
  }
}

type MulticallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

/**
 * `claimKey()` and the six gates for one account, in ONE multicall (allowFailure: a gate that
 * reverts or returns nothing is a failed read, not an open gate; a multicall that throws fails
 * every read). Exported for the tests.
 */
export async function readSettleSafety(writer: Address, registry: Address | null): Promise<SettleSafety> {
  const clear = config.CLEARINGHOUSE;
  const contracts: ContractFunctionParameters[] = [
    { address: writer, abi: accountAbi, functionName: 'claimKey' },
    { address: config.USDG, abi: usdgGateAbi, functionName: 'paused' },
    { address: config.USDG, abi: usdgGateAbi, functionName: 'isFrozen', args: [writer] },
    { address: config.USDG, abi: usdgGateAbi, functionName: 'isFrozen', args: [clear] },
    { address: config.ASSET, abi: stockTokenAbi, functionName: 'paused' },
  ];
  if (registry !== null) {
    contracts.push(
      { address: registry, abi: stockRegistryAbi, functionName: 'isBlocked', args: [writer] },
      { address: registry, abi: stockRegistryAbi, functionName: 'isBlocked', args: [clear] },
    );
  }

  let results: readonly MulticallResult[] = [];
  try {
    results = (await publicClient.multicall({ contracts, allowFailure: true })) as readonly MulticallResult[];
  } catch (error) {
    log.solo.debug({ writer, err: describeError(error).slice(0, 160) }, 'settle guard multicall failed; every read counts as failed');
  }
  const value = (i: number): unknown => {
    const r = results[i];
    return r !== undefined && r.status === 'success' ? r.result : undefined;
  };
  const flag = (i: number): boolean | null => {
    const v = value(i);
    return typeof v === 'boolean' ? v : null;
  };

  const rawKey = value(0);
  const claimKey = typeof rawKey === 'bigint' ? rawKey : null;
  const gates: Record<SettleGateRead, boolean | null> = {
    'USDG.paused': flag(1),
    'USDG.isFrozen(account)': flag(2),
    'USDG.isFrozen(Clear)': flag(3),
    'ASSET.paused': flag(4),
    'isBlocked(account)': registry === null ? null : flag(5),
    'isBlocked(Clear)': registry === null ? null : flag(6),
  };
  const failedReads: string[] = [];
  if (claimKey === null) failedReads.push('claimKey');
  if (registry === null) failedReads.push('ACCESS_CONTROLLED_REGISTRY');
  for (const g of SETTLE_GATES) if (gates[g.read] === null) failedReads.push(g.read);

  const hold: SettleHoldReason[] = [];
  if (claimKey !== 0n) {
    for (const g of SETTLE_GATES) if (gates[g.read] === true) hold.push(g.reason);
    if (failedReads.length > 0) hold.push('read_failed');
  }
  return { claimKey, gates, failedReads, hold };
}

interface SettleHold {
  account: Address;
  /** When this process first held it. */
  since: string;
  claimKey: string | null;
  listedExpiryTs: number;
  /** The reasons holding it now, each with whether its alert went out. */
  reasons: Map<SettleHoldReason, boolean>;
}

/** Held accounts, by lowercased address. In memory: a restart re-reads every gate and says each
 *  hold once more, which is what a restarted keeper should do while a claim is at risk. */
const settleHolds = new Map<string, SettleHold>();

const HOLD_DEDUPE_KEY = (writer: Address, reason: SettleHoldReason) => `${writer.toLowerCase()}:${reason}`;

function holdPhrase(reason: SettleHoldReason, safety: SettleSafety): string {
  const token = `the ${config.KEEPER_MARKET} Stock Token`;
  switch (reason) {
    case 'usdg_paused':
      return 'USDG is paused';
    case 'usdg_frozen':
      return 'the account is frozen on USDG';
    case 'clear_usdg_frozen':
      return `the Valorem Clear ${config.CLEARINGHOUSE} is frozen on USDG`;
    case 'asset_paused':
      return `${token} is paused`;
    case 'asset_blocked':
      return `the account is blocked on ${token}`;
    case 'clear_asset_blocked':
      return `the Valorem Clear ${config.CLEARINGHOUSE} is blocked on ${token}`;
    case 'read_failed':
      return `a safety read did not answer (${safety.failedReads.join(', ')}), which counts as unsafe`;
  }
}

/** Skip this account's settle for the tick and say why: `v1_settle_held` once per account per
 *  reason while it holds. A failed delivery is not marked, so the alert module retries it on its
 *  five-minute clock; a reason that has cleared while others still hold is forgotten, so it says
 *  so again if it comes back. */
async function holdSettle(writer: Address, listedExpiryTs: number, safety: SettleSafety): Promise<void> {
  const key = writer.toLowerCase();
  let hold = settleHolds.get(key);
  if (hold === undefined) {
    hold = { account: writer, since: new Date().toISOString(), claimKey: null, listedExpiryTs, reasons: new Map() };
    settleHolds.set(key, hold);
  }
  hold.claimKey = safety.claimKey === null ? null : safety.claimKey.toString();
  hold.listedExpiryTs = listedExpiryTs;
  for (const reason of [...hold.reasons.keys()]) {
    if (!safety.hold.includes(reason)) {
      hold.reasons.delete(reason);
      clearAlert('v1_settle_held', HOLD_DEDUPE_KEY(writer, reason));
    }
  }
  log.solo.debug({ writer, claimKey: hold.claimKey, hold: safety.hold, gates: safety.gates, failedReads: safety.failedReads }, 'settle held this tick');

  for (const reason of safety.hold) {
    if (hold.reasons.get(reason) === true) continue;
    hold.reasons.set(reason, false);
    const delivered = await alert(
      'v1_settle_held',
      `${config.KEEPER_MARKET} settle() held for account ${writer} (claimKey ${hold.claimKey ?? 'unread'}): ${holdPhrase(reason, safety)}. ` +
        'A settle now would keep its Valorem claim for good; nothing is sent while this holds, and the account settles on the first tick every gate reads open.',
      {
        account: writer,
        reason,
        claimKey: hold.claimKey,
        listedExpiryTs,
        gates: safety.gates,
        failedReads: safety.failedReads,
        usdg: config.USDG,
        asset: config.ASSET,
        clear: config.CLEARINGHOUSE,
      },
      { dedupeKey: HOLD_DEDUPE_KEY(writer, reason) },
    );
    if (delivered) hold.reasons.set(reason, true);
  }
}

/** The account reads safe (every gate open, or `claimKey == 0`): forget its hold and its alerts. */
function releaseHold(writer: Address, safety: SettleSafety): void {
  const hold = settleHolds.get(writer.toLowerCase());
  if (hold === undefined) return;
  for (const reason of hold.reasons.keys()) clearAlert('v1_settle_held', HOLD_DEDUPE_KEY(writer, reason));
  settleHolds.delete(writer.toLowerCase());
  log.solo.info({ writer, claimKey: safety.claimKey, heldSince: hold.since }, 'settle hold lifted: every gate reads open; settling');
}

/** A held account that has left the live set was settled by someone else (settle() is
 *  permissionless). Forgotten, with a warning: if its claimKey is still non-zero, that settle
 *  stranded the claim (ops/runbooks/v1-runoff.md step 8, "claimKey still non-zero"). */
function dropGoneHolds(live: readonly Address[]): void {
  if (settleHolds.size === 0) return;
  const still = new Set(live.map((w) => w.toLowerCase()));
  for (const [key, hold] of settleHolds) {
    if (still.has(key)) continue;
    for (const reason of hold.reasons.keys()) clearAlert('v1_settle_held', HOLD_DEDUPE_KEY(hold.account, reason));
    settleHolds.delete(key);
    log.solo.warn(
      { writer: hold.account, claimKey: hold.claimKey, reasons: [...hold.reasons.keys()] },
      'a held account is no longer live: someone else called settle(); read its claimKey, a non-zero one is stranded',
    );
  }
}

/** For /state: every account whose settle is held right now. */
export function getSettleHolds(): Array<{ account: Address; claimKey: string | null; listedExpiryTs: number; reasons: SettleHoldReason[]; since: string }> {
  return [...settleHolds.values()].map((h) => ({
    account: h.account,
    claimKey: h.claimKey,
    listedExpiryTs: h.listedExpiryTs,
    reasons: [...h.reasons.keys()],
    since: h.since,
  }));
}

/** roll.sendAndConfirm's twin for the factory kinds: submit, record, wait, record, alert. */
async function sendAndConfirm(kind: TxKind, send: () => Promise<Hash>, data: Record<string, unknown> = {}): Promise<TransactionReceipt | null> {
  let hash: Hash;
  try {
    hash = await send();
  } catch (error) {
    const reason = describeError(error);
    await alert('tx_revert', `${kind} submission failed: ${reason}`, { kind, reason, ...data }, { dedupeKey: kind });
    return null;
  }
  store.recordTxSubmitted(hash, kind, null);
  log.solo.info({ kind, hash, ...data }, 'transaction submitted');
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.KEEPER_TX_TIMEOUT_MS, confirmations: 1 });
    if (receipt.status === 'success') {
      store.recordTxResult(hash, 'success', receipt.blockNumber, receipt.gasUsed, null);
      clearAlert('tx_revert', kind);
      log.solo.info({ kind, hash, block: receipt.blockNumber, gas: receipt.gasUsed }, 'transaction confirmed');
      return receipt;
    }
    store.recordTxResult(hash, 'reverted', receipt.blockNumber, receipt.gasUsed, 'receipt status: reverted');
    await alert('tx_revert', `${kind} reverted on chain`, { kind, hash, ...data }, { dedupeKey: kind, force: true });
    return null;
  } catch (error) {
    const reason = describeError(error);
    store.recordTxResult(hash, 'pending', null, null, reason);
    await alert('tx_revert', `${kind} was submitted but not confirmed in time: ${reason}`, { kind, hash, reason, ...data }, { dedupeKey: kind });
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                           V1 RUN-OFF
//////////////////////////////////////////////////////////////*/

let windDownLogged = false;

/** SOLO_WIND_DOWN: settle what has expired, say when nothing is left. Never setWeek, never listFor. */
async function tickWindDown(snap: SoloSnapshot): Promise<void> {
  if (!windDownLogged) {
    // Once per process, not every tick like the pooled WIND_DOWN line: 35 keepers in run-off would
    // otherwise fill the log with the same sentence every minute.
    log.solo.warn({ live: snap.liveCount, pending: snap.pendingCount, weekId: snap.week.id }, 'SOLO_WIND_DOWN: v1 run-off; settling only, never setWeek or listFor');
    windDownLogged = true;
  }
  await settleExpired(snap);
  await noteDrained(snap);
}

/**
 * `v1_drained` once per factory, across restarts, when `liveCount() == 0 && pendingCount() == 0`.
 * Judged on the tick's snapshot, i.e. before this tick's settles: the settle that empties the
 * factory is confirmed by the next snapshot, one poll interval later.
 */
async function noteDrained(snap: SoloSnapshot): Promise<void> {
  if (snap.liveCount !== 0 || snap.pendingCount !== 0) return;
  const factory = factoryAddress();
  const key = DRAINED_KEY(factory);
  if (store.getMeta(key) !== null) return;
  // Marked only once the alert is out (or logged with no webhook), as rememberSkip does: a failed
  // delivery is retried on the alert module's five-minute clock, not forgotten.
  const delivered = await alert(
    'v1_drained',
    `${config.KEEPER_MARKET} v1 market drained: factory ${factory} has no live or pending account; nothing is left to settle`,
    { factory, liveCount: snap.liveCount, pendingCount: snap.pendingCount, weekId: snap.week.id, block: snap.blockNumber },
    { dedupeKey: factory },
  );
  if (delivered) store.setMeta(key, new Date().toISOString());
}

/*//////////////////////////////////////////////////////////////
                              TICK
//////////////////////////////////////////////////////////////*/

/** The conditions /health also reports, paged through the webhook because a 503 cannot fix them. */
async function raiseSoloHealthAlerts(snap: SoloSnapshot): Promise<void> {
  if (snap.keeperBalanceWei < config.KEEPER_MIN_GAS_WEI) {
    await alert('low_gas', `keeper ${account.address} holds ${formatEth(snap.keeperBalanceWei)} ETH, under ${formatEth(config.KEEPER_MIN_GAS_WEI)}`, {
      balanceWei: snap.keeperBalanceWei,
      minWei: config.KEEPER_MIN_GAS_WEI,
    });
  } else {
    clearAlert('low_gas');
  }
  if (snap.rpcLagSeconds * 1000 > config.KEEPER_RPC_LAG_ALERT_MS) {
    await alert('rpc_lag', `head block ${snap.blockNumber} is ${snap.rpcLagSeconds}s behind the wall clock`, { lagSeconds: snap.rpcLagSeconds, block: snap.blockNumber });
  } else {
    clearAlert('rpc_lag');
  }
  if (snap.spot === null && snap.spotError !== null) {
    await alert('oracle_paused', `${config.KEEPER_MARKET} feed ${config.PRICE_FEED} cannot be priced on: ${snap.spotError}`, { feed: config.PRICE_FEED, error: snap.spotError }, {
      dedupeKey: 'feed',
    });
  } else {
    clearAlert('oracle_paused', 'feed');
  }
}

/** One factory tick. No-op unless FACTORY is set. Beats the heartbeat on the way out, so /health
 *  reads a factory-only process as alive without any vault tick. */
export async function tickSolo(): Promise<void> {
  if (config.FACTORY === undefined) return;
  tickStartedAt = Date.now();
  try {
    let snap: SoloSnapshot;
    try {
      snap = await soloSnapshot();
    } catch (error) {
      const reason = describeError(error);
      await alert('rpc_lag', `factory snapshot failed on every RPC: ${reason}`, { reason });
      throw error;
    }
    store.beat(snap.at);
    await raiseSoloHealthAlerts(snap);
    log.solo.debug(
      {
        block: snap.blockNumber,
        weekId: snap.week.id,
        pending: snap.pendingCount,
        live: snap.liveCount,
        writesHalted: snap.writesHalted,
        spotUsdg6: snap.spot?.spotUsdg6 ?? null,
        spotAgeS: snap.spot?.ageS ?? null,
      },
      'solo tick',
    );

    if (config.SOLO_WIND_DOWN) {
      await tickWindDown(snap);
    } else {
      await ensureWeek(snap);
      await listPending(snap);
      await settleExpired(snap);
    }

    store.beat();
  } finally {
    tickStartedAt = null;
  }
}

/*//////////////////////////////////////////////////////////////
                         FOR /state AND ALERTS
//////////////////////////////////////////////////////////////*/

/** The persisted memory /state serves beside the snapshot. `drainedAt` is when `v1_drained` went
 *  out for this factory, null before (and always outside run-off). */
export function soloMemory(): { lastPricing: Record<string, unknown> | null; lastSkip: Record<string, unknown> | null; drainedAt: string | null } {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    lastPricing: parse(store.getMeta(LAST_PRICING_KEY)),
    lastSkip: parse(store.getMeta(LAST_SKIP_KEY)),
    drainedAt: config.FACTORY === undefined ? null : store.getMeta(DRAINED_KEY(config.FACTORY)),
  };
}

/** The figures an operator reads first, for alert data. */
function pricingSummary(p: PricingRecord): Record<string, unknown> {
  return {
    pricingMode: p.mode,
    strikeUsdg: formatUsdg(BigInt(p.strikeUsdg6)),
    strikeOtmBps: p.strikeOtmBps,
    targetDelta: p.targetDelta,
    deltaAtStrike: p.deltaAtStrike,
    ivAtStrike: p.ivAtStrike,
    fairUnitUsdg: p.fairUnit6 === null ? null : formatUsdg(BigInt(p.fairUnit6)),
    askUsdg: formatUsdg(BigInt(p.unitPrice6)),
    floorUnitUsdg: formatUsdg(BigInt(p.floorUnit6)),
    priceSource: p.priceSource,
    strikeClamped: p.strikeClamped,
    expiry: p.expiry,
    chainTimestamp: p.chainTimestamp,
  };
}

/** One human line: "+502 bps over spot 212.21, delta 0.146 (target 0.15), Cboe iv 32.7, fair 0.86". */
export function pricingPhrase(p: PricingRecord): string {
  const parts = [`${p.strikeOtmBps >= 0 ? '+' : ''}${p.strikeOtmBps} bps over spot ${formatUsdg(BigInt(p.spotUsdg6))}`];
  if (p.mode === 'vol') {
    if (p.deltaAtStrike !== null) parts.push(`delta ${p.deltaAtStrike.toFixed(3)} (target ${p.targetDelta ?? '?'})`);
    if (p.ivAtStrike !== null) parts.push(`Cboe iv ${(p.ivAtStrike * 100).toFixed(1)}`);
    if (p.fairUnit6 !== null) parts.push(`fair ${formatUsdg(BigInt(p.fairUnit6))}`);
    if (p.strikeClamped !== null) parts.push(`delta strike ${p.deltaStrikeUsdg6 === null ? '?' : formatUsdg(BigInt(p.deltaStrikeUsdg6))} clamped to the ${p.strikeClamped}`);
  }
  parts.push(`ask from ${p.priceSource}`);
  return parts.join(', ');
}
