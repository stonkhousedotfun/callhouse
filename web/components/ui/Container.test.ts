/**
 * Page layout, Neon: a 1280px artboard is 1200px of content inside 40px gutters, split
 * a flexible main column + 40px gap + a 300-380px rail. Phone gutters are 16px, 20px from 640px.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Container, RailLayout, Section } from "./Container";

describe("Container", () => {
  it("is 1200px of content with 16/20/40px gutters", () => {
    const out = renderToStaticMarkup(createElement(Container, null, "x"));
    expect(out).toContain("max-w-[1200px]");
    expect(out).toContain("box-content");
    expect(out).toContain("px-4");
    expect(out).toContain("sm:px-5");
    expect(out).toContain("lg:px-10");
    expect(out).not.toContain("1160");
  });

  it("Section uses the same column and gutters", () => {
    const out = renderToStaticMarkup(createElement(Section, null, "x"));
    expect(out).toContain("max-w-[1200px]");
    expect(out).toContain("lg:px-10");
  });
});

describe("RailLayout", () => {
  const out = renderToStaticMarkup(createElement(RailLayout, { main: "MAIN", rail: "RAIL", railLabel: "Order ticket" }));

  it("puts the main column beside a 300-380px rail from 1024px, with a 40px gap", () => {
    expect(out).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]");
    expect(out).toContain("lg:gap-10");
  });

  it("renders main before rail, so the phone stack reads main first", () => {
    expect(out.indexOf("MAIN")).toBeLessThan(out.indexOf("RAIL"));
    expect(out).toContain('data-slot="main-column"');
    expect(out).toMatch(/<aside data-slot="rail" aria-label="Order ticket"/);
  });
});
