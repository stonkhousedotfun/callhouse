/**
 * UX review item 6, the chrome half: the mobile link row faded its overflow behind a mask while
 * also suppressing the scrollbar, so on a phone Trust and Wins were not merely hard to reach but
 * invisible — and nothing on screen said anything was hidden.
 *
 * AUTHORED, NOT RUN — this worktree is not hydrated (vitest and tsc both exit 127).
 *
 * This is a source assertion because the defect IS the class list: there is no behaviour to
 * render, and jsdom does not lay out a scroll container or evaluate a mask.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./Nav.tsx", import.meta.url)), "utf8");

/**
 * The nav's own class attribute, isolated.
 *
 * The first version of this file grepped the WHOLE SOURCE for an unprefixed
 * `[scrollbar-width:none]` and went red against the explanatory comment that quotes the very
 * class it was asserting about. Searching a file for a string that the file legitimately
 * discusses is its own small false-positive; the assertion has to look at the class list.
 */
const navClass = (() => {
  const at = source.indexOf('aria-label="App"');
  const open = source.indexOf('className="', at);
  return source.slice(open, source.indexOf('"', open + 'className="'.length) + 1);
})();

describe("the mobile nav says when there is more to see", () => {
  it("the source was actually read — the control", () => {
    expect(source).toContain('aria-label="App"');
    expect(source).toContain("overflow-x-auto");
  });

  it("does not suppress the scrollbar where the row actually overflows", () => {
    // The defect: `[scrollbar-width:none]` applied at every width, including the widths where
    // the row scrolls. It is now `lg:` only, where there is nothing hidden to disclose.
    expect(navClass, "the class attribute was located — the control").toContain("overflow-x-auto");
    expect(navClass).not.toMatch(/(^|\s)\[scrollbar-width:none\]/);
    expect(navClass).toContain("lg:[scrollbar-width:none]");
  });

  it("keeps the fade, which reads as 'more this way' once a scrollbar confirms it", () => {
    expect(navClass).toContain("max-lg:[mask-image:linear-gradient(to_right,#000_88%,transparent)]");
  });
});
