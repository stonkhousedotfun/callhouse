/**
 * The config schema's hard edges.
 *
 * WHY THIS FILE EXISTS: a keeper that boots on a malformed value discovers it at 20:00 UTC on
 * a Friday, so this schema is deliberately strict. The edges pinned here: bigint fields
 * (`BigInt('-1')` PARSES, and `KEEPER_MIN_GAS_WEI=-1` would then silently switch the low-gas
 * alert off), the week's own knobs (a strike target, an arm lead that cannot undercut the
 * vault's MIN_LEAD, a holiday table that must be dates), and that nothing Overcall-shaped is a
 * key any more.
 *
 * DELIBERATELY ABSENT: no RPC. loadConfig is pure; the module-level config it also builds reads
 * the discard-port environment below.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-config-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { loadConfig } = await import('./config.js');
const { NYSE_HOLIDAYS_2026_2027 } = await import('./calendar.js');

/** The minimal valid environment for a vault process: RH_RPC, KEEPER_PK and one of VAULT / FACTORY. */
const VALID: Record<string, string> = {
  RH_RPC: 'http://127.0.0.1:9',
  VAULT: '0x1111111111111111111111111111111111111111',
  KEEPER_PK: `0x${'11'.repeat(32)}`,
};

test('VAULT or FACTORY: one is enough, neither is refused in the same list as the other problems', () => {
  const factory = '0x2222222222222222222222222222222222222222';
  const solo = loadConfig({ RH_RPC: VALID.RH_RPC, KEEPER_PK: VALID.KEEPER_PK, FACTORY: factory });
  assert.equal(solo.VAULT, undefined, 'a factory-only process has no vault');
  assert.equal(solo.FACTORY, factory);
  const both = loadConfig({ ...VALID, FACTORY: factory });
  assert.equal(both.VAULT, VALID.VAULT);
  assert.equal(both.FACTORY, factory);
  assert.throws(
    () => loadConfig({ RH_RPC: VALID.RH_RPC, KEEPER_PK: VALID.KEEPER_PK }),
    (err: unknown) => {
      assert.match(String(err), /VAULT \/ FACTORY: at least one must be set: VAULT \(the pooled vault\) or FACTORY \(the isolated 1-lot factory\)/);
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ RH_RPC: VALID.RH_RPC }),
    (err: unknown) => {
      // Both problems in one boot failure, not one per restart.
      assert.match(String(err), /KEEPER_PK: Required/);
      assert.match(String(err), /VAULT \/ FACTORY: at least one must be set/);
      return true;
    },
  );
  assert.throws(() => loadConfig({ ...VALID, FACTORY: 'not-an-address' }), /FACTORY: not a 20-byte hex address/);
});

test('the factory keys: PRICE_FEED defaults to the NVDA proxy, KEEPER_MIN_ASK_USDG6 to 1 USDG, KEEPER_MARKET to NVDA', () => {
  const parsed = loadConfig(VALID);
  assert.equal(parsed.PRICE_FEED, '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', 'the live NVDA keeper needs no new key');
  assert.equal(parsed.KEEPER_MIN_ASK_USDG6, 1_000_000n, 'the floor the first factory keeper hard-coded');
  assert.equal(parsed.KEEPER_MARKET, 'NVDA');
  assert.equal(loadConfig({ ...VALID, PRICE_FEED: '0x4a1166a659a55625345e9515b32adecea5547c38' }).PRICE_FEED, '0x4A1166a659A55625345e9515b32adECea5547C38', 'checksummed on the way in');
  assert.equal(loadConfig({ ...VALID, KEEPER_MIN_ASK_USDG6: '100000' }).KEEPER_MIN_ASK_USDG6, 100_000n, 'the registry value, 0.10 USDG');
  assert.equal(loadConfig({ ...VALID, KEEPER_MIN_ASK_USDG6: '0' }).KEEPER_MIN_ASK_USDG6, 0n, 'zero switches the floor off');
  assert.throws(() => loadConfig({ ...VALID, KEEPER_MIN_ASK_USDG6: '-1' }), /KEEPER_MIN_ASK_USDG6: must not be negative/);
  assert.throws(() => loadConfig({ ...VALID, PRICE_FEED: '0x12' }), /PRICE_FEED: not a 20-byte hex address/);
  for (const ok of ['TSLA', 'BRK.B', 'GOOGL', 'X', 'A1B2C3D4']) {
    assert.equal(loadConfig({ ...VALID, KEEPER_MARKET: ok }).KEEPER_MARKET, ok);
  }
  for (const bad of ['tsla', 'TOOLONGTICK', 'TS LA', '', 'TSLA-X']) {
    if (bad === '') continue; // blank is unset: the default
    assert.throws(() => loadConfig({ ...VALID, KEEPER_MARKET: bad }), /KEEPER_MARKET/, `refuses ${bad}`);
  }
});

