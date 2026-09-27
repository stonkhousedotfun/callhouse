/**
 * Button, Neon. The element choice by href is the old contract; the pill shape, the 44px md target and
 * the four named looks are the new one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, buttonClasses } from "./Button";

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Button as never, props, "Go"));

describe("Button", () => {
  it("is a pill at every size", () => {
    for (const size of ["md", "touch", "sm", "xs"] as const) expect(buttonClasses({ size })).toContain("rounded-pill");
  });

  // Header controls needed sm's look at 44px. A size of its own, so sm (every dense row) is untouched and
  // no call site stacks two min-heights for stylesheet order to settle.
  it("touch is sm's look at exactly one 44px min-height; sm keeps its own classes", () => {
    expect(buttonClasses({ size: "sm" })).toContain(" min-h-9 px-4 py-2 text-sm ");
    expect(buttonClasses({ size: "touch" })).toContain(" min-h-11 px-4 py-2 text-sm ");
    expect(buttonClasses({ size: "touch" }).match(/min-h-/g)).toHaveLength(1);
  });

  it("md is at least 44px tall, sm is not held to it", () => {
    expect(buttonClasses({ size: "md" })).toContain("min-h-11");
    expect(buttonClasses({ size: "sm" })).not.toContain("min-h-11");
  });

  it.each([
    ["primary", "bg-accent", "text-accent-ink"],
    ["secondary", "bg-surface-2", "border-line-2"],
    ["ghost", "bg-transparent", "border-line-2"],
    ["select", "bg-select-bg", "text-select-ink"],
    ["quiet", "bg-transparent", "text-ink-3"],
  ] as const)("%s carries its own tokens", (variant, a, b) => {
    const classes = buttonClasses({ variant });
    expect(classes).toContain(a);
    expect(classes).toContain(b);
  });

  it("the variants differ -- the control for the table above", () => {
    const all = (["primary", "secondary", "ghost", "inverse", "select", "quiet"] as const).map((variant) => buttonClasses({ variant }));
    expect(new Set(all).size).toBe(all.length);
  });

  it("renders a <button type=button> without href, a link with one", () => {
    expect(html({})).toMatch(/^<button type="button"/);
    expect(html({ href: "/wins" })).toMatch(/^<a [^>]*href="\/wins"/);
    const external = html({ href: "https://example.com" });
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noreferrer noopener"');
  });
});
