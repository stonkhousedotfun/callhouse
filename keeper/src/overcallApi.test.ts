/**
 * The Overcall listings client against an in-process stub, and the vault's error vocabulary.
 *
 * WHY THIS FILE EXISTS: the client is the one piece of the keeper that talks to a third party
 * whose schema we do not control. What it must get right is small and specific: the body shape,
 * the market query, treating a 200 on a repost as success, NOT retrying a 4xx that means our
 * order is wrong, retrying a 429 the way their limiter asks, and reading the newest fill on the
 * right rung. Each of those is a week of premium when it is wrong, and each is checked here
 * against a stub that records exactly what was sent.
 *
 * The second half pins abi.ts against the compiled contracts: every custom error the vault and
 * its two linked libraries can throw must be decodable by the keeper, because an alert that says
 * "reverted" and nothing else is what an operator reads at 20:00 UTC on a Friday. The list is
 * pinned as literals and, when contracts/out is present, re-derived from the artifacts too.
 *
 * DELIBERATELY ABSENT: no call to overcall.finance. OVERCALL_ORDERS_URL points at the stub.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeErrorResult,
  toFunctionSelector,
  type Abi,
  type Hex,
} from 'viem';

type AbiError = Extract<Abi[number], { type: 'error' }>;

/*//////////////////////////////////////////////////////////////
                            THE STUB
//////////////////////////////////////////////////////////////*/

interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Drop the connection instead of answering: a network error, not an HTTP one. */
  destroy?: boolean;
}
type Handler = (request: StubRequest) => StubResponse;

const requests: StubRequest[] = [];
let handler: Handler = () => ({ status: 500, body: { error: 'no handler set' } });

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://stub');
    const request: StubRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw === '' ? null : (JSON.parse(raw) as unknown),
    };
    requests.push(request);
    const reply = handler(request);
    if (reply.destroy) {
      res.destroy();
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('stub did not bind a port');
const STUB = `http://127.0.0.1:${address.port}`;

/* ---- environment: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-api-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.OVERCALL_ORDERS_URL = `${STUB}/api/orders`;
process.env.OVERCALL_MARKET = 'NVDA';
process.env.OVERCALL_MAX_ATTEMPTS = '2'; // enough to prove a retry, short enough to run quickly
delete process.env.OVERCALL_API_KEY;
delete process.env.CHAIN_ID;

const { OvercallApiError, OvercallNetworkError, MAX_RETRY_AFTER_MS, fetchListing, fetchListings, lastFilledUnitPrice6, publishListing, recordCancellation, retryWaitMs } =
  await import('./overcallApi.js');
const { vaultAbi } = await import('./abi.js');
const { describeError } = await import('./roll.js');
const { PLACEHOLDER_SIGNATURE, buildOrderComponents, componentsToJson } = await import('./seaport.js');

test.after(() => {
  server.close();
});

/*//////////////////////////////////////////////////////////////
                             FIXTURES
//////////////////////////////////////////////////////////////*/

const ORDER_HASH = '0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522';
const OPTION_A = '56885395977254369119998982131173877604217583767740146085872832926902011297792';
const OPTION_B = '873393324505681306211742772675693943830305973181304956549530887026947129344';

/** The shape GET /api/orders/:hash returned for the real filled order (recon R3). */
function realListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderHash: ORDER_HASH,
    chainId: 4663,
    offerer: '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be',
    optionId: OPTION_A,
    quantity: '1',
    remaining: '0',
    unitPrice6: '4000000',
    totalPrice6: '4000000',
    realisedPremium6: '3800000',
    startTime: '0',
    endTime: '1789761600',
    salt: '95941992777576660739888578361827826050802484697670100586800480598437555708740',
    counter: '0',
    status: 'filled',
    filledNumerator: '1',
    filledDenominator: '1',
    signature: `0x${'11'.repeat(64)}1b`,
    createdAt: '2026-09-12T13:40:00.000Z',
    checkedAt: '2026-09-12T13:49:12.000Z',
    ...overrides,
  };
}

const componentsJson = componentsToJson(
  buildOrderComponents({
    offerer: '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be',
    optionId: BigInt(OPTION_A),
    contracts: 1n,
    unitPrice6: 4_000_000n,
    endTime: 1789761600n,
    counter: 0n,
    salt: 95941992777576660739888578361827826050802484697670100586800480598437555708740n,
  }),
);

function lastRequest(): StubRequest {
  const last = requests[requests.length - 1];
  if (!last) throw new Error('no request recorded');
  return last;
}

/*//////////////////////////////////////////////////////////////
                               POST
//////////////////////////////////////////////////////////////*/

