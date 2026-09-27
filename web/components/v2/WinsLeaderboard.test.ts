import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LeaderboardResponse, WinsResponse } from "@/lib/v2/api-types";
import { WinRow } from "./WinsFeed";
import {
  LEADERBOARD_RULES, Leaderboard, LeaderboardRail, LeaderRowView, leaderValue, rankLabel, RAIL_ROWS, uniqueHolders, winsTabFromParam,
} from "./WinsLeaderboard";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useInfiniteQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));

const wins = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/feed/wins.json"), "utf8")) as WinsResponse;
const board = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/leaderboard.json"), "utf8")) as LeaderboardResponse;
type Row = LeaderboardResponse["items"][number];

afterEach(() => vi.clearAllMocks());

describe("public outcome value labels", () => {
  // Was rendered through WinTile; Neon replaced the tile with a row (WinRow). The property is unchanged.
  it("describes a call win as USDG value, since its payout can include Stock Tokens", () => {
    const win = wins.items.find((item) => !item.series.isPut)!;
    const html = renderToStaticMarkup(createElement(WinRow, { win, now: win.settledAt }));
    expect(html).toContain(`${win.payout.formatted} USDG value`);
    expect(html).not.toContain(`${win.payout.formatted} USDG</`);
  });

  it("labels an absolute leaderboard amount as value too", () => {
    const row = { value: wins.items[0]!.payout } as Row;
    expect(leaderValue(row, "absolute")).toBe(`${wins.items[0]!.payout.formatted} USDG value`);
    // A payout rounds down to the cent, never the indexer's six decimals: 4.585409 -> 4.58.
    expect(wins.items[1]!.payout.formatted).toBe("4.585409");
    expect(leaderValue({ value: wins.items[1]!.payout } as Row, "absolute")).toBe("4.58 USDG value");
  });
});

describe("the leaderboard rail beside the feed", () => {
  function renderRail(data: LeaderboardResponse | undefined, isPending = false) {
    vi.mocked(useQuery).mockReturnValue({ data, isPending, isError: false, error: null } as never);
    return renderToStaticMarkup(createElement(LeaderboardRail));
  }

  it("asks for this week's top five by the chosen measure", () => {
    renderRail(board);
    const options = vi.mocked(useQuery).mock.calls[0]![0] as { queryKey: unknown[] };
    expect(options.queryKey).toEqual(["v2", "leaderboardRail", "multiple"]);
    expect(RAIL_ROWS).toBe(5);
  });

  it("renders the real rows, ranked 01.., with the rules and the full-board link", () => {
    const html = renderRail(board);
    expect(html.match(/data-slot="leader-row"/g)).toHaveLength(board.items.length);
    expect(html).toContain(">01<");
    expect(html).toContain(leaderValue(board.items[0]!, "multiple"));
    // The rules sit in the heading's "?" rather than a footnote; the text is still in the page.
    expect(html).toContain(LEADERBOARD_RULES);
    expect(html).toContain('aria-label="About the leaderboard"');
    expect(html).toContain('href="/leaderboard"');
  });

  it("never shows more than five, even if the API returns more", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...board.items[0]!, rank: i + 1, holder: `0x${String(i).repeat(40)}` }));
    const html = renderRail({ ...board, items: many } as LeaderboardResponse);
    expect(html.match(/data-slot="leader-row"/g)).toHaveLength(RAIL_ROWS);
  });

  it("an empty week says so instead of drawing placeholder ranks", () => {
    const html = renderRail({ ...board, items: [] } as LeaderboardResponse);
    expect(html).toContain("No ranked wins this week yet.");
    expect(html).not.toContain('data-slot="leader-row"');
    expect(html).not.toContain("0x9e2D"); // the mockup's first wallet
  });

  it("loading is not an empty board", () => {
    const html = renderRail(undefined, true);
    expect(html).toContain("Loading leaderboard…");
    expect(html).not.toContain("No ranked wins this week yet.");
  });
});

describe("/leaderboard with no ranked wins", () => {
  const renderPage = (pages: LeaderboardResponse[]) => {
    vi.mocked(useInfiniteQuery).mockReturnValue({ data: { pages }, isPending: false, isError: false, error: null,
      hasNextPage: false, isFetchingNextPage: false } as never);
    return renderToStaticMarkup(createElement(Leaderboard));
  };

  it("says the first ranked win lands here, with no placeholder rows", () => {
    const html = renderPage([{ ...board, items: [] } as LeaderboardResponse]);
    expect(html).toContain('data-slot="leaderboard-empty"');
    expect(html).toContain("First ranked win lands here");
    expect(html).not.toContain('data-slot="leader-row"');
  });

  it("with ranked wins it draws them instead of the empty state", () => {
    const html = renderPage([board]);
    expect(html).not.toContain("First ranked win lands here");
    expect(html.match(/data-slot="leader-row"/g)).toHaveLength(uniqueHolders(board.items).length);
  });
});

