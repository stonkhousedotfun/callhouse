import { describe, expect, it } from "vitest";
import { clearCalendarCache, weeklyAtExpiry } from "../../lib/v2/calendarCache";
import { bountyAmount, rewardTotal, seriesTenor } from "../../lib/v2/periphery";

describe("v2 optional periphery reducers", () => {
  it("classifies a whitelisted nonweekly expiry as special, and respects a later denial", () => {
    let allowed = false;
    expect(seriesTenor(false, allowed)).toBe("daily");
    allowed = true; // SpecialExpirySet(ts, true)
    expect(seriesTenor(false, allowed)).toBe("special");
    expect(seriesTenor(true, allowed)).toBe("weekly");
    allowed = false; // SpecialExpirySet(ts, false)
    expect(seriesTenor(false, allowed)).toBe("daily");
  });

  it("replays bounty replacements and reward sums independently", () => {
    let bounty = bountyAmount(250_000n);
    let total = rewardTotal(null, bounty);
    bounty = bountyAmount(100_000n);
    total = rewardTotal(total, 0n);
    total = rewardTotal(total, bounty);
    expect(total).toEqual({ count: 3, amount: 350_000n });
    expect(bounty).toBe(100_000n);
    expect(() => rewardTotal(total, -1n)).toThrow("Negative");
    expect(() => bountyAmount(-1n)).toThrow("Negative");
  });

  it("reads weekly once per expiry and invalidates when calendar policy changes", async () => {
    const calendar = "0x4444444444444444444444444444444444444444";
    clearCalendarCache();
    let calls = 0;
    const read = async () => { calls++; return calls > 1; };
    expect(await weeklyAtExpiry(calendar, 200n, "0x01", read)).toBe(false);
    expect(await weeklyAtExpiry(calendar, 200n, "0x01", read)).toBe(false);
    expect(calls).toBe(1);
    expect(await weeklyAtExpiry(calendar, 200n, "0x02", read)).toBe(true); // Next block or reorg.
    expect(calls).toBe(2);
    clearCalendarCache(); // HolidaySet / SpecialExpirySet in the same block.
    expect(await weeklyAtExpiry(calendar, 200n, "0x02", read)).toBe(true);
    expect(calls).toBe(3);
  });
});
