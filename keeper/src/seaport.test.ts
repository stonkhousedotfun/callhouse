/**
 * The Seaport order builder, pinned to real orders from chain 4663.
 *
 * WHY THIS FILE EXISTS: the order shape is a transcription of what Overcall's book accepts, and
 * the local order hash is what the keeper compares against `seaport.getOrderHash` before it
 * spends gas. A drift in the struct encoding — a field order, a type width, a missing item —
 * produces a hash that looks fine and never matches, and the keeper then refuses to publish
 * every week. So the hash is pinned to two REAL orders whose hashes were emitted by the real
 * Seaport: the one filled order (ops/recon/sample-overcall-order.json, tx 0x013cd30b...) and a
 * live 21-contract open order from the same book. Byte for byte, or this fails.
 *
 * DELIBERATELY ABSENT: no RPC. `readOrderHash` and friends are the chain side of the same
 * comparison and are exercised by the fork dry run (dryrun.ts), not here.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-seaport-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
// The four values the builder reads from config must be the chain-4663 defaults for the pinned
// hashes to reproduce. Clear any operator override so the test is about the code, not the shell.
for (const key of ['SEAPORT_ZONE', 'SEAPORT_CONDUIT_KEY', 'CLEARINGHOUSE', 'USDG', 'OVERCALL_FEE_RECIPIENT', 'SEAPORT', 'CHAIN_ID']) {
  delete process.env[key];
}

const {
  ITEM_TYPE_ERC1155,
  ITEM_TYPE_ERC20,
  ORDER_TYPE_PARTIAL_OPEN,
  PLACEHOLDER_SIGNATURE,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  buildOrderComponents,
  componentsFromJson,
  componentsToJson,
  digestFromDomainSeparator,
  localOrderDigest,
  localOrderHash,
  randomSalt,
  splitPremium,
  toOrderParametersJson,
} = await import('./seaport.js');

/*//////////////////////////////////////////////////////////////
                         THE KNOWN VECTORS
//////////////////////////////////////////////////////////////*/

const CLEAR = '0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const OVERCALL_FEE = '0xdAe7e82A2E7D566C67E87C164B05a1C560190782';

/** The one real filled Overcall order on 4663. Fill tx 0x013cd30b..., block 61153997. */
const FILLED = {
  offerer: '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be',
  optionId: 56885395977254369119998982131173877604217583767740146085872832926902011297792n,
  contracts: 1n,
  unitPrice6: 4_000_000n, // consideration 3_800_000 + 200_000
  endTime: 1789761600n,
  salt: 95941992777576660739888578361827826050802484697670100586800480598437555708740n,
  counter: 0n,
  orderHash: '0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522',
  digest: '0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150',
  domainSeparator: '0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0',
} as const;

/** A live 21-contract PARTIAL_OPEN order from the same book: N > 1, so the per-contract
 *  rounding is inside the hash (47_500 * 21 and 2_500 * 21, not 5% of 1_050_000). */
const OPEN_21 = {
  offerer: '0x789A7490718CF944D6F2cA411ED53cDeFd56306a',
  optionId: 873393324505681306211742772675693943830305973181304956549530887026947129344n,
  contracts: 21n,
  unitPrice6: 50_000n,
  endTime: 1789761600n,
  salt: 75794036196465706161439318797461512643738241961564828131921871581053974772386n,
  counter: 0n,
  orderHash: '0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded',
  toVault6: 997_500n,
  toOvercall6: 52_500n,
} as const;

/*//////////////////////////////////////////////////////////////
                              THE SHAPE
//////////////////////////////////////////////////////////////*/

