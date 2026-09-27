import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatsResponse, WinsResponse } from "@/lib/v2/api-types";
import { useStats } from "@/lib/v2/hooks";
import { avatarTone, fmtMultiple, WINS_ONLY_NOTE, winAge, WinRow, WinsFeed } from "./WinsFeed";

vi.mock("@tanstack/react-query", () => ({ useInfiniteQuery: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useStats: vi.fn() }));

const stats = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/stats.json"), "utf8")) as StatsResponse;
const wins = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/feed/wins.json"), "utf8")) as WinsResponse;

type Feed = { isPending: boolean; data: { pages: WinsResponse[] } | undefined; isError: boolean };
const pendingFeed: Feed = { isPending: true, data: undefined, isError: false };

function render(data: StatsResponse | undefined, isPending: boolean, isError: boolean, feed: Feed = pendingFeed) {
  vi.mocked(useStats).mockReturnValue({ data, isPending, isError } as ReturnType<typeof useStats>);
  vi.mocked(useInfiniteQuery).mockReturnValue(feed as never);
  return renderToStaticMarkup(createElement(WinsFeed));
}

afterEach(() => vi.clearAllMocks());

/*
 * These four pre-date Neon and are kept unchanged: they protect "loading and an outage are not zero wins". The
 * figures moved from bespoke panels into StatTiles, but the loading, outage and empty wording is the same text in
 * the same two "biggest win" tiles, so every count below still holds without being retyped.
 */
describe("wins feed headline states", () => {
  it("shows loading while stats have no response", () => {
    const html = render(undefined, true, false);
    expect(html.match(/Loading recorded wins…/g)).toHaveLength(3); // two tiles and the feed
    expect(html).not.toContain("No recorded win yet");
  });

  it("does not mistake a stats outage for zero wins", () => {
    const html = render(undefined, false, true);
    expect(html.match(/Results unavailable/g)).toHaveLength(2);
    expect(html).toContain("Totals are unavailable.");
    expect(html).not.toContain("No recorded win yet");
  });

  it("uses an empty result only after a successful stats response", () => {
    const html = render({ ...stats, biggestWinDay: null, biggestWinWeek: null }, false, false);
    expect(html.match(/No recorded win yet/g)).toHaveLength(2);
    expect(html).not.toContain("Results unavailable");
  });

  it("labels cached empty results when live stats updates fail", () => {
    const html = render({ ...stats, biggestWinDay: null, biggestWinWeek: null }, false, true);
    expect(html.match(/No recorded win in saved results/g)).toHaveLength(2);
    expect(html).toContain("Showing saved totals.");
  });
});

/*
 * The empty state, the real state today: the live book has 0 fills. The tiles read 0 in mono and the feed says
 * "First win lands here"; the mockup's illustrative rows and tile values never ship.
 */
describe("the no-fills state", () => {
  const zero = { raw: "0", decimals: 6, formatted: "0" };
  const empty: StatsResponse = { ...stats, contractsFilled: "0", volume24h: zero, biggestWinDay: null, biggestWinWeek: null };
  const html = () => render(empty, false, false, { isPending: false, isError: false, data: { pages: [{ items: [], nextCursor: null }] } });

  it("shows 0 in mono in all four tiles", () => {
    // The value element of a Stat carries `num` (the mono face) when mono; the four tiles each render 0.
    const zeros = html().match(/data-slot="stat-value" class="[^"]*\bnum\b[^"]*">0(?=<| )/g);
    expect(zeros).toHaveLength(4);
  });

  it("says where the first win will land, and draws no row", () => {
    const out = html();
    expect(out).toContain("First win lands here");
    expect(out).not.toContain('data-slot="win-row"');
  });

  it("ships none of the mockup's sample data", () => {
    const out = html();
    // The design mockup's illustrative values: tile figures and a wallet.
    for (const sample of [">184<", "412 USDG", "4.2×", "8.0×", "0x9e2D", "sold early"]) expect(out, sample).not.toContain(sample);
  });

  it("keeps the worthless-expiry line verbatim", () => {
    expect(WINS_ONLY_NOTE).toBe("Most options expire worthless. This feed shows wins only.");
    expect(html()).toContain(WINS_ONLY_NOTE);
  });

  it("the regex above can see a non-zero tile — the control", () => {
    const out = render({ ...empty, contractsFilled: "1895" }, false, false,
      { isPending: false, isError: false, data: { pages: [{ items: [], nextCursor: null }] } });
    expect(out.match(/data-slot="stat-value" class="[^"]*\bnum\b[^"]*">0(?=<| )/g)).toHaveLength(3);
    expect(out).toContain(">1,895<");
  });
});

