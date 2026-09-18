import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatsResponse } from "@/lib/v2/api-types";
import { useStats } from "@/lib/v2/hooks";
import { WinsFeed } from "./WinsLeaderboard";

vi.mock("@tanstack/react-query", () => ({ useInfiniteQuery: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useStats: vi.fn() }));

const stats = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/stats.json"), "utf8")) as StatsResponse;

function renderStats(data: StatsResponse | undefined, isPending: boolean, isError: boolean) {
  vi.mocked(useStats).mockReturnValue({ data, isPending, isError } as ReturnType<typeof useStats>);
  vi.mocked(useInfiniteQuery).mockReturnValue({ isPending: true, data: undefined, isError: false } as never);
  return renderToStaticMarkup(createElement(WinsFeed));
}

afterEach(() => vi.clearAllMocks());

describe("wins feed headline states", () => {
  it("shows loading while stats have no response", () => {
    const html = renderStats(undefined, true, false);
    expect(html.match(/Loading recorded wins…/g)).toHaveLength(3); // two cards and the feed
    expect(html).not.toContain("No recorded win yet");
  });

  it("does not mistake a stats outage for zero wins", () => {
    const html = renderStats(undefined, false, true);
    expect(html.match(/Results unavailable/g)).toHaveLength(2);
    expect(html).toContain("Headline totals are temporarily unavailable.");
    expect(html).not.toContain("No recorded win yet");
  });

  it("uses an empty result only after a successful stats response", () => {
    const html = renderStats({ ...stats, biggestWinDay: null, biggestWinWeek: null }, false, false);
    expect(html.match(/No recorded win yet/g)).toHaveLength(2);
    expect(html).not.toContain("Results unavailable");
  });

  it("labels cached empty results when live stats updates fail", () => {
    const html = renderStats({ ...stats, biggestWinDay: null, biggestWinWeek: null }, false, true);
    expect(html.match(/No recorded win in saved results/g)).toHaveLength(2);
    expect(html).toContain("Live headline updates are unavailable. Showing saved totals.");
  });
});
