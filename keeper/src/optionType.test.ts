/**
 * The option id derivation and the strike rounding, pinned to the five real NVDA option types.
 *
 * WHY THIS FILE EXISTS: the keeper checks `clear.tokenType(id)` for an id it computed itself
 * BEFORE it creates the type, and arms the vault on that id. A derivation off by a byte order
 * (the top 20 bytes of the hash, not the low 20) would create a type, read `None` for the wrong
 * id, try to create it again and revert `OptionsTypeExists` every week. The five ids below were
 * emitted by the real Clear for Overcall's cycle 1 (ops/recon/R4-valorem-abi.md).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: optionType.ts imports config.ts for the unit constants ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-option-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { TOKEN_TYPE_CLAIM, TOKEN_TYPE_NONE, TOKEN_TYPE_OPTION, optionIdFor, optionIdOfClaim, targetStrike6, weeklyTuple } =
  await import('./optionType.js');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const LOT = 1_000_000_000_000_000_000n;

/** Overcall's NVDA cycle 1: exercise 1789761600, expiry 1789848000, strikes 226..246. */
const REAL: Array<[bigint, bigint]> = [
  [226_000_000n, 113025628429828481228850936737953628080486640605422851339090182744894714413056n],
  [231_000_000n, 29652592033419692000166847561911668028189801263392568326594311383797020491776n],
  [236_000_000n, 13956151908388063551378518883460877979717043668997816139085862263440384458752n],
  [241_000_000n, 8012928620938394388054169085135774622795258770514699139381494411582911807488n],
  [246_000_000n, 56885395977254369119998982131173877604217583767740146085872832926902011297792n],
];

test('optionIdFor reproduces the five real NVDA ids: top 20 bytes of the tuple hash, shifted << 96', () => {
  for (const [strike, id] of REAL) {
    const tuple = weeklyTuple(NVDA, USDG, strike, 1789761600, 1789848000);
    assert.equal(optionIdFor(tuple), id, `strike ${strike}`);
    assert.equal(id & ((1n << 96n) - 1n), 0n, 'an option id has a zero claim key');
  }
  // Hex form of the 226 rung, as R4 prints it.
  assert.equal(`0x${optionIdFor(weeklyTuple(NVDA, USDG, 226_000_000n, 1789761600, 1789848000)).toString(16)}`, '0xf9e23d199282d4611ff78a93abe9f31de2d43398000000000000000000000000');
});

test('the id commits to every field of the tuple', () => {
  const base = optionIdFor(weeklyTuple(NVDA, USDG, 226_000_000n, 1789761600, 1789848000));
  assert.notEqual(optionIdFor(weeklyTuple(NVDA, USDG, 226_000_000n, 1789761600 + 1, 1789848000)), base);
  assert.notEqual(optionIdFor(weeklyTuple(NVDA, USDG, 226_000_000n, 1789761600, 1789848000 + 1)), base);
  assert.notEqual(optionIdFor(weeklyTuple(NVDA, USDG, 227_000_000n, 1789761600, 1789848000)), base);
  assert.notEqual(optionIdFor(weeklyTuple(USDG, NVDA, 226_000_000n, 1789761600, 1789848000)), base);
  assert.notEqual(optionIdFor({ ...weeklyTuple(NVDA, USDG, 226_000_000n, 1789761600, 1789848000), underlyingAmount: LOT - 1n }), base);
});

test('optionIdOfClaim strips the claim key; the first claim on an option is optionId + 1', () => {
  const [, id] = REAL[0] as [bigint, bigint];
  assert.equal(optionIdOfClaim(id + 1n), id);
  assert.equal(optionIdOfClaim(id + 7n), id);
  assert.equal(optionIdOfClaim(id), id);
});

test('weeklyTuple is one Stock Token per contract against USDG', () => {
  const t = weeklyTuple(NVDA, USDG, 230_000_000n, 1, 2);
  assert.equal(t.underlyingAsset, NVDA);
  assert.equal(t.underlyingAmount, LOT, 'Policy.LOT: the vault refuses any other (UnexpectedLotSize)');
  assert.equal(t.exerciseAsset, USDG);
  assert.equal(t.exerciseAmount, 230_000_000n);
  assert.deepEqual([t.exerciseTimestamp, t.expiryTimestamp], [1, 2]);
});

test('targetStrike6: spot lifted by the target, rounded half up to a whole USDG', () => {
  // The real print of 2026-09-12: 218.297934 USDG. +5% = 229.2128 -> 229.
  assert.equal(targetStrike6(218_297_934n, 500), 229_000_000n);
  // +3% = 224.846872 -> 225; +12% = 244.493686 -> 244.
  assert.equal(targetStrike6(218_297_934n, 300), 225_000_000n);
  assert.equal(targetStrike6(218_297_934n, 1200), 244_000_000n);
  // Half rounds up: 200 x 1.0525 = 210.5 -> 211; just under stays.
  assert.equal(targetStrike6(200_000_000n, 525), 211_000_000n);
  assert.equal(targetStrike6(200_000_000n, 524), 210_000_000n);
  // 0 bps is spot itself, rounded.
  assert.equal(targetStrike6(218_297_934n, 0), 218_000_000n);
  assert.equal(targetStrike6(218_500_000n, 0n), 219_000_000n);
});

test('the token types the arm gate distinguishes', () => {
  assert.deepEqual([TOKEN_TYPE_NONE, TOKEN_TYPE_OPTION, TOKEN_TYPE_CLAIM], [0, 1, 2]);
});
