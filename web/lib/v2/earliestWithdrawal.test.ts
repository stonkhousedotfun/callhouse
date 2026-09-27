import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SITE_URL } from "@/lib/site";
import {
  earliestWithdrawalSchema,
  earnApySchema,
  earnResponseSchema,
  houseListResponseSchema,
  houseMarketResponseSchema,
} from "@/lib/v2/api-schema";
import type { EarliestWithdrawal } from "@/lib/v2/api-types";
import { closePhrase, earliestWithdrawalCopy, faqHref } from "./earliestWithdrawal";

const NOW = 1_790_186_400; // Wed 2026-09-23 14:00 ET
const TODAY_CLOSE = 1_790_193_600; // Wed 16:00 ET
const TOMORROW_CLOSE = 1_790_280_000; // Thu 16:00 ET
const FRIDAY_CLOSE = 1_790_366_400; // Fri 16:00 ET

describe("closePhrase: New York days, the boundary's own time", () => {
  it("says today's / tomorrow's / the dated close", () => {
    expect(closePhrase(TODAY_CLOSE, NOW)).toBe("today's 4pm ET close");
    expect(closePhrase(TOMORROW_CLOSE, NOW)).toBe("tomorrow's 4pm ET close");
    expect(closePhrase(FRIDAY_CLOSE, NOW)).toBe("the 4pm ET close on Fri, Sep 25");
  });

  it("uses the New York calendar day, not UTC: 23:30 ET Wednesday is still Wednesday", () => {
    const lateWednesday = 1_790_220_600; // 2026-09-24T03:30Z = Wed 23:30 ET
    expect(closePhrase(TOMORROW_CLOSE, lateWednesday)).toBe("tomorrow's 4pm ET close");
  });

  it("reads an early close from the boundary rather than assuming 4pm", () => {
    const earlyClose = 1_795_802_400; // Fri 2026-11-27 13:00 ET (day after Thanksgiving)
    const morning = 1_795_791_600; // same day 10:00 ET
    expect(closePhrase(earlyClose, morning)).toBe("today's 1pm ET close");
  });
});

