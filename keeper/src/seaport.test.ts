/**
 * The Seaport order builder and the local order hash, pinned to real orders from chain 4663.
 *
 * WHY THIS FILE EXISTS: the order shape is what SeaportOrderLib checks field by field at
 * `approveListing`, and the local order hash is what the keeper compares against
 * `seaport.getOrderHash` before it spends gas (and what the web fill page derives to trust
 * /orders). A drift in the struct encoding — a field order, a type width, a missing item —
 * produces a hash that looks fine and never matches, and the keeper then refuses to publish
 * every week. So the hash is pinned to two REAL orders whose hashes were emitted by the real
 * Seaport: a filled one (ops/recon/sample-overcall-order.json, tx 0x013cd30b...) and a live
 * 21-contract open order from the same book. Those two are two-item PARTIAL_OPEN orders from the
 * old venue; the hash is shape-agnostic, so they are built by hand here and the keeper's own
 * builder is tested for the new shape beside them.
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
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
// The values the builder reads from config must be the chain-4663 defaults for the pinned
// hashes to reproduce. Clear any operator override so the test is about the code, not the shell.
for (const key of ['SEAPORT_CONDUIT_KEY', 'CLEARINGHOUSE', 'USDG', 'SEAPORT', 'CHAIN_ID']) {
  delete process.env[key];
}

const {
  EMPTY_SIGNATURE,
  ITEM_TYPE_ERC1155,
  ITEM_TYPE_ERC20,
  ORDER_TYPE_PARTIAL_RESTRICTED,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  buildOrderComponents,
  componentsFromJson,
  componentsToJson,
  digestFromDomainSeparator,
  filledContracts,
  localOrderDigest,
  localOrderHash,
  randomSalt,
  toOrderParametersJson,
} = await import('./seaport.js');
type OrderComponentsStruct = import('./seaport.js').OrderComponentsStruct;

/*//////////////////////////////////////////////////////////////
                         THE KNOWN VECTORS
//////////////////////////////////////////////////////////////*/

const CLEAR = '0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const VAULT = '0x1111111111111111111111111111111111111111';
/** The old venue's fee recipient: part of the two REAL orders' hashes, nothing else. */
const OLD_FEE_RECIPIENT = '0xdAe7e82A2E7D566C67E87C164B05a1C560190782';

/** A real filled order on 4663 (fill tx 0x013cd30b..., block 61153997): PARTIAL_OPEN, two items. */
const FILLED = {
  offerer: '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be',
  optionId: 56885395977254369119998982131173877604217583767740146085872832926902011297792n,
  contracts: 1n,
  toVault6: 3_800_000n,
  toFee6: 200_000n,
  endTime: 1789761600n,
  salt: 95941992777576660739888578361827826050802484697670100586800480598437555708740n,
  counter: 0n,
  orderHash: '0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522',
  digest: '0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150',
  domainSeparator: '0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0',
} as const;

/** A real 21-contract PARTIAL_OPEN order from the same book. */
const OPEN_21 = {
  offerer: '0x789A7490718CF944D6F2cA411ED53cDeFd56306a',
  optionId: 873393324505681306211742772675693943830305973181304956549530887026947129344n,
  contracts: 21n,
  toVault6: 997_500n,
  toFee6: 52_500n,
  endTime: 1789761600n,
  salt: 75794036196465706161439318797461512643738241961564828131921871581053974772386n,
  counter: 0n,
  orderHash: '0xeda0150a4b4fa3dbdac9fb4aca507c9784f19b9024dc24c52c6993429ef4bded',
} as const;