test('publishListing POSTs {chainId, components, signature} to ?market=NVDA and reads the listing back', async () => {
  handler = () => ({ status: 201, body: { listing: realListing({ status: 'open' }) } });
  const result = await publishListing(componentsJson, PLACEHOLDER_SIGNATURE);

  const sent = lastRequest();
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/api/orders');
  assert.equal(sent.query.get('market'), 'NVDA');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.equal(sent.headers.authorization, undefined, 'there is no auth on this API');
  assert.deepEqual(sent.body, { chainId: 4663, components: componentsJson, signature: PLACEHOLDER_SIGNATURE });

  assert.equal(result.httpStatus, 201);
  assert.equal(result.idempotent, false);
  assert.equal(result.listing?.orderHash, ORDER_HASH);
  assert.equal(result.listing?.status, 'open');
});

test('a 200 on a repost is idempotent success, not a duplicate error', async () => {
  handler = () => ({ status: 200, body: { listing: realListing({ status: 'open' }) } });
  const result = await publishListing(componentsJson, PLACEHOLDER_SIGNATURE);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.idempotent, true);
  assert.equal(result.listing?.orderHash, ORDER_HASH);
});

test('a 4xx that is not 429 is NOT retried and carries the server message verbatim', async () => {
  const before = requests.length;
  handler = () => ({ status: 422, body: { error: 'offerer does not hold the option tokens' } });
  await assert.rejects(publishListing(componentsJson, PLACEHOLDER_SIGNATURE), (error: unknown) => {
    assert.ok(error instanceof OvercallApiError);
    assert.equal(error.status, 422);
    assert.equal(error.retryable, false);
    assert.equal(error.serverMessage, 'offerer does not hold the option tokens');
    assert.match(error.message, /422: offerer does not hold/);
    return true;
  });
  assert.equal(requests.length - before, 1, 'exactly one attempt');
});

test('a 429 is retried, honouring Retry-After, and the second attempt is the answer', async () => {
  const before = requests.length;
  let calls = 0;
  handler = () => {
    calls += 1;
    return calls === 1
      ? { status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '1' } }
      : { status: 201, body: { listing: realListing({ status: 'open' }) } };
  };
  const started = Date.now();
  const result = await publishListing(componentsJson, PLACEHOLDER_SIGNATURE);
  assert.equal(result.httpStatus, 201);
  assert.equal(requests.length - before, 2);
  assert.ok(Date.now() - started >= 900, 'waited roughly the Retry-After second');
});

test('Retry-After is CAPPED: a day-long 429 hint waits a minute, not a day', () => {
  // `Retry-After: 86400` is legal and the keeper is single-threaded: honouring it would park
  // lockBook and rollClose for a day. The cap is the whole point.
  assert.equal(MAX_RETRY_AFTER_MS, 60_000);
  assert.equal(retryWaitMs(1, 86_400), 60_000);
  assert.equal(retryWaitMs(2, 30), 30_000, 'a sane Retry-After is honoured as-is');
  const backoff = retryWaitMs(1, 0);
  assert.ok(backoff >= 1_000 && backoff < 1_600, 'no Retry-After -> attempt-1 backoff plus jitter');
});

