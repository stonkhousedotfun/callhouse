import { createConfig, factory } from "ponder";
import { getAbiItem, type Address } from "viem";

import { accountFactoryAbi } from "./abis/accountFactory";
import { erc20Abi } from "./abis/erc20";
import { stockTokenAbi } from "./abis/stockToken";
import { seaportAbi } from "./abis/seaport";
import { valoremClearAbi } from "./abis/valoremClear";
import { vaultAbi } from "./abis/vault";
import { writerAccountAbi } from "./abis/writerAccount";
import { accessManagerAbi } from "./abis/v2/accessManager";
import { autoRollerAbi } from "./abis/v2/autoRoller";
import { buybackExecutorAbi } from "./abis/v2/buybackExecutor";
import { chainlinkFeedSourceAbi } from "./abis/v2/chainlinkFeedSource";
import { dataStreamsSourceAbi } from "./abis/v2/dataStreamsSource";
import { earnVaultAbi } from "./abis/v2/earnVault";
import { houseVaultAbi } from "./abis/v2/houseVault";
import { houseVaultFactoryAbi } from "./abis/v2/houseVaultFactory";
import { houseVaultFactoryIndexingAbi } from "./lib/v2/houseVaultEvents";
import { stockZapAbi } from "./abis/v2/stockZap";
import { clearinghouseAbi } from "./abis/v2/clearinghouse";
import { expiryCalendarAbi } from "./abis/v2/expiryCalendar";
import { feeSplitterAbi } from "./abis/v2/feeSplitter";
import { keeperRewardsAbi } from "./abis/v2/keeperRewards";
import { makerVaultAbi } from "./abis/v2/makerVault";
import { makerRegistryAbi } from "./abis/v2/makerRegistry";
import { orderBookAbi } from "./abis/v2/orderBook";
import { payoutAdapterAbi } from "./abis/v2/payoutAdapter";
import { rewardsDistributorAbi } from "./abis/v2/rewardsDistributor";
import { settlementOracleAbi } from "./abis/v2/settlementOracle";
import { uniV3TwapSourceAbi } from "./abis/v2/uniV3TwapSource";
import {
  ASSET,
  CHAIN_ID,
  CLEARINGHOUSE,
  END_BLOCK,
  ETH_GET_LOGS_BLOCK_RANGE,
  FACTORY,
  PGLITE_DIRECTORY,
  RPC_URL,
  SEAPORT,
  START_BLOCK,
  USDG,
  VAULT,
  V2_ACCESS_MANAGER,
  V2_AUTO_ROLLER,
  V2_BUYBACK_EXECUTOR,
  V2_CLEARINGHOUSE,
  V2_EARN_START_BLOCK,
  V2_EARN_VAULT,
  V2_EXPIRY_CALENDAR,
  V2_FEE_SPLITTER,
  V2_FLYWHEEL_START_BLOCK,
  V2_HOUSE_START_BLOCK,
  V2_HOUSE_VAULT_FACTORY,
  V2_KEEPER_REWARDS,
  V2_MAKER_VAULT,
  V2_MAKER_REGISTRY,
  V2_ORDER_BOOK,
  V2_PAYOUT_ROUTER,
  V2_PRODUCTION,
  V2_ZAP_HELPER,
  V2_REWARDS_DISTRIBUTORS,
  V2_SETTLEMENT_ORACLE,
  V2_START_BLOCK,
} from "./lib/env";
import { ethGetLogsBlockRange, maxAddressesPerGetLogs } from "./lib/getLogsRange";
import { v2AssertProductionHouseFactory, v2HouseVaultSource } from "./lib/v2/houseVaultSource";
import { houseDiscoveryEvent, houseSourceAnchor, v2KindedHouseFactorySources, type KindedHouseFactorySources } from "./src/v2/houseVaultKind";
import { v2PriceSources } from "./src/v2/priceSourceRegistry";
import { v2AssertRegistryClearinghouse } from "./src/v2/registryClearinghouse";

