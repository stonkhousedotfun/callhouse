/**
 * DayPicker. The option list is lib/ui/dayPicker.ts's and is pinned there; this proves the component
 * renders it with the Segments contract (labelled group, exactly one aria-pressed) and both label widths.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DayPicker } from "./DayPicker";

const close = (day: number) => Date.UTC(2026, 8, day, 20, 0, 0) / 1000;
const NOW = Date.UTC(2026, 8, 22, 14, 0, 0) / 1000; // Tue 22 Sep 2026, 10:00 EDT

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(DayPicker, {
  expiries: [close(22), close(23), close(24)], now: NOW, selected: close(23), onSelect: () => undefined, ...props,
} as never));

describe("DayPicker", () => {
  it("is a labelled group of the listed days", () => {
    const out = html({});
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Expiry day"');
    expect(out.match(/<button/g)).toHaveLength(3);
  });

  it("prints 'Wed 23' from 640px and 'Wed' on a phone", () => {
    const out = html({});
    expect(out).toContain('<span class="max-sm:hidden">Wed 23</span>');
    expect(out).toContain('<span class="sm:hidden">Wed</span>');
    expect(out).toContain('<span class="max-sm:hidden">Today</span>');
  });

  it("presses exactly the selected day, in the inverted select look", () => {
    const out = html({});
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    const pressed = out.slice(out.lastIndexOf("<button", out.indexOf('aria-pressed="true"')));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain("Wed 23");
    expect(pressed).toContain("bg-select-bg");
  });

  it("moving the selection moves the press -- the control for the test above", () => {
    const out = html({ selected: close(24) });
    const pressed = out.slice(out.lastIndexOf("<button", out.indexOf('aria-pressed="true"')));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain("Thu 24");
  });

  it("names each chip by its full New York time", () => {
    expect(html({})).toContain('aria-label="Sep 23, 2026, 4:00 PM EDT"');
  });

  // The phone read "Today · Thu · Fri · Fri". Thu 24, Fri 25 and Fri 2 Oct at 4pm New York.
  it("never prints the same phone tab for two different days", () => {
    const out = html({ expiries: [close(22), close(24), close(25), Date.UTC(2026, 9, 2, 20, 0, 0) / 1000], selected: null });
    const phone = [...out.matchAll(/<span class="sm:hidden">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(phone).toEqual(["Today", "Thu", "Fri 25", "Fri 2"]);
  });

  it("renders nothing when nothing is listed, leaving the empty state to the screen", () => {
    expect(html({ expiries: [] })).toBe("");
    expect(html({ expiries: [close(21)] })).toBe("");
  });
});

describe("DayPicker: resale-only days", () => {
  it("marks a day past its mint cutoff from 640px and names it in the accessible label", () => {
    const out = html({ resaleOnly: [close(22)] });
    expect(out.match(/data-slot="resale-only"/g) ?? []).toHaveLength(1);
    expect(out).toContain("resale asks and bids only");
    expect(out).toMatch(/max-sm:hidden[^"]*" data-slot="resale-only"> · resale</);
  });

  it("marks nothing without the prop", () => {
    expect(html({})).not.toContain('data-slot="resale-only"');
  });
});
