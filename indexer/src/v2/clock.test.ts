import { describe, expect, it } from "vitest";
import { orderExpiresAt, seriesStatusAt } from "../../lib/v2/clock";

describe("periodic v2 status", () => {
  it("moves open series through cutoff and expiry at the exact timestamp", () => {
    expect(seriesStatusAt("open", 100n, 200n, 99n)).toBe("open");
    expect(seriesStatusAt("open", 100n, 200n, 100n)).toBe("cutoff");
    expect(seriesStatusAt("cutoff", 100n, 200n, 200n)).toBe("expired");
    expect(seriesStatusAt("settling", 100n, 200n, 300n)).toBe("settling");
    expect(seriesStatusAt("held", 100n, 200n, 300n)).toBe("held");
    expect(seriesStatusAt("settled", 100n, 200n, 300n)).toBe("settled");
  });

  it("expires asks requiring fresh mint at cutoff, and all orders at their own deadline or expiry", () => {
    expect(orderExpiresAt("AskWrite", 190n, 100n, 200n, 100n)).toBe(true);
    expect(orderExpiresAt("AskResale", 190n, 100n, 200n, 100n)).toBe(false);
    expect(orderExpiresAt("Bid", 190n, 100n, 200n, 190n)).toBe(true);
    expect(orderExpiresAt("AskResale", 300n, 100n, 200n, 200n)).toBe(true);
  });
});