/**
 * Stonkhouse indexer — chain 4663 (Robinhood Chain mainnet). V2 indexes all markets through
 * one Clearinghouse; optional legacy groups retain their one-product-per-process behavior.
 *
 * TWO PRODUCTS, TWO GROUPS OF SOURCES, EACH REGISTERED ONLY WHEN ITS ADDRESS IS SET:
 *
 *   VAULT_ADDRESS    the pooled vault, exactly as it has been indexed since the redesign. Every
 *                    source in `vaultContracts` is unchanged; the NVDA deployment sets this and
 *                    nothing else and behaves as before.
 *   FACTORY_ADDRESS  a factory market (contracts/src/solo/): the `AccountFactory` and the
 *                    `WriterAccount` clones it creates. Tier 1 of the multi-market plan runs ONE
 *                    process per market, with this, `MARKET` and `START_BLOCK` = that market's
 *                    deploy block from ops/markets/tier1.json. There is no multi-factory config.
 *
 * Both may be set (the NVDA deployment, if it ever wants the factory tape beside the vault's);
 * v2 may be set with either or on its own. An entirely empty config is refused by lib/env.ts.
 * The handler registrations follow the same switch
 * (lib/registry.ts), because Ponder refuses to build an indexing function whose contract is not
 * in the config.
 *
 * The vault's sources, and why each one is here:
 *
 *   Vault          every event the vault emits. This is the primary record, and under write on
 *                  fill it is also the clock: `RollOpen` is what creates a week in the tape (the
 *                  vault numbers its own cycles; there is no registry), and `CallsWritten` fires
 *                  once per Seaport fill with that fill's size.
 *   Clear          Valorem. Writes and redemptions are topic-filtered to the vault; exercise
 *                  and bucket-assignment events cannot be (the vault is not a topic on
 *                  them), so they are filtered in the handler against the option id we armed.
 *                  Valorem's whole log history on this chain is tiny, so that is cheap.
 *   Seaport        `OrderFulfilled` topic-filtered to the vault as offerer. Every fill of the
 *                  vault's PARTIAL_RESTRICTED listing (zone == the vault) lands here with the
 *                  contracts moved and the USDG paid; the vault's `CallsWritten` in the same
 *                  transaction is the write it caused.
 *   StockTokenIn /
 *   StockTokenOut  asset movements in and out of the vault, which give an exact running
 *                  balance without an RPC read. Two sources because a log filter ANDs its
 *                  topics: `from == vault` and `to == vault` cannot be ORed in one filter.
 *   UsdgIn /
 *   UsdgOut        the same trick for USDG, so the vault's premium balance is exact and the
 *                  harvest accounting can be checked against it without an RPC read.
 *   StockToken     the issuer's switches: oracle pause, transfer pause, and the ERC-8056
 *                  multiplier. A paused oracle blocks every arm and every fill, and a transfer
 *                  freeze blocks settlement. Neither is something we can code around, so both
 *                  are indexed and published.
 *
 * The factory market's sources:
 *
 *   Factory        every event the `AccountFactory` emits: accounts created and rekeyed, the
 *                  week (`WeekSet` is the clock here: the factory numbers its own weeks), the
 *                  halt switch, policy / fee recipient / cap changes, and the roles.
 *   WriterAccount  every event of every clone, with the address set resolved by Ponder from the
 *                  factory's `AccountCreated(owner, account, index)` — the `factory()` address
 *                  pattern, keyed on the `account` parameter. A clone's events are delivered from
 *                  the block it was created in.
 *
 *   NOT a source for the factory market, on purpose: Seaport and the two tokens. A `filter` narrows
 *   topics to fixed addresses and the set of clones is dynamic, so neither could be filtered to
 *   the accounts, and unfiltered they are the whole chain's transfer history. `LotFilled` carries
 *   the order hash and the premium, which is the fill; balances are not derivable and the API
 *   says so. Nor is the Clear: the account handlers are log-only and every figure the tape needs
 *   is in the clone's own events.
 *
 * Legacy sources start at START_BLOCK; v2 sources start at V2_START_BLOCK. END_BLOCK is normally
 * unset — production follows the head — and exists to bound a replay or smoke test.
 */

const chain = "robinhood" as const;

