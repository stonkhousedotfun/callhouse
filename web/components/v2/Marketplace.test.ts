/**
 * UX review item 9: the hero fallback banner conflated two states.
 *
 * It read "live quotes are unavailable OR no option has enough depth", which asks the reader to
 * disambiguate a FAILURE from an EMPTY BOOK. Those call for different responses — "come back in
 * a minute" versus "there is genuinely nothing to feature right now" — and a reader who cannot
 * tell them apart assumes the worse one. Both states were already distinguishable in the data
 * (`hero.isError`) and nothing was reading it.
 */
import { describe, expect, it } from "vitest";

import { heroFallbackReason } from "./Marketplace";

describe("the hero fallback says which state it is in", () => {
  it("a failed request says so, and says what is unaffected", () => {
    const failed = heroFallbackReason(true);
    expect(failed).toContain("could not be loaded");
    expect(failed).toContain("unaffected");
  });

  it("an empty book says THAT, and does not imply a failure", () => {
    const empty = heroFallbackReason(false);
    expect(empty).toContain("enough depth");
    expect(empty).not.toContain("could not be loaded");
  });

  it("the two sentences differ — the control, since one shared string would pass both above", () => {
    expect(heroFallbackReason(true)).not.toBe(heroFallbackReason(false));
  });

  it("neither sentence makes the reader disambiguate with an 'or'", () => {
    // The exact defect: one sentence offering two explanations.
    for (const failed of [true, false]) {
      expect(heroFallbackReason(failed)).not.toMatch(/unavailable or|or no option/i);
    }
  });
});
