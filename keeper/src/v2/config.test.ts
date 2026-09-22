/**
 * The v2 config's hard edges, per mode.
 *
 * WHY THIS FILE EXISTS: a v2 bot that boots on a wrong address settles the wrong deployment or
 * nothing at all. Pinned here: V2_MODE picks the schema and refuses a name it does not know; each
 * signing mode names its own key, port and URLs; the contracts a mode needs must resolve (env over
 * registry, both places named when neither has it) while the ones it does not need may stay null,
 * as they are in today's registry; every problem is in one list; secrets are never echoed; the
 * pricing mode is the pricing service's own loader.
 *
 * INTERFACE_VERSION 8 adds three edges of its own. `accessManager` is required by mm and pricer and by
 * neither the cranker, because only those two read a role they would otherwise never learn they lack.
 * `feeSplitter` and `buybackExecutor` live in `v2.flywheel`, not `v2.contracts`, so an expected message
 * here reads V2_ADDRESS_PATH rather than spelling a block. And the payout slot has two env spellings,
 * where quietly picking a winner is the exact failure the alias exists to prevent.
 *
 * DELIBERATELY ABSENT: any RPC. loadV2Config reads the environment it is given and a registry file
 * (fixtures under src/v2/fixtures/).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { getAddress } from 'viem';
import {
  CONTRACT_ENV,
  DEFAULT_REGISTRY_PATH,
  KEEPER_PACKAGE_DIR,
  MODE_CONTRACTS,
  PAYOUT_ENV_ALIAS,
  V2ConfigError,
  ladderSeriesCount,
  loadV2Config,
  settleSeriesCaps,
  type CrankerConfig,
  type MmConfig,
  type PricerConfig,
} from './config.js';
import { DEFAULT_REGISTRY_PATH as PRICING_DEFAULT_REGISTRY_PATH, KEEPER_PACKAGE_DIR as PRICING_PACKAGE_DIR } from './pricing/main.js';
import { V2_ADDRESS_NAMES, V2_ADDRESS_PATH, loadV2Registry, type V2AddressName } from './registry.js';
import { bigintReplacer } from './store.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DEPLOYED = join(FIXTURES, 'registry-v2.json');
const UNSET = join(FIXTURES, 'registry-v2-unset.json');
const NO_V2 = join(FIXTURES, 'registry-no-v2.json');

const KEY = `0x${'2b'.repeat(32)}`;
const RPC = 'http://127.0.0.1:9';
/** An address no fixture registry names: a Railway variable left behind by an earlier release. */
const STALE_BOOK = '0x00000000000000000000000000000000000000b0';

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadV2Config(env);
  } catch (error) {
    assert.ok(error instanceof V2ConfigError, `expected V2ConfigError, got ${String(error)}`);
    return error.message;
  }
  assert.fail('the configuration was accepted');
}

/** The registry path a message prints, as a regex fragment. Read, never spelled: `v2.contracts.` is wrong
 *  for a name whose home is `v2.flywheel`, and the loader itself interpolates V2_ADDRESS_PATH. */
function addressPath(name: V2AddressName): string {
  return V2_ADDRESS_PATH[name].replace(/\./g, '\\.');
}

/*//////////////////////////////////////////////////////////////
                              MODE
//////////////////////////////////////////////////////////////*/

test('V2_MODE: unset or unknown is refused on its own line, whatever else is wrong', () => {
  assert.match(refusal({}), /V2_MODE: must be one of cranker \| pricing \| mm \| pricer \(unset\)/);
  assert.match(refusal({ V2_MODE: '   ' }), /\(unset\)/, 'blank is unset');
  assert.match(refusal({ V2_MODE: 'crank' }), /V2_MODE: must be one of cranker \| pricing \| mm \| pricer \(got "crank"\)/);
});

test('the package dir and default registry path agree with the pricing service\'s', () => {
  assert.equal(KEEPER_PACKAGE_DIR, PRICING_PACKAGE_DIR);
  assert.equal(DEFAULT_REGISTRY_PATH, PRICING_DEFAULT_REGISTRY_PATH);
});

/*//////////////////////////////////////////////////////////////
                             CRANKER
//////////////////////////////////////////////////////////////*/

test('cranker on a deployed registry: addresses from the registry, v1-named defaults, port 8792, no indexer required', () => {
  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY.slice(2).toUpperCase(), V2_REGISTRY_PATH: DEPLOYED }) as CrankerConfig;
  assert.equal(config.mode, 'cranker');
  assert.equal(config.privateKey(), KEY, '0x added, lower-cased');
  assert.equal(config.keyEnv, 'CRANKER_PK');
  assert.equal(config.port, 8792);
  assert.equal(config.indexerUrl, null);
  assert.deepEqual(config.rpcUrls, [RPC]);
  assert.equal(config.chainId, 4663);
  assert.equal(config.multicall3, '0xcA11bde05977b3631167028862bE2a173976CA11');
  assert.equal(config.registryPath, DEPLOYED);
  assert.equal(config.dbPath, './keeper-v2.db');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.minGasWei, 10n ** 16n);
  assert.equal(config.txTimeoutMs, 180_000);
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.alertWebhook, null);
  assert.equal(config.contracts.clearinghouse, config.registry.contracts.clearinghouse);
  assert.equal(config.contracts.autoRoller, getAddress('0x00000000000000000000000000000000c0de0006'));
  assert.equal(config.contractSources.orderBook, 'registry');
  assert.equal(config.registry.markets.length, 4);
});