describe("leaderboard rows", () => {
  it("prints the rank as two mono digits, the leader in the accent colour", () => {
    expect(rankLabel(1)).toBe("01");
    expect(rankLabel(12)).toBe("12");
    expect(rankLabel(120)).toBe("120");
    const first = renderToStaticMarkup(createElement(LeaderRowView, { row: board.items[0]!, metric: "multiple", own: false, compact: true }));
    const second = renderToStaticMarkup(createElement(LeaderRowView, { row: board.items[1]!, metric: "multiple", own: false, compact: true }));
    expect(first).toMatch(/class="num [^"]*text-accent-text">01</);
    expect(second).toMatch(/class="num [^"]*text-ink-3">02</);
  });

  it("the full row links the wallet's best receipt", () => {
    const row = board.items[0]!;
    const html = renderToStaticMarkup(createElement(LeaderRowView, { row, metric: "multiple", own: true }));
    expect(html).toContain(`href="/pnl/${encodeURIComponent(row.best.id)}"`);
    expect(html).toContain(">You<");
  });

  it("keeps one row per wallet, whatever the address case", () => {
    const a = board.items[0]!;
    expect(uniqueHolders([a, { ...a, holder: a.holder.toLowerCase(), rank: 9 }])).toHaveLength(1);
  });
});

/**
 * The reset and exclusion copy, checked against the indexer that implements it, not against the mockup text.
 * indexer/lib/v2/windows.ts starts the week window on Monday at New York midnight, and
 * indexer/src/api/v2/feed.ts `eligible` drops positions (self-fill, transfer in/out, off-market), not accounts.
 */
describe("leaderboard rules copy", () => {
  const indexer = (path: string) => readFileSync(resolve(import.meta.dirname, "../../../indexer", path), "utf8");

  it("the indexer sources were actually read — the control", () => {
    expect(indexer("lib/v2/windows.ts")).toContain("export function windowStarts");
    expect(indexer("src/api/v2/feed.ts")).toContain("function eligible(row: PnlRow)");
  });

  it("the week is New York Monday midnight, and ineligibility is per position", () => {
    const windows = indexer("lib/v2/windows.ts");
    expect(windows).toContain("const monday = ");
    expect(windows).toContain("week: nyMidnight(monday");
    const eligible = indexer("src/api/v2/feed.ts").match(/function eligible\(row: PnlRow\): boolean \{[\s\S]*?\n\}/)![0];
    for (const flag of ["selfFill", "transferIn", "transferredOut", "offMarket"]) expect(eligible).toContain(`!row.${flag}`);
    expect(LEADERBOARD_RULES).toBe("Weekly rankings reset Monday 00:00 New York. Flagged or gifted positions are excluded.");
  });
});

/**
 * UX review item 3: `/leaderboard` was real and unreachable. Neon makes the leaderboard permanent on /wins, as the
 * rail with "Full leaderboard →", and /leaderboard is that list full width.
 *
 * The route is KEPT rather than deleted: it was unreachable from the nav, not unreachable full stop, so bookmarks
 * and shared links exist. Deleting it would turn every one of those into a 404 to fix a discovery problem.
 */
describe("wins and leaderboard share one component", () => {
  const routeSource = (route: string) => readFileSync(resolve(import.meta.dirname, `../../app/${route}/page.tsx`), "utf8");
  const componentSource = () => readFileSync(resolve(import.meta.dirname, "WinsLeaderboard.tsx"), "utf8");

  it("the route sources were actually read — the control", () => {
    expect(routeSource("wins")).toContain("export default function WinsPage");
    expect(routeSource("leaderboard")).toContain("export default function LeaderboardPage");
  });

  it("both routes render the SAME component, each opening on its own view", () => {
    expect(routeSource("wins")).toContain("WinsAndLeaderboard");
    expect(routeSource("wins")).toContain('initialTab="wins"');
    expect(routeSource("leaderboard")).toContain("WinsAndLeaderboard");
    expect(routeSource("leaderboard")).toContain('initialTab="leaderboard"');
  });

  it("/wins carries the rail, and the rail links the full board", () => {
    expect(componentSource()).toMatch(/<RailLayout main=\{<WinsFeed \/>\} rail=\{<LeaderboardRail \/>\}/);
  });

  it("/leaderboard still exists, so an existing link does not become a 404", () => {
    // The whole reason the route was not deleted. If someone later removes it, this says why not.
    expect(() => routeSource("leaderboard")).not.toThrow();
    expect(routeSource("leaderboard")).toContain("canonical");
  });

  it("/leaderboard is its own canonical: /wins never read ?tab, so /wins?tab=leaderboard showed the feed", () => {
    expect(routeSource("leaderboard")).toContain('canonical: "/leaderboard"');
    expect(routeSource("wins")).not.toContain("searchParams");
  });

  it("an unknown ?tab= value opens the default rather than an error", () => {
    expect(winsTabFromParam("leaderboard")).toBe("leaderboard");
    expect(winsTabFromParam("wins")).toBe("wins");
    for (const junk of [null, undefined, "", "nonsense", "LEADERBOARD"]) {
      expect(winsTabFromParam(junk), String(junk)).toBe("wins");
    }
  });
});
