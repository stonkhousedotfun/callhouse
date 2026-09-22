/**
 * The market registry as the v2 bots read it: ops/markets/tier1.json and its `v2` blocks.
 *
 * Two kinds of `v2` block, both hand-maintained until the O2 deploy write-back fills addresses:
 *   - top level `v2`: interface version, deploy block, contract addresses (INTERFACE_VERSION 8 included the
 *     AccessManager among them), the `flywheel` block, Uniswap v3 periphery, fee params, and `defaults`
 *     (oracle bounds, ladders per tenor, expiries ahead per tenor);
 *   - per market `markets[i].v2`: status (planned | live | paused), wave, strikeTick, puts, the
 *     Uniswap pool and its liquidity floor, the Data Streams feed id, the `payoutRoute`, and `overrides`.
 *
 * VERSION. `INTERFACE_VERSION` below is exact and total: a registry for any other version is refused outright
 * rather than partly read. That is what keeps the v7 run-off and v8 apart — `ops/markets/v7-legacy.json` is
 * the frozen v7 file and the v7 image reads it; one process never serves both.
 *
 * RESOLUTION, one rule for every market parameter: the §3 defaults compiled in here, then the
 * registry's `v2.defaults`, then the market's `overrides`, each layer replacing only the keys it
 * names. So a registry may carry a partial `defaults`, and SGOV can say
 * `"overrides": { "expiriesAhead": { "daily": 0 } }` (no dailies) without restating its ladders.
 *
 * ABSENCE IS NOT AN ERROR. Until O2-01 lands the registry has no `v2` blocks at all: the loader
 * then returns every contract address as null, the compiled defaults, and `v2: null` on every
 * market. Whether a missing address matters is the caller's question (config.ts asks it per mode),
 * so the pricing service and a dry run keep working on today's file.
 *
 * PRESENCE IS STRICT, like config.ts: a block that is there and malformed refuses to load, with
 * every problem listed and the market's ticker in the path. `overrides`, `defaults` and the ladder
 * objects reject unknown keys, because a typo there (`"ladders"`, `"firstOtm"`) would otherwise be
 * ignored and the market would quietly trade on the defaults. The containers (`v2`, `contracts`,
 * a market's `v2`) pass unknown keys through: an informational field added by a later task is
 * harmless, and a misspelt address is caught anyway when a mode needs it.
 *
 * Big integers (strikeTick, takerFeeFlat, univ3MinLiquidity, deployBlock) are decimal strings in
 * the file (§3) and bigint here; a plain JSON integer is accepted too when it is exact.
 *
 * The v1 fields each v2 market also needs (ticker, name, `asset` = the underlying, `feed`, `cboe`)
 * are read from the same row, so this loader is a superset of pricing/markets.ts, which keeps its
 * own narrower reader.
 */
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/**
 * The frozen on-chain interface version these bots were built against. Mirrors the one place ops/ spells it,
 * `ops/markets/build-markets.mjs` `INTERFACE_VERSION` (:217); a registry for any other version describes
 * contracts this keeper cannot call correctly and is refused below.
 */
export const INTERFACE_VERSION = 8;

/**
 * V2Constants.MINT_FEE_CEIL_PPM: the highest collateral rent a market may be registered with, in millionths of
 * the locked collateral per MINT_FEE_PERIOD (7 days) of remaining life. Clearinghouse._checkConfig reverts
 * CeilingExceeded above it. Mirrored from `ops/markets/build-markets.mjs` (:333-337), which cites the contract.
 *
 * INTERFACE_VERSION 8 keeps the ceiling and switches the dial off: v8 charges the writer a premium fee on the
 * first sale and no rent, so the rate is 0 everywhere and this bound only applies to a registry that says
 * `v2.fees.allowRent: true` out loud (V8_ALLOW_RENT_KEY).
 */
export const MINT_FEE_CEIL_PPM = 5_000;

/**
 * V2Constants.MAX_ROUTE_FEE_TIER: the highest fee tier `PayoutRouter.setRoute` accepts on either venue.
 * Mirrored from `ops/markets/build-markets.mjs` (:374-375).
 */
export const MAX_ROUTE_FEE_TIER = 10_000;

/**
 * Uniswap v4's PoolManager bounds `tickSpacing` to [1, MAX_TICK_SPACING]. It is part of the PoolKey and so of
 * the pool id, which is why a wrong one names a different pool rather than failing. Mirrored from
 * `ops/markets/build-markets.mjs` (:348-352).
 */
export const MAX_TICK_SPACING = 32_767;

/**
 * The registry key that switches collateral rent back on. INTERFACE_VERSION 8 refuses any non-zero rent without
 * it; v7 refused a zero rate instead. Mirrored from `ops/markets/build-markets.mjs` `ALLOW_RENT_KEY` (:345).
 */
