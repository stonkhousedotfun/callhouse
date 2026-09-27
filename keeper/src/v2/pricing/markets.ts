/**
 * The markets the pricing service can price, read from the registry (ops/markets/tier1.json).
 *
 * Only what pricing needs: the ticker, the Stock Token's Chainlink feed (the token spot) and the
 * Cboe chain (`cboe.root`, `cboe.url`), plus the registry's own freshness defaults. The full v2
 * registry loader (the `v2` blocks, ladders, contract addresses) belongs to src/v2/registry.ts;
 * this reads the fields that already exist today and ignores everything else, so it keeps working
 * as that file grows.
 *
 * Strict like config.ts: a registry this service cannot trust refuses to boot, with every problem
 * listed, instead of pricing some markets against a wrong feed. A market with no `cboe` block is
 * kept (it has a spot) and every price for it is refused as `chain-unavailable`.
 *
 * IDENTITY. `token` is the registry's canonical Stock Token for the market: `asset`, the
 * chain id from `shared.chainId` and `verification.uiMultiplier`, each null when the registry does not
 * carry it. It is informational (pricing provenance and identity checks); a missing or malformed value
 * leaves the market unmapped instead of refusing the boot, and `token` is absent when there is no
 * valid `asset`. There is no issuer field in the registry, so the canonical issuer is null.
 *
 * POOL. `pool` is the market's Uniswap v3 USDG pool for the second spot (pool-spot.ts):
 * `v2.univ3Pool`, its harmonic-mean liquidity floor `v2.univ3MinLiquidity`, and `shared.usdg`, the
 * quote token the pool must hold. Absent when the registry names no pool (the market prices on
 * Chainlink alone, as before). A pool the registry names but this service cannot read (a bad
 * address, a floor that is not a positive integer, no `shared.usdg`) REFUSES THE BOOT: a half-read
 * pool would silently drop the second spot for that market.
 */
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import type { PricingPool } from './pool-spot.js';

export interface PricingMarket {
  ticker: string;
  feed: Address;
  cboe: { root: string; url: string } | null;
  token?: { chainId: number | null; address: Address; uiMultiplier: string | null };
  /** The registry's v3 pool for the pool spot (pool-spot.ts); absent when it names none. */
  pool?: PricingPool;
}

export interface PricingRegistry {
  markets: ReadonlyMap<string, PricingMarket>;
  /** `defaults.maxPriceAgeS`: v1's staleness limit for the feed and the chain. */
  maxPriceAgeS: number | null;
  /** `defaults.maxSpotDivergenceBps`: v1's token-vs-Cboe spot limit. */
  maxSpotDivergenceBps: number | null;
}

const address = z.string().refine((raw) => isAddress(raw, { strict: false }), 'not a 20-byte hex address').transform((raw) => getAddress(raw));

const httpsUrl = z.string().refine((raw) => {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}, 'not an https URL');

const chainIdSchema = z.number().int().positive();
/** `v2.univ3MinLiquidity`: pool L units, a positive decimal integer below 2^128 (build-markets.mjs). */
const minLiquiditySchema = z.string().regex(/^[1-9]\d{0,38}$/).refine((raw) => BigInt(raw) < 1n << 128n, 'above uint128');

/** The token's uiMultiplier as the registry verified it: a decimal integer string (1e18-scaled). */
const uiMultiplierSchema = z.string().regex(/^[1-9]\d{0,40}$/);

const registrySchema = z.object({
  defaults: z
    .object({
      maxPriceAgeS: z.number().int().positive().optional(),
      maxSpotDivergenceBps: z.number().int().positive().optional(),
    })
    .passthrough()
    .optional(),
  markets: z
    .array(
      z
        .object({
          ticker: z.string().regex(/^[A-Z0-9.]{1,8}$/, 'an upper-case ticker'),
          feed: address,
          cboe: z.object({ root: z.string().regex(/^[A-Z]{1,6}$/, 'an upper-case option root'), url: httpsUrl }).passthrough().nullable().optional(),
        })
        .passthrough(),
    )
    .min(1),
});

/** Parse a decoded registry. Throws with every problem listed. */
export function parsePricingRegistry(json: unknown): PricingRegistry {
  const parsed = registrySchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 20).map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`the market registry is not usable for pricing:\n${lines.join('\n')}`);
  }
  const markets = new Map<string, PricingMarket>();
  const shared = (json as { shared?: { chainId?: unknown; usdg?: unknown } } | null)?.shared;
  const chainId = chainIdSchema.safeParse(shared?.chainId);
  const usdg = address.safeParse(shared?.usdg);
  const poolProblems: string[] = [];
  for (const m of parsed.data.markets) {
    if (markets.has(m.ticker)) throw new Error(`the market registry lists ${m.ticker} twice`);
    const market: PricingMarket = { ticker: m.ticker, feed: m.feed, cboe: m.cboe ? { root: m.cboe.root, url: m.cboe.url } : null };
    const asset = address.safeParse((m as { asset?: unknown }).asset);
    if (asset.success) {
      const ui = uiMultiplierSchema.safeParse((m as { verification?: { uiMultiplier?: unknown } }).verification?.uiMultiplier);
      market.token = { chainId: chainId.success ? chainId.data : null, address: asset.data, uiMultiplier: ui.success ? ui.data : null };
    }
    const v2 = (m as { v2?: { univ3Pool?: unknown; univ3MinLiquidity?: unknown } }).v2;
    if (v2?.univ3Pool !== undefined && v2.univ3Pool !== null) {
      const pool = address.safeParse(v2.univ3Pool);
      const floor = minLiquiditySchema.safeParse(v2.univ3MinLiquidity);
      if (!pool.success) poolProblems.push(`  markets.${m.ticker}.v2.univ3Pool: not a 20-byte hex address`);
      if (!floor.success) poolProblems.push(`  markets.${m.ticker}.v2.univ3MinLiquidity: not a positive uint128 decimal string`);
      if (!usdg.success) poolProblems.push(`  shared.usdg: required when ${m.ticker} names a v2.univ3Pool`);
      if (!asset.success) poolProblems.push(`  markets.${m.ticker}.asset: required when it names a v2.univ3Pool`);
      if (pool.success && floor.success && usdg.success && asset.success) {
        market.pool = { address: pool.data, minLiquidity: BigInt(floor.data), usdg: usdg.data };
      }
    }
    markets.set(m.ticker, market);
  }
  if (poolProblems.length > 0) throw new Error(`the market registry is not usable for pricing:\n${[...new Set(poolProblems)].join('\n')}`);
  return {
    markets,
    maxPriceAgeS: parsed.data.defaults?.maxPriceAgeS ?? null,
    maxSpotDivergenceBps: parsed.data.defaults?.maxSpotDivergenceBps ?? null,
  };
}

export function loadPricingRegistry(path: string): PricingRegistry {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the market registry at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsePricingRegistry(json);
}
