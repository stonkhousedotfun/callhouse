/**
 * An EarnVault venue pull starved of gas REVERTS instead of
 * succeeding with 0 moved, so the mm bot's fixed gas for sweepToVenue / pullFromVenue must pay for the venue call.
 * Measured on a 4663 fork at block 71,413,160, the launch venue (Steakhouse USDG
 * through Erc4626VenueAdapter): the adapter's whole-position withdraw 354,422 gas; EarnVault.redeem through it 519,368.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MM_GAS } from './constants.js';

test('MM_GAS.earnMove pays at least twice the measured venue pull, with EarnVault.redeem around it', () => {
  const adapterPull = 354_422n;
  const redeemThroughAdapter = 519_368n;
  assert.ok(MM_GAS.earnMove >= 2n * redeemThroughAdapter, `earnMove ${MM_GAS.earnMove} is under twice the measured ${redeemThroughAdapter}`);
  assert.ok(MM_GAS.earnMove >= 3n * adapterPull, `earnMove ${MM_GAS.earnMove} is under three times the measured adapter pull ${adapterPull}`);
});