test('the signer key never serialises: not in JSON, not in util.inspect', () => {
  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED });
  assert.ok(!JSON.stringify(config, bigintReplacer).includes(KEY.slice(2)));
  assert.ok(!inspect(config, { depth: 8 }).includes(KEY.slice(2)));
});

test('cranker on §3\'s unset block: every contract it needs is named, with both places to set it, in one list with the other problems', () => {
  const text = refusal({ V2_MODE: 'cranker', RH_RPC: RPC, V2_REGISTRY_PATH: UNSET, POLL_INTERVAL_MS: '10' });
  for (const name of MODE_CONTRACTS.cranker) {
    assert.match(text, new RegExp(`${CONTRACT_ENV[name]}: V2_MODE=cranker needs the ${name} address; set ${CONTRACT_ENV[name]} or ${addressPath(name)} in `));
  }
  assert.doesNotMatch(
    text,
    /keeperRewards|makerVault|payoutAdapter|accessManager|feeSplitter|buybackExecutor/,
    'what the cranker does not need may stay null, the v8 manager and flywheel included',
  );
  assert.match(text, /CRANKER_PK: Required/);
  assert.match(text, /POLL_INTERVAL_MS: Number must be greater than or equal to 1000/);
  assert.doesNotMatch(text, /the registry has no v2 block yet/);
});

test('cranker without an AutoRoller boots (rolls are skipped, not required); CRANKER_* tuning has defaults and bounds', () => {
  assert.ok(!(MODE_CONTRACTS.cranker as readonly string[]).includes('autoRoller'));
  const text = refusal({ V2_MODE: 'cranker', RH_RPC: RPC, V2_REGISTRY_PATH: UNSET });
  assert.doesNotMatch(text, /V2_AUTO_ROLLER/, 'a registry without the roller is not a refusal for the cranker');
  assert.match(text, /CRANKER_PK: Required/, 'the other problems are still listed');
  assert.match(text, /V2_CLEARINGHOUSE: V2_MODE=cranker needs the clearinghouse address/);

  const explicit = {
    V2_CLEARINGHOUSE: '0x00000000000000000000000000000000000000c1',
    V2_ORDER_BOOK: '0x00000000000000000000000000000000000000c2',
    V2_SETTLEMENT_ORACLE: '0x00000000000000000000000000000000000000c3',
    V2_EXPIRY_CALENDAR: '0x00000000000000000000000000000000000000c4',
  };
  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: UNSET, ...explicit }) as CrankerConfig;
  assert.equal(config.contracts.autoRoller, null);
  assert.deepEqual(config.tuning, {
    maxTxPerStep: 50,
    txGasCap: 8_000_000n,
    logChunkBlocks: 50_000,
    logChunksPerTick: 40,
    zeroPayoutMaxGasPriceWei: 0n,
    redeemBacklogS: 3_600,
    noSourceAlertS: 3_600,
    pendingStuckS: 1_800,
    sweepIntervalS: 604_800,
    indexerTimeoutMs: 5_000,
    flywheelEnabled: false,
    flywheelIntervalS: 3_600,
    buybackToleranceBps: 50,
    buybackDryRun: false,
  });
  const tuned = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: UNSET, ...explicit, CRANKER_MAX_TX_PER_STEP: '5', CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI: '100000000' }) as CrankerConfig;
  assert.equal(tuned.tuning.maxTxPerStep, 5);
  assert.equal(tuned.tuning.zeroPayoutMaxGasPriceWei, 100_000_000n);
  const bad = refusal({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: UNSET, ...explicit, CRANKER_MAX_TX_PER_STEP: '0', CRANKER_TX_GAS_CAP: '10', CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI: '-1' });
  assert.match(bad, /CRANKER_MAX_TX_PER_STEP: Number must be greater than or equal to 1/);
  assert.match(bad, /CRANKER_TX_GAS_CAP: Number must be greater than or equal to 1000000/);
  assert.match(bad, /CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI: must not be negative/);
});

test('cranker on today\'s registry (no v2 block): explicit addresses are enough, and win over the registry', () => {
  const env: NodeJS.ProcessEnv = { V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: NO_V2 };
  assert.match(refusal(env), /V2_CLEARINGHOUSE: V2_MODE=cranker needs the clearinghouse address; .* \(the registry has no v2 block yet\)/);

  const explicit = {
    V2_CLEARINGHOUSE: '0x00000000000000000000000000000000000000c1',
    V2_ORDER_BOOK: '0x00000000000000000000000000000000000000c2',
    V2_SETTLEMENT_ORACLE: '0x00000000000000000000000000000000000000c3',
    V2_EXPIRY_CALENDAR: '0x00000000000000000000000000000000000000c4',
    V2_AUTO_ROLLER: '0x00000000000000000000000000000000000000c5',
  };
  const config = loadV2Config({ ...env, ...explicit }) as CrankerConfig;
  assert.equal(config.contracts.clearinghouse, getAddress(explicit.V2_CLEARINGHOUSE));
  assert.equal(config.contractSources.clearinghouse, 'env');
  assert.equal(config.contracts.keeperRewards, null);
  assert.equal(config.contractSources.keeperRewards, null);

  // An address the registry does not have: no disagreement, the environment fills it in.
  const mixed = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: NO_V2, ...explicit, V2_KEEPER_REWARDS: '0x00000000000000000000000000000000000000c6' }) as CrankerConfig;
  assert.equal(mixed.contracts.keeperRewards, getAddress('0x00000000000000000000000000000000000000c6'));
  assert.equal(mixed.contractSources.keeperRewards, 'env');
  assert.equal(mixed.contractSources.clearinghouse, 'env');
});

