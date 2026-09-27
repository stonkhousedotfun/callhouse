import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThemeToggle, ThemeToggleButton } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("in night mode offers day, with the sun icon, and a 44px target", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggleButton, { theme: "night", onToggle: vi.fn() }));
    expect(html).toContain('aria-label="Switch to day mode"');
    expect(html).toContain('type="button"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
    expect(html).toContain("<circle"); // the sun
  });
  it("in day mode offers night, with the moon icon", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggleButton, { theme: "day", onToggle: vi.fn() }));
    expect(html).toContain('aria-label="Switch to night mode"');
    expect(html).not.toContain("<circle");
  });
  it("the stateful toggle server-renders a working button before it has read the page", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle));
    expect(html).toContain("<button");
    expect(html).toMatch(/aria-label="Switch to (day|night) mode"/);
  });
});
