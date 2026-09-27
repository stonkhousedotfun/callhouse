/**
 * The pricing service's boot refuses on the event calendar the way pricing.env relies on. With
 * PRICING_EVENTS_PATH set (pricing.env sets it to the copy keeper/Dockerfile bakes), a missing or unparseable file
 * rejects startPricingService with EventCalendarFileError before anything listens. Unset, boot is unchanged.
 *
 *   pnpm --filter @callhouse/keeper exec tsx --test src/v2/pricing/main.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FetchChain } from './cboe.js';
import { USAGE as COVERAGE_USAGE } from './coverage-main.js';
import { parseEventCalendar } from './coverage.js';
import { EventCalendarFileError } from './events.js';
import { PRODUCTION_REGISTRY_FILE, isProductionPricing, loadPricingEnv, startPricingService, type RunningPricingService } from './main.js';
import { DEFAULT_POOL_TWAP_MAX_END_AGE_S, type PoolReader } from './pool-spot.js';
import type { SpotReader } from './spot.js';

/** Seams that fail if boot ever reaches the network: nothing here should. */
const offlineSpot: SpotReader = async () => {
  throw new Error('offline in tests');
};
const offlineChain: FetchChain = async () => {
  throw new Error('offline in tests');
};

/** A synthetic key (never a real one): Massive is the default provider and needs one. */
const SYNTHETIC_MASSIVE_KEY = 'SYNTHETIC0000000000000000000000000';
const BASE_ENV = { RH_RPC: 'http://127.0.0.1:9', PRICING_PORT: '0', KEEPER_LOG_LEVEL: 'silent', MASSIVE_API_KEY: SYNTHETIC_MASSIVE_KEY };

// Bound to 127.0.0.1, the address every read uses (cboe.test.ts shows why a no-host bind can be another's port).
function boot(env: Record<string, string>) {
  return startPricingService({ env: { ...BASE_ENV, ...env }, spotReader: offlineSpot, fetchChain: offlineChain, hostname: '127.0.0.1' });
}

async function assertBootRefused(env: Record<string, string>, code: EventCalendarFileError['code']): Promise<void> {
  // A boot that wrongly succeeds is closed, so the failure reports instead of holding the process open.
  let running: RunningPricingService | undefined;
  try {
    await assert.rejects(
      boot(env).then((r) => (running = r)),
      (error: unknown) => {
        assert.ok(error instanceof EventCalendarFileError, `an EventCalendarFileError, got ${String(error)}`);
        assert.equal(error.code, code);
        assert.match(error.message, /^PRICING_EVENTS_PATH /);
        return true;
      },
    );
  } finally {
    await running?.close();
  }
}

test('startPricingService: PRICING_EVENTS_PATH set and missing refuses boot (EventCalendarFileError, missing)', async () => {
  await assertBootRefused({ PRICING_EVENTS_PATH: join(mkdtempSync(join(tmpdir(), 'main-259-')), 'events.json') }, 'missing');
});

test('startPricingService: PRICING_EVENTS_PATH set and unparseable refuses boot (EventCalendarFileError, invalid)', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'main-259-')), 'events.json');
  writeFileSync(path, '{"events": "not a list"}');
  await assertBootRefused({ PRICING_EVENTS_PATH: path }, 'invalid');
});

test('startPricingService: /health serves the loaded file\'s re-check days, overdue past the day', async () => {
  // Real wall clock: one day long past and one far ahead, so the answer does not depend on when this runs.
  const path = join(mkdtempSync(join(tmpdir(), 'main-392-')), 'events.json');
  writeFileSync(path, JSON.stringify({ recheckBy: { NVDA: '2020-01-02', SPCX: '2999-01-02' }, events: [] }));
  const running = await boot({ PRICING_EVENTS_PATH: path });
  try {
    const body = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { eventRecheck: unknown };
    assert.deepEqual(body.eventRecheck, {
      NVDA: { recheckBy: '2020-01-02', overdue: true, coveredBy: null },
      SPCX: { recheckBy: '2999-01-02', overdue: false, coveredBy: null },
    });
  } finally {
    await running.close();
  }
});

