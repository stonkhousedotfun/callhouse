import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LeaderboardResponse, WinsResponse } from "@/lib/v2/api-types";
import { leaderValue, WinTile, winsTabFromParam } from "./WinsLeaderboard";

const wins = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/feed/wins.json"), "utf8")) as WinsResponse;

describe("public outcome value labels", () => {
  it("describes a call win as USDG value, since its payout can include Stock Tokens", () => {
    const win = wins.items.find((item) => !item.series.isPut)!;
    const html = renderToStaticMarkup(createElement(WinTile, { win }));
    expect(html).toContain(`${win.payout.formatted} USDG value`);
    expect(html).not.toContain(`${win.payout.formatted} USDG</p>`);
  });

  it("labels an absolute leaderboard amount as value too", () => {
    const row = { value: wins.items[0]!.payout } as LeaderboardResponse["items"][number];
    expect(leaderValue(row, "absolute")).toBe(`${wins.items[0]!.payout.formatted} USDG value`);
  });
});

/**
 * UX review item 3: `/leaderboard` was real and unreachable.
 *
 * It rendered three windows by three metrics and NOTHING in the nav linked to it — only `/wins`
 * was there. The fix is one tabbed page rather than a ninth nav destination, because item 1 of
 * the same review was that there were already eight top-level destinations. (T-411 has since cut
 * the nav to five: Buy, Portfolio, Vaults, Wins and Trust.)
 *
 * The route is KEPT rather than deleted: it was unreachable from the nav, not unreachable full
 * stop, so bookmarks and shared links exist. Deleting it would turn every one of those into a 404
 * to fix a discovery problem.
 */
describe("wins and leaderboard are one page", () => {
  const routeSource = (route: string) => readFileSync(resolve(import.meta.dirname, `../../app/${route}/page.tsx`), "utf8");

  it("the route sources were actually read — the control", () => {
    expect(routeSource("wins")).toContain("export default function WinsPage");
    expect(routeSource("leaderboard")).toContain("export default function LeaderboardPage");
  });

  it("both routes render the SAME component, each opening on its own tab", () => {
    expect(routeSource("wins")).toContain("WinsAndLeaderboard");
    expect(routeSource("wins")).toContain('initialTab="wins"');
    expect(routeSource("leaderboard")).toContain("WinsAndLeaderboard");
    expect(routeSource("leaderboard")).toContain('initialTab="leaderboard"');
  });

  it("/leaderboard still exists, so an existing link does not become a 404", () => {
    // The whole reason the route was not deleted. If someone later removes it, this says why not.
    expect(() => routeSource("leaderboard")).not.toThrow();
    expect(routeSource("leaderboard")).toContain("canonical");
  });

  it("an unknown ?tab= value opens the default rather than an error", () => {
    expect(winsTabFromParam("leaderboard")).toBe("leaderboard");
    expect(winsTabFromParam("wins")).toBe("wins");
    for (const junk of [null, undefined, "", "nonsense", "LEADERBOARD"]) {
      expect(winsTabFromParam(junk), String(junk)).toBe("wins");
    }
  });
});
