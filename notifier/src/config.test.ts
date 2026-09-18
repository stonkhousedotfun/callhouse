/**
 * Boot configuration: what refuses to start, what the defaults are, and that no error message ever
 * repeats a value it is complaining about.
 */
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { test } from 'node:test';
import { ConfigError, parseConfig } from './config.js';
import { TEST_VAPID, testEnv } from './testing.js';

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    assert.match(error.message, /^Notifier configuration is not usable:/);
    return error.issues;
  }
  assert.fail('expected parseConfig to throw');
}

test('a complete environment: defaults for port and Telegram base, email off, VAPID subject from APP_URL', () => {
  const config = parseConfig(testEnv({ APP_URL: 'https://app.stonkhouse.test/' }));
  assert.equal(config.port, 8791);
  assert.equal(config.appUrl, 'https://app.stonkhouse.test');
  assert.equal(config.telegram.apiBase, 'https://api.telegram.org');
  assert.equal(config.email, null);
  assert.equal(config.webPush.subject, 'https://app.stonkhouse.test');
  assert.equal(config.dataKey.length, 32);
  assert.deepEqual(config.rules, { enabled: true, pollMs: 30_000 });
});

test('RULES_ENABLED and RULES_POLL_S: switch and interval of the rules engine', () => {
  assert.deepEqual(parseConfig(testEnv({ RULES_ENABLED: 'false', RULES_POLL_S: '60' })).rules, { enabled: false, pollMs: 60_000 });
  assert.deepEqual(parseConfig(testEnv({ RULES_ENABLED: ' 0 ' })).rules, { enabled: false, pollMs: 30_000 });
  assert.deepEqual(parseConfig(testEnv({ RULES_ENABLED: 'TRUE', RULES_POLL_S: '' })).rules, { enabled: true, pollMs: 30_000 });
  assert.ok(issuesOf(testEnv({ RULES_ENABLED: 'maybe' })).some((i) => i.startsWith('RULES_ENABLED')));
  assert.ok(issuesOf(testEnv({ RULES_POLL_S: '1' })).some((i) => i.startsWith('RULES_POLL_S')));
});

test('every required variable is reported at once, blank counts as unset', () => {
  const issues = issuesOf({ TELEGRAM_BOT_TOKEN: '   ' });
  for (const name of ['DATABASE_URL', 'INDEXER_URL', 'RH_RPC', 'NOTIFIER_DATA_KEY', 'TELEGRAM_BOT_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'APP_URL']) {
    assert.ok(issues.some((i) => i.startsWith(name)), `${name} missing from ${issues.join(' | ')}`);
  }
});

test('the data key must be 32 bytes of hex and not all zeros', () => {
  assert.ok(issuesOf(testEnv({ NOTIFIER_DATA_KEY: 'ab'.repeat(16) })).some((i) => i.startsWith('NOTIFIER_DATA_KEY')));
  assert.ok(issuesOf(testEnv({ NOTIFIER_DATA_KEY: 'zz'.repeat(32) })).some((i) => i.startsWith('NOTIFIER_DATA_KEY')));
  assert.ok(issuesOf(testEnv({ NOTIFIER_DATA_KEY: '0'.repeat(64) })).some((i) => i.includes('all zeros')));
});

test('a VAPID private key that is not the public key’s pair refuses to boot', () => {
  const other = createECDH('prime256v1');
  other.generateKeys();
  const privateKey = Buffer.from(other.getPrivateKey().toString('hex').padStart(64, '0'), 'hex');
  const issues = issuesOf(testEnv({ VAPID_PRIVATE_KEY: privateKey.toString('base64url') }));
  assert.ok(issues.some((i) => i.startsWith('VAPID_PRIVATE_KEY') && i.includes('not the private key')));
  assert.ok(issuesOf(testEnv({ VAPID_PUBLIC_KEY: 'AAAA' })).some((i) => i.startsWith('VAPID_PUBLIC_KEY')));
});

test('an http APP_URL needs VAPID_SUBJECT (push services take only mailto: or https:)', () => {
  assert.ok(issuesOf(testEnv({ APP_URL: 'http://localhost:3000' })).some((i) => i.startsWith('VAPID_SUBJECT')));
  const config = parseConfig(testEnv({ APP_URL: 'http://localhost:3000', VAPID_SUBJECT: 'mailto:ops@stonkhouse.test' }));
  assert.equal(config.webPush.subject, 'mailto:ops@stonkhouse.test');
});

test('email: SMTP_URL, EMAIL_FROM and NOTIFIER_PUBLIC_URL come together', () => {
  const smtp = 'smtps://user:SECRET-SMTP@smtp.stonkhouse.test:465';
  assert.ok(issuesOf(testEnv({ SMTP_URL: smtp })).some((i) => i.startsWith('EMAIL_FROM')));
  assert.ok(issuesOf(testEnv({ SMTP_URL: smtp })).some((i) => i.startsWith('NOTIFIER_PUBLIC_URL')));
  assert.ok(issuesOf(testEnv({ EMAIL_FROM: 'alerts@stonkhouse.test' })).some((i) => i.startsWith('SMTP_URL')));
  assert.ok(
    issuesOf(testEnv({ SMTP_URL: smtp, EMAIL_FROM: 'Evil\r\nBcc: x@y.z <a@b.c>', NOTIFIER_PUBLIC_URL: 'https://n.test' })).some((i) =>
      i.startsWith('EMAIL_FROM'),
    ),
  );
  const config = parseConfig(
    testEnv({ SMTP_URL: smtp, EMAIL_FROM: 'Stonkhouse <alerts@stonkhouse.test>', NOTIFIER_PUBLIC_URL: 'https://notifier.stonkhouse.test/' }),
  );
  assert.deepEqual(config.email, {
    smtpUrl: smtp,
    from: 'Stonkhouse <alerts@stonkhouse.test>',
    publicUrl: 'https://notifier.stonkhouse.test',
  });
});

test('the bot token must look like one, and TELEGRAM_API_BASE loses its trailing slash', () => {
  assert.ok(issuesOf(testEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token' })).some((i) => i.startsWith('TELEGRAM_BOT_TOKEN')));
  assert.equal(parseConfig(testEnv({ TELEGRAM_API_BASE: 'http://127.0.0.1:9999/' })).telegram.apiBase, 'http://127.0.0.1:9999');
});

test('no issue message echoes a secret value', () => {
  const issues = issuesOf({
    DATABASE_URL: 'mysql://root:SECRET-DB@db/x',
    INDEXER_URL: 'ftp://SECRET-INDEXER',
    RH_RPC: 'SECRET-RPC',
    NOTIFIER_DATA_KEY: 'SECRET-KEY',
    TELEGRAM_BOT_TOKEN: '555:SECRET-BOT',
    VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
    VAPID_PRIVATE_KEY: 'SECRET-VAPID',
    SMTP_URL: 'http://user:SECRET-SMTP@smtp',
    APP_URL: 'https://app.test',
  });
  const text = issues.join('\n');
  assert.ok(issues.length >= 7, text);
  assert.ok(!text.includes('SECRET'), text);
});
