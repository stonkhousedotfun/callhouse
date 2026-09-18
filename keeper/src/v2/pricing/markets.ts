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
 */
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';

export interface PricingMarket {
  ticker: string;
  feed: Address;
  cboe: { root: string; url: string } | null;
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
  for (const m of parsed.data.markets) {
    if (markets.has(m.ticker)) throw new Error(`the market registry lists ${m.ticker} twice`);
    markets.set(m.ticker, { ticker: m.ticker, feed: m.feed, cboe: m.cboe ? { root: m.cboe.root, url: m.cboe.url } : null });
  }
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
