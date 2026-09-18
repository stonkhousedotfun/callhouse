const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  timeZoneName: "shortOffset",
});

function nyDate(at: bigint): { year: number; month: number; day: number } {
  const parts = NEW_YORK.formatToParts(new Date(Number(at) * 1000));
  const field = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  return { year: field("year"), month: field("month"), day: field("day") };
}

function nyMidnight(year: number, month: number, day: number): bigint {
  const utcStart = Date.UTC(year, month - 1, day) / 1000;
  let guess = utcStart + 5 * 3600;
  // The offset at local noon can differ from midnight on a DST change day.
  // Resolve the offset at the candidate midnight until it stops moving.
  for (let i = 0; i < 3; i++) {
    const zone = NEW_YORK.formatToParts(new Date(guess * 1000))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
    if (!match) throw new Error(`unrecognized New York offset: ${zone}`);
    const sign = match[1] === "+" ? 1 : -1;
    const offset = sign * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60);
    const next = utcStart - offset;
    if (next === guess) return BigInt(next);
    guess = next;
  }
  return BigInt(guess);
}

/** Exact New York calendar-day bounds, including 23- and 25-hour DST days. */
export function nyDayBounds(at: bigint): { start: bigint; end: bigint } {
  const { year, month, day } = nyDate(at);
  return { start: nyMidnight(year, month, day), end: nyMidnight(year, month, day + 1) };
}

export function windowStarts(at: bigint): { week: bigint; month: bigint; all: bigint } {
  const { year, month, day } = nyDate(at);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const monday = new Date(Date.UTC(year, month - 1, day - ((weekday + 6) % 7)));
  return {
    week: nyMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
    month: nyMidnight(year, month, 1),
    all: 0n,
  };
}

/** Maker reward epochs use Monday 00:00 UTC, distinct from the New York leaderboard week. */
export function makerEpochUtc(at: bigint): bigint {
  const date = new Date(Number(at) * 1000);
  const day = date.getUTCDay();
  return BigInt(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((day + 6) % 7)) / 1000);
}

export type RankPosition = { id: string; closedAt: bigint; multiplePpm: bigint | null; realisedUsdg: bigint; excluded: boolean };
export function rankTotals(positions: readonly RankPosition[]): {
  bestMultiplePpm: bigint; absoluteRealisedUsdg: bigint; streak: number; wins: number; losses: number; bestWinId: string | null;
} {
  const ordered = [...positions].sort((a, b) => a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : a.id.localeCompare(b.id));
  let bestMultiplePpm = 0n;
  let absoluteRealisedUsdg = 0n;
  let streak = 0;
  let wins = 0;
  let losses = 0;
  let bestWinId: string | null = null;
  for (const position of ordered) {
    // Gifts, self-fills and off-market prints are absent from the ranking.
    // A legitimate losing close still breaks the streak.
    if (position.excluded) continue;
    const won = (position.multiplePpm ?? 0n) > 1_000_000n;
    if (won) {
      wins++;
      streak++;
      if (position.multiplePpm! > bestMultiplePpm) {
        bestMultiplePpm = position.multiplePpm!;
        bestWinId = position.id;
      }
      if (position.realisedUsdg > absoluteRealisedUsdg) absoluteRealisedUsdg = position.realisedUsdg;
    } else {
      losses++;
      streak = 0;
    }
  }
  return { bestMultiplePpm, absoluteRealisedUsdg, streak, wins, losses, bestWinId };
}