export const V8_ALLOW_RENT_KEY = 'v2.fees.allowRent';

/*//////////////////////////////////////////////////////////////
                         NAMES AND TYPES
//////////////////////////////////////////////////////////////*/

/**
 * `v2.contracts` keys, in §3 order. INTERFACE_VERSION 8 appends `accessManager`, the OpenZeppelin
 * AccessManager every v8 target is `Managed` by, taking the counted set from 13 addresses to 14
 * (these 11 plus the three `sources`). Mirrors `ops/markets/build-markets.mjs` `V2_CONTRACT_NAMES` (:228-231).
 *
 * `payoutAdapter` keeps its name and now holds the `PayoutRouter`, so nothing downstream learns a second key
 * for the same slot.
 */
export const V2_CONTRACT_NAMES = [
  'clearinghouse',
  'orderBook',
  'settlementOracle',
  'expiryCalendar',
  'keeperRewards',
  'autoRoller',
  'payoutAdapter',
  'makerVault',
  'makerRegistry',
  'rewardsDistributor',
  'accessManager',
] as const;
export type V2ContractName = (typeof V2_CONTRACT_NAMES)[number];

/**
 * `v2.flywheel` address keys (INTERFACE_VERSION 8). They are deliberately NOT `v2.contracts` keys: that set is
 * closed and counted by the deploy tooling, so the flywheel gets its own block
 * (`ops/markets/build-markets.mjs` :812-814). The bots still resolve them by name like any other address,
 * which is what V2_ADDRESS_NAMES below is for.
 */
export const V2_FLYWHEEL_NAMES = ['feeSplitter', 'buybackExecutor'] as const;
export type V2FlywheelName = (typeof V2_FLYWHEEL_NAMES)[number];

/** Every address a v2 bot resolves by name, whichever registry block it lives in. */
export const V2_ADDRESS_NAMES = [...V2_CONTRACT_NAMES, ...V2_FLYWHEEL_NAMES] as const;
export type V2AddressName = (typeof V2_ADDRESS_NAMES)[number];

/** Where each name is read from, for the message an unresolved address prints. */
export const V2_ADDRESS_PATH: Record<V2AddressName, string> = {
  ...(Object.fromEntries(V2_CONTRACT_NAMES.map((name) => [name, `v2.contracts.${name}`])) as Record<V2ContractName, string>),
  ...(Object.fromEntries(V2_FLYWHEEL_NAMES.map((name) => [name, `v2.flywheel.${name}`])) as Record<V2FlywheelName, string>),
};

/** `v2.contracts.sources` keys. */
export const V2_SOURCE_NAMES = ['chainlink', 'univ3', 'dataStreams'] as const;
export type V2SourceName = (typeof V2_SOURCE_NAMES)[number];

export const V2_MARKET_STATUSES = ['planned', 'live', 'paused'] as const;
export type V2MarketStatus = (typeof V2_MARKET_STATUSES)[number];

export const TENORS = ['weekly', 'daily'] as const;
export type Tenor = (typeof TENORS)[number];

/** One tenor's strike ladder (K2-03 builds it, ADR-12 reads `cardTargetBps`). */
export interface LadderParams {
  rungs: number;
  /** Rung 0 = roundUp(spot × (1 + firstOtmBps / 1e4), strikeTick); puts mirror below spot. */
  firstOtmBps: number;
  /** Each further rung × (1 + stepBps / 1e4). */
  stepBps: number;
  /** Card scenario target = roundUp(strike × (1 + cardTargetBps / 1e4), strikeTick). */
  cardTargetBps: number;
}

/** Everything a market inherits from `v2.defaults` and may override. */
export interface MarketParams {
  maxDeviationBps: number;
  uncorroboratedDelayS: number;
  spotMaxAgeS: number;
  ladder: Record<Tenor, LadderParams>;
  /** How many upcoming expiries of each tenor carry a ladder. 0 switches the tenor off. */
  expiriesAhead: Record<Tenor, number>;
}

/** §3's `v2.defaults`, verbatim. What a registry without (part of) that block resolves to. */
export const SPEC_DEFAULTS: MarketParams = {
  maxDeviationBps: 150,
  uncorroboratedDelayS: 21_600,
  // A feed heartbeat (24 h) plus 1 h: the last print of a quiet feed stays a valid spot (ops/deploy.md §15.13).
  spotMaxAgeS: 90_000,
  ladder: {
    weekly: { rungs: 5, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 },
    daily: { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 },
  },
  expiriesAhead: { weekly: 2, daily: 3 },
};

/** A market's `overrides`, as written: any subset of MarketParams. */
export interface MarketOverrides {
  maxDeviationBps?: number;
  uncorroboratedDelayS?: number;
  spotMaxAgeS?: number;
  ladder?: Partial<Record<Tenor, Partial<LadderParams>>>;
  expiriesAhead?: Partial<Record<Tenor, number>>;
}

