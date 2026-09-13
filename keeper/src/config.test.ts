/**
 * The config schema's hard edges.
 *
 * WHY THIS FILE EXISTS: a keeper that boots on a malformed value discovers it at 20:00 UTC on
 * a Friday, so this schema is deliberately strict. The edge pinned here: bigint fields.
 * `BigInt('-1')` PARSES, and `KEEPER_MIN_GAS_WEI=-1` would then silently switch the low-gas
 * alert off — the schema must refuse a negative at boot, loudly, like every other bad value.
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
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { loadConfig } = await import('./config.js');

/** The minimal valid environment: the four keys without defaults. */
const VALID: Record<string, string> = {
  RH_RPC: 'http://127.0.0.1:9',
  REGISTRY: '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA',
  VAULT: '0x1111111111111111111111111111111111111111',
  KEEPER_PK: `0x${'11'.repeat(32)}`,
};

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

test('PREMIUM_MARGIN_BPS: default 0 (price at the floor), an integer 0..1000, anything else refused at boot', () => {
  assert.equal(loadConfig(VALID).PREMIUM_MARGIN_BPS, 0);
  assert.equal(loadConfig({ ...VALID, PREMIUM_MARGIN_BPS: '0' }).PREMIUM_MARGIN_BPS, 0);
  assert.equal(loadConfig({ ...VALID, PREMIUM_MARGIN_BPS: '50' }).PREMIUM_MARGIN_BPS, 50);
  assert.equal(loadConfig({ ...VALID, PREMIUM_MARGIN_BPS: '1000' }).PREMIUM_MARGIN_BPS, 1000);
  assert.equal(loadConfig({ ...VALID, PREMIUM_MARGIN_BPS: '' }).PREMIUM_MARGIN_BPS, 0, 'blank in .env is unset');
  for (const bad of ['1001', '-1', '12.5', 'fifty']) {
    assert.throws(() => loadConfig({ ...VALID, PREMIUM_MARGIN_BPS: bad }), /PREMIUM_MARGIN_BPS:/, `refuses ${bad}`);
  }
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
