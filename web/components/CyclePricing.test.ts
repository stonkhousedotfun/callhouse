/**
 * The keeper-reported
 * times on the cycle pricing card render through components/ui/Time.tsx: New York, zone named, in the server render
 * (the reader's zone is not known there), the reader's zone once mounted, and never a UTC line.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { reportedWhen } from "./CyclePricing";

/** 2026-09-15T05:57:42Z, the README record's chain timestamp (lib/cycleTerms.test.ts CHAIN_TS). */
const CHAIN_TS = 1_789_451_862;

describe("keeper-reported times on the cycle pricing card", () => {
  it("a known instant is a <time> in New York on the server, zone named, with no UTC line", () => {
    const html = renderToStaticMarkup(reportedWhen({ raw: "2026-09-15 05:57:42", ts: CHAIN_TS, eastern: "Tue 15 Sep, 1:57am EDT" }));
    expect(html).toBe('<time dateTime="2026-09-15T05:57:42.000Z" class="whitespace-nowrap">Sep 15, 1:57 AM EDT</time>');
    expect(html).not.toContain("UTC");
  });

  it("an instant whose zone is unknown is shown as reported, never converted", () => {
    const html = renderToStaticMarkup(reportedWhen({ raw: "2026-09-15 05:57:42", ts: undefined, eastern: "—" }));
    expect(html).toContain("2026-09-15 05:57:42");
    expect(html).toContain("as reported, zone unknown");
    expect(html).not.toContain("<time");
  });
});
