/** StatusPill: the closed four-word vocabulary of the Market status page, with the word always printed. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { STATUS_LABEL, StatusPill, type MarketStatus } from "./StatusPill";

const html = (status: MarketStatus) => renderToStaticMarkup(createElement(StatusPill, { status }));

describe("StatusPill", () => {
  it("has exactly the spec's four words", () => {
    expect(Object.values(STATUS_LABEL)).toEqual(["Live", "Coming soon", "Paused", "Deferred"]);
  });

  it.each([
    ["live", "Live", "bg-accent-soft"],
    ["soon", "Coming soon", "bg-warn-soft"],
    ["paused", "Paused", "bg-warn-soft"],
    ["deferred", "Deferred", "bg-surface-2"],
  ] as const)("%s prints %s on %s", (status, word, ground) => {
    const out = html(status);
    expect(out).toContain(`>${word}</span>`);
    expect(out).toContain(ground);
    expect(out).toContain(`data-status="${status}"`);
  });
});
