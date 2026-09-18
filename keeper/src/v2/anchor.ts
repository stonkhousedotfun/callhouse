/**
 * Which deployment a signing mode's SQLite file describes beyond its contract addresses: the DEPLOYMENT ANCHOR.
 *
 * WHY ADDRESSES ARE NOT ENOUGH. ops/devnet/up.sh deploys from a pinned deployer nonce, so every fresh devnet has the
 * same contract addresses, and so does the same deploy script replayed on any fork. A file kept across such a
 * redeploy (a devnet KEEPER_DB_PATH that survived up.sh, a volume reused after a rehearsal) holds cursors, adopted
 * orders and "already done" marks of a chain that no longer exists: the MM bot skips the new vault's orders below a
 * stale makerIndex and never scans the series under a stale cursor; the cranker takes a new expiry's snapshot as
 * already sent; the pricer waits out an evaluation clock from another chain's time.
 *
 * THE ANCHOR is registry v2.deployBlock and that block's hash on the connected chain, read once per process before
 * the mode reads its store. In production the block is final, its hash never changes, and the file keeps its state
 * across restarts. A fresh devnet or a redeploy has another deploy block, or the same number with another hash, so
 * the mode resets what it stores for the deployment and says so in a warning. A file that holds state but no anchor
 * (written before anchors existed) cannot be vouched for and is reset the same way. A registry without a deploy block
 * gives no anchor: the store stays bound on its addresses alone and the mode warns that it cannot tell a redeploy.
 *
 * A deploy block the chain does not have (its head is below it) throws: the mode points at another chain or a node far
 * behind, and the store is neither read nor reset until the block is there.
 */
import type { PublicClient } from 'viem';

export type AnchorClient = Pick<PublicClient, 'getBlock'>;

/** `<deployBlock>:<hash>` of the registry's deploy block on this chain; null when the registry has no deploy block. */
export async function readDeploymentAnchor(client: AnchorClient, deployBlock: bigint | null): Promise<string | null> {
  if (deployBlock === null) return null;
  const block = await client.getBlock({ blockNumber: deployBlock });
  if (block?.hash == null) throw new Error(`the chain has no block ${deployBlock} (registry v2.deployBlock): is RH_RPC the deployment's chain?`);
  return `${deployBlock}:${block.hash.toLowerCase()}`;
}

/**
 * How a store's recorded anchor compares with the chain's:
 *   fresh       nothing recorded and nothing stored: record the anchor
 *   same        recorded and equal: keep everything
 *   changed     recorded and different: another deployment at the same addresses, reset
 *   unverified  nothing recorded but the store holds state (written before anchors): reset
 *   unanchored  the registry has no deploy block: nothing to compare, keep everything
 */
export type AnchorCheck = 'fresh' | 'same' | 'changed' | 'unverified' | 'unanchored';

export function compareAnchor(recorded: string | null, current: string | null, hasState: boolean): AnchorCheck {
  if (current === null) return 'unanchored';
  if (recorded === null) return hasState ? 'unverified' : 'fresh';
  return recorded === current ? 'same' : 'changed';
}

export const anchorResets = (check: AnchorCheck): boolean => check === 'changed' || check === 'unverified';

/** The warning a mode logs for a check, or null when there is nothing to say. */
export function anchorWarning(check: AnchorCheck, what: string): string | null {
  switch (check) {
    case 'changed':
      return `${what} described another deployment at the same addresses (registry v2.deployBlock or its block hash differs): it was reset`;
    case 'unverified':
      return `${what} held state without a deployment anchor, so it could not be matched to this deployment: it was reset`;
    case 'unanchored':
      return `registry v2.deployBlock is unset: ${what} is bound on contract addresses alone and cannot tell a redeploy at the same addresses`;
    default:
      return null;
  }
}