test('a 5xx on every attempt is a retryable OvercallApiError after OVERCALL_MAX_ATTEMPTS', async () => {
  const before = requests.length;
  handler = () => ({ status: 503, body: { error: 'upstream' } });
  await assert.rejects(publishListing(componentsJson, PLACEHOLDER_SIGNATURE), (error: unknown) => {
    assert.ok(error instanceof OvercallApiError);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(requests.length - before, 2);
});

test('a dropped connection is an OvercallNetworkError, retried, then surfaced', async () => {
  const before = requests.length;
  handler = () => ({ status: 0, destroy: true });
  await assert.rejects(publishListing(componentsJson, PLACEHOLDER_SIGNATURE), (error: unknown) => {
    assert.ok(error instanceof OvercallNetworkError);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(requests.length - before, 2);
});

/*//////////////////////////////////////////////////////////////
                               GET
//////////////////////////////////////////////////////////////*/

test('fetchListing parses a real-shaped listing and rejects a truncated one', async () => {
  handler = () => ({ status: 200, body: { listing: realListing() } });
  const listing = await fetchListing(ORDER_HASH);
  assert.equal(lastRequest().path, `/api/orders/${ORDER_HASH}`);
  assert.equal(listing?.orderHash, ORDER_HASH);
  assert.equal(listing?.status, 'filled');
  assert.equal(listing?.filledNumerator, '1');

  // Truncated: the one required field is missing. The schema refuses it and the caller sees
  // "not in the book", which is an answer it acts on, rather than a half-object.
  const { orderHash: _dropped, ...truncated } = realListing();
  handler = () => ({ status: 200, body: { listing: truncated } });
  assert.equal(await fetchListing(ORDER_HASH), null);

  // A 404 is "not in the book", not an exception.
  handler = () => ({ status: 404, body: { error: 'listing not found' } });
  assert.equal(await fetchListing(ORDER_HASH), null);

  // Any other failure is still an exception.
  handler = () => ({ status: 422, body: { error: 'bad hash' } });
  await assert.rejects(fetchListing(ORDER_HASH), OvercallApiError);
});

test('fetchListings forwards the query and parses the array; a malformed row empties it', async () => {
  handler = () => ({ status: 200, body: { listings: [realListing(), realListing({ orderHash: `0x${'22'.repeat(32)}` })] } });
  const listings = await fetchListings({ offerer: '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be', status: 'all', limit: 20 });
  const sent = lastRequest();
  assert.equal(sent.query.get('offerer'), '0xE73d7021A3ef2808C3Dd8237982FcC5FA11275be');
  assert.equal(sent.query.get('status'), 'all');
  assert.equal(sent.query.get('limit'), '20');
  assert.equal(listings.length, 2);

  // DOCUMENTED BEHAVIOUR, not an endorsement: one row without an orderHash fails the whole
  // array's schema and the client answers "no listings". A caller that reads [] as "our order
  // is not in the book" will mark it `missing`. If Overcall ever ships a partial row this is
  // the line that changes; the test exists so the change is a decision, not a surprise.
  const { orderHash: _dropped, ...truncated } = realListing();
  handler = () => ({ status: 200, body: { listings: [realListing(), truncated] } });
  assert.deepEqual(await fetchListings({ status: 'filled' }), []);

  handler = () => ({ status: 200, body: {} });
  assert.deepEqual(await fetchListings(), []);
  assert.equal(lastRequest().query.toString(), '', 'no query, no question mark');
});

test('lastFilledUnitPrice6 takes the NEWEST fill by createdAt on the wanted rungs only', async () => {
  handler = () => ({
    status: 200,
    body: {
      listings: [
        realListing({ orderHash: '0x01', optionId: OPTION_A, unitPrice6: '3000000', createdAt: '2026-09-10T00:00:00Z', checkedAt: '2026-09-12T00:00:00Z' }),
        // Newer by createdAt though re-synced (checkedAt) earlier: this is the one that counts.
        realListing({ orderHash: '0x02', optionId: OPTION_A, unitPrice6: '4000000', realisedPremium6: '1', createdAt: '2026-09-11T00:00:00Z', checkedAt: '2026-09-11T00:00:00Z' }),
        // Another rung, a bigger number, newest of all: ignored when only A is wanted.
        realListing({ orderHash: '0x03', optionId: OPTION_B, unitPrice6: '9000000', createdAt: '2026-09-12T00:00:00Z' }),
        realListing({ orderHash: '0x04', optionId: OPTION_A, unitPrice6: 'not-a-number', createdAt: '2026-09-13T00:00:00Z' }),
        realListing({ orderHash: '0x05', optionId: OPTION_A, unitPrice6: '0', createdAt: '2026-09-13T00:00:00Z' }),
      ],
    },
  });
  assert.equal(await lastFilledUnitPrice6([BigInt(OPTION_A)]), 4_000_000n);
  const sent = lastRequest();
  assert.equal(sent.query.get('status'), 'filled');
  assert.equal(sent.query.get('limit'), '50');
  assert.equal(await lastFilledUnitPrice6([BigInt(OPTION_A), BigInt(OPTION_B)]), 9_000_000n);
  assert.equal(await lastFilledUnitPrice6([1n]), null, 'a rung nobody has traded');
  assert.equal(await lastFilledUnitPrice6([]), null, 'nothing wanted, nothing asked');

  // The book being down is not a reason to refuse to write: null means "price from the floor".
  handler = () => ({ status: 503, body: { error: 'down' } });
  assert.equal(await lastFilledUnitPrice6([BigInt(OPTION_A)]), null);
});

/*//////////////////////////////////////////////////////////////
                              DELETE
//////////////////////////////////////////////////////////////*/

test('recordCancellation reports the outcome instead of throwing', async () => {
  handler = () => ({ status: 200, body: { ok: true } });
  assert.deepEqual(await recordCancellation(ORDER_HASH), { ok: true, status: 200, error: null });
  assert.equal(lastRequest().method, 'DELETE');
  assert.equal(lastRequest().path, `/api/orders/${ORDER_HASH}`);

  handler = () => ({ status: 409, body: { error: 'order is still fillable on chain' } });
  assert.deepEqual(await recordCancellation(ORDER_HASH), { ok: false, status: 409, error: 'order is still fillable on chain' });
});

/*//////////////////////////////////////////////////////////////
                      THE VAULT'S ERROR VOCABULARY
//////////////////////////////////////////////////////////////*/

/**
 * Every custom error in contracts/out/{Vault,SeaportOrderLib,ValoremLib}.json, as signatures,
 * generated 2026-09-13 from the write-on-fill redesign at ca0e985 (92 unique; Policy's are all
 * inside Vault.json). SeaportOrderLib and ValoremLib are linked libraries, so their reverts
 * surface through the vault's calls; a decoder that only knew Vault.json's 56 would print
 * `BadZone` or `WriteReturnedWrongClaim` as an opaque selector.
 */
const PINNED_ERROR_SIGNATURES = [
  'AccessControlBadConfirmation()',
  'AccessControlUnauthorizedAccount(address,bytes32)',
  'BadConduitKey(bytes32,bytes32)',
  'BadConsiderationIdentifier(uint256)',
  'BadConsiderationItemType(uint8)',
  'BadConsiderationLength(uint256)',
  'BadConsiderationToken(address,address)',
  'BadCounter(uint256,uint256)',
  'BadCycleWindow(uint40,uint40)',
  'BadOfferIdentifier(uint256,uint256)',
  'BadOfferItemType(uint8)',
  'BadOfferLength(uint256)',
  'BadOfferToken(address,address)',
  'BadOfferer(address)',
  'BadOrderType(uint8)',
  'BadVaultRecipient(address,address)',
  'BadZone(address,address)',
  'BadZoneHash(bytes32)',
  'ContractsAboveCap(uint256,uint256)',
  'ContractsAboveUtilization(uint256,uint256)',
  'ContractsCapZero()',
  'ContractsZero()',
  'DepositCapExceeded(uint256,uint256)',
  'DepositsClosed()',
  'DutchAuctionNotAllowed()',
  'ERC20InsufficientAllowance(address,uint256,uint256)',
  'ERC20InsufficientBalance(address,uint256,uint256)',
  'ERC20InvalidApprover(address)',
  'ERC20InvalidReceiver(address)',
  'ERC20InvalidSender(address)',
  'ERC20InvalidSpender(address)',
  'EpochNotSettled(uint256,uint256)',
  'ExerciseTooSoon(uint40,uint40)',
  'GuardianTooEarly(uint40)',
  'InsufficientFreeShares(uint256,uint256)',
  'InventoryLeftBehind(uint256,uint256)',
  'ListingAlreadyEnded(uint256)',
  'ListingOutlivesExercise(uint256,uint256)',
  'ListingStartsInFuture(uint256)',
  'MaxOtmAboveCeiling(uint16,uint16)',
  'MinOtmBelowFloor(uint16,uint16)',
  'MinPremiumBelowFloor(uint16,uint16)',
  'NoLiveListing()',
  'NoOpenClaim()',
  'NotAnOptionType(uint256)',
  'NotLiveListing(bytes32)',
  'NotSeaport()',
  'NotStranded()',
  'NotYetExercisable(uint40)',
  'NotYetExpired(uint40)',
  'NothingQueued()',
  'NothingToClaim()',
  'OfferAmountZero()',
  'OfferExceedsCapacity(uint256,uint256)',
  'OptionAssetMismatch(address,address)',
  'OptionExerciseAssetMismatch(address,address)',
  'OraclePaused()',
  'OrderHashMismatch(bytes32,bytes32)',
  'OtmBandInverted(uint16,uint16)',
  'PremiumBelowFloorAtFill(uint256,uint256)',
  'PremiumBelowMinimum(uint256,uint256)',
  'PremiumNotDivisibleByOrderSize(uint256,uint256)',
  'PreviousListingLive(bytes32)',
  'PriceAgeOutOfBounds(uint32,uint32,uint32)',
  'ProtocolFeeAboveCeiling(uint16,uint16)',
  'RedeemOutOfGas()',
  'ReentrancyGuardReentrantCall()',
  'ReserveBreached(uint256,uint256)',
  'SafeERC20FailedOperation(address)',
  'SeaportCancelFailed()',
  'SeaportValidateFailed()',
  'SpotZero()',
  'StalePrice(uint256,uint256)',
  'StillStranded()',
  'StrikeAboveBand(uint256,uint256)',
  'StrikeBelowBand(uint256,uint256)',
  'TooManyListings(uint8,uint8)',
  'UnexpectedLotSize(uint96,uint96)',
  'UnitPriceExceedsStrike(uint256,uint256)',
  'UsdgLegBlocked(uint256)',
  'UseQueue()',
  'UtilizationAboveCeiling(uint16,uint16)',
  'ValoremFeeNotAccepted(uint8)',
  'WriteReturnedNoClaim()',
  'WriteReturnedWrongClaim(uint256,uint256)',
  'WriteWindowClosed(uint40)',
  'WritesAreHalted()',
  'WrongPhase(uint8,uint8)',
  'ZeroAddr()',
  'ZeroAddress()',
  'ZeroAssets()',
  'ZeroShares()',
] as const;

const ARTIFACTS = ['Vault.sol/Vault.json', 'SeaportOrderLib.sol/SeaportOrderLib.json', 'ValoremLib.sol/ValoremLib.json'];

function signatureOf(item: AbiError): string {
  return `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
}

function abiErrorSignatures(abi: Abi): Set<string> {
  return new Set(abi.filter((item): item is AbiError => item.type === 'error').map(signatureOf));
}

/** A representative value per Solidity type, so every error can be encoded and decoded. */
function sampleArg(type: string): unknown {
  if (type === 'address') return '0x0000000000000000000000000000000000000001';
  if (type === 'bytes32') return `0x${'11'.repeat(32)}`;
  if (type.startsWith('uint')) return 7n;
  throw new Error(`no sample for ${type}`);
}

test('abi.ts names every error the vault and its linked libraries can throw', () => {
  const known = abiErrorSignatures(vaultAbi as Abi);
  const missing = PINNED_ERROR_SIGNATURES.filter((signature) => !known.has(signature));
  assert.deepEqual(missing, [], `add these fragments to vaultAbi in abi.ts: ${missing.join(', ')}`);

  // Selectors, not just names: a wrong argument width is a different selector and would
  // decode as nothing.
  const knownSelectors = new Set([...known].map((signature) => toFunctionSelector(signature)));
  for (const signature of PINNED_ERROR_SIGNATURES) {
    assert.ok(knownSelectors.has(toFunctionSelector(signature)), `selector for ${signature}`);
  }
});

test('the pinned list still matches contracts/out (when the artifacts are present)', () => {
  const outDir = fileURLToPath(new URL('../../contracts/out/', import.meta.url));
  if (!ARTIFACTS.every((file) => existsSync(join(outDir, file)))) {
    // CI's js job has no forge build; the pinned list is the contract there. When you do have
    // artifacts (`cd contracts && forge build`), this is the test that says "a new error was
    // added on the Solidity side and abi.ts has not heard about it".
    return;
  }
  const fromArtifacts = new Set<string>();
  for (const file of ARTIFACTS) {
    const artifact = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as { abi: Abi };
    for (const signature of abiErrorSignatures(artifact.abi)) fromArtifacts.add(signature);
  }
  assert.deepEqual([...fromArtifacts].sort(), [...PINNED_ERROR_SIGNATURES].sort());
});

test('every pinned error encodes and decodes through vaultAbi with its name intact', () => {
  const errors = (vaultAbi as Abi).filter((item): item is AbiError => item.type === 'error');
  for (const signature of PINNED_ERROR_SIGNATURES) {
    const item = errors.find((candidate) => signatureOf(candidate) === signature);
    assert.ok(item, signature);
    const args = item.inputs.map((input) => sampleArg(input.type));
    const data = encodeErrorResult({ abi: [item], errorName: item.name, args });
    const decoded = decodeErrorResult({ abi: vaultAbi, data });
    assert.equal(decoded.errorName, item.name, signature);
    assert.equal(data.slice(0, 10), toFunctionSelector(signature));
  }
});

test('describeError names the decoded custom error and its arguments', () => {
  const data: Hex = encodeErrorResult({ abi: vaultAbi, errorName: 'StrikeBelowBand', args: [226_000_000n, 231_750_000n] });
  const revert = new ContractFunctionRevertedError({ abi: vaultAbi, data, functionName: 'rollOpen' });
  const described = describeError(revert);
  assert.match(described, /StrikeBelowBand\(226000000, 231750000\)/);
  assert.match(described, /rollOpen/);

  // A selector abi.ts does not know is reported as such, never swallowed.
  const unknown = new ContractFunctionRevertedError({ abi: vaultAbi, data: '0xdeadbeef', functionName: 'rollOpen' });
  assert.match(describeError(unknown), /0xdeadbeef/);

  // Non-viem errors pass through.
  assert.equal(describeError(new Error('plain')), 'plain');
  assert.equal(describeError('string'), 'string');
});