/** §3 `v2.fees`: what the deploy sets on chain. The bots read the live values from the contracts. */
export interface V2Fees {
  /**
   * INTERFACE_VERSION 8 (V3-D6, D17): the writer fee IS the premium fee, charged on the first sale of every
   * long, and it must be ABOVE `resaleFeeBps`. v7 required the opposite — it was 0 and rent replaced it — so
   * the two directions are one inversion, checked below only for an interface-8 registry.
   */
  premiumFeeBps: number;
  /**
   * The shared collateral rent, millionths of the locked collateral per 7 days of remaining life. A market's own
   * `v2.mintFeePpm` overrides it; null when the registry carries no `v2.fees` block at all.
   *
   * INTERFACE_VERSION 8 (V3-D18): **0 everywhere**. The dial survives in the Clearinghouse so rent can be
   * switched back on later under the 72 h lane, and a registry that carries a non-zero rate is refused unless it
   * also carries `allowRent: true`.
   */
  mintFeePpm: number | null;
  /**
   * The explicit opt-in that makes a non-zero `mintFeePpm` legal (INTERFACE_VERSION 8). null on a registry whose
   * `v2.fees` block predates the key, which the version gate refuses anyway.
   */
  allowRent: boolean | null;
  resaleFeeBps: number;
  takerFeeFlat: bigint;
  takerFeeCapBps: number;
  makerRebateBps: number;
  exerciseFeeBps: number;
}

/**
 * §3 `v2.vault`: the MakerVault `Limits` tuple the deploy sets, in `setLimits` order (INTERFACE_VERSION 7, c21).
 * The bots read the live values from the vault; this is what the deploy was asked for. null when the registry
 * carries no `v2.vault` block.
 */
export interface V2VaultLimits {
  maxSeriesUnits: bigint;
  maxTotalNotional: bigint;
  askToleranceBps: number;
  maxBidBpsOfSpot: number;
  maxOrderLifetime: number;
  /** Net USDG a quoter call may pay out at once; refills linearly over MakerVault.OUTFLOW_WINDOW (24 h). */
  maxDailyOutflow: bigint;
}

/**
 * §3 `markets[].v2.payoutRoute` (INTERFACE_VERSION 8): the venue that sells this market's Stock Tokens for USDG
 * — the Clearinghouse's payout leg and the FeeSplitter's fee stock. `null` is not a failure: a winning call is
 * then paid in kind.
 *
 * This is NOT `univ3Pool`. That key stays the settlement TWAP source and stays v3-only, because v4 has no
 * observation array to walk. Key sets are closed per venue, mirroring `ops/markets/build-markets.mjs`
 * `PAYOUT_ROUTE_KEYS` (:323-327).
 */
export type V2PayoutRoute =
  | { venue: 'v3'; fee: number }
  | { venue: 'v4'; fee: number; tickSpacing: number; poolId: Hex };

/**
 * §3 `v2.flywheel` (INTERFACE_VERSION 8): the native FeeSplitter and the v4 buyback executor. Its own block and
 * never a `v2.contracts` key, because that set is closed and counted by the deploy tooling
 * (`ops/markets/build-markets.mjs` :812-814). null when the registry carries no `v2.flywheel` block.
 */
export interface V2Flywheel {
  feeSplitter: Address | null;
  buybackExecutor: Address | null;
  /** The splitter is deployed BEFORE the core, so this is deliberately not `v2.deployBlock`. */
  deployBlock: bigint | null;
}

export interface UniswapV3Periphery {
  factory: Address;
  swapRouter02: Address;
  quoterV2: Address;
}

/** A market's `v2` block, typed, with its parameters resolved. */
export interface V2MarketBlock {
  status: V2MarketStatus;
  wave: string;
  /** USDG base units per share; > 0 and a multiple of PRICE_TICK (100). */
  strikeTick: bigint;
  puts: boolean;
  /**
   * The collateral rent this market is registered with (INTERFACE_VERSION 7, c05): millionths of the locked
   * collateral per 7 days of remaining life, pinned into every series created afterwards. Falls back to the
   * registry's `v2.fees.mintFeePpm`; null only on a registry that predates v7.
   */
  mintFeePpm: number | null;
  univ3Pool: Address | null;
  univ3MinLiquidity: bigint | null;
  dataStreamsFeedId: Hex | null;
  /** INTERFACE_VERSION 8. null: no route, and a winning call is paid in Stock Tokens. */
  payoutRoute: V2PayoutRoute | null;
  /** As written in the file. */
  overrides: MarketOverrides;
  /** SPEC_DEFAULTS ← registry `v2.defaults` ← `overrides`. */
  params: MarketParams;
  registeredAt: number | string | null;
  registerTx: Hex | null;
}

