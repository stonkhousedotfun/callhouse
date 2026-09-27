/**
 * Card / Panel. Neon outlines cards with --line-2, and a lifted card keeps that outline because night
 * mode has no shadows (--elevation-lift is `none` there).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Card, Panel } from "./Panel";

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Card, { children: "x", ...props } as never));

describe("Card", () => {
  it("is Panel", () => {
    expect(Card).toBe(Panel);
  });

  it("is a 22px-radius surface outlined in --line-2", () => {
    const out = html({});
    expect(out).toContain('data-slot="card"');
    expect(out).toContain("rounded-lg");
    expect(out).toContain("border-line-2");
    expect(out).not.toMatch(/border-line(?!-2)/);
  });

  it("a lifted card keeps its outline and adds the shadow", () => {
    const out = html({ lift: true });
    expect(out).toContain("border-line-2");
    expect(out).toContain("shadow-lift");
    expect(html({})).not.toContain("shadow-lift");
  });
});
