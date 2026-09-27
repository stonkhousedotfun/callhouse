/**
 * <Time> server-renders New York (the server cannot know the reader's zone) and shows the reader's zone after
 * mount. Rendered with react-dom/server in vitest's node environment, as the other component tests here are; the
 * after-mount text is `timeText` with the browser's zone, tested directly with explicit zones.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { Time, timeText, viewerTimeZone, type TimeProps } from "./Time";

/** 2026-09-24 20:00Z: 4:00 PM EDT, 1:00 PM PDT, 5:00 AM on the 25th in Tokyo. */
const T = Date.UTC(2026, 8, 24, 20, 0, 0) / 1000;
const savedTz = process.env.TZ;

afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("<Time> server render", () => {
  it("renders New York, zone named, whatever zone the server process is in", () => {
    // The forbidden fix is formatting in the process's zone during the server render (UTC on Railway). Put this
    // process in Los Angeles: the server markup must still say New York.
    process.env.TZ = "America/Los_Angeles";
    const html = renderToStaticMarkup(createElement(Time, { at: T }));
    expect(html).toBe('<time dateTime="2026-09-24T20:00:00.000Z">Sep 24, 4:00 PM EDT</time>');
  });

  it("a market time on the server is New York once, and a day is New York's day", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(renderToStaticMarkup(createElement(Time, { at: T, market: true }))).toContain(">Sep 24, 4:00 PM EDT<");
    expect(renderToStaticMarkup(createElement(Time, { at: T, dateOnly: true, className: "x" })))
      .toBe('<time dateTime="2026-09-24T20:00:00.000Z" class="x">Sep 24, 2026</time>');
  });
});

describe("<Time> after mount (timeText with the browser's zone)", () => {
  it("shows the reader's zone, named, plus the ET time for a market deadline", () => {
    expect(timeText({ at: T }, "America/Los_Angeles")).toBe("Sep 24, 1:00 PM PDT");
    expect(timeText({ at: T, market: true }, "America/Los_Angeles")).toBe("Sep 24, 1:00 PM PDT (4:00 PM ET)");
    expect(timeText({ at: T, dateOnly: true }, "Asia/Tokyo")).toBe("Sep 25, 2026");
  });

  it("falls back to New York while the zone is unknown", () => {
    expect(timeText({ at: T }, null)).toBe("Sep 24, 4:00 PM EDT");
    expect(timeText({ at: T, market: true }, null)).toBe("Sep 24, 4:00 PM EDT");
  });

  it("reads the zone the runtime reports", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(viewerTimeZone()).toBe("Asia/Tokyo");
    process.env.TZ = "America/Los_Angeles";
    expect(viewerTimeZone()).toBe("America/Los_Angeles");
  });

  it("a day-only time cannot also be a market time (tsc --noEmit checks this file)", () => {
    // @ts-expect-error dateOnly and market are exclusive
    const props: TimeProps = { at: T, dateOnly: true, market: true };
    expect(props.at).toBe(T);
  });
});