export interface V2RegistryMarket {
  ticker: string;
  name: string | null;
  /** The Stock Token (`asset` in the file). */
  underlying: Address;
  feed: Address;
  cboe: { root: string; url: string } | null;
  /** null: this market has no `v2` block (not a v2 market yet). */
  v2: V2MarketBlock | null;
}

export interface V2Registry {
  /** The file it was read from, or null when parsed from memory. */
  path: string | null;
  /** `shared.chainId` / `shared.usdg` / `shared.multicall3`: the v1 shared block, present today. */
  chainId: number | null;
  usdg: Address | null;
  multicall3: Address | null;
  /** false before O2-01: no top-level `v2` block. Every address is then null. */
  hasV2Block: boolean;
  interfaceVersion: number | null;
  deployBlock: bigint | null;
  contracts: Record<V2ContractName, Address | null>;
  sources: Record<V2SourceName, Address | null>;
  uniswapV3: UniswapV3Periphery | null;
  fees: V2Fees | null;
  /** `v2.flywheel` (INTERFACE_VERSION 8). null when the registry has no `v2.flywheel` block. */
  flywheel: V2Flywheel | null;
  /** `v2.vault`, the MakerVault limits the deploy sets. null when the registry has no `v2.vault` block. */
  vault: V2VaultLimits | null;
  /** SPEC_DEFAULTS ← registry `v2.defaults`. What a market with no overrides trades on. */
  defaults: MarketParams;
  /** Every market row, in file order, v2 or not. */
  markets: readonly V2RegistryMarket[];
}

/*//////////////////////////////////////////////////////////////
                             FIELDS
//////////////////////////////////////////////////////////////*/

const address = z
  .string()
  .refine((raw) => isAddress(raw, { strict: false }), 'not a 20-byte hex address')
  .transform((raw): Address => getAddress(raw));

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'not a 32-byte hex value')
  .transform((raw) => raw.toLowerCase() as Hex);

const httpsUrl = z.string().refine((raw) => {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}, 'not an https URL');

/** A non-negative integer as a decimal string (§3) or an exact JSON integer. */
const uint = z.union([z.string(), z.number()]).transform((raw, ctx): bigint => {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a non-negative safe integer: ${raw} (write big values as a decimal string)` });
      return z.NEVER;
    }
    return BigInt(raw);
  }
  if (!/^\d{1,78}$/.test(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a non-negative decimal integer string: ${JSON.stringify(raw)}` });
    return z.NEVER;
  }
  return BigInt(raw);
});

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Bounds the contracts (or the calendar) enforce, restated so a bad registry fails at boot and
 *  not as a revert. Ceilings: V2Constants.sol; oracle bounds: architecture §3.4; MAX_TENOR = 45 days
 *  caps how many expiries ahead can exist at all (6 weeklies, ~31 session days). */
const ladderFields = {
  rungs: int(1, 50),
  // 5000: a put rung mirrored below spot at 50 % OTM is the createSeries sanity floor (spot / 2).
  firstOtmBps: int(0, 5_000),
  stepBps: int(1, 5_000),
  // 0 would make the card target the strike itself: a payout of zero and a multiple of 0.
  cardTargetBps: int(1, 10_000),
};
const paramFields = {
  maxDeviationBps: int(1, 1_000),
  uncorroboratedDelayS: int(1_800, 86_400),
  spotMaxAgeS: int(1, 4 * 86_400),
};
const expiriesAheadFields = { weekly: int(0, 6), daily: int(0, 31) };

const ladderPartial = z.object(ladderFields).partial().strict();
const paramsPartial = z
  .object({
    ...paramFields,
    ladder: z.object({ weekly: ladderPartial, daily: ladderPartial }).partial().strict(),
    expiriesAhead: z.object(expiriesAheadFields).partial().strict(),
  })
  .partial()
  .strict();

