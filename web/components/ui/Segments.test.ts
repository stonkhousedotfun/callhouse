/**
 * The promoted segmented control (UX review item 7).
 *
 * WHAT MATTERS HERE is not that it renders — it is that the ONE control now used in five places
 * keeps the contract the raw `<button>` sites had: a labelled `role="group"`, `aria-pressed` on
 * every option, exactly one pressed at a time. The review lists those aria attributes among the
 * things this app already does better than most dapps, so consolidating the appearance must not
 * cost the semantics.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Segments } from "./Segments";

const options = [
  { value: "all", label: "All expiries" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const;

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Segments as never, { label: "Expiry type", options, onSelect: () => undefined, ...props }));

describe("Segments", () => {
  it("is a labelled group — the control for every assertion below", () => {
    const html = render({ selected: "all" });
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Expiry type"');
    expect(html).toContain("All expiries");
  });

  it("marks exactly one option pressed, and it is the selected one", () => {
    const html = render({ selected: "daily" });
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(2);
    // Positional check: the pressed one is Daily, not just "one of them".
    const pressed = html.slice(html.indexOf('aria-pressed="true"'));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain("Daily");
  });

  it("changing the selection moves the pressed state — the control for the test above", () => {
    // Without this, a component that hardcoded the first option as pressed would pass.
    const weekly = render({ selected: "weekly" });
    const pressed = weekly.slice(weekly.indexOf('aria-pressed="true"'));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain("Weekly");
  });

  it("wraps by default and scrolls only when asked", () => {
    expect(render({ selected: "all" })).toContain("flex-wrap");
    const scrolling = render({ selected: "all", scroll: true });
    expect(scrolling).toContain("overflow-x-auto");
    expect(scrolling).not.toContain("flex-wrap");
    expect(scrolling).toContain("shrink-0");
  });

  it("disables every option together, for a form that is mid-submit", () => {
    // Count the ATTRIBUTE, not the word: Button's class list carries
    // `disabled:cursor-not-allowed disabled:opacity-60`, so a bare /disabled/ matches three times
    // per button and the count silently becomes meaningless.
    const html = render({ selected: "all", disabled: true });
    expect(html.match(/ disabled=""/g)?.length).toBe(options.length);
    expect(render({ selected: "all" }).match(/ disabled=""/g)).toBeNull();
  });
});