test('an address env var that disagrees with the registry is refused, not silently preferred', () => {
  const base = { V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED };
  const registryBook = (loadV2Config(base) as CrankerConfig).contracts.orderBook;
  assert.ok(registryBook !== null && registryBook !== getAddress(STALE_BOOK), 'the fixture registry names an orderBook');

  // A Railway variable left from an earlier release, against the registry baked into the image.
  const text = refusal({ ...base, V2_ORDER_BOOK: STALE_BOOK });
  assert.match(text, new RegExp(`V2_ORDER_BOOK: 0x[0-9a-fA-F]{40} disagrees with ${addressPath('orderBook')} 0x[0-9a-fA-F]{40}`));
  assert.match(text, /set V2_CONTRACTS_FROM_ENV=1 to use the environment on purpose/);

  // The same value the registry has is not a disagreement.
  const agreeing = loadV2Config({ ...base, V2_ORDER_BOOK: registryBook }) as CrankerConfig;
  assert.equal(agreeing.contracts.orderBook, registryBook);
  assert.equal(agreeing.contractSources.orderBook, 'env');

  // And the override is available on purpose.
  const forced = loadV2Config({ ...base, V2_ORDER_BOOK: STALE_BOOK, V2_CONTRACTS_FROM_ENV: '1' }) as CrankerConfig;
  assert.equal(forced.contracts.orderBook, getAddress(STALE_BOOK), 'env over registry when asked for');
  assert.equal(forced.contractSources.orderBook, 'env');
});

test('the payout slot has two env spellings: V2_PAYOUT_ADAPTER is read as a fallback, never as a winner', () => {
  const base = { V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED };
  const registryPayout = getAddress('0x00000000000000000000000000000000c0de0007');
  assert.equal(CONTRACT_ENV[PAYOUT_ENV_ALIAS.name], 'V2_PAYOUT_ROUTER', 'v8 takes ops\' and the indexer\'s spelling');
  assert.equal(PAYOUT_ENV_ALIAS.env, 'V2_PAYOUT_ADAPTER', 'the keeper\'s pre-v8 spelling, kept rather than ignored');

  // The deprecated spelling on its own RESOLVES and does not refuse. That is deliberate: the loader's only
  // channel is the fatal problem list, and refusing a boot over the NAME of an address that is otherwise
  // correct would break a working deployment for a rename that is ours, not the operator's. The consequence
  // is that there is no runtime deprecation signal at all — it lives in CONTRACT_ENV's comment and the README.
  const aliasOnly = loadV2Config({ ...base, V2_PAYOUT_ADAPTER: registryPayout }) as CrankerConfig;
  assert.equal(aliasOnly.contracts.payoutAdapter, registryPayout, 'the pre-v8 spelling still names the slot');
  assert.equal(aliasOnly.contractSources.payoutAdapter, 'env');

  // Both spellings, one contract: accepted, and the case each is written in is not a disagreement.
  const agreeing = loadV2Config({ ...base, V2_PAYOUT_ROUTER: registryPayout, V2_PAYOUT_ADAPTER: registryPayout.toLowerCase() }) as CrankerConfig;
  assert.equal(agreeing.contracts.payoutAdapter, registryPayout);
  assert.equal(agreeing.contractSources.payoutAdapter, 'env');

  // Both spellings, two addresses: refused naming both, rather than resolved to whichever the code reads first.
  const text = refusal({ ...base, V2_PAYOUT_ROUTER: registryPayout, V2_PAYOUT_ADAPTER: STALE_BOOK });
  assert.match(
    text,
    new RegExp(`V2_PAYOUT_ADAPTER: 0x[0-9a-fA-F]{40} disagrees with V2_PAYOUT_ROUTER 0x[0-9a-fA-F]{40}; they are two spellings of the same contract \\(${addressPath('payoutAdapter')}\\)`),
  );
  assert.match(text, /V2_PAYOUT_ROUTER is the v8 name ops renders — unset V2_PAYOUT_ADAPTER\./);
});

test('CONTRACT_ENV names every address once: a shared env var would quietly make two contracts one', () => {
  assert.deepEqual(Object.keys(CONTRACT_ENV).sort(), [...V2_ADDRESS_NAMES].sort(), 'every name the loop iterates has an env var');
  const envVars = V2_ADDRESS_NAMES.map((name) => CONTRACT_ENV[name]);
  // The Record type pins the KEYS; it cannot see a repeated VALUE. Two names on one variable would resolve to
  // one address, agree with each other and with the registry, and point a bot at the wrong contract in silence.
  assert.equal(new Set(envVars).size, envVars.length, `an env var is used twice: ${envVars.join(', ')}`);
  assert.ok(!envVars.includes(PAYOUT_ENV_ALIAS.env), 'the alias is a second spelling of one slot, not a second slot');
});

