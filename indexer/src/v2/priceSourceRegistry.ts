import { getAddress, isAddress, zeroAddress, type Address } from "viem";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";

/**
 * The three shared price sources, read from the registry and nowhere else.
 *
 * ChainlinkFeedSource, UniV3TwapSource and DataStreamsSource are singletons every market's
 * SettlementOracle config points at. Their addresses live in ops/markets/tier1.json
 * `v2.contracts.sources`, compiled into lib/v2/marketRegistry.generated.ts; no env var carries them
 * and none is added here, so there is no second place an address can be typed by hand.
 *
 * THE REGISTRY DESCRIBES ONE DEPLOYMENT. A process indexing a different Clearinghouse (a dev or
 * rehearsal deployment) must not pick up the production sources, or it would index the right
 * contracts for the wrong book and nothing downstream could tell. So the sources register only
 * when the configured V2_CLEARINGHOUSE IS the registry's clearinghouse. That drop is the dev
 * footing only: a V2_PRODUCTION=1 process refuses boot on it before this runs, and a dev process
 * warns and reports it at /v2/health/registry (src/v2/registryClearinghouse.ts).
 *
 * START BLOCK is the registry's `v2.deployBlock`. That is safe only because every source was
 * created at or after it (Etherscan V2 getcontractcreation, chain 4663, 2026-09-22: chainlink
 * 69512765, univ3 69512771, dataStreams 69512777, against deployBlock 69512673). A source that
 * starts before its creation block only backfills empty blocks; one that starts after it drops logs
 * silently. A later redeploy of one source to a new address must move this block with it.
 *
 * FAIL CLOSED. A null source is "not deployed" and is skipped. A malformed or zero address, or a
 * non-null source with no deploy block, throws: a source pointed at the zero address indexes
 * nothing and looks configured, and one with no start block would scan from genesis.
 */
export const PRICE_SOURCE_NAMES = ["ChainlinkFeedSource", "UniV3TwapSource", "DataStreamsSource"] as const;
export type PriceSourceName = (typeof PRICE_SOURCE_NAMES)[number];

/** The registry field each Ponder source reads. */
export const PRICE_SOURCE_REGISTRY_KEY: Record<PriceSourceName, string> = {
  ChainlinkFeedSource: "chainlink",
  UniV3TwapSource: "univ3",
  DataStreamsSource: "dataStreams",
};

export type PriceSources = {
  startBlock: number;
  addresses: Partial<Record<PriceSourceName, Address>>;
};

type RegistryShape = {
  deployBlock: number | null;
  contracts: { clearinghouse: string | null; sources?: Readonly<Record<string, string | null>> };
};

export function priceSourcesFor(clearinghouse: Address | undefined, registry: RegistryShape): PriceSources | undefined {
  if (clearinghouse === undefined) return undefined;
  const own = registry.contracts.clearinghouse;
  if (own === null || own.toLowerCase() !== clearinghouse.toLowerCase()) return undefined;

  const addresses: Partial<Record<PriceSourceName, Address>> = {};
  for (const name of PRICE_SOURCE_NAMES) {
    const field = PRICE_SOURCE_REGISTRY_KEY[name];
    const raw = registry.contracts.sources?.[field] ?? null;
    if (raw === null) continue;
    if (!isAddress(raw, { strict: false })) {
      throw new Error(`[callhouse/indexer] registry v2.contracts.sources.${field}="${raw}" is not an address.`);
    }
    const address = getAddress(raw);
    if (address === zeroAddress) {
      throw new Error(`[callhouse/indexer] registry v2.contracts.sources.${field} is the zero address.`);
    }
    addresses[name] = address;
  }
  if (Object.keys(addresses).length === 0) return undefined;

  const startBlock = registry.deployBlock;
  if (startBlock === null || !Number.isSafeInteger(startBlock) || startBlock <= 0) {
    throw new Error("[callhouse/indexer] registry v2.contracts.sources is set but v2.deployBlock is not a block above zero.");
  }
  return { startBlock, addresses };
}

/**
 * What a process whose V2_CLEARINGHOUSE is `clearinghouse` registers. ponder.config.ts (the sources)
 * and lib/registry.ts (the handler gates) both call this with the same env value, so the two cannot
 * disagree. This module does not import lib/env itself: env.ts throws at import without a
 * configured deployment, and the decision above has to stay testable without one.
 */
export function v2PriceSources(clearinghouse: Address | undefined): PriceSources | undefined {
  return priceSourcesFor(clearinghouse, V2_REGISTRY);
}
