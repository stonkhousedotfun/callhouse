import type { MetadataRoute } from "next";
import { DEV_PREVIEW } from "@/lib/devPreview";

/**
 * V1 is not indexed. V2 allows the public buyer pages and excludes wallet, writer, settings,
 * and legacy paths.
 *
 * This file and route metadata in app/layout.tsx and the public pages form one crawl policy.
 * In v1 there is no public sitemap content. In v2 app/sitemap.ts lists public entry points;
 * private pages also emit per-page noindex metadata.
 */
export default function robots(): MetadataRoute.Robots {
  if (process.env.NEXT_PUBLIC_V2 === "1" && !DEV_PREVIEW) {
    return {
      rules: [{ userAgent: "*", allow: "/", disallow: ["/portfolio", "/earn", "/settings", "/legacy", "/account", "/book", "/activity", "/collect", "/vault"] }],
      sitemap: `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "https://app.stonkhouse.fun"}/sitemap.xml`,
    };
  }
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