test('feeSplitter and buybackExecutor resolve from v2.flywheel, the block that is not v2.contracts', () => {
  // The deploy tooling counts the v2.contracts set, so v8 gave the flywheel its own block; the bots still
  // resolve both by name, which is what V2_ADDRESS_NAMES and v2Address() are for.
  assert.equal(V2_ADDRESS_PATH.feeSplitter, 'v2.flywheel.feeSplitter');
  assert.equal(V2_ADDRESS_PATH.buybackExecutor, 'v2.flywheel.buybackExecutor');

  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED }) as CrankerConfig;
  assert.equal(config.contracts.feeSplitter, getAddress('0x00000000000000000000000000000000c0de000c'));
  assert.equal(config.contracts.buybackExecutor, getAddress('0x00000000000000000000000000000000c0de000d'));
  assert.equal(config.contractSources.feeSplitter, 'registry', 'read from the registry, not left unresolved');
  assert.equal(config.contractSources.buybackExecutor, 'registry');

  // And the env spellings ops renders reach the same two slots (ops/v2/env/cranker.env sets only these).
  const fromEnv = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: RPC,
    CRANKER_PK: KEY,
    V2_REGISTRY_PATH: UNSET,
    V2_CLEARINGHOUSE: '0x00000000000000000000000000000000000000c1',
    V2_ORDER_BOOK: '0x00000000000000000000000000000000000000c2',
    V2_SETTLEMENT_ORACLE: '0x00000000000000000000000000000000000000c3',
    V2_EXPIRY_CALENDAR: '0x00000000000000000000000000000000000000c4',
    V2_FEE_SPLITTER: '0x00000000000000000000000000000000000000c7',
    V2_BUYBACK_EXECUTOR: '0x00000000000000000000000000000000000000c8',
  }) as CrankerConfig;
  assert.equal(fromEnv.contracts.feeSplitter, getAddress('0x00000000000000000000000000000000000000c7'));
  assert.equal(fromEnv.contractSources.buybackExecutor, 'env');
});

test('a malformed address env var is reported once, as malformed, not also as missing', () => {
  const text = refusal({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: UNSET, V2_CLEARINGHOUSE: '0x1234' });
  assert.match(text, /V2_CLEARINGHOUSE: not a 20-byte hex address: 0x1234/);
  assert.doesNotMatch(text, /needs the clearinghouse address/);
});

test('secrets are never echoed: a malformed key, RPC URL or webhook names the problem only', () => {
  const text = refusal({
    V2_MODE: 'cranker',
    RH_RPC: 'rpc-with-secret-apikey',
    CRANKER_PK: '0xsecret-not-a-key',
    ALERT_WEBHOOK: 'ftp://relay/alert?token=secret-token',
    V2_REGISTRY_PATH: DEPLOYED,
  });
  assert.match(text, /CRANKER_PK: must be a 32-byte hex private key/);
  assert.match(text, /RH_RPC: not a URL \(value not shown; 22 chars\)/);
  assert.match(text, /ALERT_WEBHOOK: not an http\(s\) URL \(scheme ftp:\)/);
  assert.doesNotMatch(text, /secret/);
});

test('blank values are unset; overrides of the v1-named knobs parse; CHAIN_ID must match the registry', () => {
  const config = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: RPC,
    RH_RPC_2: 'https://backup.example/rpc/',
    CRANKER_PK: KEY,
    CRANKER_PORT: '  ',
    V2_REGISTRY_PATH: DEPLOYED,
    KEEPER_DB_PATH: '/data/keeper.db',
    KEEPER_MIN_GAS_WEI: '5',
    POLL_INTERVAL_MS: '1000',
    INDEXER_URL: 'http://indexer.railway.internal:42069/',
    ALERT_WEBHOOK: 'http://relay.railway.internal:8080/alert',
    ALERT_WEBHOOK_TOKEN: 'a-token-of-32-characters-or-more',
  }) as CrankerConfig;
  assert.equal(config.port, 8792);
  assert.deepEqual(config.rpcUrls, [RPC, 'https://backup.example/rpc']);
  assert.equal(config.dbPath, '/data/keeper.db');
  assert.equal(config.minGasWei, 5n);
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.indexerUrl, 'http://indexer.railway.internal:42069');
  assert.equal(config.alertWebhookToken, 'a-token-of-32-characters-or-more');

  assert.match(refusal({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, KEEPER_MIN_GAS_WEI: '-1', V2_REGISTRY_PATH: DEPLOYED }), /KEEPER_MIN_GAS_WEI: must not be negative: -1/);
  assert.match(
    refusal({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, CHAIN_ID: '31337', V2_REGISTRY_PATH: DEPLOYED }),
    /CHAIN_ID: 31337, but the registry at .*registry-v2\.json describes chain 4663; point V2_REGISTRY_PATH at that chain's registry/,
  );
});

test('an unreadable or malformed registry is listed with the env problems, under V2_REGISTRY_PATH', () => {
  const missing = join(FIXTURES, 'nope.json');
  const text = refusal({ V2_MODE: 'cranker', V2_REGISTRY_PATH: missing });
  assert.match(text, new RegExp(`V2_REGISTRY_PATH \\(${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): cannot read the file: ENOENT`));
  assert.match(text, /RH_RPC: Required/);
  assert.match(text, /CRANKER_PK: Required/);
});

/*//////////////////////////////////////////////////////////////
                           MM, PRICER
//////////////////////////////////////////////////////////////*/

