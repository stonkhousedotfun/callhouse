/**
 * The OrderBook's trading brake on the app's own trade buttons.
 *
 * MIRROR, DO NOT RE-REASON. callhouse-contracts src/v2/OrderBook.sol: `_whenTrading` reverts `TradingPaused` while
 * `tradingPaused` is set, and it runs in `place`, `placeFor`, `replace` and `take` (through `_checkTake`, which
 * `quoteTake` also runs). `cancel` and `prune` do not read it, and nothing on the Clearinghouse does (`deposit`,
 * `withdraw`, `close`, `redeem`), so cancels, closes, collects and balance moves are never gated here.
 *
 * Without this, a paused book still showed live Buy, Bid, Sell, List, Edit and Place-ask buttons (the indexed book keeps
 * its orders, and `/v2/markets` `status` does not reflect the brake). The click then spent gas on the steps in front of
 * the refused write (an approval, the operator grant, createSeries, or the cancel of a resale ask being re-listed)
 * before the write itself reverted `TradingPaused`.
 *
 * Two halves, as the House gates have (houseGates.ts): the page shuts the buttons from the brake `/v2/markets` serves
 * and every click re-reads `tradingPaused()` on chain before its first write. An unread market list is not
 * a pause for the buttons: the click still asks the chain.
 */
import type { PublicClient } from "viem";

import { orderBookAbi } from "../abi/v2/orderBook";
import { publicClient } from "../chain";
import type { Market } from "./api-types";
import { requireV2Address } from "./config";

/**
 * The line under a shut trade button, the market page's notice, and the click's refusal. It says what is
 * paused and what still works (a pause comes with information, not only shut buttons). The brake is
 * ONE switch on the OrderBook, so it covers every market. What still works is exactly what the brake does not gate
 * (see the header): `cancel`; `close` of a matched pair until the series settles; `redeem` once it has. A decoded
 * revert keeps the shorter `V2_ERROR_TEXT.TradingPaused`, because HouseVault's quoting brake and a paused FeeSplitter
 * revert `TradingPaused` too, and this line is only true of the OrderBook's.
 */
export const TRADING_PAUSED_LINE =
  "Trading is paused on every market right now. You can still cancel your open orders, close matched positions and collect payouts.";

/** False only when the served market reads the trading brake on. Unknown (no row, list unread) is not a pause. */
export function tradingOpen(market: Pick<Market, "tradingPaused"> | null | undefined): boolean {
  return market?.tradingPaused !== true;
}

/** Throws the brake's line when `OrderBook.tradingPaused()` is set. For a click, before its first write. */
export async function assertTradingOpen(client: PublicClient = publicClient, blockNumber?: bigint): Promise<void> {
  const paused = await client.readContract({ address: requireV2Address("orderBook"), abi: orderBookAbi,
    functionName: "tradingPaused", ...(blockNumber === undefined ? {} : { blockNumber }) });
  if (paused) throw new Error(TRADING_PAUSED_LINE);
}
