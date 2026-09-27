/**
 * The guardian mode's boot (main.ts): it runs under the guardian key only. The AccessManager must say the
 * signer may call `veto` on the configured oracle immediately. A key without GUARDIAN, or one whose calls must be
 * scheduled, stops the boot before the health server, the loop or any send.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAbiItem, toFunctionSelector, type Address, type Hex } from 'viem';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { loadV2Config, type GuardianConfig } from '../config.js';
import type { RunningMode } from '../mode.js';
import { GuardianRoleError, VETO_SELECTOR, resolveGuardianRole, startGuardian, type CanCall } from './main.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const KEY = `0x${'11'.repeat(32)}`;
const SIGNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as Address; // the address of KEY
const ORACLE = '0x0e4F266b73e95dc6d4cA10674DCd5eF353e2BDCD' as Address;

test('VETO_SELECTOR is the oracle ABI\'s veto(address,uint40): 0x1fb3a5be', () => {
  const fromAbi = toFunctionSelector(getAbiItem({ abi: settlementOracleAbi, name: 'veto' }) as never);
  assert.equal(VETO_SELECTOR, fromAbi);
  assert.equal(VETO_SELECTOR, '0x1fb3a5be');
});

const SAFE = '0x6f8A7B77b72511cD8939596b1659bA28C28f101B' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

test('resolveGuardianRole: an immediate GUARDIAN is the key; no role, or a scheduled one, is refused by name', async () => {
  const asked: Array<[Address, Address, Hex]> = [];
  const answer = (immediate: boolean, delay: number): CanCall => async (caller, target, selector) => {
    asked.push([caller, target, selector]);
    return [immediate, delay] as const;
  };
  assert.deepEqual(await resolveGuardianRole(answer(true, 0), SIGNER, ORACLE, 'GUARDIAN_PK', {}), { vetoBy: 'key' });
  assert.deepEqual(asked[0], [SIGNER, ORACLE, VETO_SELECTOR]);
  await assert.rejects(resolveGuardianRole(answer(false, 0), SIGNER, ORACLE, 'GUARDIAN_PK', {}), (e: unknown) => e instanceof GuardianRoleError && /is not a GUARDIAN/.test(e.message) && /GUARDIAN_PK/.test(e.message));
  await assert.rejects(resolveGuardianRole(answer(false, 86_400), SIGNER, ORACLE, 'GUARDIAN_PK', {}), (e: unknown) => e instanceof GuardianRoleError && /86400 s schedule/.test(e.message));
});

/** canCall answering per caller: `can` is the set that may veto at once. */
const byCaller = (can: Address[], asked: Address[] = []): CanCall => async (caller) => {
  asked.push(caller);
  return [can.some((a) => a.toLowerCase() === caller.toLowerCase()), 0] as const;
};

test('after the lock the registry guardian key without GUARDIAN runs watch-only when the Admin Safe can veto', async () => {
  const asked: Address[] = [];
  const role = await resolveGuardianRole(byCaller([SAFE], asked), SIGNER, ORACLE, 'GUARDIAN_PK', { adminSafe: SAFE, guardianBot: SIGNER });
  assert.deepEqual(role, { vetoBy: 'admin-safe', adminSafe: SAFE });
  assert.deepEqual(asked, [SIGNER, SAFE], 'the Admin Safe is read from the chain, not assumed');
});

