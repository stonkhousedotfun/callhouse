/** SectionHead: heading level, id wiring, eyebrow spacing, and the intro column only when there is an intro. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SectionHead } from "./SectionHead";

const render = (props: Parameters<typeof SectionHead>[0]) => renderToStaticMarkup(createElement(SectionHead, props));

describe("SectionHead", () => {
  it("defaults to an h2 with the section size and a single column", () => {
    const html = render({ title: "How it works", id: "how" });
    expect(html).toMatch(/<h2 id="how"[^>]*>How it works<\/h2>/);
    expect(html).toContain("clamp(30px,3.6vw,44px)");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("lg:grid-cols-");
    expect(html, "no eyebrow, no top margin on the heading").not.toContain("mt-3");
    expect(html).not.toContain("max-w-[36em]");
  });

  it("level 1 is the page h1 with the larger size", () => {
    const html = render({ title: "Risks", level: 1 });
    expect(html).toMatch(/<h1[^>]*>Risks<\/h1>/);
    expect(html).toContain("clamp(36px,4.8vw,56px)");
    expect(html).not.toContain("<h2");
  });

  it("an eyebrow renders above the heading and pushes it down", () => {
    const html = render({ title: "T", eyebrow: "Step 1" });
    expect(html).toContain(">Step 1</p>");
    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("<h2"));
    expect(html).toMatch(/<h2 class="[^"]*mt-3/);
  });

  it("a string intro is wrapped in <p> and switches on the two-column grid", () => {
    const html = render({ title: "T", intro: "Read this.", className: "extra" });
    expect(html).toContain("lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]");
    expect(html).toContain('<div class="max-w-[36em] text-[17.5px] text-ink-2"><p>Read this.</p></div>');
    expect(html).toContain("extra");
  });

  it("a JSX intro is rendered as given, not wrapped", () => {
    const html = render({ title: "T", intro: createElement("ul", null, createElement("li", null, "a")) });
    expect(html).toContain('text-ink-2"><ul><li>a</li></ul></div>');
    expect(html).not.toContain("<p><ul>");
  });
});