describe("a win row", () => {
  const now = 1789156962 + 5 * 3600;

  it("renders every real win once, with its receipt", () => {
    const out = render(stats, false, false, { isPending: false, isError: false, data: { pages: [wins] } });
    expect(out.match(/data-slot="win-row"/g)).toHaveLength(wins.items.length);
    for (const win of wins.items) expect(out).toContain(`href="/pnl/${encodeURIComponent(win.id)}"`);
    // The 24h volume goes through the money formatter, not the indexer's full-precision string (5.1309).
    expect(stats.volume24h.formatted).toBe("5.1309");
    expect(out).not.toContain("5.1309");
  });

  it("prints paid → got as a USDG value, the multiple and the wallet", () => {
    const win = wins.items[0]!;
    const out = renderToStaticMarkup(createElement(WinRow, { win, now }));
    // To the cent like the receipt, cost rounded up and value down: 0.275 -> 0.28, 1.26 stays 1.26.
    expect(win.cost.formatted).toBe("0.275");
    expect(out).toContain("paid 0.28 → 1.26 USDG value");
    expect(out).not.toContain("0.275");
    expect(out).toContain(fmtMultiple(win.multiple));
    expect(out).toContain(`${win.holder.slice(0, 6)}…${win.holder.slice(-4)}`);
    expect(out).toContain(`${win.ticker} $${win.series.strike.formatted} call`);
    expect(out).toContain(">5h<");
  });

  it("leaves the age out before mount (useNow is 0), instead of calling every win 'now'", () => {
    const win = wins.items[0]!;
    const out = renderToStaticMarkup(createElement(WinRow, { win, now: 0 }));
    expect(out).not.toContain("<time");
    expect(out).not.toContain(">now<");
    expect(out).toContain("paid 0.28 →");
  });

  it("keeps up to two decimals and no zero tail, so a 1.04× win never reads as a 1× break-even", () => {
    // 8 reads "8×", not "8.00×"; the hundredths still show when they are not zero.
    expect(fmtMultiple(1.04)).toBe("1.04×");
    expect(fmtMultiple(2.4)).toBe("2.4×");
    expect(fmtMultiple(8)).toBe("8×");
  });
});

describe("winAge", () => {
  // 2026-09-15 16:00:00 New York (EDT, UTC-4) is a Tuesday: 20:00 UTC.
  const tue4pm = Date.UTC(2026, 8, 15, 20, 0, 0) / 1000;

  it("counts minutes and hours inside a day", () => {
    expect(winAge(tue4pm, tue4pm + 30)).toBe("now");
    expect(winAge(tue4pm, tue4pm + 12 * 60)).toBe("12m");
    expect(winAge(tue4pm, tue4pm + 5 * 3600 + 59)).toBe("5h");
  });

  it("names the New York weekday inside a week, then the date", () => {
    expect(winAge(tue4pm, tue4pm + 2 * 86_400)).toBe("Tue");
    expect(winAge(tue4pm, tue4pm + 8 * 86_400)).toBe("Sep 15");
  });

  it("uses the New York day, not UTC: 22:30 New York on Tuesday is already Wednesday in UTC", () => {
    const tueLate = Date.UTC(2026, 8, 16, 2, 30, 0) / 1000; // 2026-09-15 22:30 EDT
    expect(winAge(tueLate, tueLate + 3 * 86_400)).toBe("Tue");
  });

  it("reads a close time in the future (clock skew) as now, never a negative age", () => {
    expect(winAge(tue4pm + 600, tue4pm)).toBe("now");
  });
});

describe("avatarTone", () => {
  it("is a function of the wallet alone, so a wallet keeps its colour when rows move", () => {
    const holder = wins.items[0]!.holder;
    expect(avatarTone(holder)).toBe(avatarTone(holder.toLowerCase()));
    expect(avatarTone(holder)).toBe(avatarTone(holder.toUpperCase().replace("0X", "0x")));
  });

  it("uses only theme tokens", () => {
    for (const win of wins.items) expect(avatarTone(win.holder)).toMatch(/^bg-(accent|usdg|danger-text|warn|ink-3)$/);
  });
});
