/**
 * The words for the indexer's `earliestWithdrawal` (api-schema.ts `earliestWithdrawalSchema`):
 * one short line, a tooltip that says WHY, and the FAQ answer that explains it (callhouse-site app/faq).
 *
 * The indexer decides the branch from the contracts' own rules (indexer/src/v2/earnYield.ts); this file only words
 * it. So nothing here re-derives a rule, and every branch the indexer cannot vouch for -- `not-read`, or a field an
 * older indexer does not send -- says "unavailable" and never "now". A guessed "now" is the one wrong answer a
 * depositor would act on.
 */
import { fmtUsdg } from "@/lib/format";
import { SITE_URL } from "@/lib/site";
import type { EarliestWithdrawal } from "@/lib/v2/api-types";
import { NEW_YORK_TIME_ZONE } from "@/lib/v2/time";

export type EarliestWithdrawalCopy = {
  /** The short line, e.g. "Now (up to 6,000.00 USDG available)". */
  line: string;
  /** The reason, in a sentence, for the tooltip. */
  tooltip: string;
  /** The FAQ answer that explains this surface's timing. */
  faqHref: string;
};

/** callhouse-site app/faq/page.tsx section ids. */
export const FAQ_ANCHORS = {
  earliest: "earliest-withdrawal",
  house: "house-vault",
  earn: "earn-vault",
  close: "the-close",
} as const;

export function faqHref(anchor: keyof typeof FAQ_ANCHORS): string {
  return `${SITE_URL}/faq#${FAQ_ANCHORS[anchor]}`;
}

const NY_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const NY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const NY_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

/** "4pm", "1:30pm": the close as people say it. */
function clock(unixSeconds: number): string {
  return spoken(NY_TIME.format(unixSeconds * 1_000));
}

function spoken(time: string): string {
  return time.replace(":00", "").replace(/\s/g, "").toLowerCase();
}

/**
 * "1pm PDT": the same instant on the reader's clock, zone named. "Sat 5am GMT+9" when the reader's day is
 * not New York's, so the ET date in the phrase is not read as theirs.
 */
function readerClock(unixSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" })
    .formatToParts(unixSeconds * 1_000);
  const zone = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const time = parts.filter((p) => p.type !== "timeZoneName").map((p) => p.value).join("").trim();
  const readerDay = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(unixSeconds * 1_000);
  const weekday = readerDay === NY_DAY.format(unixSeconds * 1_000) ? ""
    : `${new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(unixSeconds * 1_000)} `;
  return `${weekday}${spoken(time)} ${zone}`;
}

/**
 * "today's 4pm ET close", "tomorrow's 4pm ET close", or "the 4pm ET close on Fri, Sep 25". The time is read from the
 * boundary itself, so an early close (1pm) says 1pm; nothing here assumes 4pm. Days are New York calendar days.
 * With the reader's `timeZone` their clock follows: "today's 4pm ET close (1pm PDT)"; a reader in New
 * York, or no zone (a server render), gets the ET phrase alone.
 */
export function closePhrase(at: number, now: number, timeZone?: string): string {
  const day = NY_DAY.format(at * 1_000);
  const local = timeZone === undefined ? null : readerClock(at, timeZone);
  const time = `${clock(at)} ET close`;
  const reader = local === null || local === readerClock(at, NEW_YORK_TIME_ZONE) ? "" : ` (${local})`;
  if (day === NY_DAY.format(now * 1_000)) return `today's ${time}${reader}`;
  if (day === NY_DAY.format((now + 86_400) * 1_000)) return `tomorrow's ${time}${reader}`;
  return `the ${time} on ${NY_DATE.format(at * 1_000)}${reader}`;
}

const UNAVAILABLE_TIP =
  "The indexer could not read what this depends on, so no time is shown rather than a guessed one.";

