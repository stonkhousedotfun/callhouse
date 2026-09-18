import schema from "ponder:schema";
import { and, eq, inArray, lte, or } from "ponder";

import { orderExpiresAt, seriesStatusAt } from "../../lib/v2/clock";
import { v2Ponder as ponder } from "../../lib/registry";
import { scoreMakerBlock } from "./makerScoring";

/** A 600-block tick is roughly one minute on chain 4663. The API still checks timestamps
 * when reading, so an order is never displayed as fillable while waiting for the next tick. */
ponder.on("V2Clock:block", async ({ event, context }) => {
  const now = event.block.timestamp;

  const series = await context.db.sql.select({
    longId: schema.v2Series.longId,
    status: schema.v2Series.status,
    mintCutoff: schema.v2Series.mintCutoff,
    expiry: schema.v2Series.expiry,
  }).from(schema.v2Series).where(and(
    inArray(schema.v2Series.status, ["open", "cutoff"]),
    or(lte(schema.v2Series.mintCutoff, now), lte(schema.v2Series.expiry, now)),
  ));

  for (const row of series) {
    const status = seriesStatusAt(row.status, row.mintCutoff, row.expiry, now);
    if (status !== row.status) {
      await context.db.update(schema.v2Series, { longId: row.longId }).set({ status });
    }
  }

  const orders = await context.db.sql.select({
    orderId: schema.v2Order.orderId,
    kind: schema.v2Order.kind,
    validUntil: schema.v2Order.validUntil,
    mintCutoff: schema.v2Series.mintCutoff,
    expiry: schema.v2Series.expiry,
  }).from(schema.v2Order).innerJoin(schema.v2Series, eq(schema.v2Order.longId, schema.v2Series.longId))
    .where(and(
      eq(schema.v2Order.status, "open"),
      or(
        lte(schema.v2Order.validUntil, now),
        lte(schema.v2Series.expiry, now),
        and(eq(schema.v2Order.kind, "AskWrite"), lte(schema.v2Series.mintCutoff, now)),
      ),
    ));

  for (const row of orders) {
    if (orderExpiresAt(row.kind, row.validUntil, row.mintCutoff, row.expiry, now)) {
      await context.db.update(schema.v2Order, { orderId: row.orderId }).set({ status: "expired", updatedAt: now });
    }
  }

  await scoreMakerBlock({ event, context });
});