test('mm: MM_QUOTER_PK, PRICING_URL, MM_KILL_TOKEN and MAKER_VAULT are required, INDEXER_URL is not; port 8793', () => {
  const text = refusal({ V2_MODE: 'mm', RH_RPC: RPC, V2_REGISTRY_PATH: UNSET });
  assert.match(text, /MM_QUOTER_PK: Required/);
  assert.match(text, /PRICING_URL: Required/);
  assert.match(text, /MM_KILL_TOKEN: Required/);
  assert.doesNotMatch(text, /INDEXER_URL/);
  assert.match(text, new RegExp(`MAKER_VAULT: V2_MODE=mm needs the makerVault address; set MAKER_VAULT or ${addressPath('makerVault')}`));
  assert.doesNotMatch(text, /settlementOracle|expiryCalendar|autoRoller/);

  const config = loadV2Config({
    V2_MODE: 'mm',
    RH_RPC: RPC,
    MM_QUOTER_PK: KEY,
    PRICING_URL: 'http://pricing.railway.internal:8790',
    INDEXER_URL: 'http://indexer.railway.internal:42069',
    MM_KILL_TOKEN: KILL_TOKEN,
    V2_REGISTRY_PATH: DEPLOYED,
  }) as MmConfig;
  assert.equal(config.mode, 'mm');
  assert.equal(config.keyEnv, 'MM_QUOTER_PK');
  assert.equal(config.port, 8793);
  assert.equal(config.pricingUrl, 'http://pricing.railway.internal:8790');
  assert.equal(config.contracts.makerVault, getAddress('0x00000000000000000000000000000000c0de0008'));
  assert.equal(config.indexerUrl, 'http://indexer.railway.internal:42069');
  assert.equal(config.killToken(), KILL_TOKEN);
  assert.doesNotMatch(JSON.stringify(config, bigintReplacer) + inspect(config, { depth: 5 }), new RegExp(KILL_TOKEN), 'the kill token is behind a function');
});

const KILL_TOKEN = 'f0'.repeat(32);
const MM_BASE = { V2_MODE: 'mm', RH_RPC: RPC, MM_QUOTER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: KILL_TOKEN, V2_REGISTRY_PATH: DEPLOYED };

test('mm: every MM_* setting has a default, parses, and is range-checked', () => {
  const d = (loadV2Config(MM_BASE) as MmConfig).tuning;
  assert.equal(d.markets, null);
  assert.equal(d.halfSpreadBps, 500);
  assert.equal(d.minHalfSpreadUsdg6, 20_000n);
  assert.equal(d.requoteBps, 300);
  assert.equal(d.pullMinutes, 15);
  assert.equal(d.quoteOffHours, false);
  assert.equal(d.bidUnits, 100n);
  assert.equal(d.askUnits, 100n);
  assert.equal(d.maxSeriesUnits, 0n);
  assert.equal(d.maxTotalNotionalUsdg6, 0n);
  assert.equal(d.dailyLossLimitUsdg6, 1_000_000_000n);
  assert.equal(d.depositTokens, true);
  assert.equal(d.syncIntervalS, 900);
  assert.equal(d.epochWindDownS, 14_400);
  // T-OP-133: the owner's model IS the default -- fallback-only asks on, the exact write budget.
  assert.equal(d.askFallbackOnly, true);
  assert.equal(d.writeOversubscribeBps, 10_000);
  assert.deepEqual(d.extraVaults, []);
  assert.equal(d.houseFactory, null);
  assert.equal(d.vaultCaps.size, 0);

  const t = (
    loadV2Config({
      ...MM_BASE,
      MM_MARKETS: 'nvda, NVDA ,',
      MM_HALF_SPREAD_BPS: '250',
      MM_QUOTE_OFF_HOURS: '1',
      MM_REQUOTE_BPS: '50',
      MM_BID_UNITS: '0',
      MM_MAX_SERIES_UNITS: '5000',
      MM_MAX_TOTAL_NOTIONAL_USDG6: '50000000000',
      MM_DAILY_LOSS_LIMIT_USDG6: '250000000',
      MM_DEPOSIT_TOKENS: '0',
    }) as MmConfig
  ).tuning;
  assert.deepEqual(t.markets, ['NVDA']);
  assert.equal(t.halfSpreadBps, 250);
  assert.equal(t.quoteOffHours, true);
  assert.equal(t.requoteBps, 50);
  assert.equal(t.bidUnits, 0n);
  assert.equal(t.maxSeriesUnits, 5000n);
  assert.equal(t.maxTotalNotionalUsdg6, 50_000_000_000n);
  assert.equal(t.dailyLossLimitUsdg6, 250_000_000n);
  assert.equal(t.depositTokens, false);

  const text = refusal({ ...MM_BASE, MM_REQUOTE_BPS: '0', MM_QUOTE_OFF_HOURS: 'yes', MM_DAILY_LOSS_LIMIT_USDG6: '0', MM_MARKETS: 'NVDA,NOPE' });
  assert.match(text, /MM_REQUOTE_BPS: Number must be greater than or equal to 1/);
  assert.match(text, /MM_QUOTE_OFF_HOURS: Invalid enum value/);
  assert.match(text, /MM_DAILY_LOSS_LIMIT_USDG6: must be positive/);
  assert.match(text, /MM_MARKETS: NOPE is not a v2 market/);
});

test('mm: a short MM_KILL_TOKEN is refused without being echoed', () => {
  const text = refusal({ ...MM_BASE, MM_KILL_TOKEN: 'short-secret-value' });
  assert.match(text, /MM_KILL_TOKEN: must be at least 32 characters/);
  assert.doesNotMatch(text, /short-secret-value/);
});

