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

/** The minimal valid environment: the three keys without defaults. */
const VALID: Record<string, string> = {
  RH_RPC: 'http://127.0.0.1:9',
  VAULT: '0x1111111111111111111111111111111111111111',
  KEEPER_PK: `0x${'11'.repeat(32)}`,
};

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
