/**
 * The Stock Token's spot from its Uniswap v3 USDG pool: a short time-weighted average price over the
 * registry's `v2.univ3Pool`, gated by the registry's `v2.univ3MinLiquidity`.
 *
 * WHY A SECOND SPOT. The Chainlink feed (spot.ts) prints only on a 0.5% move or a 24 h heartbeat, so it
 * can sit up to about 0.5% off the live price. For a 0DTE ask near the close that is most of the
 * premium. The pool trades continuously. It is never used alone: fair.ts prices a call at the higher
 * of the two spots and a put at the lower, and refuses to quote when they disagree by more than
 * `maxPoolChainlinkDivergenceBps`. Chainlink stays the settlement anchor.
 *
 * THE MATHS IS THE SETTLEMENT SOURCE'S, MIRRORED, NOT RE-DERIVED. callhouse-contracts
 * src/v2/oracle/UniV3TwapSource.sol `_observeWindow` and `_quote`, and src/v2/oracle/lib/TickMath.sol
 * restated in bigint:
 *   - `observe([window, 0])` gives two tick cumulatives and two seconds-per-liquidity cumulatives;
 *   - the mean tick is `delta(tickCumulative) / window`, FLOORED toward negative infinity
 *     (OracleLibrary.consult; Solidity truncates, so a negative remainder moves it down one);
 *   - the harmonic-mean in-range liquidity is `(window << 128) / delta(secondsPerLiquidityX128)`, the
 *     delta taken modulo 2^160 as v3-core accumulates it; a zero delta is not a pool's reply;
 *   - the price of one whole token (10^assetDecimals base units) in USDG base units is
 *     getQuoteAtTick: `10^dec * 2^192 / sqrtRatio^2` when USDG is token0, `10^dec * sqrtRatio^2 / 2^192`
 *     when the asset is token0, with the same `sqrtRatio <= 2^128` split, truncating;
 *   - `sqrtRatio` is TickMath.getSqrtRatioAtTick with THAT FILE'S factor table, which is not upstream's
 *     (three factors are +1 ulp, TickMath.sol's header). Copied here so the service reads the same
 *     number the source records; do not "fix" it to upstream.
 *
 * UNITS. USDG base units (6 dp) per whole TOKEN, the same unit spot.ts produces. No uiMultiplier is
 * applied, as in spot.ts: the pool trades the token itself, and the feed's answer already includes
 * the multiplier, so both numbers are per token and compare directly.
 *
 * STALENESS. The TWAP ends at the timestamp of the block `observe` runs at, and nothing in the reply
 * says which block that was, so a lagging RPC serves an old average undetected. The production reader reads the
 * head block, refuses it when it trails the wall clock by more than `maxEndAgeS`, and runs `observe` AT that block
 * number, so the block it aged is the block the TWAP was read at.
 *
 * Pure except poolObserveReader and createPoolObserveReader, which are the viem seam.
 */
import { createPublicClient, fallback, getAddress, http, type Address, type PublicClient } from 'viem';
import { failure, type PricingFailure } from './cboe.js';

/** A TWAP shorter than this is a spot anyone can move inside one block, so this is the floor. */
export const MIN_POOL_TWAP_S = 30;
/** UniV3TwapSource.MAX_WINDOW. */
export const MAX_POOL_TWAP_S = 3_600;
export const DEFAULT_POOL_TWAP_S = 90;

/**
 * How far the TWAP's end block may trail the wall clock, seconds. The keeper's RPC lag alert threshold,
 * KEEPER_RPC_LAG_ALERT_MS's default of 300_000 ms (keeper/src/config.ts), in seconds: a head that far behind
 * already pages `rpc_lag` (roll.ts, solo.ts), so a TWAP ending there is one the keeper already calls lagging.
 * Inclusive, as that alert's `>`.
 */
export const DEFAULT_POOL_TWAP_MAX_END_AGE_S = 300;

