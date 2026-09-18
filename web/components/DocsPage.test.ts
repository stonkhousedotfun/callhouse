import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import DocsPage from "@/app/docs/page";
import { Footer } from "@/components/Footer";

afterEach(() => vi.unstubAllEnvs());

describe("the docs entry page", () => {
  it("separates v2 paths from the legacy v1 account guide", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    const html = renderToStaticMarkup(createElement(DocsPage));
    expect(html).toContain("Current v2");
    expect(html).toContain('href="/earn"');
    expect(html).toContain('href="/portfolio"');
    expect(html).toContain("Expiry does not itself complete settlement");
    expect(html).toContain("Legacy v1 documentation");
    expect(html).toContain("Legacy v1 accounts and calls");
    expect(html).toContain('href="/legacy/nvda/account"');
    expect(html).toContain("The legacy v1 market");
    expect(html).not.toContain("The live market");

    const footer = renderToStaticMarkup(createElement(Footer));
    expect(footer).toContain('href="/docs"');
    expect(footer).not.toContain("docs.stonkhouse.fun");
  });

  it("shows the native account and live market in the v1 shell", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "0");
    const html = renderToStaticMarkup(createElement(DocsPage));
    expect(html).toContain('href="/nvda/account"');
    expect(html).toContain("Current v1 accounts and calls");
    expect(html).toContain("The live market");
    expect(html).not.toContain("Legacy v1");
    expect(html).not.toContain('href="/earn"');

    const footer = renderToStaticMarkup(createElement(Footer));
    expect(footer).toContain("docs.stonkhouse.fun");
  });
});
