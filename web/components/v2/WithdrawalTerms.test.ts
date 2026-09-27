import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HOUSE_DISCLOSURE_DAILY_WITHDRAWALS, HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS } from "@/lib/v2/houseCopy";
import { formatNewYork } from "@/lib/v2/houseEpoch";
import { EARN_QUEUE_PRICING } from "@/lib/v2/vaultCopy";
import {
  WithdrawalTerms, settlementWithdrawalTimes, withdrawalCountdown,
  type WithdrawalTiming,
} from "./WithdrawalTerms";
import { timeText } from "@/components/ui/Time";

/** What <Time market> renders on the server (and during hydration): New York, zone named. */
const serverTime = (at: number) => timeText({ at, market: true }, null);

/**
 * React escapes text when it renders, so an approved copy string containing an apostrophe never appears
 * verbatim in the markup: `'` arrives as `&#x27;`. Asserting on the raw constant therefore fails against a
 * component that is displaying exactly the right words. The constant stays the source of truth and this
 * escapes it the way the renderer does, rather than retyping the sentence in its escaped form.
 */
const asRendered = (copy: string) =>
  copy.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");


const now = 1_760_000_000;
const expiry = now + 3_600;
const timing: WithdrawalTiming = {
  settlementWindow: 1_800, finalizeDelay: 120, snapshotGrace: 600, resolveDelay: 172_800,
};

describe("WithdrawalTerms", () => {
  it("shows writer free and locked balances with the latest honest settlement checkpoint", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, {
      surface: "writer", asset: "USDG", free: "12.5", locked: "20", latestExpiry: expiry, timing, now,
    }));
    expect(html).toContain("Free now");
    expect(html).toContain("12.5");
    expect(html).toContain("USDG");
    // plain words, same statement. 
    expect(html).toContain("Locked in sold options");
    expect(html).toContain(serverTime(expiry + timing.finalizeDelay));
    expect(html).toContain("earliest routine settlement time");
    expect(html).toContain(serverTime(expiry + timing.resolveDelay));
  });

  it("refuses to invent a lending queue ETA", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "lending", now }));
    expect(html).toContain("queued request");
    // plain words, same statement. 
    expect(html).toContain("It isn&#x27;t an instant withdrawal");
    expect(html).not.toContain("processQueue()");
    expect(html).toContain("No fixed time — it depends on available liquidity");
    expect(html).not.toContain("Withdraw from");
  });

  it("reuses the approved house copy and degrades when the nullable boundary is absent", () => {
    const available = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "house", boundaryAt: expiry, now, cadence: "weekly" }));
    expect(available).toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
    expect(available).toContain(serverTime(expiry));
    expect(available).toContain("1h 0m");
    const unavailable = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "house", boundaryAt: null, now, cadence: "daily" }));
    // plain words, same statement. 
    expect(unavailable).toContain("Close timing is unavailable");
  });

  it("states the deposit and withdrawal cutoffs separately, and follows the vault's cadence", () => {
    // The chain's SETTLEMENT_WINDOW() read (a fixture here); requests stop that long before the close.
    const weekly = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "house", boundaryAt: expiry, now, cadence: "weekly", settlementWindow: 1_800 }));
    // The cutoff sentences (lib/v2/houseEpoch.ts cutoffSentences), exact: the vault's own close
    // time, never "Fri 4:00 pm ET".
    expect(weekly).toContain(asRendered(
      `Deposit before ${formatNewYork(expiry - 1_800)} to be priced at this week's close (${formatNewYork(expiry)}).`));
    expect(weekly).toContain(asRendered(
      `Withdrawal requests are taken until ${formatNewYork(expiry - 1_800)}, 30 minutes before the close, and are priced at that close.`));
    expect(weekly).not.toMatch(/Fri 4:00 pm ET|boundary/);
    // An unread window states no cutoff rather than the close: the sentences wait for the read.
    const unread = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "house", boundaryAt: expiry, now, cadence: "weekly" }));
    expect(unread).not.toContain("Withdrawal requests are taken until");
    expect(unread).not.toContain("Deposit before");
    const daily = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "house", boundaryAt: expiry, now, cadence: "daily" }));
    expect(daily).toContain(asRendered(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS));
    expect(daily).not.toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
    expect(daily).not.toMatch(/Fri |once a week/);
  });

  it("the house surface has no weekly default; the cadence is a required prop", () => {
    // Before an omitted cadence rendered the weekly disclosure. The prop is now required, so omitting it is
    // a type error (tsc --noEmit checks this file); if `cadence?` comes back, this directive goes unused and tsc fails.
    // @ts-expect-error cadence is required on the house surface
    const props: Parameters<typeof WithdrawalTerms>[0] = { surface: "house", boundaryAt: expiry, now };
    expect(props.surface).toBe("house");
    const daily = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "house", boundaryAt: expiry, now, cadence: "daily" }));
    expect(daily).toContain(asRendered(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS));
    expect(daily).not.toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
  });

  it("the lending surface says a queued exit is priced when served", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "lending", now }));
    expect(html).toContain(asRendered(EARN_QUEUE_PRICING));
  });

  it("uses a live candidate time and describes every settlement constant by its real role", () => {
    const candidateFinalizableAt = expiry + 21_600;
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, {
      surface: "redemption", expiry, status: "settling", timing, candidateFinalizableAt, now,
    }));
    const times = settlementWithdrawalTimes(expiry, timing);
    expect(html).toContain(serverTime(candidateFinalizableAt));
    expect(html).toContain("live settlement candidate time");
    expect(html).toContain(serverTime(times.windowStartsAt));
    expect(html).toContain(serverTime(times.snapshotClosesAt));
    expect(html).toContain(serverTime(times.adminEligibleAt));
  });

  it("labels held-series admin eligibility without promising withdrawal", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "redemption", expiry, status: "held", timing, now }));
    expect(html).toContain("Admin resolution eligible");
    expect(html).toContain("not a promised withdrawal time");
  });

  it("formats deterministic countdowns without negative time", () => {
    expect(withdrawalCountdown(now + 90_060, now)).toBe("1d 1h 1m");
    expect(withdrawalCountdown(now - 1, now)).toBe("available now");
  });
});