test('the three required keys are enough; there is no registry and nothing Overcall', () => {
  const parsed = loadConfig(VALID);
  assert.equal(parsed.VAULT, '0x1111111111111111111111111111111111111111');
  assert.equal(parsed.CLEARINGHOUSE, '0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0');
  assert.equal(parsed.SEAPORT, '0x0000000000000068F116a894984e2DB1123eB395');
  const keys = Object.keys(parsed);
  assert.ok(!keys.some((k) => k.includes('REGISTRY') || k.includes('OVERCALL') || k === 'SEAPORT_ZONE'), keys.join(','));
});

test('bigint fields reject a negative value loudly, naming the key', () => {
  assert.throws(() => loadConfig({ ...VALID, KEEPER_MIN_GAS_WEI: '-1' }), /KEEPER_MIN_GAS_WEI: must not be negative/);
  assert.throws(() => loadConfig({ ...VALID, KEEPER_UNIT_PRICE_USDG6: '-20' }), /KEEPER_UNIT_PRICE_USDG6: must not be negative/);
  assert.throws(() => loadConfig({ ...VALID, KEEPER_MIN_GAS_WEI: 'abc' }), /KEEPER_MIN_GAS_WEI: not an integer/);
});

test('bigint fields parse zero and positive values, and defaults land when absent', () => {
  const parsed = loadConfig({ ...VALID, KEEPER_MIN_GAS_WEI: '0', KEEPER_UNIT_PRICE_USDG6: '20' });
  assert.equal(parsed.KEEPER_MIN_GAS_WEI, 0n);
  assert.equal(parsed.KEEPER_UNIT_PRICE_USDG6, 20n);
  assert.equal(loadConfig(VALID).KEEPER_MIN_GAS_WEI, 10_000_000_000_000_000n);
  assert.equal(loadConfig(VALID).KEEPER_UNIT_PRICE_USDG6, undefined);
});

test('KEEPER_PREMIUM_MARGIN_BPS: default 100, an integer 0..1000, anything else refused at boot', () => {
  assert.equal(loadConfig(VALID).KEEPER_PREMIUM_MARGIN_BPS, 100);
  assert.equal(loadConfig({ ...VALID, KEEPER_PREMIUM_MARGIN_BPS: '0' }).KEEPER_PREMIUM_MARGIN_BPS, 0);
  assert.equal(loadConfig({ ...VALID, KEEPER_PREMIUM_MARGIN_BPS: '50' }).KEEPER_PREMIUM_MARGIN_BPS, 50);
  assert.equal(loadConfig({ ...VALID, KEEPER_PREMIUM_MARGIN_BPS: '1000' }).KEEPER_PREMIUM_MARGIN_BPS, 1000);
  assert.equal(loadConfig({ ...VALID, KEEPER_PREMIUM_MARGIN_BPS: '' }).KEEPER_PREMIUM_MARGIN_BPS, 100, 'blank in .env is unset');
  for (const bad of ['1001', '-1', '12.5', 'fifty']) {
    assert.throws(() => loadConfig({ ...VALID, KEEPER_PREMIUM_MARGIN_BPS: bad }), /KEEPER_PREMIUM_MARGIN_BPS:/, `refuses ${bad}`);
  }
});

test('the week: strike target 500 bps, arm lead 6 h and never under the vault’s hour, retry hourly', () => {
  const parsed = loadConfig(VALID);
  assert.equal(parsed.KEEPER_STRIKE_OTM_BPS, 500);
  assert.equal(parsed.KEEPER_ARM_LEAD_S, 6 * 3600);
  assert.equal(parsed.KEEPER_RETRY_STRANDED_MS, 3_600_000);
  assert.equal(loadConfig({ ...VALID, KEEPER_ARM_LEAD_S: '3600' }).KEEPER_ARM_LEAD_S, 3600);
  assert.throws(() => loadConfig({ ...VALID, KEEPER_ARM_LEAD_S: '3599' }), /KEEPER_ARM_LEAD_S/, 'below ValoremLib.MIN_LEAD');
  assert.throws(() => loadConfig({ ...VALID, KEEPER_STRIKE_OTM_BPS: '5001' }), /KEEPER_STRIKE_OTM_BPS/);
  assert.equal(loadConfig({ ...VALID, KEEPER_RETRY_STRANDED_MS: '1000' }).KEEPER_RETRY_STRANDED_MS, 1000, 'the floor a rehearsal drives');
});

