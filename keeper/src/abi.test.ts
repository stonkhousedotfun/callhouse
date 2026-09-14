/**
 * The vault's error vocabulary, pinned against the compiled contracts.
 *
 * WHY THIS FILE EXISTS: every custom error the vault and its two linked libraries can throw must
 * be decodable by the keeper, because an alert that says "reverted" and nothing else is what an
 * operator reads at 20:00 UTC on a Friday. The list is pinned as literals and, when contracts/out
 * is present, re-derived from the artifacts too — so a new error on the Solidity side fails here
 * before it ever prints as a bare selector in production.
 *
 * DELIBERATELY ABSENT: no RPC, no HTTP. abi.ts has no imports; the environment below exists only
 * because roll.ts (for describeError) pulls config.ts in.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

/* ---- environment: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-abi-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.CHAIN_ID;

const { clearAbi, vaultAbi } = await import('./abi.js');
const { describeError, revertName } = await import('./roll.js');

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

test('abi.ts names every error the vault and its linked libraries can throw (92)', () => {
  assert.equal(PINNED_ERROR_SIGNATURES.length, 92);
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

test('the functions and events the keeper calls exist in Vault.json with the same inputs (when present)', () => {
  const path = fileURLToPath(new URL('../../contracts/out/Vault.sol/Vault.json', import.meta.url));
  if (!existsSync(path)) return;
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi };
  const artifactSigs = new Set(
    artifact.abi
      .filter((item) => item.type === 'function' || item.type === 'event')
      .map((item) => `${item.type}:${item.name}(${item.inputs.map((i) => (i.type === 'tuple' ? 'tuple' : i.type)).join(',')})`),
  );
  for (const item of vaultAbi) {
    if (item.type !== 'function' && item.type !== 'event') continue;
    const sig = `${item.type}:${item.name}(${item.inputs.map((i) => (i.type === 'tuple' ? 'tuple' : i.type)).join(',')})`;
    assert.ok(artifactSigs.has(sig), `${sig} is not in Vault.json: the hand ABI has drifted`);
  }
  // The removed surface must not creep back.
  for (const gone of ['registry', 'overcallFeeRecipient', 'contractsSold', 'contractsRemaining', 'isValidSignature', 'writeMore']) {
    assert.ok(!vaultAbi.some((item) => item.type === 'function' && item.name === gone), `${gone} was removed by the redesign`);
  }
  // rollOpen takes ONE argument: the arm writes nothing.
  const rollOpen = vaultAbi.find((item) => item.type === 'function' && item.name === 'rollOpen');
  assert.ok(rollOpen && rollOpen.type === 'function' && rollOpen.inputs.length === 1);
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

test('describeError names the decoded custom error and its arguments; revertName gives the name alone', () => {
  const data: Hex = encodeErrorResult({ abi: vaultAbi, errorName: 'StrikeBelowBand', args: [226_000_000n, 231_750_000n] });
  const revert = new ContractFunctionRevertedError({ abi: vaultAbi, data, functionName: 'rollOpen' });
  const described = describeError(revert);
  assert.match(described, /StrikeBelowBand\(226000000, 231750000\)/);
  assert.match(described, /rollOpen/);
  assert.equal(revertName(revert), 'StrikeBelowBand');

  // The stranded machine's own answer, which the keeper branches on rather than pages about.
  const still = encodeErrorResult({ abi: vaultAbi, errorName: 'StillStranded', args: [] });
  assert.equal(revertName(new ContractFunctionRevertedError({ abi: vaultAbi, data: still, functionName: 'retryStrandedClaim' })), 'StillStranded');

  // A selector abi.ts does not know is reported as such, never swallowed.
  const unknown = new ContractFunctionRevertedError({ abi: vaultAbi, data: '0xdeadbeef', functionName: 'rollOpen' });
  assert.match(describeError(unknown), /0xdeadbeef/);
  assert.equal(revertName(unknown), null);

  // Non-viem errors pass through.
  assert.equal(describeError(new Error('plain')), 'plain');
  assert.equal(describeError('string'), 'string');
  assert.equal(revertName(new Error('plain')), null);
});

test('clearAbi carries the option-type factory and its two answers', () => {
  const names = new Set<string>(clearAbi.map((item) => item.name));
  for (const name of ['newOptionType', 'tokenType', 'NewOptionType', 'OptionsTypeExists', 'FeeSwitchUpdated', 'TokenNotFound']) {
    assert.ok(names.has(name), `clearAbi lacks ${name}`);
  }
  const exists = encodeErrorResult({ abi: clearAbi, errorName: 'OptionsTypeExists', args: [7n] });
  assert.equal(decodeErrorResult({ abi: clearAbi, data: exists }).errorName, 'OptionsTypeExists');
});
