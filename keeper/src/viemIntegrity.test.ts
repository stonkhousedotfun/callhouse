/**
 * The viem package in node_modules is the real one, not a stub.
 *
 * WHY THIS FILE EXISTS: on 2026-09-19 the materialised viem entry point in the pnpm store was
 * replaced by a four-line "probe stub" that exported checksumAddress as the IDENTITY function,
 * getAddress as a bare regex and nothing else. Every assertion in this repo that compared a
 * checksummed address to a checksummed literal then passed without checking anything, and no
 * address checksum was validated anywhere for the days it sat there. T-74 restored the package.
 *
 * Each workspace package resolves viem through its own node_modules symlink, so this guard is
 * duplicated in indexer, web and keeper deliberately: one package can be contaminated alone.
 *
 * READ THE VECTOR BEFORE CHANGING IT. It is given in lower case on purpose. The stub's own comment
 * said it used an "identity checksum so the probe's addresses (already canonical) pass" - against an
 * already-canonical vector an identity function is indistinguishable from a correct one. The
 * not-equal assertion below is what keeps this test honest if someone later swaps the vector.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksumAddress, isAddress, keccak256 } from 'viem';

/** Canonical EIP-55 test vector, lower case. */
const LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
/** The same address, correctly checksummed. */
const EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

test('viem checksums the canonical EIP-55 vector rather than echoing it back', () => {
  // Guards the guard: an identity checksum passes trivially on a canonical input.
  assert.notEqual(LOWER, EIP55);
  assert.equal(checksumAddress(LOWER), EIP55);
});

test('viem validates checksums instead of matching a hex regex', () => {
  // Well-formed hex, wrong case in the final nibble. A regex-only isAddress accepts this.
  assert.equal(isAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), false);
  assert.equal(isAddress(EIP55), true);
});

test('viem exports the rest of the root surface, not just the address helpers', () => {
  // The stub exported three names. Anything importing a fourth failed to link.
  assert.equal(
    keccak256('0x'),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});
