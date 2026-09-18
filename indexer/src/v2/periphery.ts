import schema from "ponder:schema";

import { v2CalendarPonder, v2RewardsPonder } from "../../lib/registry";
import { clearCalendarCache } from "../../lib/v2/calendarCache";
import { bountyAmount, rewardTotal } from "../../lib/v2/periphery";

/** Both contracts are optional. Their individual registry aliases are inert when unset. */
v2CalendarPonder.on("ExpiryCalendar:HolidaySet", async ({ event, context }) => {
  clearCalendarCache();
  const { dayIndex, isHoliday } = event.args;
  const values = {
    isHoliday, changedAt: event.block.timestamp,
    changedBlock: event.block.number, changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2CalendarHoliday).values({ dayIndex, ...values }).onConflictDoUpdate(values);
});

v2CalendarPonder.on("ExpiryCalendar:SpecialExpirySet", async ({ event, context }) => {
  clearCalendarCache();
  const { ts, allowed } = event.args;
  const values = {
    allowed, changedAt: event.block.timestamp,
    changedBlock: event.block.number, changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2SpecialExpiry).values({ ts: BigInt(ts), ...values }).onConflictDoUpdate(values);
});

v2RewardsPonder.on("KeeperRewards:BountySet", async ({ event, context }) => {
  const { action, amount } = event.args;
  const values = {
    amount: bountyAmount(amount), changedAt: event.block.timestamp,
    changedBlock: event.block.number, changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2KeeperBounty).values({ action, ...values }).onConflictDoUpdate(values);
});

v2RewardsPonder.on("KeeperRewards:Rewarded", async ({ event, context }) => {
  const { keeper, action, amount } = event.args;
  const id = `${keeper.toLowerCase()}-${action.toLowerCase()}`;
  const current = await context.db.find(schema.v2KeeperRewardTotal, { id });
  const next = rewardTotal(current, amount);
  await context.db.insert(schema.v2KeeperReward).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    keeper, action, amount,
    ts: event.block.timestamp, block: event.block.number,
    logIndex: event.log.logIndex, tx: event.transaction.hash,
  });
  if (current === null) {
    await context.db.insert(schema.v2KeeperRewardTotal).values({ id, keeper, action, ...next });
  } else {
    await context.db.update(schema.v2KeeperRewardTotal, { id }).set(next);
  }
});