/*//////////////////////////////////////////////////////////////
                    TICKMATH (UniV3TwapSource's)
//////////////////////////////////////////////////////////////*/

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

/** callhouse-contracts src/v2/oracle/lib/TickMath.sol `factors`, verbatim. */
const FACTORS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5826n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee605n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa3n,
];

const U256_MAX = (1n << 256n) - 1n;
const U160_MOD = 1n << 160n;

/** Q64.96 square-root price at `tick`, as TickMath.getSqrtRatioAtTick. Throws outside [MIN_TICK, MAX_TICK]. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);
  let magnitude = BigInt(Math.abs(tick));
  let ratio = 1n << 128n;
  let bit = 0;
  while (magnitude !== 0n) {
    // Solidity's `unchecked` product of two < 2^128 values never exceeds 256 bits, so no masking is needed.
    if ((magnitude & 1n) !== 0n) ratio = (ratio * FACTORS[bit]!) >> 128n;
    magnitude >>= 1n;
    bit += 1;
  }
  if (tick > 0) ratio = U256_MAX / ratio;
  return (ratio + ((1n << 32n) - 1n)) >> 32n;
}

/** USDG base units for one whole token at `tick` (UniV3TwapSource._quote). */
export function quoteAtTick(tick: number, usdgIsToken0: boolean, assetDecimals: number): bigint {
  const oneToken = 10n ** BigInt(assetDecimals);
  const sqrt = sqrtRatioAtTick(tick);
  if (sqrt <= (1n << 128n) - 1n) {
    const ratioX192 = sqrt * sqrt;
    return usdgIsToken0 ? ((1n << 192n) * oneToken) / ratioX192 : (ratioX192 * oneToken) / (1n << 192n);
  }
  const ratioX128 = (sqrt * sqrt) / (1n << 64n);
  return usdgIsToken0 ? ((1n << 128n) * oneToken) / ratioX128 : (ratioX128 * oneToken) / (1n << 128n);
}

/*//////////////////////////////////////////////////////////////
                              TWAP
//////////////////////////////////////////////////////////////*/

/** One `observe([window, 0])` reply: index 0 is `window` seconds ago, index 1 is now. */
export interface PoolObservation {
  tickCumulatives: readonly [bigint, bigint];
  secondsPerLiquidityCumulativeX128s: readonly [bigint, bigint];
}

/** What the pool is, read once per pool: its tokens and the asset's decimals. */
export interface PoolMeta {
  token0: Address;
  token1: Address;
  assetDecimals: number;
}

/** A pool the market registry names: `v2.univ3Pool`, its floor `v2.univ3MinLiquidity` (pool L units), and
 *  `shared.usdg`, the quote token the pool must hold. */
export interface PricingPool {
  address: Address;
  minLiquidity: bigint;
  usdg: Address;
}

export interface PoolSpot {
  /** USDG base units per whole token, truncating (UniV3TwapSource._quote). */
  spotUsdg6: bigint;
  meanTick: number;
  harmonicLiquidity: bigint;
  windowS: number;
  usdgIsToken0: boolean;
}