test('pricer: PRICER_PK, PRICING_URL, and the autoRoller and oracle it reprices against; INDEXER_URL optional; port 8794; PRICER_* tuning', () => {
  const text = refusal({ V2_MODE: 'pricer', RH_RPC: RPC, V2_REGISTRY_PATH: UNSET });
  assert.match(text, /PRICER_PK: Required/);
  assert.match(text, /PRICING_URL: Required/);
  assert.doesNotMatch(text, /INDEXER_URL/, 'the pricer falls back to its own StrategySet scan');
  for (const name of MODE_CONTRACTS.pricer) assert.match(text, new RegExp(`needs the ${name} address`));
  assert.doesNotMatch(text, /makerVault/);

  const defaults = loadV2Config({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED }) as PricerConfig;
  assert.equal(defaults.port, 8794);
  assert.equal(defaults.indexerUrl, null);
  assert.deepEqual(defaults.tuning, {
    edgeBps: 500,
    repriceThresholdBps: 1_000,
    minIntervalS: 1_800,
    repriceOffHours: false,
    maxTxPerTick: 50,
    httpTimeoutMs: 5_000,
    fairAlertS: 7_200,
    fairMaxAgeS: 1_800,
    fairSpotToleranceBps: 300,
    logChunkBlocks: 50_000,
    logChunksPerTick: 40,
  });
  const tuned = loadV2Config({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED, PRICER_EDGE_BPS: '-250', PRICER_MIN_INTERVAL_S: '600', PRICER_REPRICE_OFF_HOURS: '1', PRICER_FAIR_MAX_AGE_S: '900', PRICER_FAIR_SPOT_TOLERANCE_BPS: '250' }) as PricerConfig;
  assert.equal(tuned.tuning.edgeBps, -250);
  assert.equal(tuned.tuning.minIntervalS, 600);
  assert.equal(tuned.tuning.repriceOffHours, true);
  assert.equal(tuned.tuning.fairMaxAgeS, 900);
  assert.equal(tuned.tuning.fairSpotToleranceBps, 250);
  assert.match(refusal({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED, PRICER_REPRICE_OFF_HOURS: 'yes' }), /PRICER_REPRICE_OFF_HOURS/);
  const bad = refusal({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED, PRICER_EDGE_BPS: '-10000', PRICER_REPRICE_THRESHOLD_BPS: '0', PRICER_MIN_INTERVAL_S: '5' });
  assert.match(bad, /PRICER_EDGE_BPS: Number must be greater than or equal to -5000/);
  assert.match(bad, /PRICER_REPRICE_THRESHOLD_BPS: Number must be greater than or equal to 1/);
  assert.match(bad, /PRICER_MIN_INTERVAL_S: Number must be greater than or equal to 60/);

  const config = loadV2Config({
    V2_MODE: 'pricer',
    RH_RPC: RPC,
    PRICER_PK: KEY,
    PRICER_PORT: '0',
    PRICING_URL: 'http://127.0.0.1:8790',
    INDEXER_URL: 'http://127.0.0.1:42069',
    V2_REGISTRY_PATH: DEPLOYED,
  }) as PricerConfig;
  assert.equal(config.keyEnv, 'PRICER_PK');
  assert.equal(config.port, 0);
  assert.equal(config.contracts.autoRoller, getAddress('0x00000000000000000000000000000000c0de0006'));
});

test('accessManager: mm and pricer refuse without it; the cranker never asks and boots with it null', () => {
  // Under `Managed` a target has no hasRole of its own, so these two read their own role from the manager
  // (K8-03). Without the address the pricer does not fail — it reprices nothing for ever while reporting
  // healthy — so a bot that cannot find out whether it may act refuses to start instead.
  for (const mode of ['mm', 'pricer'] as const) {
    assert.ok((MODE_CONTRACTS[mode] as readonly string[]).includes('accessManager'));
    const text = refusal({ V2_MODE: mode, RH_RPC: RPC, V2_REGISTRY_PATH: UNSET });
    assert.match(text, new RegExp(`V2_ACCESS_MANAGER: V2_MODE=${mode} needs the accessManager address; set V2_ACCESS_MANAGER or ${addressPath('accessManager')} in `));
  }
  assert.equal((loadV2Config(MM_BASE) as MmConfig).contracts.accessManager, getAddress('0x00000000000000000000000000000000c0de000b'), 'the deployed fixture supplies it');

  // The other half, which a one-sided test would miss: the cranker reads no role, and its flywheel steps are
  // skipped rather than required (ops/v2/env/cranker.env), so a deployment without either still cranks.
  assert.ok(!(MODE_CONTRACTS.cranker as readonly string[]).includes('accessManager'));
  assert.ok(!(MODE_CONTRACTS.cranker as readonly string[]).includes('feeSplitter'));
  const cranker = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: RPC,
    CRANKER_PK: KEY,
    V2_REGISTRY_PATH: UNSET,
    V2_CLEARINGHOUSE: '0x00000000000000000000000000000000000000c1',
    V2_ORDER_BOOK: '0x00000000000000000000000000000000000000c2',
    V2_SETTLEMENT_ORACLE: '0x00000000000000000000000000000000000000c3',
    V2_EXPIRY_CALENDAR: '0x00000000000000000000000000000000000000c4',
  }) as CrankerConfig;
  assert.equal(cranker.contracts.accessManager, null);
  assert.equal(cranker.contractSources.accessManager, null);
  assert.equal(cranker.contracts.feeSplitter, null);
  assert.equal(cranker.contracts.buybackExecutor, null);
});

/*//////////////////////////////////////////////////////////////
                             PRICING
//////////////////////////////////////////////////////////////*/

