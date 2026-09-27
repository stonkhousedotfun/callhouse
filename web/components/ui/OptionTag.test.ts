/** OptionTag: Call on accent-soft, Put on danger-soft, and the word is always there. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OptionTag } from "./OptionTag";

const html = (isPut: boolean) => renderToStaticMarkup(createElement(OptionTag, { isPut }));

describe("OptionTag", () => {
  it("a call reads Call, on --accent-soft with --accent-text", () => {
    const out = html(false);
    expect(out).toContain(">Call</span>");
    expect(out).toContain("bg-accent-soft");
    expect(out).toContain("text-accent-text");
  });

  it("a put reads Put, on --danger-soft with --danger-text", () => {
    const out = html(true);
    expect(out).toContain(">Put</span>");
    expect(out).toContain("bg-danger-soft");
    expect(out).toContain("text-danger-text");
    expect(out).not.toContain("accent");
  });
});