/** The pooled vault's eight sources. Unchanged from the single-product config. */
function vaultContracts(vault: Address) {
  return {
    Vault: {
      abi: vaultAbi,
      chain,
      address: vault,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },

    Clear: {
      abi: valoremClearAbi,
      chain,
      address: CLEARINGHOUSE,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [
        // `writer` is topic2 on OptionsWritten, `redeemer` is topic3 on ClaimRedeemed, so
        // both narrow to the vault at the node. The other three Valorem events carry no
        // address for us, only an optionId or a claimId, and are filtered in the handlers.
        { event: "OptionsWritten" as const, args: { writer: vault } },
        { event: "ClaimRedeemed" as const, args: { redeemer: vault } },
      ],
    },

    Seaport: {
      abi: seaportAbi,
      chain,
      address: SEAPORT,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [
        { event: "OrderFulfilled" as const, args: { offerer: vault } },
        { event: "OrderCancelled" as const, args: { offerer: vault } },
        { event: "CounterIncremented" as const, args: { offerer: vault } },
      ],
    },

    StockTokenIn: {
      abi: stockTokenAbi,
      chain,
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer" as const, args: { to: vault } }],
    },

    StockTokenOut: {
      abi: stockTokenAbi,
      chain,
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer" as const, args: { from: vault } }],
    },

    // The issuer's own switches. Unfiltered by address on purpose: they are contract-wide and
    // carry no counterparty, and every one of them can stop this vault dead.
    StockToken: {
      abi: stockTokenAbi,
      chain,
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },

    UsdgIn: {
      abi: erc20Abi,
      chain,
      address: USDG,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer" as const, args: { to: vault } }],
    },

    UsdgOut: {
      abi: erc20Abi,
      chain,
      address: USDG,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer" as const, args: { from: vault } }],
    },
  };
}

/** The factory market's two sources. */
function factoryContracts(factoryAddress: Address) {
  return {
    Factory: {
      abi: accountFactoryAbi,
      chain,
      address: factoryAddress,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },

    WriterAccount: {
      abi: writerAccountAbi,
      chain,
      // Ponder watches the factory for `AccountCreated` and adds each `account` to this source's
      // address set from the block it appears in. The child's start block must not precede the
      // factory's; both are START_BLOCK.
      address: factory({
        address: factoryAddress,
        event: getAbiItem({ abi: accountFactoryAbi, name: "AccountCreated" }),
        parameter: "account",
        startBlock: START_BLOCK,
        endBlock: END_BLOCK,
      }),
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },
  };
}

/** All v2 markets are emitted by this one group of deployed contracts. */
function v2Contracts() {
  if (
    V2_CLEARINGHOUSE === undefined ||
    V2_ORDER_BOOK === undefined ||
    V2_SETTLEMENT_ORACLE === undefined ||
    V2_AUTO_ROLLER === undefined ||
    V2_MAKER_REGISTRY === undefined ||
    V2_START_BLOCK === undefined
  ) {
    throw new Error("[callhouse/indexer] v2Contracts called without a complete v2 deployment");
  }
  return {
    Clearinghouse: {
      abi: clearinghouseAbi,
      chain,
      address: V2_CLEARINGHOUSE,
      startBlock: V2_START_BLOCK,
      endBlock: END_BLOCK,
    },
    OrderBook: {
      abi: orderBookAbi,
      chain,
      address: V2_ORDER_BOOK,
      startBlock: V2_START_BLOCK,
      endBlock: END_BLOCK,
    },
    SettlementOracle: {
      abi: settlementOracleAbi,
      chain,
      address: V2_SETTLEMENT_ORACLE,
      startBlock: V2_START_BLOCK,
      endBlock: END_BLOCK,
    },
    AutoRoller: {
      abi: autoRollerAbi,
      chain,
      address: V2_AUTO_ROLLER,
      startBlock: V2_START_BLOCK,
      endBlock: END_BLOCK,
    },
    MakerRegistry: {
      abi: makerRegistryAbi,
      chain,
      address: V2_MAKER_REGISTRY,
      startBlock: V2_START_BLOCK,
      endBlock: END_BLOCK,
    },
  };
}

