/**
 * Wallet authentication against a real (PGlite) nonce table.
 *
 * WHAT IS PINNED:
 *   - an EOA signature verifies locally, without touching the chain client;
 *   - a contract wallet (ERC-1271) is judged by `publicClient.verifyMessage` (mocked here), and an
 *     unreachable RPC is a 503, not a 401;
 *   - nonces are single-use, bound to their address, and expire after 10 minutes;
 *   - a wrong signature burns the nonce too;
 *   - with RH_RPC_2 set, the production transport (app.ts verifierTransport) asks RH_RPC first and the
 *     backup only when RH_RPC fails, and with both down the answer is still 503, not 401. These run a
 *     real viem client against local fake JSON-RPC servers: no network.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, getAddress, type Address, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import {
  authenticate,
  challengeMessage,
  createChallenge,
  createSignatureVerifier,
  NONCE_TTL_MS,
  type VerifyArgs,
} from './auth.js';
import { verifierTransport } from './app.js';
import { createTestDb, TestClock, type TestDb } from './testing.js';

const APP_URL = 'https://app.stonkhouse.test';
// Well-known anvil key #0: test only.
const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const bob = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SAFE: Address = getAddress('0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe');
const SAFE_SIGNATURE: Hex = `0x${'12'.repeat(200)}`;

let db: TestDb;
const clock = new TestClock();
const chainCalls: VerifyArgs[] = [];
let chainDown = false;

const verify = createSignatureVerifier({
  async verifyMessage(args) {
    chainCalls.push(args);
    if (chainDown) throw new Error('fetch failed');
    return args.address === SAFE && args.signature === SAFE_SIGNATURE;
  },
});

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
  chainCalls.length = 0;
  chainDown = false;
  clock.ms = Date.parse('2026-09-16T21:00:00Z');
});

const auth = (input: { address?: unknown; signature?: unknown; nonce?: unknown }) =>
  authenticate({ db, verify, now: clock.now() }, input);

test('the challenge message names the app, the address, the nonce and both times', async () => {
  const challenge = await createChallenge(db, { appUrl: `${APP_URL}/some/path`, address: alice.address, now: clock.now() });
  assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
  assert.equal(challenge.expiresAt, Math.floor((clock.ms + NONCE_TTL_MS) / 1000));
  assert.equal(
    challenge.message,
    challengeMessage({
      appUrl: APP_URL,
      address: alice.address,
      nonce: challenge.nonce,
      issuedAt: clock.now(),
      expiresAt: new Date(clock.ms + NONCE_TTL_MS),
    }),
  );
  const parsed = parseSiweMessage(challenge.message);
  assert.equal(parsed.domain, 'app.stonkhouse.test');
  assert.equal(parsed.address, alice.address);
  assert.equal(parsed.uri, APP_URL);
  assert.equal(parsed.version, '1');
  assert.equal(parsed.chainId, 4663);
  assert.equal(validateSiweMessage({ message: parsed, domain: 'app.stonkhouse.test', address: alice.address, time: clock.now() }), true);
});

test('EOA: a personal_sign signature verifies without calling the chain', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message });
  // Lower-case address in the request: normalised before the nonce lookup.
  const result = await auth({ address: alice.address.toLowerCase(), signature, nonce });
  assert.deepEqual(result, { ok: true, address: alice.address });
  assert.equal(chainCalls.length, 0);
});

test('nonce replay: the same nonce and signature pass once, then 401', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message });
  assert.equal((await auth({ address: alice.address, signature, nonce })).ok, true);
  const replay = await auth({ address: alice.address, signature, nonce });
  assert.deepEqual(replay.ok ? null : [replay.status, replay.code], [401, 'nonce-invalid']);
});

test('two concurrent requests with one nonce: exactly one wins', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message });
  const results = await Promise.all([1, 2, 3].map(() => auth({ address: alice.address, signature, nonce })));
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test('a nonce expires after 10 minutes', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message });
  clock.advance(NONCE_TTL_MS);
  const result = await auth({ address: alice.address, signature, nonce });
  assert.deepEqual(result.ok ? null : [result.status, result.code], [401, 'nonce-invalid']);
});

test('a nonce issued for one address does not authenticate another', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await bob.signMessage({ message });
  const result = await auth({ address: bob.address, signature, nonce });
  assert.deepEqual(result.ok ? null : [result.status, result.code], [401, 'nonce-invalid']);
});

test('a signature by another key is refused, and the nonce is spent', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const forged = await bob.signMessage({ message });
  const result = await auth({ address: alice.address, signature: forged, nonce });
  assert.deepEqual(result.ok ? null : [result.status, result.code], [401, 'signature-invalid']);
  // An ordinary mismatched ECDSA signature never reaches the chain verifier.
  assert.equal(chainCalls.length, 0);
  const retry = await auth({ address: alice.address, signature: await alice.signMessage({ message }), nonce });
  assert.deepEqual(retry.ok ? null : retry.code, 'nonce-invalid');
});

test('mismatched ECDSA signatures check code once, then skip chain verification for EOAs', async () => {
  const message = 'verify this challenge';
  const signature = await bob.signMessage({ message });
  let codeReads = 0;
  let contractChecks = 0;
  const verifier = createSignatureVerifier({
    async getCode({ address }) {
      codeReads += 1;
      return address === SAFE ? '0x6000' : '0x';
    },
    async verifyMessage({ address }) {
      contractChecks += 1;
      return address === SAFE;
    },
  });
  for (let i = 0; i < 3; i += 1) assert.equal(await verifier({ address: alice.address, message, signature }), false);
  assert.equal(codeReads, 1);
  assert.equal(contractChecks, 0);
  assert.equal(await verifier({ address: SAFE, message, signature }), true, '65-byte ERC-1271 signatures still work');
  assert.equal(contractChecks, 1);
});

test('malformed ERC-6492 wrappers and repeated contract checks do not flood the RPC', async () => {
  let calls = 0;
  const verifier = createSignatureVerifier({ async verifyMessage() { calls += 1; return false; } });
  const malformed = `0x${'ab'.repeat(4000)}${'6492'.repeat(16)}` as Hex;
  assert.equal(await verifier({ address: SAFE, message: 'challenge', signature: malformed }), false);
  assert.equal(calls, 0);
  for (let i = 0; i < 15; i += 1) {
    assert.equal(await verifier({ address: SAFE, message: 'challenge', signature: SAFE_SIGNATURE }), false);
  }
  assert.equal(calls, 10);
});

test('a signature over a different message (another site, another nonce) is refused', async () => {
  const { nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message: 'Sign in to some other site' });
  const result = await auth({ address: alice.address, signature, nonce });
  assert.equal(result.ok ? null : result.code, 'signature-invalid');
});

test('ERC-1271 contract wallet: judged by publicClient.verifyMessage', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: SAFE, now: clock.now() });
  const result = await auth({ address: SAFE, signature: SAFE_SIGNATURE, nonce });
  assert.deepEqual(result, { ok: true, address: SAFE });
  assert.equal(chainCalls.length, 1);
  assert.deepEqual(chainCalls[0], { address: SAFE, message, signature: SAFE_SIGNATURE });

  const second = await createChallenge(db, { appUrl: APP_URL, address: SAFE, now: clock.now() });
  const refused = await auth({ address: SAFE, signature: `0x${'34'.repeat(200)}`, nonce: second.nonce });
  assert.equal(refused.ok ? null : refused.code, 'signature-invalid');
});

test('ERC-1271 with the RPC down: 503 verifier-unavailable, not a wrong signature', async () => {
  chainDown = true;
  const { nonce } = await createChallenge(db, { appUrl: APP_URL, address: SAFE, now: clock.now() });
  const result = await auth({ address: SAFE, signature: SAFE_SIGNATURE, nonce });
  assert.deepEqual(result.ok ? null : [result.status, result.code], [503, 'verifier-unavailable']);
});

test('malformed input is a 400 and spends no nonce', async () => {
  const { message, nonce } = await createChallenge(db, { appUrl: APP_URL, address: alice.address, now: clock.now() });
  const signature = await alice.signMessage({ message });
  for (const input of [
    { address: 'nope', signature, nonce },
    { address: alice.address, signature: 'not-hex', nonce },
    { address: alice.address, signature, nonce: 'short' },
    { address: alice.address, signature: `0x${'ab'.repeat(9000)}`, nonce },
    {},
  ]) {
    const result = await auth(input);
    assert.equal(result.ok ? null : result.status, 400, JSON.stringify(input).slice(0, 80));
  }
  assert.equal((await auth({ address: alice.address, signature, nonce })).ok, true);
});

/**
 * A local JSON-RPC endpoint that answers every contract-wallet check with "valid": code at every
 * address, and 32-byte `true` for every eth_call (the ERC-6492 validator's return). It records the
 * methods it was asked, which is how a test sees which endpoint answered.
 */
