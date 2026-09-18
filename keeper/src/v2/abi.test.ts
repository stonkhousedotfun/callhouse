/**
 * The v2 ABI pipeline's consumer end, as the keeper sees it.
 *
 * WHY THIS FILE EXISTS: v2 has no hand-written ABIs in the keeper. src/v2/abi/*.ts and
 * src/v2/seriesId.ts are generated from ops/ by scripts/gen-abis.mjs
 * and committed. Nothing else notices when a contract lane re-exports ops/abis/v2 and nobody reruns
 * `pnpm gen:abis`: the cranker would send calls against the old ABI and log a new revert as a bare
 * selector. So:
 *   1. the drift test runs the generator in `--check` mode, which renders every output in memory
 *      and fails on any drifted, missing or stale file;
 *   2. the series id mirror is checked against the vectors Solidity wrote
 *      (callhouse-contracts script/v2/EmitSeriesIds.s.sol → ops/fixtures/v2/series-ids.json), since
 *      a wrong id here would place, reprice or redeem against a series that does not exist;
 *   3. a smoke test pins that the clearinghouse module is a narrow literal carrying the functions,
 *      events and V2Errors errors the keeper will call and decode (the type-level half runs under
 *      `pnpm typecheck`, the runtime half here).
 *
 * DELIBERATELY ABSENT: no RPC and no environment. Neither module imports config.ts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Address, ContractErrorName, ContractEventName, ContractFunctionName } from 'viem';

import { clearinghouseAbi } from './abi/clearinghouse.js';
import { isShortId, longIdOf, shortIdOf } from './seriesId.js';

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = fileURLToPath(new URL('../../../ops/fixtures/v2/series-ids.json', import.meta.url));

/** One vector of ops/fixtures/v2/series-ids.json: uint256 / uint128 as decimal strings. */
interface SeriesIdVector {
  underlying: Address;
  isPut: boolean;
  strike: string;
  expiry: number;
  longId: string;
  shortId: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { vectors: SeriesIdVector[] };

/*//////////////////////////////////////////////////////////////
                              DRIFT
//////////////////////////////////////////////////////////////*/

test('gen-abis --check: the committed v2 modules and seriesId copy match a fresh render of ops/', () => {
  const run = spawnSync(process.execPath, ['scripts/gen-abis.mjs', '--check'], { cwd: pkgRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

/*//////////////////////////////////////////////////////////////
                        SERIES ID VECTORS
//////////////////////////////////////////////////////////////*/

test('series-ids.json has vectors, starting with the NVDA weekly call', () => {
  assert.ok(fixture.vectors.length > 0);
  // Pinned so an emptied or regenerated-from-nothing fixture cannot pass by agreeing with itself.
  assert.deepEqual(fixture.vectors[0], {
    underlying: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    isPut: false,
    strike: '215000000',
    expiry: 1789675200,
    longId: '1581680213800746635134346334031613802560117164807063567697891155383864121172',
    shortId: '1581680213800746635134346334031613802560117164807063567697891155383864121173',
  });
});

for (const v of fixture.vectors) {
  test(`seriesId mirrors V2Ids.sol: ${v.underlying} isPut=${v.isPut} strike=${v.strike} expiry=${v.expiry}`, () => {
    const longId = BigInt(v.longId);
    const shortId = BigInt(v.shortId);
    const strike = BigInt(v.strike);

    assert.equal(longIdOf(v.underlying, v.isPut, strike, v.expiry), longId);
    assert.equal(longIdOf(v.underlying, v.isPut, strike, BigInt(v.expiry)), longId);
    assert.equal(longIdOf(v.underlying.toLowerCase() as Address, v.isPut, strike, v.expiry), longId);
    assert.equal(shortIdOf(longId), shortId);
    assert.equal(shortIdOf(shortId), shortId);
    assert.equal(isShortId(longId), false);
    assert.equal(isShortId(shortId), true);
  });
}

test('longIdOf refuses what the Solidity signature would: a strike above uint128, an expiry above uint40', () => {
  const v = fixture.vectors[0]!;
  assert.throws(() => longIdOf(v.underlying, false, 2n ** 128n, v.expiry));
  assert.throws(() => longIdOf(v.underlying, false, 1n, 2 ** 40));
});

/*//////////////////////////////////////////////////////////////
                       CLEARINGHOUSE MODULE
//////////////////////////////////////////////////////////////*/

// Type level: these assignments fail `pnpm typecheck` if a name leaves the ABI, and the two
// expected-error lines fail it if the module stops being a narrow `as const` literal (a widened ABI
// types every name as `string` and the expected error disappears).
const functions: ContractFunctionName<typeof clearinghouseAbi>[] = ['longIdOf', 'createSeries', 'redeem'];
const events: ContractEventName<typeof clearinghouseAbi>[] = ['SeriesCreated'];
const errors: ContractErrorName<typeof clearinghouseAbi>[] = ['InsufficientCollateral', 'UnknownSeries'];
// @ts-expect-error not a function of the clearinghouse
const notAFunction: ContractFunctionName<typeof clearinghouseAbi> = 'notAFunction';
// @ts-expect-error not an error of the clearinghouse or V2Errors
const notAnError: ContractErrorName<typeof clearinghouseAbi> = 'NotAnError';

const names = (type: string) => new Set(clearinghouseAbi.flatMap((item) => (item.type === type && "name" in item ? [item.name] : [])));

test('src/v2/abi/clearinghouse.ts carries the functions, events and V2Errors errors the keeper calls and decodes', () => {
  for (const name of functions) assert.ok(names('function').has(name), `function ${name}`);
  for (const name of events) assert.ok(names('event').has(name), `event ${name}`);
  for (const name of errors) assert.ok(names('error').has(name), `error ${name}`);
  assert.equal(names('function').has(notAFunction), false);
  assert.equal(names('error').has(notAnError), false);
});
