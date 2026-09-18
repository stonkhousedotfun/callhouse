import type { MetadataRoute } from "next";
import { notFound } from "next/navigation";

import { ALL_MARKETS } from "@/lib/markets";
import { APP_URL } from "@/lib/site";
import { DEV_PREVIEW } from "@/lib/devPreview";

export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.NEXT_PUBLIC_V2 !== "1" || DEV_PREVIEW) notFound();
  const publicPaths = ["/", "/wins", "/leaderboard", ...ALL_MARKETS.map((market) => `/${market.ticker.toLowerCase()}`)];
  return publicPaths.map((path) => ({ url: `${APP_URL}${path}`, changeFrequency: "daily", priority: path === "/" ? 1 : 0.7 }));
}