/** The old venue's two-item PARTIAL_OPEN shape, built by hand: the hash function does not care. */
function oldVenueOrder(v: typeof FILLED | typeof OPEN_21): OrderComponentsStruct {
  return {
    offerer: v.offerer,
    zone: ZERO_ADDRESS,
    offer: [{ itemType: ITEM_TYPE_ERC1155, token: CLEAR, identifierOrCriteria: v.optionId, startAmount: v.contracts, endAmount: v.contracts }],
    consideration: [
      { itemType: ITEM_TYPE_ERC20, token: USDG, identifierOrCriteria: 0n, startAmount: v.toVault6, endAmount: v.toVault6, recipient: v.offerer },
      { itemType: ITEM_TYPE_ERC20, token: USDG, identifierOrCriteria: 0n, startAmount: v.toFee6, endAmount: v.toFee6, recipient: OLD_FEE_RECIPIENT },
    ],
    orderType: 1,
    startTime: 0n,
    endTime: v.endTime,
    zoneHash: ZERO_BYTES32,
    salt: v.salt,
    conduitKey: ZERO_BYTES32,
    counter: v.counter,
  };
}

/** The keeper's own listing: 23 contracts at 0.873192 USDG, the dry-run's numbers. */
const OURS = {
  vault: VAULT,
  optionId: FILLED.optionId,
  contracts: 23n,
  unitPrice6: 873_192n,
  endTime: 1789761600n,
  counter: 645105783290196256915466989660461880n,
  salt: FILLED.salt,
} as const;

/*//////////////////////////////////////////////////////////////
                              THE SHAPE
//////////////////////////////////////////////////////////////*/

test('the builder produces exactly the shape SeaportOrderLib authorises', () => {
  const c = buildOrderComponents(OURS);

  assert.equal(c.offerer, VAULT, 'the vault offers');
  assert.equal(c.zone, VAULT, 'the vault is its own zone: authorizeOrder writes the fill');
  assert.equal(c.zoneHash, ZERO_BYTES32);
  assert.equal(c.conduitKey, ZERO_BYTES32);
  assert.equal(c.orderType, ORDER_TYPE_PARTIAL_RESTRICTED);
  assert.equal(c.orderType, 3, 'PARTIAL_RESTRICTED and nothing else (BadOrderType)');
  assert.equal(c.startTime, 0n);
  assert.equal(c.endTime, OURS.endTime, 'the exercise timestamp, not the expiry');
  assert.equal(c.counter, OURS.counter);
  assert.equal(c.salt, OURS.salt);

  assert.equal(c.offer.length, 1);
  assert.deepEqual(c.offer[0], {
    itemType: ITEM_TYPE_ERC1155,
    token: CLEAR,
    identifierOrCriteria: OURS.optionId,
    startAmount: 23n,
    endAmount: 23n,
  });
  assert.equal(ITEM_TYPE_ERC1155, 3);

  assert.equal(c.consideration.length, 1, 'ONE item: no venue fee, nobody else is paid');
  assert.deepEqual(c.consideration[0], {
    itemType: ITEM_TYPE_ERC20,
    token: USDG,
    identifierOrCriteria: 0n,
    startAmount: 873_192n * 23n,
    endAmount: 873_192n * 23n,
    recipient: VAULT,
  });
  assert.equal(ITEM_TYPE_ERC20, 1);
  // gross % amount == 0 by construction, so PremiumNotDivisibleByOrderSize is impossible.
  assert.equal((c.consideration[0]?.startAmount ?? 0n) % 23n, 0n);
});

test('the builder refuses a zero size or a zero price rather than build a dead order', () => {
  assert.throws(() => buildOrderComponents({ ...OURS, contracts: 0n }), /contracts must be positive/);
  assert.throws(() => buildOrderComponents({ ...OURS, unitPrice6: 0n }), /unitPrice6 must be positive/);
});

test('the signature is empty: the vault pre-validates on Seaport and has no key', () => {
  assert.equal(EMPTY_SIGNATURE, '0x');
});

/*//////////////////////////////////////////////////////////////
                              THE HASH
//////////////////////////////////////////////////////////////*/

test('localOrderHash reproduces the real filled order hash byte for byte', () => {
  assert.equal(localOrderHash(oldVenueOrder(FILLED)), FILLED.orderHash);
});

test('localOrderHash reproduces the real 21-contract open order hash byte for byte', () => {
  assert.equal(localOrderHash(oldVenueOrder(OPEN_21)), OPEN_21.orderHash);
});

