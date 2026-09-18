import { parseV2Series, parseV2Ticker } from "@/app/v2-route-params";
import { renderBrandImage, neutralPnlLines } from "@/components/v2/PnlImage";
import { expiryLabel, seriesTitle } from "@/components/v2/PnlText";
import { v2Api } from "@/lib/v2/api";

export const alt = "StonkHouse option series and payoff";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

export default async function OpengraphImage({ params }: { params: Promise<{ ticker: string; series: string }> }) {
  const { ticker, series: segment } = await params;
  const market = parseV2Ticker(ticker);
  const id = market ? parseV2Series(market, segment) : undefined;
  if (!id) return renderBrandImage(neutralPnlLines());
  try {
    const { series } = await v2Api.getSeries(id);
    return renderBrandImage({ eyebrow: "Option payoff", metric: series.ticker,
      headline: seriesTitle(series), detail: `Expires ${expiryLabel(series.expiry)} · 0.01-share steps`,
      risk: "Maximum loss for a buyer is the amount paid" });
  } catch { return renderBrandImage(neutralPnlLines()); }
}