/** The TWAP of one observation, checked. Pure: every number from the reply, the window and the registry. */
export function poolSpotFromObservation(input: {
  observation: PoolObservation;
  windowS: number;
  meta: PoolMeta;
  asset: Address;
  pool: PricingPool;
}): PoolSpot | PricingFailure {
  const { observation, windowS, meta, asset, pool } = input;
  const detail = { source: 'pool', pool: pool.address, windowS: String(windowS) };
  if (!Number.isInteger(windowS) || windowS < MIN_POOL_TWAP_S || windowS > MAX_POOL_TWAP_S) {
    return failure('spot-unavailable', { why: `the TWAP window is outside [${MIN_POOL_TWAP_S}, ${MAX_POOL_TWAP_S}] s`, ...detail });
  }
  const a = getAddress(asset);
  const t0 = getAddress(meta.token0);
  const t1 = getAddress(meta.token1);
  // Which side USDG is on is read from the pool, never assumed (UniV3TwapSource.setPool): the registry's
  // NVDA pool has USDG as token0 and its SPCX pool has it as token1.
  // The pair must be exactly {USDG, asset}, in either order, as setPool requires.
  const u = getAddress(pool.usdg);
  let usdgIsToken0: boolean;
  if (t0 === u && t1 === a) usdgIsToken0 = true;
  else if (t0 === a && t1 === u) usdgIsToken0 = false;
  else return failure('spot-unavailable', { why: 'the pool is not the USDG pair of the market\'s token', token0: t0, token1: t1, asset: a, usdg: u, ...detail });
  if (!Number.isInteger(meta.assetDecimals) || meta.assetDecimals < 0 || meta.assetDecimals > 38) {
    return failure('spot-unavailable', { why: 'asset decimals out of range', assetDecimals: String(meta.assetDecimals), ...detail });
  }

  const len = BigInt(windowS);
  const tickDelta = observation.tickCumulatives[1] - observation.tickCumulatives[0];
  // BigInt division truncates toward zero like Solidity's; floor it as OracleLibrary.consult does.
  let mean = tickDelta / len;
  if (tickDelta < 0n && tickDelta % len !== 0n) mean -= 1n;
  if (mean < BigInt(MIN_TICK) || mean > BigInt(MAX_TICK)) {
    return failure('spot-unavailable', { why: 'the mean tick is out of range', meanTick: mean.toString(), ...detail });
  }
  const meanTick = Number(mean);

  const s0 = observation.secondsPerLiquidityCumulativeX128s[0];
  const s1 = observation.secondsPerLiquidityCumulativeX128s[1];
  const splDelta = (((s1 - s0) % U160_MOD) + U160_MOD) % U160_MOD;
  if (splDelta === 0n) return failure('spot-unavailable', { why: 'the seconds-per-liquidity delta is zero: not a pool reply', ...detail });
  const harmonicLiquidity = (len << 128n) / splDelta;
  if (harmonicLiquidity < pool.minLiquidity) {
    return failure('spot-unavailable', {
      code: 'pool-thin',
      why: 'the pool\'s harmonic-mean liquidity over the window is below the registry floor',
      harmonicLiquidity: harmonicLiquidity.toString(),
      minLiquidity: pool.minLiquidity.toString(),
      ...detail,
    });
  }
  const spotUsdg6 = quoteAtTick(meanTick, usdgIsToken0, meta.assetDecimals);
  if (spotUsdg6 === 0n) return failure('spot-unavailable', { why: 'the TWAP price is under one USDG base unit', meanTick: String(meanTick), ...detail });
  return { spotUsdg6, meanTick, harmonicLiquidity, windowS, usdgIsToken0 };
}

/*//////////////////////////////////////////////////////////////
                            THE READER
//////////////////////////////////////////////////////////////*/

/** SEAM: read `pool`. `meta` is read once per pool by the production reader. Rejects on an RPC failure, and the
 *  production reader's `observe` rejects a TWAP end block older than its bound (PoolTwapStaleError). */
export interface PoolReader {
  meta(pool: Address, asset: Address): Promise<PoolMeta>;
  observe(pool: Address, windowS: number): Promise<PoolObservation>;
  /** `observe(secondsAgos)`'s tick cumulatives, in the order asked (realized.ts). Optional: a reader without it
   *  gives the service no realized vol, which only means the ask is not raised by one (fair.ts askIvFor). */
  observeSeries?(pool: Address, secondsAgos: readonly number[]): Promise<bigint[]>;
}

