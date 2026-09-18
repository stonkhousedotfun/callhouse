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
  V2ConfigError,
  loadV2Config,
  type CrankerConfig,
  type MmConfig,
  type PricerConfig,
} from './config.js';
import { DEFAULT_REGISTRY_PATH as PRICING_DEFAULT_REGISTRY_PATH, KEEPER_PACKAGE_DIR as PRICING_PACKAGE_DIR } from './pricing/main.js';
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
    assert.match(text, new RegExp(`${CONTRACT_ENV[name]}: V2_MODE=cranker needs the ${name} address; set ${CONTRACT_ENV[name]} or v2\\.contracts\\.${name} in `));
  }
  assert.doesNotMatch(text, /keeperRewards|makerVault|payoutAdapter/, 'what the cranker does not need may stay null');
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
  assert.match(text, /V2_ORDER_BOOK: 0x[0-9a-fA-F]{40} disagrees with v2\.contracts\.orderBook 0x[0-9a-fA-F]{40}/);
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
  assert.match(text, /MAKER_VAULT: V2_MODE=mm needs the makerVault address; set MAKER_VAULT or v2\.contracts\.makerVault/);
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
  assert.doesNotMatch(text, /makerVault|expiryCalendar/);

  const defaults = loadV2Config({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED }) as PricerConfig;
  assert.equal(defaults.port, 8794);
  assert.equal(defaults.indexerUrl, null);
  assert.deepEqual(defaults.tuning, {
    edgeBps: 500,
    repriceThresholdBps: 1_000,
    minIntervalS: 1_800,
    maxTxPerTick: 50,
    httpTimeoutMs: 5_000,
    fairAlertS: 7_200,
    logChunkBlocks: 50_000,
    logChunksPerTick: 40,
  });
  const tuned = loadV2Config({ V2_MODE: 'pricer', RH_RPC: RPC, PRICER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', V2_REGISTRY_PATH: DEPLOYED, PRICER_EDGE_BPS: '-250', PRICER_MIN_INTERVAL_S: '600' }) as PricerConfig;
  assert.equal(tuned.tuning.edgeBps, -250);
  assert.equal(tuned.tuning.minIntervalS, 600);
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