test('any other key without GUARDIAN is still refused, each condition by name', async () => {
  const cases: Array<[CanCall, { adminSafe?: Address | null; guardianBot?: Address | null }, RegExp]> = [
    [byCaller([SAFE]), { adminSafe: SAFE, guardianBot: OTHER }, /not the registry's guardian key v2.bots.guardian \(0x1111/],
    [byCaller([SAFE]), { adminSafe: SAFE }, /v2.bots.guardian \(not named\)/],
    [byCaller([SAFE]), { guardianBot: SIGNER }, /names no Admin Safe \(shared.safes.admin\)/],
    [byCaller([]), { adminSafe: SAFE, guardianBot: SIGNER }, /the Admin Safe 0x6f8A7B77\w+ cannot call veto at once either/],
  ];
  for (const [canCall, registry, why] of cases) {
    await assert.rejects(resolveGuardianRole(canCall, SIGNER, ORACLE, 'GUARDIAN_PK', registry), (e: unknown) => e instanceof GuardianRoleError && /is not a GUARDIAN/.test(e.message) && why.test(e.message));
  }
});

function guardianConfig(): GuardianConfig {
  const config = loadV2Config({
    V2_MODE: 'guardian',
    GUARDIAN_PK: KEY,
    GUARDIAN_PORT: '0',
    RH_RPC: 'http://127.0.0.1:9',
    V2_REGISTRY_PATH: REGISTRY,
    KEEPER_DB_PATH: ':memory:',
    KEEPER_LOG_LEVEL: 'silent',
    KEEPER_BOOT_RETRY_MS: '0',
  });
  assert.equal(config.mode, 'guardian');
  return config as GuardianConfig;
}

test('startGuardian refuses to start under a key that is not the guardian, before anything runs', async () => {
  let ticked = false;
  // A boot that wrongly succeeds is closed at once, so the regression fails this test instead of hanging the file
  // on a live health server and loop (measured: removing the check hung the run for 190 s).
  const closeIfStarted = async (running: RunningMode): Promise<RunningMode> => (await running.close(), running);
  await assert.rejects(
    startGuardian(guardianConfig(), {
      canCall: async () => [false, 0] as const,
      guardianChain: {
        head: async () => ((ticked = true), { blockNumber: 1n, timestamp: 1 }),
        logHead: async () => 1n,
        getLogs: async () => [],
        readExpiry: async () => {
          throw new Error('not reached');
        },
        readLatest: async () => null,
        readRoundAge: async () => null,
      },
      checkWiring: async () => [],
      probe: async () => ({ headBlock: 1n, headTimestamp: 1, rpcLagSeconds: 0, balanceWei: 10n ** 18n }),
    }).then(closeIfStarted),
    GuardianRoleError,
  );
  assert.equal(ticked, false);
});

test('after the lock startGuardian boots watch-only, says the Admin Safe pauses, ticks and sends nothing', async () => {
  let heads = 0;
  const config = guardianConfig();
  config.registry = { ...config.registry, adminSafe: SAFE, guardianBot: SIGNER };
  const running = await startGuardian(config, {
    canCall: byCaller([SAFE]),
    guardianChain: {
      head: async () => (heads++, { blockNumber: 10n, timestamp: 1_790_200_000 }),
      logHead: async () => 10n,
      getLogs: async () => [],
      readExpiry: async () => {
        throw new Error('no open expiry');
      },
      readLatest: async () => null,
      readRoundAge: async () => null,
    },
    checkWiring: async () => [],
    probe: async () => ({ headBlock: 10n, headTimestamp: 1_790_200_000, rpcLagSeconds: 0, balanceWei: 10n ** 18n }),
  });
  assert.equal(running.mode, 'guardian');
  for (let i = 0; i < 50 && heads === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(heads > 0, 'the loop ran a tick');
  await running.close();
});

test('startGuardian with the guardian key boots, ticks and closes', async () => {
  let heads = 0;
  const running = await startGuardian(guardianConfig(), {
    canCall: async () => [true, 0] as const,
    guardianChain: {
      head: async () => (heads++, { blockNumber: 10n, timestamp: 1_790_200_000 }),
      logHead: async () => 10n,
      getLogs: async () => [],
      readExpiry: async () => {
        throw new Error('no open expiry');
      },
      readLatest: async () => null,
      readRoundAge: async () => null,
    },
    checkWiring: async () => [],
    probe: async () => ({ headBlock: 10n, headTimestamp: 1_790_200_000, rpcLagSeconds: 0, balanceWei: 10n ** 18n }),
  });
  assert.equal(running.mode, 'guardian');
  assert.ok(running.port !== null && running.port > 0);
  for (let i = 0; i < 50 && heads === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(heads > 0, 'the loop ran a tick');
  await running.close();
});
