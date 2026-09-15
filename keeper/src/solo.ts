/**
 * Isolated 1-lot factory: list requested writes, settle expired accounts.
 * No-op unless config.FACTORY is set. Does not replace the pooled-vault roll.
 */
import { type Address, type Hex } from 'viem';

import { vaultAbi } from './abi.js';
import { nextWeekWindow } from './calendar.js';
import { account, publicClient, walletClient } from './clients.js';
import { config } from './config.js';
import { log } from './logger.js';

const factoryAbi = [
  {
    type: 'function',
    name: 'accountCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'accounts',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'listFor',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'week',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint32' },
      { type: 'uint256' },
      { type: 'uint40' },
      { type: 'uint40' },
      { type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'setWeek',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256' },
      { type: 'uint40' },
      { type: 'uint40' },
      { type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const accountAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'requestedLots',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'listedLots',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;

async function send(label: string, request: { address: Address; abi: typeof factoryAbi | typeof accountAbi; functionName: string; args?: readonly unknown[] }): Promise<Hex | null> {
  try {
    const hash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: request.address,
      abi: request.abi,
      functionName: request.functionName as never,
      args: request.args as never,
    });
    log.roll.info({ label, hash }, 'solo tx sent');
    return hash;
  } catch (error) {
    log.roll.warn({ label, err: error instanceof Error ? error.message : String(error) }, 'solo tx failed');
    return null;
  }
}

async function ensureWeek(factory: Address): Promise<void> {
  const week = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'week',
  });
  const now = Number((await publicClient.getBlock()).timestamp);
  const baseExpiry = Number(week[3]);
  if (week[0] !== 0 && now < baseExpiry) return;

  const window = nextWeekWindow(now, config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
  const spot = await publicClient.readContract({
    address: config.VAULT,
    abi: vaultAbi,
    functionName: 'spotUsdg',
  });
  const strike = ((spot * (10_000n + BigInt(config.KEEPER_STRIKE_OTM_BPS))) / 10_000n / 1_000_000n) * 1_000_000n;
  const minPrem = (spot * 40n) / 10_000n;
  const ask = minPrem < 1_000_000n ? 1_000_000n : minPrem;
  if (ask > strike || strike === 0n) {
    log.roll.warn({ spot: spot.toString(), strike: strike.toString(), ask: ask.toString() }, 'solo setWeek skipped: bad quote');
    return;
  }
  await send('setWeek', {
    address: factory,
    abi: factoryAbi,
    functionName: 'setWeek',
    args: [strike, window.exerciseTs, window.expiryTs, ask],
  });
}

export async function tickSolo(): Promise<void> {
  const factory = config.FACTORY;
  if (!factory) return;

  await ensureWeek(factory);

  const count = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'accountCount',
  });

  for (let i = 0n; i < count; i++) {
    const writer = await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'accounts',
      args: [i],
    });
    const [owner, requested, listed] = await Promise.all([
      publicClient.readContract({ address: writer, abi: accountAbi, functionName: 'owner' }),
      publicClient.readContract({ address: writer, abi: accountAbi, functionName: 'requestedLots' }),
      publicClient.readContract({ address: writer, abi: accountAbi, functionName: 'listedLots' }),
    ]);

    if (requested > 0n && listed === 0n) {
      await send('listFor', { address: factory, abi: factoryAbi, functionName: 'listFor', args: [owner] });
    }

    try {
      await publicClient.simulateContract({
        address: writer,
        abi: accountAbi,
        functionName: 'settle',
        account,
      });
      await send('settle', { address: writer, abi: accountAbi, functionName: 'settle' });
    } catch {
      // TooEarly until expiry, or nothing to settle.
    }
  }
}
