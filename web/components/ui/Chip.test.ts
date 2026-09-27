/**
 * Chip. The danger tone moved from `bg-danger/10` to the palette's own --danger-soft / --danger-text
 * pair (the Neon theme retires the opacity tint).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chip } from "./Chip";

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Chip as never, props, "Halted"));

describe("Chip", () => {
  it("danger uses --danger-soft and --danger-text, not the retired opacity tint", () => {
    const out = html({ tone: "danger" });
    expect(out).toContain("bg-danger-soft");
    expect(out).toContain("text-danger-text");
    expect(out).not.toContain("bg-danger/10");
  });

  it("each tone is distinct -- the control for the assertion above", () => {
    const tones = ["neutral", "accent", "warn", "usdg", "danger"].map((tone) => html({ tone }));
    expect(new Set(tones).size).toBe(tones.length);
  });

  it("is a pill, and the dot is decorative", () => {
    const out = html({ dot: true });
    expect(out).toContain("rounded-pill");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("Halted");
  });
});