test('startPricingService: PRICING_EVENTS_PATH unset boots as before and answers /health', async () => {
  const running = await boot({});
  try {
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await running.close();
  }
});

/*
 * The pool reader's TWAP end-age bound was a code option only. main.ts built
 * `createPoolObserveReader(env.rpcUrls)`, so production always ran pool-spot.ts's 300 s default. It is now
 * PRICING_POOL_MAX_END_AGE_S, parsed here AND handed to the reader at the call site.
 */
test('PRICING_POOL_MAX_END_AGE_S parses to env.poolReader.maxEndAgeS: default 300, whole seconds 1..3600, anything else refused by name', () => {
  assert.equal(DEFAULT_POOL_TWAP_MAX_END_AGE_S, 300, 'the pool-spot.ts default this env var defaults to');
  assert.equal(loadPricingEnv(BASE_ENV).poolReader.maxEndAgeS, 300);
  assert.equal(loadPricingEnv({ ...BASE_ENV, PRICING_POOL_MAX_END_AGE_S: '900' }).poolReader.maxEndAgeS, 900);
  assert.equal(loadPricingEnv({ ...BASE_ENV, PRICING_POOL_MAX_END_AGE_S: '1' }).poolReader.maxEndAgeS, 1);
  assert.equal(loadPricingEnv({ ...BASE_ENV, PRICING_POOL_MAX_END_AGE_S: '3600' }).poolReader.maxEndAgeS, 3_600);
  for (const bad of ['0', '3601', '1.5', 'abc', '-5']) {
    assert.throws(() => loadPricingEnv({ ...BASE_ENV, PRICING_POOL_MAX_END_AGE_S: bad }), /PRICING_POOL_MAX_END_AGE_S/, `${bad} is refused`);
  }
});

test('startPricingService hands PRICING_POOL_MAX_END_AGE_S to the pool reader it builds (the call site, not only the schema)', async () => {
  const offlinePool: PoolReader = {
    meta: async () => {
      throw new Error('offline in tests');
    },
    observe: async () => {
      throw new Error('offline in tests');
    },
  };
  const built: Array<{ rpcUrls: readonly string[]; options: { maxEndAgeS: number } }> = [];
  const bootWith = async (env: Record<string, string>) => {
    const running = await startPricingService({
      env: { ...BASE_ENV, ...env },
      spotReader: offlineSpot,
      fetchChain: offlineChain,
      createPoolReader: (rpcUrls, _timeoutMs, options) => {
        built.push({ rpcUrls, options });
        return offlinePool;
      },
    });
    await running.close();
  };
  await bootWith({ PRICING_POOL_MAX_END_AGE_S: '900' });
  await bootWith({});
  assert.deepEqual(built, [
    { rpcUrls: ['http://127.0.0.1:9'], options: { maxEndAgeS: 900 } },
    { rpcUrls: ['http://127.0.0.1:9'], options: { maxEndAgeS: 300 } },
  ]);
});

/*
 * The coverage CLI's --events help showed only the per-ticker list. A ticker's
 * entry may also be `{ "events": [...], "through": "YYYY-MM-DD" }` (coverage.ts tickerEventsSchema). Pinned HERE because
 * coverage-main.ts has no test file of its own, so it is covered here: the help's example must parse, with its
 * `through`, through the same parser --events uses.
 */
test('the coverage CLI --events help names the {events, through} form, and its example parses through parseEventCalendar', () => {
  const lines = COVERAGE_USAGE.split('\n');
  const from = lines.findIndex((l) => l.trimStart().startsWith('--events '));
  assert.ok(from >= 0, 'the --events flag is where this test reads it');
  const to = lines.findIndex((l, i) => i > from && /^\s{2}-/.test(l));
  const help = lines.slice(from, to).map((l) => l.trim()).join('');
  assert.match(help, /"through":"YYYY-MM-DD"/, 'the through form is documented');
  const example = help.match(/e\.g\. (\{.*\}); flags event-uncertainty/);
  assert.ok(example, 'the help carries one example calendar');
  const calendar = parseEventCalendar(JSON.parse(example[1]!));
  const nvda = calendar.get('NVDA');
  assert.ok(nvda, 'the example names NVDA');
  assert.equal(nvda.through, '2026-12-31');
  assert.equal(nvda.events.length, 1);
});