test('the EIP-712 digest matches the one the real signature was made over, both ways', () => {
  const c = oldVenueOrder(FILLED);
  // Derived from name/version/chainId/verifyingContract...
  assert.equal(localOrderDigest(c), FILLED.digest);
  // ...and from Seaport's live domain separator. The two must agree, or the domain is wrong.
  assert.equal(digestFromDomainSeparator(FILLED.orderHash, FILLED.domainSeparator), FILLED.digest);
  // And the struct hash is NOT the digest. Comparing the wrong one is the classic mistake.
  assert.notEqual(localOrderHash(c), localOrderDigest(c));
});

test('the hash moves when any field moves, zone and order type included', () => {
  const base = localOrderHash(buildOrderComponents(OURS));
  const variants = [
    { ...OURS, counter: OURS.counter + 1n },
    { ...OURS, salt: OURS.salt + 1n },
    { ...OURS, contracts: 22n },
    { ...OURS, unitPrice6: 873_193n },
    { ...OURS, endTime: OURS.endTime + 1n },
    { ...OURS, vault: OPEN_21.offerer },
  ];
  for (const variant of variants) {
    assert.notEqual(localOrderHash(buildOrderComponents(variant)), base);
  }
  // The same items as an open order with no zone is a different order: the hash commits to the
  // zone that performs the write, so a foreign order cannot borrow the vault's authorisation.
  const open = { ...buildOrderComponents(OURS), zone: ZERO_ADDRESS, orderType: 1 };
  assert.notEqual(localOrderHash(open), base);
});

/*//////////////////////////////////////////////////////////////
                           SERIALISATION
//////////////////////////////////////////////////////////////*/

test('componentsToJson / componentsFromJson round-trip exactly, 256-bit values included', () => {
  const c = buildOrderComponents(OURS);
  const json = componentsToJson(c);

  // Every uint is a decimal string, never a JSON number: the option id is 77 digits.
  assert.equal(json.offer[0]?.identifierOrCriteria, OURS.optionId.toString());
  assert.equal(json.salt, OURS.salt.toString());
  assert.equal(typeof json.counter, 'string');
  assert.equal(json.orderType, 3);
  assert.equal('totalOriginalConsiderationItems' in json, false, 'that field belongs to OrderParameters');

  // Through a real JSON.stringify / JSON.parse, as SQLite stores it.
  const back = componentsFromJson(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back, c);
  assert.equal(localOrderHash(back), localOrderHash(c));
});

test('toOrderParametersJson drops the counter and appends the consideration count (1)', () => {
  const c = buildOrderComponents(OURS);
  const params = toOrderParametersJson(c);
  assert.equal('counter' in params, false);
  assert.equal(params.totalOriginalConsiderationItems, '1');
  assert.equal(params.consideration.length, 1);
  assert.equal(params.offer[0]?.startAmount, '23');
  assert.equal(params.orderType, 3);
  assert.equal(params.zone, VAULT);
});

test('filledContracts applies Seaport’s fill fraction to the size', () => {
  assert.equal(filledContracts(28n, { totalFilled: 0n, totalSize: 0n }), 0n, 'untouched');
  assert.equal(filledContracts(28n, { totalFilled: 1n, totalSize: 1n }), 28n, 'a full fulfillOrder is 1/1');
  assert.equal(filledContracts(28n, { totalFilled: 7n, totalSize: 28n }), 7n);
  assert.equal(filledContracts(28n, { totalFilled: 1n, totalSize: 4n }), 7n, 'the reduced fraction of 7/28');
  assert.equal(filledContracts(28n, { totalFilled: 13n, totalSize: 28n }), 13n);
});

test('randomSalt is a fresh 256-bit value each time', () => {
  const a = randomSalt();
  const b = randomSalt();
  assert.notEqual(a, b);
  assert.ok(a > 0n && a < 1n << 256n);
  assert.ok(b > 0n && b < 1n << 256n);
  // Without a salt the builder draws one; with one it uses it.
  const drawn = buildOrderComponents({ ...OURS, salt: undefined });
  assert.notEqual(drawn.salt, OURS.salt);
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
  assert.equal(BigInt(doc._liveOpenOrderSecondSample.unitPrice6) * OPEN_21.contracts, OPEN_21.toVault6 + OPEN_21.toFee6);
});