async function fakeRpc(): Promise<{ url: string; methods: string[]; close: () => Promise<void> }> {
  const methods: string[] = [];
  const results: Record<string, unknown> = {
    eth_chainId: '0x1237',
    eth_blockNumber: '0x1',
    eth_getCode: '0x6080',
    eth_call: `0x${'00'.repeat(31)}01`,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const answer = (r: { id: unknown; method: string }) => {
        methods.push(r.method);
        return { jsonrpc: '2.0', id: r.id, result: results[r.method] ?? null };
      };
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A URL nothing listens on: bind a port, then release it, so a connection is refused at once. */
async function deadRpc(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Authenticate the Safe through the production transport over `rpcUrl` / `rpcBackupUrl`. */
async function safeSignIn(rpcUrl: string, rpcBackupUrl: string | null) {
  const productionVerify = createSignatureVerifier(
    createPublicClient({ transport: verifierTransport({ rpcUrl, rpcBackupUrl }) }),
  );
  const { nonce } = await createChallenge(db, { appUrl: APP_URL, address: SAFE, now: clock.now() });
  return authenticate({ db, verify: productionVerify, now: clock.now() }, { address: SAFE, signature: SAFE_SIGNATURE, nonce });
}

test('RH_RPC down, RH_RPC_2 up: the backup answers the ERC-1271 check', async () => {
  const backup = await fakeRpc();
  try {
    const result = await safeSignIn(await deadRpc(), backup.url);
    assert.deepEqual(result, { ok: true, address: SAFE });
    assert.ok(backup.methods.includes('eth_call'), `backup was asked: ${backup.methods.join(',')}`);
  } finally {
    await backup.close();
  }
});

test('RH_RPC up: RH_RPC_2 is never asked (the backup is a fallback, not a peer)', async () => {
  const primary = await fakeRpc();
  const backup = await fakeRpc();
  try {
    const result = await safeSignIn(primary.url, backup.url);
    assert.deepEqual(result, { ok: true, address: SAFE });
    assert.ok(primary.methods.includes('eth_call'), `primary answered: ${primary.methods.join(',')}`);
    assert.deepEqual(backup.methods, []);
  } finally {
    await primary.close();
    await backup.close();
  }
});

test('RH_RPC and RH_RPC_2 both down: 503 verifier-unavailable, not a wrong signature', async () => {
  const result = await safeSignIn(await deadRpc(), await deadRpc());
  assert.deepEqual(result.ok ? null : [result.status, result.code], [503, 'verifier-unavailable']);
});

test('RH_RPC down and no RH_RPC_2: 503, as before the backup existed', async () => {
  const result = await safeSignIn(await deadRpc(), null);
  assert.deepEqual(result.ok ? null : [result.status, result.code], [503, 'verifier-unavailable']);
});