/*
 * Massive is the default; production refuses Cboe and
 * a missing key by name, before anything listens. Production is NODE_ENV=production (keeper/Dockerfile) or the
 * production registry (tier1.json, the default path). A local devnet registry may still name cboe explicitly.
 */
const DEV_REGISTRY = '../ops/markets/dev.json';
const { MASSIVE_API_KEY: _key, ...NO_KEY_ENV } = BASE_ENV;

test('Massive is the default provider; with it the key is required and named', () => {
  assert.equal(loadPricingEnv(BASE_ENV).chain.provider, 'massive');
  assert.throws(() => loadPricingEnv(NO_KEY_ENV), /MASSIVE_API_KEY: required when PRICING_CHAIN_PROVIDER=massive/);
  assert.throws(() => loadPricingEnv({ ...NO_KEY_ENV, NODE_ENV: 'production' }), /MASSIVE_API_KEY: required/);
});

test('production refuses PRICING_CHAIN_PROVIDER=cboe by name (NODE_ENV=production, or the production registry)', () => {
  const refusedCboe = /PRICING_CHAIN_PROVIDER: cboe is refused in production/;
  // The default registry path IS the production registry.
  assert.throws(() => loadPricingEnv({ ...NO_KEY_ENV, PRICING_CHAIN_PROVIDER: 'cboe' }), refusedCboe);
  assert.throws(() => loadPricingEnv({ ...NO_KEY_ENV, PRICING_CHAIN_PROVIDER: 'cboe', V2_REGISTRY_PATH: '/app/ops/markets/tier1.json' }), refusedCboe);
  assert.throws(() => loadPricingEnv({ ...NO_KEY_ENV, PRICING_CHAIN_PROVIDER: 'cboe', V2_REGISTRY_PATH: DEV_REGISTRY, NODE_ENV: 'production' }), refusedCboe);
  // Control: the devnet registry outside NODE_ENV=production may still name cboe explicitly (never by default).
  assert.equal(loadPricingEnv({ ...NO_KEY_ENV, PRICING_CHAIN_PROVIDER: 'cboe', V2_REGISTRY_PATH: DEV_REGISTRY }).chain.provider, 'cboe');
  assert.equal(PRODUCTION_REGISTRY_FILE, 'tier1.json');
  assert.equal(isProductionPricing({ V2_REGISTRY_PATH: 'x/tier1.devnet.json' }), false, 'a fork copy is not the production file');
  assert.equal(isProductionPricing({ V2_REGISTRY_PATH: DEV_REGISTRY, NODE_ENV: 'development' }), false);
});

test('the boot itself refuses cboe in production and a missing key, before anything listens', async () => {
  for (const [env, named] of [
    [{ ...NO_KEY_ENV, PRICING_CHAIN_PROVIDER: 'cboe', NODE_ENV: 'production' }, /PRICING_CHAIN_PROVIDER: cboe is refused in production/],
    [{ ...NO_KEY_ENV, NODE_ENV: 'production' }, /MASSIVE_API_KEY: required/],
  ] as const) {
    let running: RunningPricingService | undefined;
    try {
      await assert.rejects(
        startPricingService({ env, spotReader: offlineSpot, fetchChain: offlineChain }).then((r) => (running = r)),
        named,
      );
    } finally {
      await running?.close();
    }
  }
  // Control: the same boot with the key on massive listens, and /health says Massive serves the chains.
  const running = await boot({ NODE_ENV: 'production' });
  try {
    const body = (await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()) as { chainProvider: string };
    assert.equal(body.chainProvider, 'massive-options');
  } finally {
    await running.close();
  }
});