export const uniswapV3PoolAbi = [
  {
    type: 'function',
    name: 'observe',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

const erc20DecimalsAbi = [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' }] as const;

/** Seconds a block stamped `blockTimestamp` trails the wall clock; a block stamped ahead of it reads as 0, not negative
 *  (roll.ts rpcLagSeconds). */
export function twapEndAgeS(blockTimestamp: bigint, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000) - Number(blockTimestamp));
}

/** The reader's refusal of a TWAP whose end block is too old. fair.ts reports its message's first line as the pool
 *  read's `error`, so the message starts with the code. */
export class PoolTwapStaleError extends Error {
  readonly code = 'pool-twap-stale';
  readonly blockNumber: bigint;
  readonly ageS: number;
  readonly maxEndAgeS: number;

  constructor(blockNumber: bigint, ageS: number, maxEndAgeS: number) {
    super(`pool-twap-stale: the TWAP ends at block ${blockNumber}, ${ageS} s behind the wall clock, over the ${maxEndAgeS} s bound`);
    this.name = 'PoolTwapStaleError';
    this.blockNumber = blockNumber;
    this.ageS = ageS;
    this.maxEndAgeS = maxEndAgeS;
  }
}

export interface PoolReaderOptions {
  /** The oldest TWAP end block `observe` accepts, whole seconds behind the wall clock. DEFAULT_POOL_TWAP_MAX_END_AGE_S. */
  maxEndAgeS?: number;
  /** The wall clock, ms. Date.now. */
  nowMs?: () => number;
}

/** The production reader over RH_RPC (RH_RPC_2 as a fallback transport), like spot.ts createFeedSpotReader. */
export function createPoolObserveReader(rpcUrls: readonly string[], timeoutMs = 10_000, options: PoolReaderOptions = {}): PoolReader {
  if (rpcUrls.length === 0) throw new Error('createPoolObserveReader: no RPC URL');
  const transports = rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1 }));
  return poolObserveReader(createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports) }), options);
}

/** The reader over one viem client. */
export function poolObserveReader(client: PublicClient, options: PoolReaderOptions = {}): PoolReader {
  const maxEndAgeS = options.maxEndAgeS ?? DEFAULT_POOL_TWAP_MAX_END_AGE_S;
  if (!Number.isInteger(maxEndAgeS) || maxEndAgeS < 1) throw new RangeError(`poolObserveReader: maxEndAgeS must be a whole number of seconds >= 1, not ${maxEndAgeS}`);
  const nowMs = options.nowMs ?? Date.now;
  const metas = new Map<string, PoolMeta>();
  return {
    async meta(pool, asset) {
      const key = `${pool.toLowerCase()}|${asset.toLowerCase()}`;
      const cached = metas.get(key);
      if (cached !== undefined) return cached;
      const [token0, token1, decimals] = await Promise.all([
        client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' }),
        client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token1' }),
        client.readContract({ address: asset, abi: erc20DecimalsAbi, functionName: 'decimals' }),
      ]);
      const meta = { token0, token1, assetDecimals: Number(decimals) };
      metas.set(key, meta);
      return meta;
    },
    async observe(pool, windowS) {
      // Age the block the TWAP is read AT, not whichever head the client saw last: observe runs pinned to this
      // block's number, so a fallback transport cannot age one node's head and read another node's older state.
      const head = await client.getBlock({ blockTag: 'latest' });
      const ageS = twapEndAgeS(head.timestamp, nowMs());
      if (ageS > maxEndAgeS) throw new PoolTwapStaleError(head.number, ageS, maxEndAgeS);
      const [ticks, spls] = await client.readContract({
        address: pool,
        abi: uniswapV3PoolAbi,
        functionName: 'observe',
        args: [[windowS, 0]],
        blockNumber: head.number,
      });
      if (ticks.length !== 2 || spls.length !== 2) throw new Error(`observe returned ${ticks.length}/${spls.length} entries, not 2`);
      return { tickCumulatives: [ticks[0]!, ticks[1]!], secondsPerLiquidityCumulativeX128s: [spls[0]!, spls[1]!] };
    },
    async observeSeries(pool, secondsAgos) {
      const [ticks] = await client.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: 'observe', args: [[...secondsAgos]] });
      if (ticks.length !== secondsAgos.length) throw new Error(`observe returned ${ticks.length} entries, not ${secondsAgos.length}`);
      return [...ticks];
    },
  };
}
