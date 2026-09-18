/**
 * Message templates and number formatting.
 *
 * WHAT IS PINNED:
 *   - every §6 event kind renders, with a link into APP_URL;
 *   - every message about a long position states its cost and its max loss, rounded UP;
 *   - the copy rules: the FORBIDDEN phrases of scripts/copy-lint.mjs and the plan README appear
 *     neither in templates.ts nor in any rendered message, and no rendered message carries an
 *     exclamation mark, an emoji or a promotional word. scripts/copy-lint.mjs scans web/ only (its
 *     package list is fixed and the file belongs to another lane), so this test is the gate here;
 *   - numbers read as the dapp formats them (web/lib/format.ts, web/lib/v2/payoff.ts);
 *   - the payload schemas N2-02 builds against.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EVENT_KINDS, parsePayload, type EventKind, type ParsedEvent } from './events.js';
import { fmtAsset, fmtEastern, fmtMultiple, fmtShares, fmtUsdg, fmtUsdgUp } from './format.js';
import { appLinks, render, type Rendered } from './templates.js';
import { SAMPLE_PAYLOADS, SERIES_216, SERIES_221 } from './testing.js';

const APP = 'https://app.stonkhouse.test';
const links = appLinks(APP);

function event(kind: EventKind, payload: unknown): ParsedEvent {
  const parsed = parsePayload(kind, payload);
  assert.ok(parsed.ok, `${kind}: ${parsed.ok ? '' : parsed.issues.join('; ')}`);
  return parsed.event;
}

const usdg = (raw: string) => ({ raw, decimals: 6 });

/** Every template branch, so the copy checks see every sentence a user can receive. */
const VARIANTS: [string, EventKind, unknown][] = [
  ...EVENT_KINDS.map((kind): [string, EventKind, unknown] => [kind, kind, SAMPLE_PAYLOADS[kind]]),
  ['fill sell primary', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', total: usdg('1710000'), fee: usdg('90000') }],
  ['fill buy for another wallet', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, role: 'taker', recipient: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B' }],
  ['fill received from another wallet', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, role: 'recipient', payer: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B', total: usdg('1800000'), fee: usdg('0') }],
  ['fill sell resale', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', primary: false, total: usdg('1800000'), fee: usdg('0') }],
  ['fill sell with proceeds to another wallet', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', role: 'taker', recipient: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B', total: usdg('1610000'), fee: usdg('190000') }],
  ['fill sale proceeds received', 'fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', role: 'recipient', seller: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B', total: usdg('1610000'), fee: usdg('190000') }],
  ['strike cross short put below', 'strike_cross', { series: { ...SERIES_221, isPut: true }, position: 'short', direction: 'below', spot: usdg('220000000'), units: '100' }],
  ['price alert below', 'price_alert', { ...SAMPLE_PAYLOADS.price_alert, direction: 'below' }],
  ['expiry 24h short', 'expiry_24h', { series: SERIES_221, position: 'short', units: '50' }],
  ['expiry 1h long', 'expiry_1h', { series: SERIES_221, position: 'long', units: '50', cost: usdg('1900000') }],
  ['settlement long worthless', 'settlement_receipt', { series: { ...SERIES_216, strike: usdg('227000000') }, position: 'long', units: '30', settlementPrice: usdg('219400000'), payout: null, cost: usdg('270000'), toLedger: false }],
  ['settlement long in kind to ledger', 'settlement_receipt', { ...SAMPLE_PAYLOADS.settlement_receipt, payout: { asset: 'stock', amount: { raw: '6198723792160437', decimals: 18 } }, payoutValue: usdg('1360000'), toLedger: true }],
  ['settlement short', 'settlement_receipt', { series: SERIES_216, position: 'short', units: '50', settlementPrice: usdg('219400000'), payout: { asset: 'stock', amount: { raw: '492024612579762989', decimals: 18 } }, toLedger: false }],
  ['settlement short nothing back', 'settlement_receipt', { series: SERIES_216, position: 'short', units: '50', settlementPrice: usdg('219400000'), payout: null, toLedger: false }],
  ['auto roll skipped', 'auto_roll', { ticker: 'NVDA', status: 'skipped', lastRolledAt: 1789156800 }],
  ['auto roll skipped with due time', 'auto_roll', { ticker: 'NVDA', status: 'skipped', dueAt: 1789997400, lastRolledAt: 1789392900 }],
  ['auto roll skipped never rolled', 'auto_roll', { ticker: 'NVDA', status: 'skipped', dueAt: 1789997400 }],
  ['payout to ledger in kind', 'payout_failed_to_ledger', { series: SERIES_216, asset: 'stock', amount: { raw: '6198723792160437', decimals: 18 } }],
];

const rendered: [string, EventKind, unknown, Rendered][] = VARIANTS.map(([label, kind, payload]) => [
  label,
  kind,
  payload,
  render(event(kind, payload), links),
]);

test('every §6 kind renders a title, a body and a link into the app', () => {
  assert.deepEqual([...EVENT_KINDS].sort(), Object.keys(SAMPLE_PAYLOADS).sort());
  for (const [label, , , message] of rendered) {
    assert.ok(message.title.length > 0 && message.title.length <= 120, label);
    assert.ok(message.body.length > 0, label);
    assert.ok(message.url.startsWith(`${APP}/`), `${label}: ${message.url}`);
    assert.ok(!message.body.includes('undefined') && !message.title.includes('undefined'), label);
    assert.ok(!message.body.includes('NaN'), label);
  }
});

test('links go to the page the message is about', () => {
  const byLabel = new Map(rendered.map(([label, , , m]) => [label, m.url]));
  assert.equal(byLabel.get('fill_receipt'), `${APP}/NVDA/${SERIES_221.longId}`);
  assert.equal(byLabel.get('price_alert'), `${APP}/NVDA`);
  assert.equal(byLabel.get('writer_itm_warning'), `${APP}/earn/NVDA`);
  assert.equal(byLabel.get('auto_roll'), `${APP}/earn/NVDA`);
  assert.equal(byLabel.get('payout_failed_to_ledger'), `${APP}/portfolio`);
  assert.equal(byLabel.get('settlement long in kind to ledger'), `${APP}/portfolio`);
});

test('a buy receipt reads exactly as specified', () => {
  const message = render(event('fill_receipt', SAMPLE_PAYLOADS.fill_receipt), links);
  assert.equal(message.title, 'Bought NVDA 221.00 call');
  assert.equal(
    message.body,
    [
      'You bought 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT, at 3.60 USDG per share.',
      'Cost: 1.90 USDG, including 0.10 USDG in fees. Max loss: 1.90 USDG.',
      'It pays out only if NVDA settles above 221.00 USDG at expiry.',
    ].join('\n'),
  );
});

test('a sale paid to another wallet: the seller’s receipt names it, the recipient’s states what it received and holds no position', () => {
  const byLabel = new Map(rendered.map(([label, , , m]) => [label, m]));
  assert.deepEqual(byLabel.get('fill sell with proceeds to another wallet'), {
    title: 'Sold NVDA 221.00 call, proceeds to 0x4088…030B',
    body: [
      'You wrote and sold 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT, at 3.60 USDG per share.',
      'Proceeds: 1.61 USDG, after 0.19 USDG in fees, paid to wallet 0x4088…030B.',
      'Your collateral backs these options until they settle. If NVDA settles above 221.00 USDG, holders are paid from it.',
    ].join('\n'),
    url: `${APP}/NVDA/${SERIES_221.longId}`,
  });
  assert.deepEqual(byLabel.get('fill sale proceeds received'), {
    title: 'Received sale proceeds: NVDA 221.00 call',
    body: [
      'Wallet 0x4088…030B sold 0.50 shares of the NVDA 221.00 call expiring Fri 25 Sep, 4:00pm EDT, at 3.60 USDG per share, and the proceeds were paid to your wallet.',
      'Received: 1.61 USDG, after 0.19 USDG in fees.',
    ].join('\n'),
    url: `${APP}/NVDA/${SERIES_221.longId}`,
  });
});

test('auto-roll skipped states when the roll fell due and the last roll; a payload queued without dueAt keeps its old wording', () => {
  const byLabel = new Map(rendered.map(([label, , , m]) => [label, m.body]));
  assert.equal(
    byLabel.get('auto roll skipped with due time'),
    [
      'Auto-roll has not rolled your NVDA position. The roll was due when the session opened Mon 21 Sep, 9:30am EDT, more than 24 hours ago.',
      'Last roll: Mon 14 Sep, 9:35am EDT.',
      'Nothing new is listed for sale until it rolls. Check the strategy on Earn.',
    ].join('\n'),
  );
  assert.equal(
    byLabel.get('auto roll skipped never rolled'),
    [
      'Auto-roll has not rolled your NVDA position. The roll was due when the session opened Mon 21 Sep, 9:30am EDT, more than 24 hours ago.',
      'Nothing new is listed for sale until it rolls. Check the strategy on Earn.',
    ].join('\n'),
  );
  assert.equal(
    byLabel.get('auto roll skipped'),
    [
      'Auto-roll has not rolled your NVDA position for more than 24 hours (last roll Fri 11 Sep, 4:00pm EDT).',
      'Nothing new is listed for sale until it rolls. Check the strategy on Earn.',
    ].join('\n'),
  );
});

test('a worthless long says what was lost and that it was the most it could lose', () => {
  const message = rendered.find(([label]) => label === 'settlement long worthless')?.[3];
  assert.ok(message);
  assert.equal(message.title, 'Your NVDA 227.00 call expired worthless');
  assert.equal(
    message.body,
    [
      'Your NVDA 227.00 call (0.30 shares) expired worthless: NVDA settled at 219.40 USDG, below the 227.00 USDG strike.',
      'You lost the cost, 0.27 USDG. Max loss: 0.27 USDG, the most this position could lose.',
    ].join('\n'),
  );
});

test('a paid long states the payout, where it went, cost, max loss and the multiple', () => {
  const paid = render(event('settlement_receipt', SAMPLE_PAYLOADS.settlement_receipt), links);
  assert.equal(paid.title, 'Your NVDA 216.00 call settled: paid 1.36 USDG');
  assert.ok(paid.body.includes('Paid: 1.36 USDG, sent to your wallet.'), paid.body);
  assert.ok(paid.body.includes('Cost: 0.50 USDG. Max loss: 0.50 USDG. The payout is 2.72 times the cost.'), paid.body);

  const inKind = rendered.find(([label]) => label === 'settlement long in kind to ledger')?.[3];
  assert.ok(inKind);
  assert.ok(
    inKind.body.includes('Paid: 0.0061 NVDA Stock Tokens (1.36 USDG at the settlement price), held in your Stonkhouse balance.'),
    inKind.body,
  );
});

test('every message about a long position states cost and max loss', () => {
  const longs = rendered.filter(([, kind, payload]) => {
    const p = payload as { position?: string; side?: string };
    return p.position === 'long' || (kind === 'fill_receipt' && p.side === 'buy');
  });
  assert.ok(longs.length >= 7, `only ${longs.length} long variants`);
  for (const [label, , payload, message] of longs) {
    const p = payload as { cost?: { raw: string }; total?: { raw: string } };
    const cost = fmtUsdgUp(BigInt((p.cost ?? p.total)?.raw ?? '0'));
    assert.match(message.body, new RegExp(`Cost: ${cost} USDG|lost the cost, ${cost} USDG`), label);
    assert.ok(message.body.includes(`Max loss: ${cost} USDG`), `${label}: ${message.body}`);
  }
});

/** scripts/copy-lint.mjs FORBIDDEN, plus the plan README copy rules. */
const FORBIDDEN: RegExp[] = [
  /\bAPY\b/i,
  /\bAPR\b/i,
  /10\s*%\s*weekly/i,
  /projected\s+(yield|return|apy|income)/i,
  /annuali[sz]ed/i,
  /backed\s+by\s+nvidia/i,
  /dividend\s+paid\s+(in\s+cash\s+)?by\s+nvidia/i,
  /guaranteed\s+(yield|return|premium)/i,
  /risk[-\s]?free/i,
  /tokeni[sz]ed\s+(stocks?|equit(y|ies)|shares?)/i,
  /\bguarantee/i,
];

/** Tone: nothing a message says may read as a pitch. */
const PROMOTIONAL: RegExp[] = [
  /!/,
  /\p{Extended_Pictographic}/u,
  /\b(moon|lambo|huge|massive|jackpot|don'?t miss|act now|hurry|last chance|free money|win big|profit|gains?|earn up to|opportunity|exciting|congratulations|amazing|boost)\b/i,
];

test('copy rules: no forbidden phrase in templates.ts or in any rendered message', () => {
  const source = readFileSync(new URL('./templates.ts', import.meta.url), 'utf8');
  for (const rule of FORBIDDEN) assert.ok(!rule.test(source), `templates.ts matches ${rule}`);
  for (const [label, , , message] of rendered) {
    const text = `${message.title}\n${message.body}`;
    for (const rule of [...FORBIDDEN, ...PROMOTIONAL]) assert.ok(!rule.test(text), `${label} matches ${rule}: ${text}`);
  }
});

test('the copy checks can fail (a check that cannot fail proves nothing)', () => {
  const bad = ['Guaranteed return', 'risk free', 'tokenized stocks', 'APY 12%', 'To the moon!', 'Nice 🚀'];
  for (const text of bad) {
    assert.ok([...FORBIDDEN, ...PROMOTIONAL].some((rule) => rule.test(text)), text);
  }
});

test('in-kind amounts say Stock Tokens', () => {
  const texts = rendered.map(([, , , m]) => m.body).join('\n');
  assert.ok(texts.includes('NVDA Stock Tokens'));
});

/* ------------------------------------------------------------------ format */

test('fmtUsdg drops digits past the cent, fmtUsdgUp rounds a cost up', () => {
  assert.equal(fmtUsdg(1_234_567_891n), '1,234.56');
  assert.equal(fmtUsdg(0n), '0.00');
  assert.equal(fmtUsdg(82_500n), '0.08');
  assert.equal(fmtUsdgUp(82_500n), '0.09');
  assert.equal(fmtUsdgUp(80_000n), '0.08');
  assert.equal(fmtUsdgUp(1n), '0.01');
  assert.equal(fmtUsdgUp(0n), '0.00');
  assert.equal(fmtUsdgUp(1_234_567_000_001n), '1,234,567.01');
  assert.throws(() => fmtUsdgUp(-1n));
});

test('shares, Stock Tokens and multiples', () => {
  assert.equal(fmtShares(40n), '0.40');
  assert.equal(fmtShares(12_345n), '123.45');
  assert.equal(fmtAsset(1_500_000_000_000_000_000n), '1.5000');
  assert.equal(fmtMultiple(1_360_000n, 500_000n), '2.72');
  assert.equal(fmtMultiple(1n, 3n), '0.33');
  assert.equal(fmtMultiple(1n, 0n), null);
});

test('times are shown on the New York clock with the zone in force', () => {
  assert.equal(fmtEastern(1790366400), 'Fri 25 Sep, 4:00pm EDT');
  // 4 December 2026 16:00 New York is 21:00Z: standard time.
  assert.equal(fmtEastern(Date.parse('2026-12-04T21:00:00Z') / 1000), 'Fri 4 Dec, 4:00pm EST');
});

/* ------------------------------------------------------------------ payload schemas */

test('payload schemas: a full SeriesRef is accepted and trimmed; bad payloads are refused with reasons', () => {
  const ok = parsePayload('fill_receipt', SAMPLE_PAYLOADS.fill_receipt);
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys((ok.event.payload as { series: object }).series).sort(), ['expiry', 'isPut', 'longId', 'strike', 'ticker']);

  const refusals: [EventKind, unknown, RegExp][] = [
    ['strike_cross', { ...SAMPLE_PAYLOADS.strike_cross, cost: undefined }, /cost is required/],
    ['expiry_24h', { series: SERIES_221, position: 'long', units: '50' }, /cost is required/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, price: { raw: '3600000', decimals: 18 } }, /USDG/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, units: '0' }, /units/],
    ['settlement_receipt', { ...SAMPLE_PAYLOADS.settlement_receipt, payout: { asset: 'stock', amount: usdg('1') } }, /decimals must match/],
    ['auto_roll', { ticker: 'NVDA', status: 'rolled' }, /needs series/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, role: 'recipient' }, /names the payer/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', role: 'recipient' }, /names the seller/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, role: 'recipient', payer: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B', recipient: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B' }, /does not name a recipient/],
    ['fill_receipt', { ...SAMPLE_PAYLOADS.fill_receipt, side: 'sell', payer: '0x4088c59Eb3fB713B124f182E7083AEb3358A030B' }, /payer goes with a buy/],
    ['auto_roll', { ticker: 'NVDA', status: 'skipped', dueAt: 0 }, /dueAt/],
    ['price_alert', { ...SAMPLE_PAYLOADS.price_alert, ticker: 'nvda' }, /ticker/],
  ];
  for (const [kind, payload, reason] of refusals) {
    const result = parsePayload(kind, payload);
    assert.equal(result.ok, false, kind);
    if (!result.ok) assert.match(result.issues.join('; '), reason);
  }
});