test('pricing: the pricing service\'s own schema; no key, no contract addresses, its errors as V2ConfigError', () => {
  const config = loadV2Config({ V2_MODE: 'pricing', RH_RPC: RPC, V2_REGISTRY_PATH: UNSET });
  assert.equal(config.mode, 'pricing');
  assert.ok(config.mode === 'pricing');
  assert.equal(config.pricing.port, 8790);
  assert.equal(config.pricing.registryPath, UNSET);
  assert.deepEqual(config.pricing.rpcUrls, [RPC]);

  assert.match(refusal({ V2_MODE: 'pricing', PRICING_PORT: 'eighty' }), /Pricing service configuration is not usable[\s\S]*RH_RPC: Required/);
});

test('ALERT_WEBHOOK needs ALERT_WEBHOOK_TOKEN of at least 32 characters, the relay\'s minimum: otherwise every page is a 401 nobody sees', () => {
  const base = { V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED, ALERT_WEBHOOK: 'http://relay.railway.internal:8080/alert' };
  assert.match(refusal(base), /ALERT_WEBHOOK_TOKEN: required with ALERT_WEBHOOK/);
  assert.match(refusal({ ...base, ALERT_WEBHOOK_TOKEN: 'x'.repeat(31) }), /ALERT_WEBHOOK_TOKEN: .*at least 32 characters/);
  assert.equal((loadV2Config({ ...base, ALERT_WEBHOOK_TOKEN: 'x'.repeat(32) }) as CrankerConfig).alertWebhookToken, 'x'.repeat(32));
  assert.equal((loadV2Config({ V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: DEPLOYED }) as CrankerConfig).alertWebhook, null, 'no webhook, no token: logged and stored only');
});


test('MM_VAULT_CAPS: per-vault caps parse, key lower-cased; a typo is refused rather than ignored', () => {
  const V = '0x00000000000000000000000000000000000000Fa';
  const caps = (
    loadV2Config({
      ...MM_BASE,
      MM_VAULT_CAPS: `{"${V}":{"maxSeriesUnits":"25","dailyLossLimitUsdg6":250000000}}`,
    }) as MmConfig
  ).tuning.vaultCaps;
  assert.deepEqual(caps.get(V.toLowerCase()), { maxSeriesUnits: 25n, dailyLossLimitUsdg6: 250_000_000n });
  assert.equal(caps.get(V), undefined, 'keyed lower-case, never by checksum');

  // WHY THIS IS A REFUSAL AND NOT A SHRUG: an ignored cap key is a cap the operator believes is in
  // force and is not. Every one of these is the same failure with a different spelling.
  const refuses = (value: string, message: RegExp) =>
    assert.throws(() => loadV2Config({ ...MM_BASE, MM_VAULT_CAPS: value }), message, value);
  refuses(`{"${V}":{"maxSeriesUnit":"25"}}`, /unknown cap maxSeriesUnit/);
  refuses(`{"${V}":{"maxSeriesUnits":"-1"}}`, /must not be negative/);
  refuses(`{"${V}":{"maxSeriesUnits":"1.5"}}`, /not an integer/);
  refuses(`{"0xnope":{"maxSeriesUnits":"1"}}`, /not an address/);
  refuses(`{"${V}":25}`, /must map to an object/);
  refuses('[]', /must be a JSON object/);
  refuses('{', /not JSON/);
});

/*
 * T-OP-123: the two series caps are DERIVED from the registry ladder of the quoted markets when unset, and a cap
 * set below what a quoted market lists is refused at boot with the unquoted count. The fixture registry-v2.json
 * resolves (SPEC_DEFAULTS <- v2.defaults <- overrides) to: NVDA (live, calls only) weekly 5 x 2 + daily 4 x 3 = 22;
 * TSLA (live, puts, weekly rungs 7) weekly 7 x 2 x 2 + daily 4 x 3 x 2 = 52; SGOV (paused, dailies off) weekly 5 x 2 = 10.
 * These numbers are re-derived below from the registry through ladderSeriesCount, then pinned as literals so a
 * changed fixture or a changed resolver is a red test with the arithmetic in its name.
 */
test('T-OP-123: ladderSeriesCount reads the resolved ladder the cranker reads (rungs x expiries ahead x sides, per tenor)', () => {
  const registry = loadV2Registry(DEPLOYED);
  const by = Object.fromEntries(registry.markets.filter((m) => m.v2 !== null).map((m) => [m.ticker, ladderSeriesCount(m.v2!.params, m.v2!.puts)]));
  assert.deepEqual(by, { NVDA: 22, TSLA: 52, SGOV: 10 }, 'the fixture ladder: v2.defaults daily rungs 4, TSLA weekly rungs 7 with puts, SGOV dailies off');
  // A tenor switched off contributes nothing; puts double a market's count and nothing else does.
  const nvda = registry.markets.find((m) => m.ticker === 'NVDA')!.v2!;
  assert.equal(ladderSeriesCount({ ...nvda.params, expiriesAhead: { weekly: 0, daily: 0 } }, true), 0);
  assert.equal(ladderSeriesCount(nvda.params, true), 44);
});