function expiryCalendarContract(address: Address) {
  return { ExpiryCalendar: { abi: expiryCalendarAbi, chain, address, startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

function keeperRewardsContract(address: Address) {
  return { KeeperRewards: { abi: keeperRewardsAbi, chain, address, startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

function accessManagerContract(address: Address) {
  return { AccessManager: { abi: accessManagerAbi, chain, address, startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

function payoutRouterContract(address: Address) {
  return { PayoutRouter: { abi: payoutAdapterAbi, chain, address, startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

function feeSplitterContract(address: Address) {
  return { FeeSplitter: { abi: feeSplitterAbi, chain, address, startBlock: V2_FLYWHEEL_START_BLOCK!, endBlock: END_BLOCK } };
}

function buybackExecutorContract(address: Address) {
  return { BuybackExecutor: { abi: buybackExecutorAbi, chain, address, startBlock: V2_FLYWHEEL_START_BLOCK!, endBlock: END_BLOCK } };
}

function makerVaultContract(address: Address) {
  return { MakerVault: { abi: makerVaultAbi, chain, address, startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

function rewardsDistributorContract(addresses: readonly Address[]) {
  return { RewardsDistributor: { abi: rewardsDistributorAbi, chain, address: [...addresses], startBlock: V2_START_BLOCK!, endBlock: END_BLOCK } };
}

/**
 * The HouseVaultFactory ABI the configured factory is indexed with: the generated ABI with its
 * `VaultCreated` swapped for the LEGACY 4-field fragment (lib/v2/houseVaultEvents.ts).
 *
 * WHY. A change appended `bool weekly` to `VaultCreated`, which changes the event's topic, and the generated
 * abis/v2/houseVaultFactory.ts follows the contracts. V2_HOUSE_VAULT_FACTORY is the launch factory
 * (registry `v2.contracts.houseVaultFactory`), compiled BEFORE kinding: it emits the 4-field event. Indexed
 * with the generated ABI, `factory()` below would watch a topic that factory never emits, and on any resync
 * the indexer would discover ZERO House vaults -- while abi.test and eventCoverage stayed green, because they
 * compare the generated file with ops/abis rather than with the live topic (houseVault.handler.test.ts pins
 * both topics and this choice). A kinded factory needs the generated event and its own source: that is
 * HouseVaultFactoryKinded below, addressed from the registry's v2.house.factories, not from env.
 * Without them a daily factory's VaultCreated was never indexed, so its vaults got
 * no v2HouseVault row. It is a second source rather than an addition to this ABI because two VaultCreated
 * overloads make Ponder demand full-signature handler names (ponder utils/abi.js toSafeName).
 */
const legacyHouseVaultFactoryAbi = [
  // An explicit tuple, not a `.filter()` of the generated ABI: a filtered array loses the literal types the
  // virtual `ponder:registry` event typing is derived from. The source indexes events only; the factory's
  // two events are both here (eventCoverage compares this list with the export).
  getAbiItem({ abi: houseVaultFactoryAbi, name: "AuthorityUpdated" }),
  ...houseVaultFactoryIndexingAbi,
] as const;

/**
 * House vaults: the launch factory (HouseVaultFactory, legacy event), the kinded factories
 * (HouseVaultFactoryKinded), and the vaults (HouseVault). Each registers only when configured, and
 * lib/registry.ts gates the handlers on the same three decisions.
 *
 * The vaults are a plain address list from the generated registry (lib/v2/houseVaultSource.ts says why):
 * with `factory()` Ponder could bloom-test only the topics, and the HouseVault `Transfer` topic is in almost every
 * block on 4663, so realtime paid an `eth_getLogs` per block. The factory stays a source so `VaultCreated` still
 * fires for a vault the registry lacks; the handler raises HOUSE_VAULT_UNREGISTERED for it. A factory the registry
 * does not name (dev, rehearsal, fork) or a registry with no vault yet keeps `factory()` discovery, and says so here.
 */
function houseVaultFactoryContract(factoryAddress: Address) {
  if (V2_HOUSE_START_BLOCK === undefined) {
    throw new Error("[callhouse/indexer] houseVaultFactoryContract called without V2_HOUSE_START_BLOCK");
  }
  return {
    HouseVaultFactory: {
      abi: legacyHouseVaultFactoryAbi,
      chain,
      address: factoryAddress,
      startBlock: V2_HOUSE_START_BLOCK,
      endBlock: END_BLOCK,
    },
  };
}

/**
 * The (daily) factories: their own source, with the GENERATED 5-field `VaultCreated`, because the
 * launch source above watches the legacy topic and these factories never emit it. Addresses and start block come from
 * the registry's `v2.house.factories` (src/v2/houseVaultKind.ts v2KindedHouseFactorySources), never from env, so a
 * daily-only registry (`v2.contracts.houseVaultFactory` null, no V2_HOUSE_VAULT_FACTORY) still indexes its vaults.
 * Both factory events are here, as on the launch source (eventCoverage compares this list with the export).
 *
 * (v9). The registry's LAUNCH factory is in this list too whenever the launch source is configured, at
 * V2_HOUSE_START_BLOCK: the v9 launch factory is compiled after kinding and emits only the 5-field event, which the
 * launch source never matches. A legacy launch factory never emits it, so the two sources never both match a log.
 *
 * And V2_HOUSE_VAULT_FACTORY itself, at V2_HOUSE_START_BLOCK, when the registry names no such House factory
 * (dev, rehearsal, a fork; any Clearinghouse): a v9 factory there has its vaults discovered by the HouseVault factory()
 * fallback on the 5-field topic, and without this entry that same event reached no handler, so none of its vaults got
 * a v2HouseVault row.
 */
const kindedHouseVaultFactoryAbi = [
  getAbiItem({ abi: houseVaultFactoryAbi, name: "AuthorityUpdated" }),
  getAbiItem({ abi: houseVaultFactoryAbi, name: "VaultCreated" }),
] as const;

function houseVaultKindedFactoryContract(kinded: KindedHouseFactorySources) {
  return {
    HouseVaultFactoryKinded: {
      abi: kindedHouseVaultFactoryAbi,
      chain,
      address: [...kinded.addresses],
      startBlock: kinded.startBlock,
      endBlock: END_BLOCK,
    },
  };
}

/**
 * The HouseVault source, decided from the launch factory when it is configured and otherwise from the kinded one
 * (houseSourceAnchor). In registry mode the address list is every vault the registry names, weekly and daily alike.
 * The factory() fallback discovers with the event the anchoring factory emits (houseVaultDiscovery).
 */
function houseVaultContract(anchor: NonNullable<ReturnType<typeof houseSourceAnchor>>, kinded: KindedHouseFactorySources | undefined) {
  const source = v2HouseVaultSource(anchor.factory, anchor.startBlock);
  if (source.mode === "factory") {
    console.warn(
      `[callhouse/indexer] HouseVault source: factory() discovery, not the registry list (${source.reason}). ` +
        "Every block with an ERC-20 Transfer costs a realtime eth_getLogs in this mode.",
    );
  }
  return {
    HouseVault: {
      abi: houseVaultAbi,
      chain,
      address: source.mode === "registry" ? [...source.addresses] : houseVaultDiscovery(anchor, kinded),
      startBlock: source.startBlock,
      endBlock: END_BLOCK,
    },
  };
}

/**
 * The factory() fallback's filter. The event is the one the anchoring factory EMITS, decided from the registry
 * by houseDiscoveryEvent (src/v2/houseVaultKind.ts, tested there): the legacy 4-field topic only for the factory the
 * registry records as legacy (the v8 weekly launch factory), the generated 5-field topic for the kinded anchor,
 * a v9 (daily) launch factory and a factory the registry does not name. Earlier every launch anchor used the
 * legacy topic, so a v9 launch factory in this mode (a fork, a rehearsal, the window before the vault write-back)
 * discovered zero House vaults. Called only in factory mode: a registry the event form cannot be read from throws there.
 */
function houseVaultDiscovery(anchor: NonNullable<ReturnType<typeof houseSourceAnchor>>, kinded: KindedHouseFactorySources | undefined) {
  if (houseDiscoveryEvent(anchor) === "legacy") {
    return factory({
      address: anchor.factory,
      event: getAbiItem({ abi: legacyHouseVaultFactoryAbi, name: "VaultCreated" }),
      parameter: "vault",
      startBlock: anchor.startBlock,
      endBlock: END_BLOCK,
    });
  }
  return factory({
    address: anchor.kind === "kinded" ? [...(kinded?.addresses ?? [anchor.factory])] : anchor.factory,
    event: getAbiItem({ abi: kindedHouseVaultFactoryAbi, name: "VaultCreated" }),
    parameter: "vault",
    startBlock: anchor.startBlock,
    endBlock: END_BLOCK,
  });
}

/**
 * Before any House source: a V2_PRODUCTION=1 process whose V2_HOUSE_VAULT_FACTORY is not the baked registry's
 * v2.contracts.houseVaultFactory refuses boot by name (HOUSE_FACTORY_NOT_REGISTRY). Without this, the v9 env on an image
 * built before the registry regen made the launch factory "another deployment": KINDED_HOUSE left it out (the registry's
 * Clearinghouse is not env's), and houseVaultContract's factory() fallback watched the legacy topic the v9 factory never
 * emits, so zero House vaults were found while /v2/health/house-registry said ok (on a v9 fork). The fix makes
 * that fallback watch the 5-field topic (houseVaultDiscovery), and put a factory the registry does not name
 * into KINDED_HOUSE, so its VaultCreated reaches its handler; the refusal stays, since the vault list is still not the
 * registry's and factory() mode pays an eth_getLogs per block.
 */
v2AssertProductionHouseFactory(V2_PRODUCTION, V2_HOUSE_VAULT_FACTORY);

/**
 * Also before any source: a V2_PRODUCTION=1 process whose V2_CLEARINGHOUSE is not the baked registry's
 * v2.contracts.clearinghouse refuses boot by name (REGISTRY_CLEARINGHOUSE_MISMATCH). KINDED_HOUSE and PRICE_SOURCES
 * below each drop themselves for another Clearinghouse, which is the dev footing and was silent in production: the v9
 * env on a v8-era image fetched no House vault event and no Chainlink/UniV3/DataStreams source event, with no warning
 * (on a v9 fork). Outside production it warns and both groups stay absent, as before. After the House
 * factory check above, so the launch-factory case keeps its own, more specific name.
 */
v2AssertRegistryClearinghouse(V2_PRODUCTION, V2_CLEARINGHOUSE);

/**
 * The same three values lib/registry.ts gates the House handlers on and src/v2/houseVault.ts reads for its alert.
 * KINDED_HOUSE is undefined unless V2_CLEARINGHOUSE is the registry's own (and it records a daily factory or the launch
 * source is configured), or V2_HOUSE_VAULT_FACTORY is a factory the registry does not name.
 */
const KINDED_HOUSE = v2KindedHouseFactorySources(V2_CLEARINGHOUSE, V2_HOUSE_START_BLOCK, V2_HOUSE_VAULT_FACTORY);
const HOUSE_ANCHOR = houseSourceAnchor(V2_HOUSE_VAULT_FACTORY, V2_HOUSE_START_BLOCK, KINDED_HOUSE);

/**
 * Lending periphery: the Earn vault and the stateless zap helper. Each is a single
 * deployed address rather than a factory, so neither needs the `factory()` discovery the House
 * vaults use.
 *
 * These sources are the thing that was missing: `src/v2/earn.ts` carried its registrations
 * as PROSE because registering a handler for a contract this config does not have breaks the
 * virtual `ponder:registry` types for every handler file in the package. The generated ABI modules
 * it was waiting for now exist (`abis/v2/earnVault.ts`, `abis/v2/stockZap.ts`), so the block below
 * is what turns those comments back into code.
 *
 * Both share `V2_EARN_START_BLOCK`, which lib/env.ts already refuses to accept without one of the
 * two addresses and refuses to omit when either is set.
 *
 * ONE BLOCK FOR TWO CONTRACTS IS SAFE ONLY IN ONE DIRECTION, and
 * nothing here can check the direction. Ponder starts each source at `startBlock`; a source that starts
 * BEFORE its creation block merely backfills empty blocks, a source that starts AFTER it silently drops
 * every log in between and nothing downstream can tell a quiet contract from a late start. So the value
 * must be the EARLIER of the two deployment blocks, which is the vault's: the zap does not depend on the
 * vault at construction (StockZap takes the PayoutRouter and the Clearinghouse, not the EarnVault), and
 * script/v2/DeployEarnVault.s.sol deploys the vault first and SKIPS the zap when the router or the
 * clearinghouse is absent -- so the one documented "late second deployment" is a zap deployed after the
 * vault, which this single block handles at the cost of backfill. The loss case is the reverse: an
 * operator re-setting this variable to a LATER block (the zap's, after such a second deployment). The
 * env docs pin the value to the vault's deploy block (ops/v2-env.mjs, ops/v2/env/indexer-v2.env); no
 * runtime guard enforces it, because neither contract's creation block is known here without an RPC.
 * A per-contract start block read from the registry would make the direction unrepresentable; that is
 * env + runbook work outside this file.
 */
function earnVaultContract(address: Address) {
  if (V2_EARN_START_BLOCK === undefined) {
    throw new Error("[callhouse/indexer] earnVaultContract called without V2_EARN_START_BLOCK");
  }
  return { EarnVault: { abi: earnVaultAbi, chain, address, startBlock: V2_EARN_START_BLOCK, endBlock: END_BLOCK } };
}

function stockZapContract(address: Address) {
  if (V2_EARN_START_BLOCK === undefined) {
    throw new Error("[callhouse/indexer] stockZapContract called without V2_EARN_START_BLOCK");
  }
  return { StockZap: { abi: stockZapAbi, chain, address, startBlock: V2_EARN_START_BLOCK, endBlock: END_BLOCK } };
}

/**
 * A change shared price sources. Addresses and the start block come from the compiled registry
 * (ops/markets/tier1.json v2.contracts.sources and v2.deployBlock), never from env and never typed
 * here; src/v2/priceSourceRegistry.ts says why the deploy block is a safe start and why a process
 * indexing another Clearinghouse registers none of them. Each source registers on its own, so a
 * null registry entry leaves only that one absent.
 */
const PRICE_SOURCES = v2PriceSources(V2_CLEARINGHOUSE);

function chainlinkFeedSourceContract(address: Address, startBlock: number) {
  return { ChainlinkFeedSource: { abi: chainlinkFeedSourceAbi, chain, address, startBlock, endBlock: END_BLOCK } };
}

function uniV3TwapSourceContract(address: Address, startBlock: number) {
  return { UniV3TwapSource: { abi: uniV3TwapSourceAbi, chain, address, startBlock, endBlock: END_BLOCK } };
}

function dataStreamsSourceContract(address: Address, startBlock: number) {
  return { DataStreamsSource: { abi: dataStreamsSourceAbi, chain, address, startBlock, endBlock: END_BLOCK } };
}

/**
 * The full set of sources, as the types see it. At runtime a group is present only when its
 * address is set; the cast is what lets `ponder.on("Vault:…")` and `ponder.on("Factory:…")` both
 * type-check in one codebase (the virtual `ponder:registry` types derive from this config), and
 * lib/registry.ts is what keeps a handler for an absent group from being registered.
 */
type Contracts = ReturnType<typeof vaultContracts> & ReturnType<typeof factoryContracts> & ReturnType<typeof v2Contracts>
  & ReturnType<typeof expiryCalendarContract> & ReturnType<typeof keeperRewardsContract>
  & ReturnType<typeof accessManagerContract> & ReturnType<typeof payoutRouterContract>
  & ReturnType<typeof feeSplitterContract> & ReturnType<typeof buybackExecutorContract>
  & ReturnType<typeof makerVaultContract> & ReturnType<typeof rewardsDistributorContract>
  & ReturnType<typeof houseVaultFactoryContract> & ReturnType<typeof houseVaultKindedFactoryContract>
  & ReturnType<typeof houseVaultContract>
  & ReturnType<typeof earnVaultContract> & ReturnType<typeof stockZapContract>
  & ReturnType<typeof chainlinkFeedSourceContract> & ReturnType<typeof uniV3TwapSourceContract>
  & ReturnType<typeof dataStreamsSourceContract>;

const contracts = {
  ...(VAULT === undefined ? {} : vaultContracts(VAULT)),
  ...(FACTORY === undefined ? {} : factoryContracts(FACTORY)),
  ...(V2_CLEARINGHOUSE === undefined ? {} : v2Contracts()),
  ...(V2_EXPIRY_CALENDAR === undefined ? {} : expiryCalendarContract(V2_EXPIRY_CALENDAR)),
  ...(V2_KEEPER_REWARDS === undefined ? {} : keeperRewardsContract(V2_KEEPER_REWARDS)),
  ...(V2_ACCESS_MANAGER === undefined ? {} : accessManagerContract(V2_ACCESS_MANAGER)),
  ...(V2_PAYOUT_ROUTER === undefined ? {} : payoutRouterContract(V2_PAYOUT_ROUTER)),
  ...(V2_FEE_SPLITTER === undefined ? {} : feeSplitterContract(V2_FEE_SPLITTER)),
  ...(V2_BUYBACK_EXECUTOR === undefined ? {} : buybackExecutorContract(V2_BUYBACK_EXECUTOR)),
  ...(V2_MAKER_VAULT === undefined ? {} : makerVaultContract(V2_MAKER_VAULT)),
  ...(V2_REWARDS_DISTRIBUTORS.length === 0 ? {} : rewardsDistributorContract(
    V2_REWARDS_DISTRIBUTORS.map((item) => item.address),
  )),
  ...(V2_HOUSE_VAULT_FACTORY === undefined ? {} : houseVaultFactoryContract(V2_HOUSE_VAULT_FACTORY)),
  ...(KINDED_HOUSE === undefined ? {} : houseVaultKindedFactoryContract(KINDED_HOUSE)),
  ...(HOUSE_ANCHOR === undefined ? {} : houseVaultContract(HOUSE_ANCHOR, KINDED_HOUSE)),
  ...(V2_EARN_VAULT === undefined ? {} : earnVaultContract(V2_EARN_VAULT)),
  ...(V2_ZAP_HELPER === undefined ? {} : stockZapContract(V2_ZAP_HELPER)),
  ...(PRICE_SOURCES?.addresses.ChainlinkFeedSource === undefined ? {} : chainlinkFeedSourceContract(
    PRICE_SOURCES.addresses.ChainlinkFeedSource, PRICE_SOURCES.startBlock,
  )),
  ...(PRICE_SOURCES?.addresses.UniV3TwapSource === undefined ? {} : uniV3TwapSourceContract(
    PRICE_SOURCES.addresses.UniV3TwapSource, PRICE_SOURCES.startBlock,
  )),
  ...(PRICE_SOURCES?.addresses.DataStreamsSource === undefined ? {} : dataStreamsSourceContract(
    PRICE_SOURCES.addresses.DataStreamsSource, PRICE_SOURCES.startBlock,
  )),
} as Contracts;

/**
 * The historical `eth_getLogs` range, from the most addresses one request can carry (lib/getLogsRange.ts):
 * the dRPC backup answers at most 200,000 addresses x blocks. A `factory()` source's children are not countable here
 * (dev, rehearsal, a fork, or production before the House vault write-back); it says so rather than guessing.
 */
const GET_LOGS_ADDRESSES = maxAddressesPerGetLogs(contracts);
if (GET_LOGS_ADDRESSES.unbounded.length > 0) {
  console.warn(
    `[callhouse/indexer] eth_getLogs range sized for ${GET_LOGS_ADDRESSES.max} addresses; the factory() children of ` +
      `${GET_LOGS_ADDRESSES.unbounded.join(", ")} are not counted, so a backup RPC that limits addresses x blocks ` +
      "can refuse their requests once enough children exist.",
  );
}
const GET_LOGS_BLOCK_RANGE = ethGetLogsBlockRange(GET_LOGS_ADDRESSES.max, ETH_GET_LOGS_BLOCK_RANGE);

/** Periodic maintenance for order expiry and series cutoff. Like contracts, this source is
 * registered only when the v2 deployment is configured; the cast preserves registry types for
 * a v1-only build whose v2 handler registrations are inert. */
const blocks = {
  ...(V2_CLEARINGHOUSE === undefined ? {} : {
    V2Clock: {
      chain,
      startBlock: V2_START_BLOCK!,
      endBlock: END_BLOCK,
      interval: 600,
    },
    /** Batched block-end PnL reconciliation sees all fills, transfers and fee logs in a transaction. */
    V2PnlClock: {
      chain,
      startBlock: V2_START_BLOCK!,
      endBlock: END_BLOCK,
      interval: 30,
    },
  }),
} as {
  V2Clock: { chain: typeof chain; startBlock: number; endBlock: number | undefined; interval: number };
  V2PnlClock: { chain: typeof chain; startBlock: number; endBlock: number | undefined; interval: number };
};

export default createConfig({
  // Only when PGLITE_DIRECTORY is set (the fork sync's throwaway database, and the smoke test's).
  // Otherwise Ponder decides: Postgres if DATABASE_URL is set, `.ponder/pglite` if not.
  ...(PGLITE_DIRECTORY === undefined
    ? {}
    : { database: { kind: "pglite" as const, directory: PGLITE_DIRECTORY } }),
  chains: {
    robinhood: {
      id: CHAIN_ID,
      // One URL, or an array when PONDER_RPC_URL_4663 lists several: Ponder gives each array
      // entry its own transport and its own adaptive rate limit (lib/env.ts RPC_URL).
      rpc: RPC_URL,
      // 4663 is an Orbit L2 with sub-second blocks; poll a little faster than the default.
      pollingInterval: 2_000,
      // Under the dRPC backup's addresses x blocks limit, which Ponder cannot narrow on by
      // itself. This also turns Ponder's range retry off (lib/env.ts ETH_GET_LOGS_BLOCK_RANGE says why).
      ethGetLogsBlockRange: GET_LOGS_BLOCK_RANGE,
    },
  },
  contracts,
  blocks,
});
