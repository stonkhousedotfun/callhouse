import schema from "ponder:schema";

import { CALENDAR_MODE_ID as ID } from "../../lib/v2/calendar";

/**
 * ExpiryCalendar's fail-closed switch, re-derived from events (see v2CalendarMode).
 * Helpers only; the registrations stay in adminConfig.ts (AuthorityUpdated) and periphery.ts
 * (HolidaySet), which own those event names.
 */

type EventLike = {
  log: { address: `0x${string}` };
  transaction: { hash: `0x${string}` };
};
type Context = { db: any };

/** On the calendar's FIRST AuthorityUpdated (its constructor's): remember the creation transaction. */
export async function recordCalendarConstruction(context: Context, event: EventLike): Promise<void> {
  await context.db.insert(schema.v2CalendarMode).values({
    id: ID, contract: event.log.address, constructionTx: event.transaction.hash, unseededYearsClosed: false,
  }).onConflictDoNothing();
}

/** A closure set in the creation transaction means the constructor was given one: the switch is on. */
export async function recordCalendarHoliday(context: Context, event: EventLike, isHoliday: boolean): Promise<void> {
  if (!isHoliday) return;
  const mode = await context.db.find(schema.v2CalendarMode, { id: ID });
  if (mode === null || mode.unseededYearsClosed || mode.constructionTx !== event.transaction.hash) return;
  await context.db.update(schema.v2CalendarMode, { id: ID }).set({ unseededYearsClosed: true });
}
