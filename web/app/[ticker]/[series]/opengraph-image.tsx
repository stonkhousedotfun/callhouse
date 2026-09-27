import { parseV2Series, parseV2Ticker } from "@/app/v2-route-params";
import { isV2Live } from "@/lib/markets";
import { v2Api } from "@/lib/v2/api";

import { neutralSeriesImageLines, renderSeriesImage, seriesImageLines } from "./seriesImage";

export const alt = "StonkHouse option series and payoff";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

/** The Neon market page's share card (./seriesImage.tsx). */
export default async function OpengraphImage({ params }: { params: Promise<{ ticker: string; series: string }> }) {
  const { ticker, series: segment } = await params;
  const market = parseV2Ticker(ticker);
  const id = market ? parseV2Series(market, segment) : undefined;
  if (!market || !id || !isV2Live(market.ticker)) return renderSeriesImage(neutralSeriesImageLines());
  try {
    const { series } = await v2Api.getSeries(id);
    return renderSeriesImage(seriesImageLines(series));
  } catch { return renderSeriesImage(neutralSeriesImageLines()); }
}