test('the builder produces exactly the README shape', () => {
  const c = buildOrderComponents(FILLED);

  assert.equal(c.offerer, FILLED.offerer);
  assert.equal(c.zone, ZERO_ADDRESS);
  assert.equal(c.zoneHash, ZERO_BYTES32);
  assert.equal(c.conduitKey, ZERO_BYTES32);
  assert.equal(c.orderType, ORDER_TYPE_PARTIAL_OPEN);
  assert.equal(c.orderType, 1);
  assert.equal(c.startTime, 0n);
  assert.equal(c.endTime, FILLED.endTime);
  assert.equal(c.counter, 0n);
  assert.equal(c.salt, FILLED.salt);

  assert.equal(c.offer.length, 1);
  assert.deepEqual(c.offer[0], {
    itemType: ITEM_TYPE_ERC1155,
    token: CLEAR,
    identifierOrCriteria: FILLED.optionId,
    startAmount: 1n,
    endAmount: 1n,
  });
  assert.equal(ITEM_TYPE_ERC1155, 3);

  assert.equal(c.consideration.length, 2);
  assert.deepEqual(c.consideration[0], {
    itemType: ITEM_TYPE_ERC20,
    token: USDG,
    identifierOrCriteria: 0n,
    startAmount: 3_800_000n,
    endAmount: 3_800_000n,
    recipient: FILLED.offerer,
  });
  assert.deepEqual(c.consideration[1], {
    itemType: ITEM_TYPE_ERC20,
    token: USDG,
    identifierOrCriteria: 0n,
    startAmount: 200_000n,
    endAmount: 200_000n,
    recipient: OVERCALL_FEE,
  });
  assert.equal(ITEM_TYPE_ERC20, 1);
});

test('the 21-contract order carries the per-contract split, not 5% of the total', () => {
  const c = buildOrderComponents(OPEN_21);
  assert.equal(c.offer[0]?.startAmount, 21n);
  assert.equal(c.consideration[0]?.startAmount, OPEN_21.toVault6);
  assert.equal(c.consideration[1]?.startAmount, OPEN_21.toOvercall6);
  assert.deepEqual(
    splitPremium(OPEN_21.unitPrice6, OPEN_21.contracts),
    { feePerContract6: 2_500n, writerPerContract6: 47_500n, toOvercall6: 52_500n, toVault6: 997_500n, gross6: 1_050_000n },
  );
});

/*//////////////////////////////////////////////////////////////
                              THE HASH
//////////////////////////////////////////////////////////////*/

test('localOrderHash reproduces the real filled order hash byte for byte', () => {
  const c = buildOrderComponents(FILLED);
  assert.equal(localOrderHash(c), FILLED.orderHash);
});

test('localOrderHash reproduces the real 21-contract open order hash byte for byte', () => {
  const c = buildOrderComponents(OPEN_21);
  assert.equal(localOrderHash(c), OPEN_21.orderHash);
});

test('the EIP-712 digest matches the one the real signature was made over, both ways', () => {
  const c = buildOrderComponents(FILLED);
  // Derived from name/version/chainId/verifyingContract...
  assert.equal(localOrderDigest(c), FILLED.digest);
  // ...and from Seaport's live domain separator. The two must agree, or the domain is wrong.
  assert.equal(digestFromDomainSeparator(FILLED.orderHash, FILLED.domainSeparator), FILLED.digest);
  // And the struct hash is NOT the digest. Comparing the wrong one is the classic mistake.
  assert.notEqual(localOrderHash(c), localOrderDigest(c));
});

test('the hash moves when any field moves', () => {
  const base = localOrderHash(buildOrderComponents(FILLED));
  const variants = [
    { ...FILLED, counter: 1n },
    { ...FILLED, salt: FILLED.salt + 1n },
    { ...FILLED, contracts: 2n },
    { ...FILLED, unitPrice6: 4_000_020n },
    { ...FILLED, endTime: FILLED.endTime + 1n },
    { ...FILLED, offerer: OPEN_21.offerer },
  ];
  for (const variant of variants) {
    assert.notEqual(localOrderHash(buildOrderComponents(variant)), base);
  }
});

/*//////////////////////////////////////////////////////////////
                           SERIALISATION
//////////////////////////////////////////////////////////////*/

