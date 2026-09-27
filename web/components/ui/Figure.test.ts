/** Num and Figure: the unit is a muted <small> after a space, tone/size/boxed/caps/mono each map to their classes. */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Figure, Num } from "./Figure";

const UNIT = '<small class="text-[0.625em] font-medium tracking-normal text-ink-3">USDG</small>';

type NumP = ComponentProps<typeof Num>;

describe("Num", () => {
  it("renders the figure with a spaced muted unit and the tone class", () => {
    const html = renderToStaticMarkup(createElement(Num, { unit: "USDG", tone: "usdg" } as NumP, "225.00"));
    expect(html).toBe(`<span class="num text-usdg">225.00 ${UNIT}</span>`);
  });

  it("no unit and no tone: just the number", () => {
    expect(renderToStaticMarkup(createElement(Num, { className: "x" } as NumP, "1"))).toBe('<span class="num x">1</span>');
  });

  it.each([
    ["ink", "text-ink"],
    ["ink-2", "text-ink-2"],
    ["accent", "text-accent-text"],
  ] as const)("tone %s maps to %s", (tone, cls) => {
    expect(renderToStaticMarkup(createElement(Num, { tone } as NumP, "1"))).toContain(`class="num ${cls}"`);
  });
});

describe("Figure", () => {
  it("default: md size, mono, dt/dd pair, not boxed", () => {
    const html = renderToStaticMarkup(createElement(Figure, { label: "Launch cap", value: "20 NVDA" }));
    expect(html).toBe(
      '<div class="grid content-start gap-1"><dt class="text-ink-3 text-[13px]">Launch cap</dt>' +
        '<dd class="font-semibold text-[17px] leading-[1.3] num">20 NVDA</dd></div>',
    );
  });

  it("boxed lg with a unit and tone", () => {
    const html = renderToStaticMarkup(
      createElement(Figure, { label: "Strike", value: "225.00", unit: "USDG", boxed: true, size: "lg", tone: "accent" }),
    );
    expect(html).toContain("rounded-md bg-surface-2 p-3.5");
    expect(html).toContain('<dt class="text-ink-3 text-[12.5px]">Strike</dt>');
    expect(html).toContain('<dd class="font-semibold text-[20px] leading-[1.2] num text-accent-text">225.00 ' + UNIT + "</dd>");
  });

  it("caps sm words (mono off): uppercase label, no num class", () => {
    const html = renderToStaticMarkup(
      createElement(Figure, { label: "Premium", value: "None", caps: true, mono: false, size: "sm", className: "c" }),
    );
    expect(html).toContain('<dt class="text-ink-3 text-[12.5px] font-semibold uppercase tracking-[0.06em]">Premium</dt>');
    expect(html).toContain('<dd class="font-semibold text-[15px] leading-[1.35]">None</dd>');
    expect(html).toContain('class="grid content-start gap-1 c"');
  });
});
