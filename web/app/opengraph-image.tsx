import { renderBrandImage } from "@/components/v2/PnlImage";
import { imageMoney } from "@/components/v2/PnlText";
import { v2Api } from "@/lib/v2/api";

export const alt = "StonkHouse — buy an outcome with a known maximum loss";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

export default async function OpengraphImage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") return renderBrandImage({ eyebrow: "StonkHouse", metric: "Stock Tokens",
    headline: "Let your stonks work for you", detail: "Explore covered calls on Robinhood Chain",
    risk: "Read the risks before you trade" });
  try {
    const { card } = await v2Api.getHeroCard();
    if (card) {
      const ticket = card.perShare ?? card.perUnit;
      return renderBrandImage({ eyebrow: "Live option", metric: `${ticket.multiple}×`,
        headline: `${card.series.ticker} outcome`,
        detail: `If ${card.series.ticker} reaches $${card.target.formatted} by expiry`,
        risk: `Max loss is ${imageMoney(ticket.cost, "up")} USDG for this ticket` });
    }
  } catch { /* the example below is deliberately labelled */ }
  return renderBrandImage({ eyebrow: "Example", metric: "Buy an outcome", headline: "Know your maximum loss",
    detail: "Explore Stock Token options on Robinhood Chain", risk: "Example only · live prices appear in the app" });
}