test('T-OP-123: unset caps derive from the ladder of the QUOTED markets: the largest per market, the sum in all', () => {
  // Every live market (MM_MARKETS unset): NVDA 22 + TSLA 52; SGOV is paused and not quoted.
  const live = (loadV2Config(MM_BASE) as MmConfig).tuning;
  assert.equal(live.maxSeriesPerMarket, 52, 'the largest ladder among the quoted markets (TSLA)');
  assert.equal(live.maxSeries, 74, '22 + 52: every listed series of every quoted market is selectable');
  assert.deepEqual(live.seriesCoverage, { derived: true, listedByMarket: { NVDA: 22, TSLA: 52 } });
  // The old literal defaults (40 / 10) are gone: this is the prove-by-breaking hook. Restoring `.default(10)` on
  // MM_MAX_SERIES_PER_MARKET makes maxSeriesPerMarket 10 here and this assertion red by name.
  assert.notEqual(live.maxSeriesPerMarket, 10, 'MM_MAX_SERIES_PER_MARKET must not fall back to the literal 10');
  assert.notEqual(live.maxSeries, 40, 'MM_MAX_SERIES must not fall back to the literal 40');

  // MM_MARKETS narrows the derivation to the named markets, whatever their status.
  const one = (loadV2Config({ ...MM_BASE, MM_MARKETS: 'NVDA' }) as MmConfig).tuning;
  assert.equal(one.maxSeriesPerMarket, 22);
  assert.equal(one.maxSeries, 22);
  assert.deepEqual(one.seriesCoverage.listedByMarket, { NVDA: 22 });
  const paused = (loadV2Config({ ...MM_BASE, MM_MARKETS: 'SGOV' }) as MmConfig).tuning;
  assert.deepEqual([paused.maxSeriesPerMarket, paused.maxSeries], [10, 10]);
});

test('T-OP-123: a cap SET below the ladder is refused at boot, naming the market and how many series it leaves unquoted', () => {
  const text = refusal({ ...MM_BASE, MM_MAX_SERIES_PER_MARKET: '10' });
  assert.match(text, /MM_MAX_SERIES_PER_MARKET=10 leaves 12 of NVDA's 22 listed series unquoted/);
  assert.match(text, /MM_MAX_SERIES_PER_MARKET=10 leaves 42 of TSLA's 52 listed series unquoted/);
  assert.match(text, /unset it to derive 52 from the registry ladder, or set it to at least 52/);
  const total = refusal({ ...MM_BASE, MM_MAX_SERIES: '40' });
  assert.match(total, /MM_MAX_SERIES=40 leaves 34 of the 74 series listed across NVDA, TSLA unquoted/);
  // Both set and both below: both lines, in one refusal, beside any other problem.
  const both = refusal({ ...MM_BASE, MM_MAX_SERIES: '40', MM_MAX_SERIES_PER_MARKET: '10', MM_REQUOTE_BPS: '0' });
  assert.match(both, /MM_MAX_SERIES=40 leaves/);
  assert.match(both, /MM_MAX_SERIES_PER_MARKET=10 leaves 42 of TSLA/);
  assert.match(both, /MM_REQUOTE_BPS: Number must be greater than or equal to 1/);
});

test('T-OP-123: a cap SET at or above the ladder is accepted as given, and the coverage says it was not derived', () => {
  const t = (loadV2Config({ ...MM_BASE, MM_MAX_SERIES: '200', MM_MAX_SERIES_PER_MARKET: '60' }) as MmConfig).tuning;
  assert.deepEqual([t.maxSeries, t.maxSeriesPerMarket, t.seriesCoverage.derived], [200, 60, false]);
  // Exactly the ladder is enough: 52 per market, 74 in all.
  const exact = (loadV2Config({ ...MM_BASE, MM_MAX_SERIES: '74', MM_MAX_SERIES_PER_MARKET: '52' }) as MmConfig).tuning;
  assert.deepEqual([exact.maxSeries, exact.maxSeriesPerMarket], [74, 52]);
  // One set, one derived: the derived one still covers the ladder, and the coverage is not "derived" as a whole.
  const half = (loadV2Config({ ...MM_BASE, MM_MAX_SERIES_PER_MARKET: '52' }) as MmConfig).tuning;
  assert.deepEqual([half.maxSeries, half.maxSeriesPerMarket, half.seriesCoverage.derived], [74, 52, false]);
});

test('T-OP-123: settleSeriesCaps is pure and handles a registry with no quoted market (the bot boots and idles)', () => {
  const registry = loadV2Registry(DEPLOYED);
  const none = settleSeriesCaps({ registry, markets: ['AAPL'], maxSeries: undefined, maxSeriesPerMarket: undefined });
  assert.deepEqual(none, { maxSeries: 1, maxSeriesPerMarket: 1, coverage: { derived: true, listedByMarket: {} }, problems: [] });
  const set = settleSeriesCaps({ registry, markets: null, maxSeries: 10, maxSeriesPerMarket: 5 });
  assert.equal(set.problems.length, 3, 'two per-market lines and one total line');
});

test('T-OP-133: MM_ASK_FALLBACK_ONLY and MM_WRITE_OVERSUBSCRIBE_BPS parse, default to the owner\'s model, and are bounded', () => {
  const on = (loadV2Config({ ...MM_BASE, MM_ASK_FALLBACK_ONLY: '0', MM_WRITE_OVERSUBSCRIBE_BPS: '50000' }) as MmConfig).tuning;
  assert.equal(on.askFallbackOnly, false, '0 restores the always-quote');
  assert.equal(on.writeOversubscribeBps, 50_000, 'the runbook suggestion');
  // Below the exact budget is refused: a factor under 1 would advertise LESS than the pool covers, which is not what
  // the setting means; 0 or a non-flag on the ask switch is refused like MM_QUOTE_OFF_HOURS.
  const text = refusal({ ...MM_BASE, MM_WRITE_OVERSUBSCRIBE_BPS: '9999', MM_ASK_FALLBACK_ONLY: 'yes' });
  assert.match(text, /MM_WRITE_OVERSUBSCRIBE_BPS/);
  assert.match(text, /MM_ASK_FALLBACK_ONLY: Invalid enum value/);
});
