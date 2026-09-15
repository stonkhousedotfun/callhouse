/**
 * Isolated 1-lot factory: list requested writes, settle expired accounts.
 * No-op unless config.FACTORY is set. Does not replace the pooled-vault roll.
 */
import { type Address, type Hex } from 'viem';

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

export async function tickSolo(): Promise<void> {
  const factory = config.FACTORY;
  if (!factory) return;

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
