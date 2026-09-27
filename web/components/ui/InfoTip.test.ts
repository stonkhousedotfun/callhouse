/**
 * InfoTip: the server markup. The open/close timing is lib/ui/infoTip.test.ts; this checks what every
 * reader gets before any script runs: a real button with a name, the explanation already in the page and wired to the
 * button for screen readers, hidden until opened, and a bubble that cannot block a click.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InfoTip } from "./InfoTip";
import { CardTitle } from "./Panel";

const html = (props: Record<string, unknown>, child?: string) => renderToStaticMarkup(createElement(InfoTip as never, props, child));

describe("InfoTip", () => {
  it("is a named button whose aria-describedby is the hidden explanation", () => {
    const out = html({ text: "Paid in USDG when the vault settles." });
    expect(out).toMatch(/<button type="button" aria-label="More info" aria-describedby="([^"]+)" aria-expanded="false"/);
    const id = /aria-describedby="([^"]+)"/.exec(out)![1];
    expect(out).toContain(`role="tooltip" id="${id}" hidden=""`);
    expect(out).toContain("Paid in USDG when the vault settles.");
    expect(out).toContain('<span aria-hidden="true">?</span>');
  });

  it("takes children as the text and a custom accessible name", () => {
    const out = html({ label: "About payouts" }, "Daily, in USDG.");
    expect(out).toContain('aria-label="About payouts"');
    expect(out).toContain("Daily, in USDG.");
  });

  it("the bubble takes no pointer events and sits above the icon, so it never covers the card's action", () => {
    const out = html({ text: "x" });
    const bubble = /<span role="tooltip"[^>]*class="([^"]+)"/.exec(out)![1];
    expect(bubble).toContain("pointer-events-none");
    expect(bubble).toContain("bottom-full");
  });

  it("demonstration: beside a card title", () => {
    const out = renderToStaticMarkup(createElement(CardTitle as never, null, "House vault ", createElement(InfoTip, { text: "A vault that sells covered calls daily." })));
    expect(out).toContain("House vault");
    expect(out).toContain('aria-label="More info"');
    expect(out).toContain("A vault that sells covered calls daily.");
  });
});
