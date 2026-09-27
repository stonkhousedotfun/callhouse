import { renderBrandImage } from "@/components/v2/PnlImage";
import { liveOptionImageLines } from "@/components/v2/PnlText";
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
    if (card) return renderBrandImage(liveOptionImageLines(card));
  } catch { /* no live card: the brand card below carries no price, so it needs no "example" label */ }
  return renderBrandImage({ eyebrow: "StonkHouse", metric: "Buy an outcome", headline: "Know your maximum loss",
    detail: "Stock Token options on Robinhood Chain", risk: "Live prices in the app" });
}
