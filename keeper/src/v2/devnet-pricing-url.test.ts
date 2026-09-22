import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDevnetPricingUrl } from './devnet-pricing-url.js';

test('flag: --pricing-url <url> wins, both spellings, trailing slash trimmed', () => {
  assert.deepEqual(resolveDevnetPricingUrl(['--pricing-url', 'http://127.0.0.1:8790'], {}), { url: 'http://127.0.0.1:8790', source: 'flag' });
  assert.deepEqual(resolveDevnetPricingUrl(['--pricing-url=http://127.0.0.1:8790/'], {}), { url: 'http://127.0.0.1:8790', source: 'flag' });
  assert.deepEqual(resolveDevnetPricingUrl(['--pricing-url', 'https://pricing.example:8443/v2/'], {}), { url: 'https://pricing.example:8443/v2', source: 'flag' });
});

test('precedence: the flag beats PRICING_URL; other argv is ignored', () => {
  const env = { PRICING_URL: 'http://127.0.0.1:9' };
  assert.deepEqual(resolveDevnetPricingUrl(['--devnet-port', '8561', '--pricing-url', 'http://127.0.0.1:8790', 'extra'], env), { url: 'http://127.0.0.1:8790', source: 'flag' });
  assert.deepEqual(resolveDevnetPricingUrl(['--devnet-port', '8561'], env), { url: 'http://127.0.0.1:9', source: 'env' });
});

test('env: PRICING_URL is the fallback; empty means unset', () => {
  assert.deepEqual(resolveDevnetPricingUrl([], { PRICING_URL: 'http://127.0.0.1:8790' }), { url: 'http://127.0.0.1:8790', source: 'env' });
  assert.deepEqual(resolveDevnetPricingUrl([], { PRICING_URL: '  http://127.0.0.1:8790  ' }), { url: 'http://127.0.0.1:8790', source: 'env' });
  assert.deepEqual(resolveDevnetPricingUrl([], { PRICING_URL: '' }), { url: null, source: 'default' });
  assert.deepEqual(resolveDevnetPricingUrl([], { PRICING_URL: '   ' }), { url: null, source: 'default' });
});

test('default: no flag and no env keeps the in-process stub', () => {
  assert.deepEqual(resolveDevnetPricingUrl([], {}), { url: null, source: 'default' });
  assert.deepEqual(resolveDevnetPricingUrl(['--devnet-port', '8561'], {}), { url: null, source: 'default' });
});

test('usage errors: missing value, unknown --pricing-* flag, bad URL, query or fragment', () => {
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url'], {}), /--pricing-url needs a value/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url='], {}), /--pricing-url needs a value/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url', '--devnet-port'], {}), /--pricing-url needs a value/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-ur', 'http://x'], {}), /unknown flag/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url', 'not-a-url'], {}), /not a URL/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url', 'ftp://127.0.0.1'], {}), /http\(s\) URL/);
  assert.throws(() => resolveDevnetPricingUrl(['--pricing-url', 'http://127.0.0.1/fair?ticker=NVDA'], {}), /no query or fragment/);
  assert.throws(() => resolveDevnetPricingUrl([], { PRICING_URL: 'nope' }), /PRICING_URL is not a URL/);
});