const contractsSchema = z
  .object({
    ...Object.fromEntries(V2_CONTRACT_NAMES.map((name) => [name, address.nullable().optional()])),
    sources: z
      .object(Object.fromEntries(V2_SOURCE_NAMES.map((name) => [name, address.nullable().optional()])))
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const v2BlockSchema = z
  .object({
    interfaceVersion: z.number().int().positive(),
    deployBlock: uint.nullable().optional(),
    contracts: contractsSchema.optional(),
    uniswapV3: z.object({ factory: address, swapRouter02: address, quoterV2: address }).passthrough().nullable().optional(),
    fees: z
      .object({
        premiumFeeBps: int(0, 1_000), // PREMIUM_FEE_CEIL_BPS
        // The ceiling is version-independent; whether a non-zero rate is legal at all is not, and is checked
        // against `allowRent` below. Optional so an older registry still parses structurally and the version
        // gate is the message an operator gets.
        mintFeePpm: int(0, MINT_FEE_CEIL_PPM).nullable().optional(), // MINT_FEE_CEIL_PPM
        // INTERFACE_VERSION 8 (V3-D18). Optional here for the same reason; required by the v8 rules below.
        allowRent: z.boolean().nullable().optional(),
        resaleFeeBps: int(0, 1_000), // same ceiling
        takerFeeFlat: uint.refine((v) => v <= 1_000_000n, 'above TAKER_FEE_FLAT_CEIL (1000000)'),
        takerFeeCapBps: int(0, 1_000), // TAKER_FEE_CAP_CEIL_BPS
        makerRebateBps: int(0, 10_000),
        exerciseFeeBps: int(0, 200), // EXERCISE_FEE_CEIL_BPS
      })
      .passthrough()
      // The two rules that RELATE these fields (premium against resale, rent against allowRent) are
      // INTERFACE_VERSION 8's, and they are the exact inversions of v7's. They are enforced after parsing,
      // gated on the version, rather than here: in the schema they would also fire on the frozen v7 registry
      // and bury the one problem that matters there — the version gate — under two messages written for v8.
      .nullable()
      .optional(),
    vault: z
      .object({
        maxSeriesUnits: uint.refine((v) => v < 2n ** 64n, 'does not fit uint64'),
        maxTotalNotional: uint.refine((v) => v < 2n ** 128n, 'does not fit uint128'),
        askToleranceBps: int(0, 10_000),
        maxBidBpsOfSpot: int(0, 10_000),
        maxOrderLifetime: int(0, 2 ** 32 - 1),
        // 0 would deploy the vault unable to bid, take or replace upwards.
        maxDailyOutflow: uint.refine((v) => v > 0n && v < 2n ** 128n, 'must be > 0 and fit uint128'),
      })
      .passthrough()
      .nullable()
      .optional(),
    // INTERFACE_VERSION 8. `.strict()`, like `defaults` and `overrides`: a typo in a key that names an address
    // would otherwise be read as "not deployed yet" and the bot would run with the address missing.
    flywheel: z
      .object({
        feeSplitter: address.nullable().optional(),
        buybackExecutor: address.nullable().optional(),
        deployBlock: uint.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    defaults: paramsPartial.optional(),
  })
  .passthrough();

/**
 * `markets[].v2.payoutRoute`, closed per venue. Mirrors `ops/markets/build-markets.mjs` `PAYOUT_ROUTE_KEYS`
 * (:323-327) and `validatePayoutRoute` (:995-1036): `fee` is in [1, MAX_ROUTE_FEE_TIER] on both venues (0 is a
 * field somebody left empty, and on v4 it neighbours the dynamic-fee flag), and a v4 route carries the pool id
 * because a v4 pool has no address.
 */
const payoutRouteSchema = z.discriminatedUnion('venue', [
  z.object({ venue: z.literal('v3'), fee: int(1, MAX_ROUTE_FEE_TIER) }).strict(),
  z
    .object({
      venue: z.literal('v4'),
      fee: int(1, MAX_ROUTE_FEE_TIER),
      tickSpacing: int(1, MAX_TICK_SPACING),
      poolId: bytes32,
    })
    .strict(),
]);

const marketV2Schema = z
  .object({
    status: z.enum(V2_MARKET_STATUSES),
    wave: z.string().min(1),
    strikeTick: uint.refine((v) => v > 0n && v % 100n === 0n && v < 2n ** 64n, 'must be > 0, a multiple of 100 (PRICE_TICK) and fit uint64'),
    puts: z.boolean(),
    // INTERFACE_VERSION 7 (c05); optional so a v6 registry still parses.
    mintFeePpm: int(0, MINT_FEE_CEIL_PPM).nullable().optional(),
    univ3Pool: address.nullable().optional(),
    univ3MinLiquidity: uint.nullable().optional(),
    dataStreamsFeedId: bytes32.nullable().optional(),
    // INTERFACE_VERSION 8. Not `univ3Pool`: that stays the settlement TWAP source, and sharing one key would
    // have re-pointed settlement at a v4 pool the moment a payout route was added.
    payoutRoute: payoutRouteSchema.nullable().optional(),
    overrides: paramsPartial.optional(),
    registeredAt: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
    registerTx: bytes32.nullable().optional(),
  })
  .passthrough();

const registrySchema = z
  .object({
    shared: z
      .object({ chainId: z.number().int().positive().optional(), usdg: address.optional(), multicall3: address.optional() })
      .passthrough()
      .optional(),
    v2: v2BlockSchema.nullable().optional(),
    markets: z
      .array(
        z
          .object({
            ticker: z.string().regex(/^[A-Z0-9.]{1,8}$/, 'an upper-case ticker'),
            name: z.string().optional(),
            asset: address,
            feed: address,
            cboe: z.object({ root: z.string().regex(/^[A-Z]{1,6}$/, 'an upper-case option root'), url: httpsUrl }).passthrough().nullable().optional(),
            v2: marketV2Schema.nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

/*//////////////////////////////////////////////////////////////
                           RESOLUTION
//////////////////////////////////////////////////////////////*/

/** `base` with `layer`'s keys replacing it, one level into `ladder.<tenor>` and `expiriesAhead`. Pure. */
export function applyOverrides(base: MarketParams, layer: MarketOverrides | undefined): MarketParams {
  if (layer === undefined) return base;
  const ladder = (tenor: Tenor): LadderParams => ({ ...base.ladder[tenor], ...stripUndefined(layer.ladder?.[tenor]) });
  return {
    maxDeviationBps: layer.maxDeviationBps ?? base.maxDeviationBps,
    uncorroboratedDelayS: layer.uncorroboratedDelayS ?? base.uncorroboratedDelayS,
    spotMaxAgeS: layer.spotMaxAgeS ?? base.spotMaxAgeS,
    ladder: { weekly: ladder('weekly'), daily: ladder('daily') },
    expiriesAhead: { ...base.expiriesAhead, ...stripUndefined(layer.expiriesAhead) },
  };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/*//////////////////////////////////////////////////////////////
                             LOADING
//////////////////////////////////////////////////////////////*/

export class V2RegistryError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
    this.name = 'V2RegistryError';
  }
}

/** `markets.3.v2.strikeTick` → `markets[3] (TSLA).v2.strikeTick`: an operator edits by ticker. */
function describePath(path: ReadonlyArray<string | number>, json: unknown): string {
  if (path[0] === 'markets' && typeof path[1] === 'number') {
    const row = (json as { markets?: unknown[] }).markets?.[path[1]] as { ticker?: unknown } | undefined;
    const ticker = typeof row?.ticker === 'string' ? ` (${row.ticker})` : '';
    const rest = path.slice(2).join('.');
    return `markets[${path[1]}]${ticker}${rest === '' ? '' : `.${rest}`}`;
  }
  return path.join('.') || '(root)';
}

/** Parse a decoded registry. Throws V2RegistryError with every problem listed. */
export function parseV2Registry(json: unknown, path: string | null = null): V2Registry {
  const where = path === null ? 'the market registry' : `the market registry at ${path}`;
  const parsed = registrySchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${describePath(i.path, json)}: ${i.message}`);
    const shown = problems.slice(0, 30);
    const more = problems.length > shown.length ? `\n  … and ${problems.length - shown.length} more` : '';
    throw new V2RegistryError(`${where} is not usable:\n  ${shown.join('\n  ')}${more}`, problems);
  }
  const data = parsed.data;
  const problems: string[] = [];

  const block = data.v2 ?? null;
  if (block !== null && block.interfaceVersion !== INTERFACE_VERSION) {
    // A registry for another interface version describes contracts these bots cannot call correctly. The
    // refusal is total on purpose: the v7 set is still live for the run-off and ops/markets/v7-legacy.json
    // still describes it, so the mistake this catches is pointing a v8 bot at the frozen v7 file. The v7
    // bots keep reading it from their own v7 image; one process never serves both interface versions.
    problems.push(
      `v2.interfaceVersion: ${block.interfaceVersion}, but this keeper implements INTERFACE_VERSION ${INTERFACE_VERSION}` +
        (block.interfaceVersion === 7
          ? '. ops/markets/v7-legacy.json is the frozen v7 registry and is read by the v7 run-off image, not by this one'
          : ''),
    );
  }
  /** Whether the v8 rules below apply at all. A registry of another version is already refused above. */
  const isV8 = block !== null && block.interfaceVersion === INTERFACE_VERSION;

  // INTERFACE_VERSION 8's two fee rules, the exact INVERSIONS of v7's
  // (ops/markets/build-markets.mjs :782-810, which is the authoritative statement of both).
  const fees = block?.fees ?? null;
  const allowRent = fees?.allowRent ?? null;
  if (isV8 && fees !== null) {
    if (typeof fees.allowRent !== 'boolean') {
      problems.push(
        `${V8_ALLOW_RENT_KEY}: missing. INTERFACE_VERSION ${INTERFACE_VERSION} wants it stated as true or false, because it is what decides whether a non-zero v2.fees.mintFeePpm is legal; there is no safe default to assume`,
      );
    }
    // v7 refused a premium fee ABOVE the resale fee, because rent was the writer fee and a premium fee was
    // avoidable by writing into your own bid and reselling. v8 charges the writer on the first sale instead,
    // so the same relationship the other way round is now the refusal.
    if (fees.premiumFeeBps <= fees.resaleFeeBps) {
      problems.push(
        `v2.fees.premiumFeeBps ${fees.premiumFeeBps} is not above v2.fees.resaleFeeBps ${fees.resaleFeeBps}: from INTERFACE_VERSION ${INTERFACE_VERSION} the writer fee IS the premium fee, charged on the first sale of every long, there is no rent to fall back on, and a resale fee at or above it taxes market-maker round trips instead of writers`,
      );
    }
    // v7 refused a zero rate. v8 refuses anything but zero unless the registry opts in out loud, and refuses
    // an ABSENT rate too: a loader that quietly treated "no rent stated" as "no rent" would read a v7 file's
    // silence and a v8 file's 0 as the same thing.
    if (fees.mintFeePpm === null || fees.mintFeePpm === undefined) {
      problems.push(
        `v2.fees.mintFeePpm: missing. INTERFACE_VERSION ${INTERFACE_VERSION} states the rent dial explicitly — 0 on every v8 market — rather than leaving the bots to infer it from its absence`,
      );
    } else if (allowRent !== true && fees.mintFeePpm !== 0) {
      problems.push(
        `v2.fees.mintFeePpm is ${fees.mintFeePpm}, and INTERFACE_VERSION ${INTERFACE_VERSION} launches every market at 0 rent: the writer pays v2.fees.premiumFeeBps of the premium on first sale instead. Set ${V8_ALLOW_RENT_KEY}: true in the same commit if rent is genuinely being switched back on`,
      );
    }
  }

  // INTERFACE_VERSION 8 `v2.flywheel`, restated from ops/markets/build-markets.mjs :824-829 so a hand-edited
  // registry fails at boot rather than at the first crank.
  const flywheelBlock = block?.flywheel ?? null;
  if (flywheelBlock != null) {
    if ((flywheelBlock.buybackExecutor ?? null) !== null && (flywheelBlock.feeSplitter ?? null) === null) {
      problems.push('v2.flywheel.buybackExecutor is set while v2.flywheel.feeSplitter is null: the executor only ever spends the splitter\'s USDG');
    }
    if ((flywheelBlock.feeSplitter ?? null) !== null && (flywheelBlock.deployBlock ?? null) === null) {
      problems.push('v2.flywheel.feeSplitter is set but v2.flywheel.deployBlock is null: there is no block to start reading the flywheel from (the splitter is deployed before the core, so it is not v2.deployBlock)');
    }
  }

  const defaults = applyOverrides(SPEC_DEFAULTS, block?.defaults);

  const rawContracts = (block?.contracts ?? {}) as Partial<Record<V2ContractName, Address | null>> & {
    sources?: Partial<Record<V2SourceName, Address | null>> | null;
  };
  const contracts = Object.fromEntries(V2_CONTRACT_NAMES.map((name) => [name, rawContracts[name] ?? null])) as Record<V2ContractName, Address | null>;
  const sources = Object.fromEntries(V2_SOURCE_NAMES.map((name) => [name, rawContracts.sources?.[name] ?? null])) as Record<V2SourceName, Address | null>;

  const seenTickers = new Set<string>();
  const seenUnderlyings = new Map<string, string>();
  const markets: V2RegistryMarket[] = data.markets.map((m, index) => {
    if (seenTickers.has(m.ticker)) problems.push(`markets: ${m.ticker} is listed twice`);
    seenTickers.add(m.ticker);
    // Two rows on one token would build two ladders for the same underlying and double every crank.
    const other = seenUnderlyings.get(m.asset);
    if (other !== undefined) problems.push(`markets: ${m.ticker} and ${other} share the underlying ${m.asset}`);
    seenUnderlyings.set(m.asset, m.ticker);

    const v2 = m.v2 ?? null;
    // A market's own rate over the shared one, exactly as RegisterMarkets resolves V2_MARKET_<T>_MINT_FEE_PPM
    // over V2_MINT_FEE_PPM. This resolved value is what gets pinned into every series the market creates.
    const mintFeePpm = v2?.mintFeePpm ?? fees?.mintFeePpm ?? null;
    // Checked per market as well as registry-wide, because a registry at 0 with one stray market at 1500 ppm
    // still charges that market's writers rent (ops/markets/build-markets.mjs :1065-1081).
    if (isV8 && v2 !== null && allowRent !== true && mintFeePpm !== null && mintFeePpm !== 0) {
      problems.push(
        `markets[${index}] (${m.ticker}).v2.mintFeePpm resolves to ${mintFeePpm}, and INTERFACE_VERSION ${INTERFACE_VERSION} registers every market at 0 rent: the writer pays v2.fees.premiumFeeBps of the premium on first sale instead. Set ${V8_ALLOW_RENT_KEY}: true in the same commit if rent is genuinely being switched back on`,
      );
    }
    return {
      ticker: m.ticker,
      name: m.name ?? null,
      underlying: m.asset,
      feed: m.feed,
      cboe: m.cboe ? { root: m.cboe.root, url: m.cboe.url } : null,
      v2:
        v2 === null
          ? null
          : {
              status: v2.status,
              wave: v2.wave,
              strikeTick: v2.strikeTick,
              puts: v2.puts,
              // Resolved above, where the v8 rent rule reads the same value. null only on a registry that
              // states no rent anywhere, which the v8 rules already refuse.
              mintFeePpm,
              univ3Pool: v2.univ3Pool ?? null,
              univ3MinLiquidity: v2.univ3MinLiquidity ?? null,
              dataStreamsFeedId: v2.dataStreamsFeedId ?? null,
              payoutRoute: (v2.payoutRoute ?? null) as V2PayoutRoute | null,
              overrides: (v2.overrides ?? {}) as MarketOverrides,
              params: applyOverrides(defaults, v2.overrides),
              registeredAt: v2.registeredAt ?? null,
              registerTx: v2.registerTx ?? null,
            },
    };
  });

  if (problems.length > 0) throw new V2RegistryError(`${where} is not usable:\n  ${problems.join('\n  ')}`, problems);

  return {
    path,
    chainId: data.shared?.chainId ?? null,
    usdg: data.shared?.usdg ?? null,
    multicall3: data.shared?.multicall3 ?? null,
    hasV2Block: block !== null,
    interfaceVersion: block?.interfaceVersion ?? null,
    deployBlock: block?.deployBlock ?? null,
    contracts,
    sources,
    uniswapV3: block?.uniswapV3 ? { factory: block.uniswapV3.factory, swapRouter02: block.uniswapV3.swapRouter02, quoterV2: block.uniswapV3.quoterV2 } : null,
    fees: block?.fees
      ? {
          premiumFeeBps: block.fees.premiumFeeBps,
          mintFeePpm: block.fees.mintFeePpm ?? null,
          allowRent: block.fees.allowRent ?? null,
          resaleFeeBps: block.fees.resaleFeeBps,
          takerFeeFlat: block.fees.takerFeeFlat,
          takerFeeCapBps: block.fees.takerFeeCapBps,
          makerRebateBps: block.fees.makerRebateBps,
          exerciseFeeBps: block.fees.exerciseFeeBps,
        }
      : null,
    flywheel: flywheelBlock
      ? {
          feeSplitter: flywheelBlock.feeSplitter ?? null,
          buybackExecutor: flywheelBlock.buybackExecutor ?? null,
          deployBlock: flywheelBlock.deployBlock ?? null,
        }
      : null,
    vault: block?.vault
      ? {
          maxSeriesUnits: block.vault.maxSeriesUnits,
          maxTotalNotional: block.vault.maxTotalNotional,
          askToleranceBps: block.vault.askToleranceBps,
          maxBidBpsOfSpot: block.vault.maxBidBpsOfSpot,
          maxOrderLifetime: block.vault.maxOrderLifetime,
          maxDailyOutflow: block.vault.maxDailyOutflow,
        }
      : null,
    defaults,
    markets,
  };
}

/** Read and parse `path`. Throws V2RegistryError on an unreadable file, bad JSON or a bad registry. */
export function loadV2Registry(path: string): V2Registry {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new V2RegistryError(`cannot read the market registry at ${path}: ${reason}`, [`cannot read the file: ${reason}`]);
  }
  return parseV2Registry(json, path);
}

/*//////////////////////////////////////////////////////////////
                            ACCESSORS
//////////////////////////////////////////////////////////////*/

/**
 * The address of `name`, whichever block holds it: `v2.contracts` for a contract, `v2.flywheel` for the fee
 * splitter and the buyback executor. null when the registry does not carry it. One accessor so a caller never
 * has to know which of the two blocks a v8 address lives in.
 */
export function v2Address(registry: V2Registry, name: V2AddressName): Address | null {
  return isFlywheelName(name) ? (registry.flywheel?.[name] ?? null) : registry.contracts[name];
}

/** Narrowing helper for `v2Address`; exported because config.ts builds the same split. */
export function isFlywheelName(name: V2AddressName): name is V2FlywheelName {
  return (V2_FLYWHEEL_NAMES as readonly string[]).includes(name);
}

/** A market with its `v2` block known to be present. */
export type V2Market = V2RegistryMarket & { v2: V2MarketBlock };

/** Markets that have a `v2` block with one of `statuses` (default: live only), in file order. */
export function v2Markets(registry: V2Registry, statuses: readonly V2MarketStatus[] = ['live']): V2Market[] {
  return registry.markets.filter((m): m is V2Market => m.v2 !== null && statuses.includes(m.v2.status));
}

export function marketByTicker(registry: V2Registry, ticker: string): V2RegistryMarket | null {
  return registry.markets.find((m) => m.ticker === ticker) ?? null;
}

/** Case-insensitive on the address, since events and the indexer do not all checksum. */
export function marketByUnderlying(registry: V2Registry, underlying: string): V2RegistryMarket | null {
  const key = underlying.toLowerCase();
  return registry.markets.find((m) => m.underlying.toLowerCase() === key) ?? null;
}