test('vol pricing: the defaults, and every bound refused at boot', () => {
  const parsed = loadConfig(VALID);
  assert.equal(parsed.KEEPER_PRICING_MODE, 'vol');
  assert.equal(parsed.KEEPER_TARGET_DELTA, 0.15);
  assert.equal(parsed.KEEPER_PRICE_EDGE_BPS, 1000);
  assert.equal(parsed.KEEPER_VOL_URL, 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json');
  assert.equal(parsed.KEEPER_VOL_MAX_AGE_S, 345_600);
  assert.equal(parsed.KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS, 300);
  assert.equal(parsed.KEEPER_VOL_TIMEOUT_MS, 10_000);
  assert.equal(parsed.KEEPER_VOL_MAX_BYTES, 8_000_000);
  assert.equal(parsed.KEEPER_STRIKE_BAND_BUFFER_BPS, 200, 'the fixed rule’s rally room: a 5% strike over a 3% floor');
  assert.equal(parsed.KEEPER_VOL_REPRICE_UP_BPS, 2500);
  assert.equal(parsed.KEEPER_VOL_ROOT, 'NVDA');
  assert.equal(loadConfig({ ...VALID, KEEPER_VOL_REPRICE_UP_BPS: '0' }).KEEPER_VOL_REPRICE_UP_BPS, 0, '0 turns it off');
  assert.equal(loadConfig({ ...VALID, KEEPER_VOL_ROOT: 'AAPL' }).KEEPER_VOL_ROOT, 'AAPL');

  assert.equal(loadConfig({ ...VALID, KEEPER_PRICING_MODE: 'fixed' }).KEEPER_PRICING_MODE, 'fixed');
  assert.equal(loadConfig({ ...VALID, KEEPER_TARGET_DELTA: '0.05' }).KEEPER_TARGET_DELTA, 0.05);
  assert.equal(loadConfig({ ...VALID, KEEPER_TARGET_DELTA: '0.4' }).KEEPER_TARGET_DELTA, 0.4);
  assert.equal(loadConfig({ ...VALID, KEEPER_PRICE_EDGE_BPS: '0' }).KEEPER_PRICE_EDGE_BPS, 0);
  assert.equal(loadConfig({ ...VALID, KEEPER_PRICE_EDGE_BPS: '5000' }).KEEPER_PRICE_EDGE_BPS, 5000);
  const bad: Array<[string, string]> = [
    ['KEEPER_PRICING_MODE', 'auto'],
    ['KEEPER_TARGET_DELTA', '0.04'],
    ['KEEPER_TARGET_DELTA', '0.41'],
    ['KEEPER_TARGET_DELTA', 'fifteen'],
    ['KEEPER_PRICE_EDGE_BPS', '5001'],
    ['KEEPER_PRICE_EDGE_BPS', '-1'],
    ['KEEPER_PRICE_EDGE_BPS', '10.5'],
    ['KEEPER_VOL_MAX_AGE_S', '0'],
    ['KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS', '0'],
    ['KEEPER_VOL_TIMEOUT_MS', '999'],
    ['KEEPER_VOL_MAX_BYTES', '10'],
    ['KEEPER_STRIKE_BAND_BUFFER_BPS', '1001'],
    ['KEEPER_VOL_REPRICE_UP_BPS', '-1'],
    ['KEEPER_VOL_REPRICE_UP_BPS', '50001'],
    ['KEEPER_VOL_ROOT', 'nvda'],
    ['KEEPER_VOL_ROOT', 'NVDA.json'],
  ];
  for (const [key, value] of bad) {
    assert.throws(() => loadConfig({ ...VALID, [key]: value }), new RegExp(`${key}:`), `refuses ${key}=${value}`);
  }
});

test('KEEPER_VOL_URL: https only, and never echoed', () => {
  assert.equal(loadConfig({ ...VALID, KEEPER_VOL_URL: 'https://mirror.example/NVDA.json?k=1' }).KEEPER_VOL_URL, 'https://mirror.example/NVDA.json?k=1');
  assert.throws(() => loadConfig({ ...VALID, KEEPER_VOL_URL: 'http://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' }), /KEEPER_VOL_URL: not an https URL/);
  assert.throws(
    () => loadConfig({ ...VALID, KEEPER_VOL_URL: 'not a url SECRET123' }),
    (err: unknown) => {
      assert.match(String(err), /KEEPER_VOL_URL: not a URL/);
      assert.ok(!String(err).includes('SECRET123'));
      return true;
    },
  );
});

test('SOLO_WIND_DOWN: off unless 1 or true, and a value that is neither on nor off is refused at boot', () => {
  const factory = { RH_RPC: VALID.RH_RPC, KEEPER_PK: VALID.KEEPER_PK, FACTORY: '0x2222222222222222222222222222222222222222' };
  assert.equal(loadConfig(factory).SOLO_WIND_DOWN, false, 'unset: the factory keeps setting weeks');
  assert.equal(loadConfig({ ...factory, SOLO_WIND_DOWN: '' }).SOLO_WIND_DOWN, false, 'blank is unset (the .env.example line)');
  assert.equal(loadConfig({ ...factory, SOLO_WIND_DOWN: '1' }).SOLO_WIND_DOWN, true, 'what ops/keeper-env.sh writes');
  assert.equal(loadConfig({ ...factory, SOLO_WIND_DOWN: 'true' }).SOLO_WIND_DOWN, true);
  assert.equal(loadConfig({ ...factory, SOLO_WIND_DOWN: '0' }).SOLO_WIND_DOWN, false);
  assert.equal(loadConfig({ ...factory, SOLO_WIND_DOWN: 'false' }).SOLO_WIND_DOWN, false);
  // Neither switch reads a typo as off (WIND_DOWN below).
  for (const typo of ['yes', 'on', 'TRUE', '2']) {
    assert.throws(() => loadConfig({ ...factory, SOLO_WIND_DOWN: typo }), /SOLO_WIND_DOWN: Invalid enum value/, typo);
  }
  assert.equal(loadConfig(factory).WIND_DOWN, false, 'the two switches are independent');
});

test('KEEPER_NYSE_HOLIDAYS: unset is the built-in table; a list must be dates', () => {
  assert.deepEqual(loadConfig(VALID).KEEPER_NYSE_HOLIDAYS, NYSE_HOLIDAYS_2026_2027);
  assert.deepEqual(loadConfig({ ...VALID, KEEPER_NYSE_HOLIDAYS: '2028-01-17, 2028-02-21' }).KEEPER_NYSE_HOLIDAYS, ['2028-01-17', '2028-02-21']);
  assert.throws(() => loadConfig({ ...VALID, KEEPER_NYSE_HOLIDAYS: '2028-01-17,next friday' }), /KEEPER_NYSE_HOLIDAYS: not a YYYY-MM-DD date: next friday/);
});

test('the boot failure message points at keeper/.env.example, which has the keeper keys', () => {
  assert.throws(() => loadConfig({}), /keeper\/\.env\.example/);
});

test('a malformed URL field is refused without echoing its value (RPC keys, relay tokens)', () => {
  const secret = 'not a url with sk_live_SECRET123';
  assert.throws(
    () => loadConfig({ ...VALID, ALERT_WEBHOOK: secret }),
    (err: unknown) => {
      const text = String(err);
      assert.match(text, /ALERT_WEBHOOK: not a URL/);
      assert.ok(!text.includes('SECRET123'), 'the value must not appear in the error');
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ ...VALID, RH_RPC: 'ftp://user:SECRET123@rpc.example' }),
    (err: unknown) => {
      const text = String(err);
      assert.match(text, /RH_RPC: not an http\(s\) URL/);
      assert.ok(!text.includes('SECRET123'));
      return true;
    },
  );
});

