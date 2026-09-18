/**
 * Refused settlement pins named from reverts (pin.ts).
 *
 * WHY THIS FILE EXISTS: since INTERFACE_VERSION 6 every createSeries pins its expiry and the pin fails closed. A
 * refusal the cranker cannot name is a ladder that silently never appears (or a batch retried every tick); one it names
 * wrongly sends the operator to the wrong contract. Pinned: the selectors against the error signatures, each refusal
 * from a simulation's decoded error and from a Multicall3 result's raw revert data, SourceNotPinned's reason names, the
 * roll's ambiguous errors, and that a SourceNotPinned without data proves nothing under a limit that may have starved it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeErrorResult, toFunctionSelector } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { decodeRevertData, PIN_ERROR_SELECTORS, pinRefusalOf, SOURCE_REASON_NAMES } from './pin.js';

const SOURCE = '0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20';

test('the pin error selectors are the V2Errors signatures, and every one is in the keeper\'s Clearinghouse and AutoRoller ABIs', () => {
  assert.equal(PIN_ERROR_SELECTORS.PinMismatch, toFunctionSelector('PinMismatch()'));
  assert.equal(PIN_ERROR_SELECTORS.SourceNotPinned, toFunctionSelector('SourceNotPinned(address,bytes4)'));
  assert.equal(PIN_ERROR_SELECTORS.NotAuthorized, toFunctionSelector('NotAuthorized()'));
  assert.equal(PIN_ERROR_SELECTORS.NoSource, toFunctionSelector('NoSource()'));
  assert.deepEqual(Object.keys(PIN_ERROR_SELECTORS).map((k) => k), ['PinMismatch', 'SourceNotPinned', 'NotAuthorized', 'NoSource']);
  for (const abi of [clearinghouseAbi, autoRollerAbi]) {
    for (const name of Object.keys(PIN_ERROR_SELECTORS)) assert.ok(abi.some((x) => x.type === 'error' && x.name === name), name);
  }
});

test('createSeries: each refusal named, from a Multicall3 result\'s raw revert data; SourceNotPinned carries the source and a named reason', () => {
  const raw = (errorName: string, args: readonly unknown[] = []) => encodeErrorResult({ abi: clearinghouseAbi, errorName, args } as never);

  const mismatch = pinRefusalOf(decodeRevertData(clearinghouseAbi, raw('PinMismatch')), 'createSeries', false);
  assert.deepEqual({ error: mismatch?.error, cause: mismatch?.cause, source: mismatch?.source }, { error: 'PinMismatch', cause: 'pinmismatch', source: null });
  assert.equal(pinRefusalOf(decodeRevertData(clearinghouseAbi, raw('NotAuthorized')), 'createSeries', false)?.error, 'NotAuthorized');
  assert.match(pinRefusalOf(decodeRevertData(clearinghouseAbi, raw('NoSource')), 'createSeries', false)!.explanation, /setMarket/);

  const reasons: Array<[string, string, RegExp]> = [
    [PIN_ERROR_SELECTORS.NotAuthorized, 'NotAuthorized', /setOracle/],
    [PIN_ERROR_SELECTORS.NoSource, 'NoSource', /no configuration for the underlying/],
    [PIN_ERROR_SELECTORS.PinMismatch, 'PinMismatch', /earlier pin/],
    ['0x00000000', 'none', /no code, an answer that is not the pin selector, or out of gas/],
  ];
  for (const [reason, name, why] of reasons) {
    const r = pinRefusalOf(decodeRevertData(clearinghouseAbi, raw('SourceNotPinned', [SOURCE, reason])), 'createSeries', true);
    assert.equal(r?.error, 'SourceNotPinned');
    assert.equal(r?.source, SOURCE.toLowerCase());
    assert.equal(r?.reason, reason);
    assert.equal(r?.reasonName, name);
    assert.equal(SOURCE_REASON_NAMES[reason], name);
    assert.match(r!.explanation, why);
    assert.equal(r?.cause, `sourcenotpinned:${SOURCE.toLowerCase()}:${reason}`);
    assert.equal(r?.maybeOutOfGas, false, 'a probe runs with ample gas');
  }
  // A reason no v2 source raises is shown as its selector.
  assert.equal(pinRefusalOf({ name: 'SourceNotPinned', args: [SOURCE, '0xdeadbeef'] }, 'createSeries', true)?.reasonName, '0xdeadbeef');
});

test('a SourceNotPinned without revert data under a batch\'s limit may be a starved source; any other revert, or none, is no refusal', () => {
  const starved = pinRefusalOf({ name: 'SourceNotPinned', args: [SOURCE, '0x00000000'] }, 'createSeries', false);
  assert.equal(starved?.maybeOutOfGas, true);
  assert.equal(pinRefusalOf({ name: 'SourceNotPinned', args: [SOURCE, PIN_ERROR_SELECTORS.NotAuthorized] }, 'createSeries', false)?.maybeOutOfGas, false, 'a named reason is never gas');
  assert.equal(pinRefusalOf(decodeRevertData(clearinghouseAbi, encodeErrorResult({ abi: clearinghouseAbi, errorName: 'BadStrike' })), 'createSeries', true), null);
  assert.equal(pinRefusalOf({ name: null }, 'createSeries', true), null);
  assert.equal(pinRefusalOf(null, 'createSeries', true), null);
  // No revert data at all (the oracle frame itself out of gas) decodes to nothing; an unknown error to its selector.
  assert.equal(decodeRevertData(clearinghouseAbi, '0x'), null);
  assert.deepEqual(decodeRevertData(clearinghouseAbi, '0x12345678'), { name: '0x12345678', args: [] });
  // The raw selector of a known pin error is still a refusal (an ABI that lacks it).
  assert.equal(pinRefusalOf({ name: PIN_ERROR_SELECTORS.PinMismatch }, 'createSeries', true)?.error, 'PinMismatch');
});

test('roll: PinMismatch and SourceNotPinned are the series\' pin; NotAuthorized and NoSource are the roller\'s own (revoked operator, no spot)', () => {
  assert.equal(pinRefusalOf({ name: 'PinMismatch' }, 'roll', false)?.error, 'PinMismatch');
  assert.equal(pinRefusalOf({ name: 'SourceNotPinned', args: [SOURCE, PIN_ERROR_SELECTORS.NoSource] }, 'roll', false)?.reasonName, 'NoSource');
  assert.equal(pinRefusalOf({ name: 'NotAuthorized' }, 'roll', false), null);
  assert.equal(pinRefusalOf({ name: 'NoSource' }, 'roll', false), null);
});