/**
 * @param ew the wire value; `undefined` when the indexer predates and does not send it.
 * @param surface which vault this is, for the FAQ link and the not-sent wording.
 * @param now unix seconds, for "today's" / "tomorrow's".
 * @param timeZone the reader's zone; omitted, the close is named in ET only.
 */
export function earliestWithdrawalCopy(
  ew: EarliestWithdrawal | undefined,
  surface: "earn" | "house",
  now: number,
  timeZone?: string,
): EarliestWithdrawalCopy {
  const faq = faqHref(surface);
  if (ew === undefined) {
    return { line: "Unavailable", tooltip: "This indexer does not report the earliest withdrawal yet.", faqHref: faq };
  }
  switch (ew.reason) {
    case "liquid": {
      const cap = ew.liquidityCap == null ? null : BigInt(ew.liquidityCap);
      return {
        line: cap === null ? "Now" : `Now (up to ${fmtUsdg(cap, 2)} USDG available)`,
        tooltip: "The vault holds no option position and has no queue, so a redemption is paid at once from the "
          + "vault's cash and what it can pull back from its lending venue. A redemption worth more than is available "
          + "is not paid in part: the whole of it is queued and paid in order as cash comes back.",
        faqHref: faq,
      };
    }
    case "open-position":
      return {
        line: ew.at === null
          ? "Queued: until the vault's open option settles"
          : `Queued: until the open option settles, after ${closePhrase(ew.at, now, timeZone)}`,
        tooltip: "While the vault holds an option position, every redemption is queued and priced only once the "
          + "position has settled. The time shown is the latest expiry the vault still holds; settlement follows it.",
        faqHref: faq,
      };
    case "queue-ahead":
      return {
        line: "Queued: behind earlier requests",
        tooltip: "Earlier requests are waiting in the vault's queue. A new redemption joins the back and is paid in "
          + "order; it is never refused, and anyone can process the queue.",
        faqHref: faq,
      };
    case "venue-unreadable":
      return {
        line: "Queued: the lending venue can't be read right now",
        tooltip: "The vault can't read what it holds at its lending venue, so it can't price shares. Until it can, "
          + "every deposit and withdrawal waits in line and is priced when it's served. If the venue doesn't recover, "
          + "the vault's admin can disconnect it, and the value last read there is written off.",
        faqHref: faq,
      };
    case "venue-liquidity":
      return {
        line: "Queued: waiting for venue liquidity",
        tooltip: "Neither the vault nor its lending venue can pay anything right now. The redemption is queued, not "
          + "refused, and paid in order as cash comes back from the venue.",
        faqHref: faq,
      };
    case "epoch-boundary":
      return {
        line: ew.at === null ? "At the vault's next boundary" : `After ${closePhrase(ew.at, now, timeZone)}`,
        tooltip: `${ew.kind === "daily" ? "This daily vault's epoch ends at every session close" : ew.kind === "weekly"
          ? "This weekly vault's epoch ends at the week's last session close"
          : "This vault's epoch ends at its boundary"}. A withdrawal requested before then is priced when the epoch `
          + "rolls, after the options it traded have settled, and is then claimed in kind.",
        faqHref: faq,
      };
    case "boundary-pending":
      return {
        line: ew.at === null ? "At the pending roll" : `At the pending roll (${closePhrase(ew.at, now, timeZone)} has passed)`,
        tooltip: "The epoch has ended, but it rolls only once every option the vault traded has settled and the "
          + "closing price is final. A request made now is priced at that roll.",
        faqHref: faq,
      };
    case "queue-closed":
      return {
        line: ew.at === null
          ? "Closed until the vault rolls"
          : `Closed until the vault rolls; then priced after ${closePhrase(ew.at, now, timeZone)}`,
        tooltip: "Withdrawal requests are closed until the vault rolls. They reopen after the roll, and a request "
          + "made then is priced at the next epoch's end.",
        faqHref: faq,
      };
    case "not-read":
      return { line: "Unavailable", tooltip: UNAVAILABLE_TIP, faqHref: faq };
  }
}
