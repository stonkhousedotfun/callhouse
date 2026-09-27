/**
 * The 404 links only to live v2 routes: the app's own nav (lib/ui/navEntries.ts) plus Docs and Legal, never
 * the v1 per-market /<ticker>/account and /<ticker>/book pages it used to send readers to. Rendered with
 * react-dom/server in vitest's node environment, as the component tests are.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { V2_NAV_ENTRIES } from "@/lib/ui/navEntries";
import NotFound from "./not-found";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("404 page", () => {
  const out = renderToStaticMarkup(createElement(NotFound));
  const links = hrefs(out);
  const expected = [...V2_NAV_ENTRIES.map((e) => e.href), "/docs", "/legal"];

  it("lists every nav destination, then Docs and Legal, and nothing else", () => {
    expect(new Set(links)).toEqual(new Set(expected));
    for (const entry of V2_NAV_ENTRIES) expect(out).toContain(`>${entry.label}<`);
  });

  it("renders no v1 per-market account or book link", () => {
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).not.toMatch(/\/(account|book)$/);
  });
});
