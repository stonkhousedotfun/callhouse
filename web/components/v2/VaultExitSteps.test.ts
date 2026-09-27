import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CLAIM_ZERO, EARN_QUEUE_PRICING } from "@/lib/v2/vaultCopy";
import { earnExitSteps, houseExitSteps, VaultExitSteps } from "./VaultExitSteps";

const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("VaultExitSteps", () => {
  it("House: three steps, the cancel rule and the claim-zero note; the daily variant names no weekday", () => {
    const weekly = houseExitSteps("weekly", 1_800);
    const html = renderToStaticMarkup(createElement(VaultExitSteps, weekly));
    // "Boundary" -> "Close"; the weekly close is the week's LAST session close (Thursday when Friday is a
    // holiday: HouseVault.weekly -> ExpiryCalendar.nextExpiry), so it is no longer named "Fri".
    expect(weekly.steps.map((s) => s.title)).toEqual(["Request", "Close", "Claim"]);
    expect(html).toContain("the week&#x27;s last 4:00 pm ET close");
    expect(html).not.toMatch(/fri/i);
    expect(html).toContain(esc(CLAIM_ZERO));
    expect(JSON.stringify(houseExitSteps("daily", 1_800))).not.toMatch(/fri|week/i);
  });
  it("House requests and cancels stop at the chain's queue cutoff, never 'any time'", () => {
    // 1_800 is a fixture for the SETTLEMENT_WINDOW() read (HouseVault._requireBeforeCutoff).
    const read = houseExitSteps("weekly", 1_800);
    expect(read.steps[0]).toEqual({ title: "Request", body: "Until 30 minutes before the close. Your shares wait in the vault." });
    expect(read.notes[0]).toBe("You can cancel until 30 minutes before the close. Requests reopen when the vault starts its next epoch.");
    expect(houseExitSteps("daily", 600).steps[0].body).toBe("Until 10 minutes before the close. Your shares wait in the vault.");
    const unread = houseExitSteps("weekly", null);
    // Unread: the copy says "before the close" without a number rather than type the window.
    expect(unread.steps[0].body).toBe("Before the close. Your shares wait in the vault.");
    expect(unread.notes[0]).toBe("You can cancel before the close. Requests reopen when the vault starts its next epoch.");
    for (const s of [read, unread]) {
      expect(JSON.stringify(s)).not.toMatch(/any time\. your shares|until the close is processed/i);
    }
  });
  it("Earn: flat and open variants, and the queue-pricing sentence", () => {
    const html = renderToStaticMarkup(createElement(VaultExitSteps, earnExitSteps()));
    // plain words ("options", not "series").
    expect(html).toContain("Options open");
    expect(html).not.toMatch(/series/i);
    expect(html).toContain(esc(EARN_QUEUE_PRICING));
  });
});