describe("earliestWithdrawalCopy: one line per indexer branch", () => {
  const earn = (value: EarliestWithdrawal) => earliestWithdrawalCopy(value, "earn", NOW);
  const house = (value: EarliestWithdrawal) => earliestWithdrawalCopy(value, "house", NOW);

  it("now: states the amount available, from the indexer's cap", () => {
    const copy = earn({ kind: "now", at: NOW, reason: "liquid", liquidityCap: "6000000000" });
    expect(copy.line).toBe("Now (up to 6,000 USDG available)"); // No zero tail
    expect(copy.tooltip).toMatch(/queued and paid in order/);
    // redeem queues the WHOLE amount it cannot cover; nothing is paid in part.
    expect(copy.tooltip).toMatch(/not paid in part: the whole of it is queued/);
    expect(copy.faqHref).toBe(`${SITE_URL}/faq#earn-vault`);
  });

  it("queued, open position: names when the option settles", () => {
    expect(earn({ kind: "queued", at: TODAY_CLOSE, reason: "open-position", liquidityCap: null }).line)
      .toBe("Queued: until the open option settles, after today's 4pm ET close");
    expect(earn({ kind: "queued", at: null, reason: "open-position", liquidityCap: null }).line)
      .toBe("Queued: until the vault's open option settles");
  });

  it("queued behind the queue, and queued for venue liquidity", () => {
    expect(earn({ kind: "queued", at: null, reason: "queue-ahead", liquidityCap: null }).line).toBe("Queued: behind earlier requests");
    expect(earn({ kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" }).line)
      .toBe("Queued: waiting for venue liquidity");
  });

  it("queued because the lending venue cannot be read", () => {
    // An unreadable venue queues everything, with its own reason.
    const unreadable = earn({ kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null });
    expect(unreadable.line).toBe("Queued: the lending venue can't be read right now");
    expect(unreadable.tooltip).toMatch(/every deposit and withdrawal waits in line/);
  });

  it("House daily and weekly: after the boundary close, with the cadence in the reason", () => {
    const daily = house({ kind: "daily", at: TODAY_CLOSE, reason: "epoch-boundary" });
    expect(daily.line).toBe("After today's 4pm ET close");
    expect(daily.tooltip).toMatch(/daily vault's epoch ends at every session close/);
    expect(daily.faqHref).toBe(`${SITE_URL}/faq#house-vault`);
    const weekly = house({ kind: "weekly", at: FRIDAY_CLOSE, reason: "epoch-boundary" });
    expect(weekly.line).toBe("After the 4pm ET close on Fri, Sep 25");
    expect(weekly.tooltip).toMatch(/week's last session close/);
  });

  it("House queue closed: requests reopen after the roll and are priced at the next end", () => {
    const closed = house({ kind: "daily", at: null, reason: "queue-closed" });
    expect(closed.line).toBe("Closed until the vault rolls");
    expect(closed.tooltip).toMatch(/reopen after the roll/);
    expect(closed.tooltip).toMatch(/next epoch's end/);
    const dated = house({ kind: "daily", at: FRIDAY_CLOSE, reason: "queue-closed" });
    expect(dated.line).toMatch(/^Closed until the vault rolls; then priced after /);
  });

  it("House boundary pending: the close has passed and the roll waits", () => {
    const pending = house({ kind: "daily", at: NOW - 3_600, reason: "boundary-pending" });
    expect(pending.line).toBe("At the pending roll (today's 1pm ET close has passed)");
    expect(pending.tooltip).toMatch(/closing price is final/);
  });

  it("never says now when the indexer could not read, or does not send, the value", () => {
    for (const copy of [
      earn({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null }),
      house({ kind: "weekly", at: null, reason: "not-read" }),
      earliestWithdrawalCopy(undefined, "earn", NOW),
      earliestWithdrawalCopy(undefined, "house", NOW),
    ]) {
      expect(copy.line).toBe("Unavailable");
      expect(copy.line).not.toMatch(/now/i);
    }
  });

  it("links the published FAQ answers", () => {
    expect(faqHref("earliest")).toBe(`${SITE_URL}/faq#earliest-withdrawal`);
    expect(faqHref("close")).toBe(`${SITE_URL}/faq#the-close`);
  });
});

/**
 * (launch action). The v2 API fixtures (ops/fixtures/api/v2, generated by gen.mjs) carried none of
 * the newer fields, so fixture mode showed "Unavailable" for every vault and no fixture consumer met a reason, a venue
 * or an APY. These hold the generated files to covering every branch this copy has.
 */
describe("the v2 API fixtures exercise every earliest-withdrawal and APY branch", () => {
  const FIXTURES = resolve(import.meta.dirname, "../../../ops/fixtures/api/v2");
  const read = (file: string): unknown => JSON.parse(readFileSync(resolve(FIXTURES, file), "utf8"));
  const earn = earnResponseSchema.parse(read("earn.json"));
  const houseList = houseListResponseSchema.parse(read("house.json"));
  const houseNvda = houseMarketResponseSchema.parse(read("house/NVDA.json"));
  const vaults = earn.vaults ?? [];

  it("every Earn vault and every House vault sends earliestWithdrawal, so none shows the not-sent line", () => {
    expect(vaults.length).toBeGreaterThan(0);
    const sent = [
      ...vaults.map((v) => ["earn", v.vault, v.earliestWithdrawal] as const),
      ...houseList.items.map((h) => ["house", h.market, h.earliestWithdrawal] as const),
      ["house", houseNvda.market, houseNvda.earliestWithdrawal] as const,
    ];
    for (const [surface, name, ew] of sent) {
      expect(ew, `${surface} ${name}`).toBeDefined();
      const copy = earliestWithdrawalCopy(ew, surface, 1_789_592_400);
      expect(copy.tooltip, `${surface} ${name}`).not.toMatch(/does not report the earliest withdrawal/);
    }
  });

  it("every reason the wire can carry appears in at least one fixture", () => {
    const seen = new Set([
      ...vaults.map((v) => v.earliestWithdrawal?.reason),
      ...houseList.items.map((h) => h.earliestWithdrawal?.reason),
      houseNvda.earliestWithdrawal?.reason,
    ]);
    expect([...earliestWithdrawalSchema.shape.reason.options].filter((r) => !seen.has(r))).toEqual([]);
  });

  it("the Earn fixtures carry a venue (absent, advisory, standard, unread) and APY figures beside every null reason", () => {
    expect(vaults.some((v) => v.venue === null)).toBe(true);
    const sources = new Set(vaults.map((v) => v.venue?.withdrawableSource));
    expect(sources.has("position") && sources.has("maxWithdraw") && sources.has(null)).toBe(true);
    const apys = vaults.flatMap((v) => [v.apy7d, v.apy30d, v.venue?.apy24h, v.venue?.apy7d]).filter((a) => a !== undefined);
    expect(apys.some((a) => a.bps !== null)).toBe(true);
    const reasons = new Set(apys.map((a) => a.reason));
    const nullReasons = earnApySchema.shape.reason.unwrap().options.filter((r) => r !== "out-of-range");
    expect(nullReasons.filter((r) => !reasons.has(r))).toEqual([]);
  });
});

// The reader's clock beside the ET close. Zones are passed explicitly, so this passes on any runner.
describe("closePhrase with the reader's zone", () => {
  it("adds the reader's clock, zone named, and nothing for a New York reader or no zone", () => {
    expect(closePhrase(TODAY_CLOSE, NOW, "America/Los_Angeles")).toBe("today's 4pm ET close (1pm PDT)");
    expect(closePhrase(TODAY_CLOSE, NOW, "America/New_York")).toBe("today's 4pm ET close");
    expect(closePhrase(TODAY_CLOSE, NOW)).toBe("today's 4pm ET close");
  });

  it("names the reader's weekday when their day is not New York's", () => {
    // Fri 16:00 ET is Sat 05:00 in Tokyo.
    expect(closePhrase(FRIDAY_CLOSE, NOW, "Asia/Tokyo")).toBe("the 4pm ET close on Fri, Sep 25 (Sat 5am GMT+9)");
  });
});
