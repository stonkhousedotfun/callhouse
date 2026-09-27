/**
 * OrderBook.quoteTake, asked the way the contract requires.
 *
 * MIRROR, DO NOT RE-REASON. callhouse-contracts src/v2/OrderBook.sol: quoteTake is no longer a view. It
 * runs take's own code (the pre-fund stage and every planning round with its deliveries) and rolls it back, so it is
 * `nonpayable` in the ABI and is asked with an eth_call (viem simulateContract). The answer is msg.sender's (its fee
 * discount, its own orders skipped, its collateral or inventory when selling), and a call with no `from` reverts
 * NotAuthorized: `_quoteLeg` reads a zero recorded taker as no quote in progress. So every quote names its taker.
 */
import { zeroAddress, type Address, type ContractFunctionArgs, type PublicClient } from 'viem';
import { orderBookAbi } from './abi/orderBook.js';

/** The TakeParams a quote is asked for, as the generated ABI types them. */
export type QuoteTakeParams = ContractFunctionArgs<typeof orderBookAbi, 'nonpayable', 'quoteTake'>[0];

/** (unitsFilled, premium, takerFee, sellerFees), as IOrderBook.quoteTake returns them. */
export type QuoteTakeResult = readonly [bigint, bigint, bigint, bigint];

/** What {quoteTakeAs} needs from a client: one simulation. A viem PublicClient is one. */
export type QuoteSimulator = Pick<PublicClient, 'simulateContract'>;

/**
 * Quote `params` for `taker` against `orderBook`: a simulation from the taker's account, never a view read.
 * Refuses a missing or zero taker before any RPC, because the chain would revert NotAuthorized (or, on a deployment
 * before that check, quietly price the zero address's fill instead of the taker's).
 */
export async function quoteTakeAs(
  client: QuoteSimulator, orderBook: Address, taker: Address, params: QuoteTakeParams,
): Promise<QuoteTakeResult> {
  if (!taker || taker.toLowerCase() === zeroAddress) {
    throw new Error('quoteTake needs the taker account: since T-OP-835 a quote with no `from` reverts NotAuthorized');
  }
  const { result } = await client.simulateContract({
    address: orderBook, abi: orderBookAbi, functionName: 'quoteTake', args: [params], account: taker,
  });
  return result;
}