test('componentsToJson / componentsFromJson round-trip exactly, 256-bit values included', () => {
  const c = buildOrderComponents(FILLED);
  const json = componentsToJson(c);

  // Every uint is a decimal string, never a JSON number: the option id is 77 digits.
  assert.equal(json.offer[0]?.identifierOrCriteria, FILLED.optionId.toString());
  assert.equal(json.salt, FILLED.salt.toString());
  assert.equal(typeof json.counter, 'string');
  assert.equal(json.orderType, 1);
  assert.equal('totalOriginalConsiderationItems' in json, false, 'that field belongs to OrderParameters');

  // Through a real JSON.stringify / JSON.parse, as SQLite stores it.
  const back = componentsFromJson(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back, c);
  assert.equal(localOrderHash(back), FILLED.orderHash);
});

test('toOrderParametersJson drops the counter and appends the consideration count', () => {
  const c = buildOrderComponents(OPEN_21);
  const params = toOrderParametersJson(c);
  assert.equal('counter' in params, false);
  assert.equal(params.totalOriginalConsiderationItems, '2');
  assert.equal(params.consideration.length, 2);
  assert.equal(params.offer[0]?.startAmount, '21');
});

test('PLACEHOLDER_SIGNATURE is 65 well-formed bytes and passes Overcall\'s schema regex', () => {
  assert.match(PLACEHOLDER_SIGNATURE, /^0x([0-9a-f]{128}|[0-9a-f]{130})$/);
  assert.equal((PLACEHOLDER_SIGNATURE.length - 2) / 2, 65);
  assert.equal(PLACEHOLDER_SIGNATURE.slice(-2), '1b', 'v = 27 so (r, s, v) parsers do not choke');
});

test('randomSalt is a fresh 256-bit value each time', () => {
  const a = randomSalt();
  const b = randomSalt();
  assert.notEqual(a, b);
  assert.ok(a > 0n && a < 1n << 256n);
  assert.ok(b > 0n && b < 1n << 256n);
  // Without a salt the builder draws one; with one it uses it.
  const drawn = buildOrderComponents({ ...FILLED, salt: undefined });
  assert.notEqual(drawn.salt, FILLED.salt);
});

/*//////////////////////////////////////////////////////////////
                    THE RECON FILE STILL SAYS THIS
//////////////////////////////////////////////////////////////*/

test('ops/recon/sample-overcall-order.json, when present, still carries the pinned vectors', () => {
  const path = fileURLToPath(new URL('../../ops/recon/sample-overcall-order.json', import.meta.url));
  if (!existsSync(path)) {
    // The keeper's tests also run inside a filtered Docker build where ops/ is absent.
    // The literals above are the contract; the file is the evidence.
    return;
  }
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    _source: { orderHash: string; domainSeparator: string };
    _signature: { eip712Digest: string };
    parameters: { offerer: string; salt: string; endTime: string; offer: Array<{ identifierOrCriteria: string }> };
    _liveOpenOrderSecondSample: { orderHash: string; salt: string; optionId: string; quantity: string; unitPrice6: string };
  };
  assert.equal(doc._source.orderHash, FILLED.orderHash);
  assert.equal(doc._source.domainSeparator, FILLED.domainSeparator);
  assert.equal(doc._signature.eip712Digest, FILLED.digest);
  assert.equal(doc.parameters.offerer, FILLED.offerer);
  assert.equal(doc.parameters.salt, FILLED.salt.toString());
  assert.equal(doc.parameters.endTime, FILLED.endTime.toString());
  assert.equal(doc.parameters.offer[0]?.identifierOrCriteria, FILLED.optionId.toString());
  assert.equal(doc._liveOpenOrderSecondSample.orderHash, OPEN_21.orderHash);
  assert.equal(doc._liveOpenOrderSecondSample.salt, OPEN_21.salt.toString());
  assert.equal(doc._liveOpenOrderSecondSample.optionId, OPEN_21.optionId.toString());
  assert.equal(doc._liveOpenOrderSecondSample.quantity, OPEN_21.contracts.toString());
  assert.equal(doc._liveOpenOrderSecondSample.unitPrice6, OPEN_21.unitPrice6.toString());
});