test('ALERT_WEBHOOK_TOKEN must be at least 16 characters when set', () => {
  assert.throws(() => loadConfig({ ...VALID, ALERT_WEBHOOK_TOKEN: 'short' }), /ALERT_WEBHOOK_TOKEN/);
  assert.equal(loadConfig({ ...VALID, ALERT_WEBHOOK_TOKEN: 'x'.repeat(32) }).ALERT_WEBHOOK_TOKEN, 'x'.repeat(32));
});

test('WIND_DOWN: the pooled vault\'s close is strict too: 1/true on, 0/false/unset off, any other spelling refused at boot, never read as off', () => {
  assert.equal(loadConfig(VALID).WIND_DOWN, false);
  assert.equal(loadConfig({ ...VALID, WIND_DOWN: '1' }).WIND_DOWN, true, 'what ops/deploy.md sets on the keeper service');
  assert.equal(loadConfig({ ...VALID, WIND_DOWN: 'true' }).WIND_DOWN, true);
  assert.equal(loadConfig({ ...VALID, WIND_DOWN: '0' }).WIND_DOWN, false);
  assert.equal(loadConfig({ ...VALID, WIND_DOWN: '' }).WIND_DOWN, false, 'blank is unset');
  for (const typo of ['TRUE', 'yes', 'on', '2']) {
    assert.throws(() => loadConfig({ ...VALID, WIND_DOWN: typo }), /WIND_DOWN: Invalid enum value/, typo);
  }
});
