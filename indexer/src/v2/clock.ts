import schema from "ponder:schema";
import { eq, inArray } from "ponder";

import { V2_EARN_START_BLOCK, V2_EARN_VAULT } from "../../lib/env";
import { clockTick } from "../../lib/v2/clock";
import { seriesStatusOnVerdict, settlementId } from "../../lib/v2/oracle";
import { v2Ponder as ponder } from "../../lib/registry";
import { markPnlInput } from "./pnlInput";
import { sampleEarnVault } from "./earnSample";
import { scoreMakerBlock } from "./makerScoring";

/** A 600-block tick is roughly one minute on chain 4663. The API still checks timestamps
 * when reading, so an order is never displayed as fillable while waiting for the next tick. */
ponder.on("V2Clock:block", async ({ event, context }) => {
  const now = event.block.timestamp;

  // ONE read of the open/cutoff series and ONE of the open orders serve both the status maintenance and maker
  // scoring, which used to select them again. Every raw select costs a SQL parse, a cache flush and a transaction (about
  // 5 ms on PGlite), and this tick runs every 600 blocks of a replay. clockTick (lib/v2/clock.ts) acts on exactly the
  // rows the old deadline-filtered selects returned.
  const series = await context.db.sql.select().from(schema.v2Series)
    .where(inArray(schema.v2Series.status, ["open", "cutoff"]));
  const orders = await context.db.sql.select({
    order: schema.v2Order,
    mintCutoff: schema.v2Series.mintCutoff,
    expiry: schema.v2Series.expiry,
  }).from(schema.v2Order).leftJoin(schema.v2Series, eq(schema.v2Order.longId, schema.v2Series.longId))
    .where(eq(schema.v2Order.status, "open"));
  const tick = clockTick({ now, series, orders });

  const byLongId = new Map(series.map((row) => [row.longId, row]));
  for (const { longId, status } of tick.seriesStatus) {
    // A verdict recorded before expiry (a pre-emptive veto or its unveto) left the series trading; it takes
    // effect here, the first tick at or past expiry. One primary-key read, only for a series expiring on this tick.
    let next = status;
    const row = byLongId.get(longId);
    if (status === "expired" && row !== undefined) {
      const verdict = await context.db.find(schema.v2Settlement, { id: settlementId(row.underlying, row.expiry) });
      next = seriesStatusOnVerdict(status, verdict?.status ?? null, row.expiry, now);
    }
    await markPnlInput(context.db, event.block.number);
    await context.db.update(schema.v2Series, { longId }).set({ status: next });
  }
  for (const orderId of tick.expiredOrders) {
    await context.db.update(schema.v2Order, { orderId }).set({ status: "expired", updatedAt: now });
  }

  await scoreMakerBlock({ event, context, open: { series: tick.liveSeries, orders: tick.openOrders } });

  // The hourly Earn price sample behind the public APY. A primary-key lookup on 59 ticks of 60.
  await sampleEarnVault({ vault: V2_EARN_VAULT, startBlock: V2_EARN_START_BLOCK, event, context });
});
