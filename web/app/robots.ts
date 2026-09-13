import type { MetadataRoute } from "next";

/**
 * app.callhouse.finance is not indexed. Full disallow, every user agent.
 *
 * This file and the `robots: { index: false, follow: true }` block in app/layout.tsx are the
 * same decision expressed twice — a served /robots.txt for crawlers that read it before
 * fetching, and a per-page meta tag for the ones that do not. The reasoning is written out in
 * layout.tsx; read it there before changing either, and change BOTH or neither. A robots.txt
 * that allows what the meta tag forbids is the kind of drift nobody notices until a /legal page
 * is duplicated across two domains in search results.
 *
 * Deliberately absent: a sitemap. There is nothing here we want crawled, so pointing at a map
 * of it would be self-contradictory. The marketing site owns the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
