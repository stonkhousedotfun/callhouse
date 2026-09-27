import { ponder } from "ponder:registry";

import {
  FACTORY,
  V2_ACCESS_MANAGER,
  V2_BUYBACK_EXECUTOR,
  V2_CLEARINGHOUSE,
  V2_EARN_VAULT,
  V2_EXPIRY_CALENDAR,
  V2_HOUSE_START_BLOCK,
  V2_HOUSE_VAULT_FACTORY,
  V2_FEE_SPLITTER,
  V2_KEEPER_REWARDS,
  V2_MAKER_VAULT,
  V2_PAYOUT_ROUTER,
  V2_REWARDS_DISTRIBUTORS,
  V2_ZAP_HELPER,
  VAULT,
} from "./env";
import { houseSourceAnchor, v2KindedHouseFactorySources } from "../src/v2/houseVaultKind";
import { v2PriceSources } from "../src/v2/priceSourceRegistry";

/**
 * The three source groups, each either the real registry or a no-op.
 *
 * WHY THIS EXISTS. Ponder loads EVERY file under src/ at boot, whatever the config says, and its
 * build refuses to start when an indexing function names a contract the config does not have:
 * `Validation failed: Invalid event 'Vault:Transfer' uses an unrecognized contract ... name`. The
 * sources are conditional (ponder.config.ts registers the vault sources only when VAULT_ADDRESS is
 * set and the factory sources only when FACTORY_ADDRESS is), so the handler registrations have to
 * be conditional in the same way, or a factory-only deployment could not build at all.
 *
 * Wrapping every `ponder.on` in src/vault.ts in an `if` would re-indent 1,400 lines of a handler
 * file that is not supposed to change for the NVDA vault. Swapping its import for `vaultPonder`
 * changes one line and nothing else: with VAULT_ADDRESS set it IS `ponder`, the same singleton the
 * build reads `fns` from, so the registrations are the ones the vault had before. Without it every
 * `on` is a no-op and the file loads as an inert module.
 *
 * Typed as `typeof ponder` so a handler's `event`, `context` and `event.args` keep their inferred
 * shapes either way; the no-op never sees an event.
 */
const inert = { on: () => undefined } as unknown as typeof ponder;

/** src/vault.ts, src/seaport.ts, src/token.ts, src/valorem.ts: the pooled vault's handlers. */
export const vaultPonder: typeof ponder = VAULT === undefined ? inert : ponder;

/** src/factory.ts, src/writerAccount.ts: the factory market's handlers. */
export const factoryPonder: typeof ponder = FACTORY === undefined ? inert : ponder;

/** One v2 Clearinghouse contains every v2 market; its handlers are inert in v1-only mode. */
export function hasV2(): boolean {
  return V2_CLEARINGHOUSE !== undefined;
}

/** src/v2/* handlers. Use this instead of ponder directly so a v1-only build stays valid. */
export const v2Ponder: typeof ponder = hasV2() ? ponder : inert;

/** Optional periphery events are registered only when their individual address is present. */
export const v2CalendarPonder: typeof ponder = V2_EXPIRY_CALENDAR === undefined ? inert : ponder;
export const v2RewardsPonder: typeof ponder = V2_KEEPER_REWARDS === undefined ? inert : ponder;
export const v2AccessManagerPonder: typeof ponder = V2_ACCESS_MANAGER === undefined ? inert : ponder;
export const v2FeeSplitterPonder: typeof ponder = V2_FEE_SPLITTER === undefined ? inert : ponder;
export const v2BuybackExecutorPonder: typeof ponder = V2_BUYBACK_EXECUTOR === undefined ? inert : ponder;
export const v2PayoutRouterPonder: typeof ponder = V2_PAYOUT_ROUTER === undefined ? inert : ponder;
export const v2MakerVaultPonder: typeof ponder = V2_MAKER_VAULT === undefined ? inert : ponder;
export const v2RewardsDistributorPonder: typeof ponder = V2_REWARDS_DISTRIBUTORS.length === 0 ? inert : ponder;

/**
 * P8 lending periphery. `v2EarnVaultPonder` is the LENDING vault, not the `/earn` covered-call
 * writing surface; see src/v2/earn.ts. Both are inert until their address is configured, so a
 * deployment without the periphery still builds.
 */
export const v2EarnVaultPonder: typeof ponder = V2_EARN_VAULT === undefined ? inert : ponder;
export const v2ZapPonder: typeof ponder = V2_ZAP_HELPER === undefined ? inert : ponder;

/**
 * House vaults. Do not reuse v2MakerVaultPonder. Three gates, because ponder.config.ts registers three
 * House sources independently, and a handler whose source is absent fails the build:
 *
 *   v2HouseVaultPonder               `HouseVaultFactory:*`, the LAUNCH factory: live when V2_HOUSE_VAULT_FACTORY is set.
 *   v2HouseVaultKindedFactoryPonder  `HouseVaultFactoryKinded:*`, the (daily) factories from the registry, and
 *                                    V2_HOUSE_VAULT_FACTORY when the registry names no such factory.
 *   v2HouseVaultEventsPonder         `HouseVault:*`: live when either factory anchors the HouseVault source.
 *
 * A daily-only registry (`v2.contracts.houseVaultFactory` null) leaves the first inert and the other two live, so its
 * vaults are indexed. Each gate is computed by the same functions ponder.config.ts calls (src/v2/houseVaultKind.ts).
 */
const kindedHouse = v2KindedHouseFactorySources(V2_CLEARINGHOUSE, V2_HOUSE_START_BLOCK, V2_HOUSE_VAULT_FACTORY);
export const v2HouseVaultPonder: typeof ponder = V2_HOUSE_VAULT_FACTORY === undefined ? inert : ponder;
export const v2HouseVaultKindedFactoryPonder: typeof ponder = kindedHouse === undefined ? inert : ponder;
export const v2HouseVaultEventsPonder: typeof ponder =
  houseSourceAnchor(V2_HOUSE_VAULT_FACTORY, V2_HOUSE_START_BLOCK, kindedHouse) === undefined ? inert : ponder;

/**
 * A change shared price sources. Registered from the registry, not env, and only when V2_CLEARINGHOUSE
 * is the registry's own clearinghouse: see src/v2/priceSourceRegistry.ts, which ponder.config.ts
 * calls with the same value, so a handler is live exactly when its source is configured.
 */
const priceSources = v2PriceSources(V2_CLEARINGHOUSE)?.addresses;
export const v2ChainlinkSourcePonder: typeof ponder = priceSources?.ChainlinkFeedSource === undefined ? inert : ponder;
export const v2UniV3SourcePonder: typeof ponder = priceSources?.UniV3TwapSource === undefined ? inert : ponder;
export const v2DataStreamsSourcePonder: typeof ponder = priceSources?.DataStreamsSource === undefined ? inert : ponder;
