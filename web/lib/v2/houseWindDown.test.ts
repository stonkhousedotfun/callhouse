import { describe, expect, it } from "vitest";

import { formatNewYork } from "./houseEpoch";
import {
  dailyFirst, HOUSE_WIND_DOWN_DETAIL, HOUSE_WIND_DOWN_UNREAD, houseKindsOpenForDeposit, houseWindDownHeadline, houseWindDownUnknown,
  houseWindingDown,
} from "./houseWindDown";

describe("houseWindingDown", () => {
  it("winds a weekly vault down once the list carries a daily vault", () => {
    expect(houseWindingDown("weekly", ["weekly", "daily"])).toBe(true);
    expect(houseWindingDown("weekly", ["daily"])).toBe(true);
  });

  it("winds nothing down before any daily vault is listed (the launch state: weekly only)", () => {
    expect(houseWindingDown("weekly", ["weekly", "weekly"])).toBe(false);
    expect(houseWindingDown("weekly", [])).toBe(false);
  });

  it("an unknown or absent kind in the list is not a daily vault", () => {
    expect(houseWindingDown("weekly", ["weekly", "unknown"])).toBe(false);
    expect(houseWindingDown("weekly", ["weekly", undefined])).toBe(false);
  });

  it("only a weekly vault winds down: daily, unknown and absent kinds never do", () => {
    expect(houseWindingDown("daily", ["weekly", "daily"])).toBe(false);
    expect(houseWindingDown("unknown", ["weekly", "daily"])).toBe(false);
    expect(houseWindingDown(undefined, ["weekly", "daily"])).toBe(false);
  });
});

// The list is the only wind-down signal, so an unread or failed list leaves a weekly vault's wind-down
// unknown, and its deposit stays shut rather than open on a guess.
describe("houseWindDownUnknown", () => {
  it("a weekly vault's wind-down is unknown while the list is unread or failed", () => {
    expect(houseWindDownUnknown("weekly", false)).toBe(true);
  });

  it("a read list decides it: known either way", () => {
    expect(houseWindDownUnknown("weekly", true)).toBe(false);
  });

  it("daily, unknown and absent kinds are never wound down, so the list cannot shut their deposit", () => {
    expect(houseWindDownUnknown("daily", false)).toBe(false);
    expect(houseWindDownUnknown("unknown", false)).toBe(false);
    expect(houseWindDownUnknown(undefined, false)).toBe(false);
  });

  it("the line says it could not check and that leaving still works", () => {
    expect(HOUSE_WIND_DOWN_UNREAD).toMatch(/^Could not check whether this weekly vault is winding down\./);
    expect(HOUSE_WIND_DOWN_UNREAD).toMatch(/withdrawals stay open/);
  });
});

describe("wind-down copy", () => {
  it("names the exit as the current epoch's end, in New York time", () => {
    const end = 1_760_604_800;
    expect(houseWindDownHeadline(end)).toBe(`Winding down: no new deposits; withdraw at ${formatNewYork(end)}.`);
  });

  it("with no epoch end observed, names the next close and never a date it does not have", () => {
    const line = houseWindDownHeadline(null);
    expect(line).toBe("Winding down: no new deposits; withdraw at the vault's next close.");
    expect(line).not.toMatch(/1970/);
  });

  it("says close, never boundary", () => {
    expect(HOUSE_WIND_DOWN_DETAIL).toBe(
      "This weekly vault is closing now that the daily house vaults are live. It takes no new deposits, and its bot only closes what the vault already holds. A withdrawal you request before the close is paid there, in kind. Requesting a withdrawal and claiming it stay open for as long as you hold shares.",
    );
    expect(`${houseWindDownHeadline(null)} ${HOUSE_WIND_DOWN_DETAIL}`).not.toMatch(/boundary/i);
  });

  it("keeps the way out open in words: withdrawals and claims are never described as closing", () => {
    expect(HOUSE_WIND_DOWN_DETAIL).toMatch(/Requesting a withdrawal and claiming it stay open/);
    expect(HOUSE_WIND_DOWN_DETAIL).not.toMatch(/withdrawals? (are|is) (closed|paused|shut)/i);
  });
});

describe("houseKindsOpenForDeposit", () => {
  it("drops weekly once a daily vault is listed", () => {
    expect(houseKindsOpenForDeposit(["weekly", "daily", "weekly", "daily"])).toEqual(["daily", "daily"]);
  });

  it("changes nothing before a daily vault is listed", () => {
    expect(houseKindsOpenForDeposit(["weekly", "weekly"])).toEqual(["weekly", "weekly"]);
    expect(houseKindsOpenForDeposit(["weekly", "unknown"])).toEqual(["weekly", "unknown"]);
    expect(houseKindsOpenForDeposit([])).toEqual([]);
  });

  it("keeps unknown kinds (it only removes what it knows is winding down)", () => {
    expect(houseKindsOpenForDeposit(["weekly", "daily", "unknown"])).toEqual(["daily", "unknown"]);
  });
});

describe("dailyFirst", () => {
  it("puts daily vaults first and keeps every other row in its order", () => {
    const rows = [
      { market: "NVDA", kind: "weekly" as const },
      { market: "SPCX", kind: "weekly" as const },
      { market: "NVDA", kind: "daily" as const },
      { market: "XYZ" },
      { market: "SPCX", kind: "daily" as const },
    ];
    expect(dailyFirst(rows).map((row) => `${row.market}:${row.kind ?? "-"}`))
      .toEqual(["NVDA:daily", "SPCX:daily", "NVDA:weekly", "SPCX:weekly", "XYZ:-"]);
  });

  it("does not mutate its input", () => {
    const rows = [{ kind: "weekly" as const }, { kind: "daily" as const }];
    dailyFirst(rows);
    expect(rows.map((row) => row.kind)).toEqual(["weekly", "daily"]);
  });
});
