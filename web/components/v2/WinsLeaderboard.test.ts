import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LeaderboardResponse, WinsResponse } from "@/lib/v2/api-types";
import { leaderValue, WinTile } from "./WinsLeaderboard";

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
