import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS } from "@/lib/v2/houseCopy";
import {
  WithdrawalTerms, newYorkWithdrawalTime, settlementWithdrawalTimes, withdrawalCountdown,
  type WithdrawalTiming,
} from "./WithdrawalTerms";

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
    expect(html).toContain("Locked in shorts");
    expect(html).toContain(newYorkWithdrawalTime(expiry + timing.finalizeDelay));
    expect(html).toContain("earliest routine settlement time");
    expect(html).toContain(newYorkWithdrawalTime(expiry + timing.resolveDelay));
  });

  it("refuses to invent a lending queue ETA", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, { surface: "lending", now }));
    expect(html).toContain("queued request");
    expect(html).toContain("submitting a request is not an instant withdrawal");
    expect(html).toContain("No fixed time — it depends on available liquidity");
    expect(html).not.toContain("Withdraw from");
  });

  it("reuses the approved house copy and degrades when the nullable boundary is absent", () => {
    const available = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "house", boundaryAt: expiry, now }));
    expect(available).toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
    expect(available).toContain(newYorkWithdrawalTime(expiry));
    expect(available).toContain("1h 0m");
    const unavailable = renderToStaticMarkup(createElement(WithdrawalTerms,
      { surface: "house", boundaryAt: null, now }));
    expect(unavailable).toContain("Boundary timing is unavailable");
  });

  it("uses a live candidate time and describes every settlement constant by its real role", () => {
    const candidateFinalizableAt = expiry + 21_600;
    const html = renderToStaticMarkup(createElement(WithdrawalTerms, {
      surface: "redemption", expiry, status: "settling", timing, candidateFinalizableAt, now,
    }));
    const times = settlementWithdrawalTimes(expiry, timing);
    expect(html).toContain(newYorkWithdrawalTime(candidateFinalizableAt));
    expect(html).toContain("live settlement candidate time");
    expect(html).toContain(newYorkWithdrawalTime(times.windowStartsAt));
    expect(html).toContain(newYorkWithdrawalTime(times.snapshotClosesAt));
    expect(html).toContain(newYorkWithdrawalTime(times.adminEligibleAt));
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
