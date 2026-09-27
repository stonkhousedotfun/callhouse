/**
 * The "When you get paid" block renders the module's answer (lib/v2/payoutTiming.ts) and nothing of its own:
 * the headline, the time in ET (plus the reader's zone once mounted), the self-serve route and the unhappy path, all
 * visible, none behind a tooltip. Rendered with react-dom/server in vitest's node environment, as the other
 * component tests here are.
 */
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buyCallTiming, earnVaultRedeemTiming, ledgerWithdrawTiming, restingOrderTiming, sellCallTiming, zapTiming } from "@/lib/v2/payoutTiming";
import { PayoutTiming, PayoutTimingNote, initialPayoutClock, payoutWhen, startPayoutClock, whenLabel } from "./PayoutTiming";

const EXPIRY = 1_790_366_400; // 2026-09-25 20:00:00Z, a 4 pm ET close
const NOW = EXPIRY - 3_600;

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("PayoutTimingNote", () => {
  it("renders the module's headline, the ET time, the self-serve route and the unhappy path; no title tooltip", () => {
    const t = buyCallTiming({ expiry: EXPIRY, now: NOW });
    const out = html(createElement(PayoutTimingNote, { timing: t }));
    expect(out).toContain("When you get paid");
    expect(out).toContain(t.headline.replace(/'/g, "&#x27;"));
    expect(out).toContain(`Usually by <span class="font-semibold text-ink">${t.whenEt}</span>`);
    expect(out).toContain(t.selfServe!.replace(/'/g, "&#x27;"));
    expect(out).toContain(t.unhappy.split(".")[0]);
    expect(out).toContain('data-payout-timing="buy-call"');
    expect(out).toContain('data-arrival="automatic"');
    expect(out).not.toContain("title=");
  });

  it("an immediate path with no clock says so and prints no time line", () => {
    const t = sellCallTiming({ expiry: EXPIRY, now: NOW, writes: false });
    expect(whenLabel(t)).toBe("From");
    const zap = zapTiming(NOW);
    const out = html(createElement(PayoutTimingNote, { timing: zap }));
    expect(out).toContain("The swap pays you in the same transaction");
    expect(out).toContain('data-arrival="immediate"');
  });

  it("the reader's zone is added, named, only when a zone is given (after mount); never on the server render", () => {
    const t = buyCallTiming({ expiry: EXPIRY, now: NOW });
    expect(html(createElement(PayoutTimingNote, { timing: t }))).not.toContain("your time");
    const tokyo = html(createElement(PayoutTimingNote, { timing: t, localZone: "Asia/Tokyo" }));
    expect(tokyo).toMatch(/your time Sep 26, 2026, 5:0\d AM GMT\+9/);
  });

  it("a late payment says it is late", () => {
    const late = earnVaultRedeemTiming({ now: EXPIRY + 86_400, positionOpen: true, queueOpen: true, openExpiry: EXPIRY });
    expect(late.late).toBe(true);
    const out = html(createElement(PayoutTimingNote, { timing: late }));
    expect(out).toContain("Running late");
    expect(out).toContain('data-late="true"');
  });

  it("null renders nothing", () => {
    expect(html(createElement(PayoutTimingNote, { timing: null }))).toBe("");
  });
});

describe("PayoutTiming (the mounted form)", () => {
  it("calls `of` with the pinned clock and renders its answer; server render carries no local zone", () => {
    const seen: number[] = [];
    const out = html(createElement(PayoutTiming, { now: NOW, of: (now: number) => (seen.push(now), buyCallTiming({ expiry: EXPIRY, now })) }));
    expect(seen).toEqual([NOW]);
    expect(out).toContain('data-payout-timing="buy-call"');
    expect(out).not.toContain("your time");
  });

  it("`of` returning null renders nothing", () => {
    expect(html(createElement(PayoutTiming, { now: NOW, of: () => null }))).toBe("");
  });
});

/**
 * A static page is prerendered at BUILD time and hydrated at READ time. Anything the first render derives from
 * the wall clock differs between the two, React throws #418 and re-renders the tree on the client, and that re-render
 * drops the `data-theme` the pre-paint script set (/lend ignored the stored theme). A render that runs no effects is both
 * the server render and the first client render, so two such renders at two wall-clock times must be byte-identical.
 */
describe("no wall clock before mount", () => {
  afterEach(() => vi.restoreAllMocks());

  const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);
  const T1 = NOW * 1_000; // the static prerender (build time)
  const T2 = (NOW + 13 * 60) * 1_000; // the reader's first client render, 13 minutes later

  it("the server render at T1 and the first client render at T2 are identical, with no Date.now-derived text", () => {
    const seen: number[] = [];
    const el = () => createElement(PayoutTiming, { of: (now: number) => (seen.push(now), zapTiming(now)) });
    at(T1);
    const server = renderToString(el());
    at(T2);
    const client = renderToString(el());
    expect(client).toBe(server);
    expect(server).not.toContain(zapTiming(NOW).whenEt!);
    expect(seen).toEqual([]);
  });

  it("a `now` pinned by the caller still renders at once and ignores the wall clock, as before", () => {
    at(T2);
    const seen: number[] = [];
    const out = html(createElement(PayoutTiming, { now: NOW, of: (now: number) => (seen.push(now), zapTiming(now)) }));
    expect(seen).toEqual([NOW]);
    expect(out).toContain(zapTiming(NOW).whenEt!);
  });

  it("before mount the clock is the pinned value, else null, never the wall clock", () => {
    at(T2);
    expect(initialPayoutClock(NOW)).toBe(NOW);
    expect(initialPayoutClock(0)).toBe(0);
    expect(initialPayoutClock(undefined)).toBeNull();
  });

  it("after mount the clock reads the wall clock once at once, then once a minute, and stops on cleanup", () => {
    const fake = { ms: T1, tick: () => {}, period: 0, stopped: false };
    const set: number[] = [];
    const stop = startPayoutClock((now) => set.push(now), {
      now: () => fake.ms,
      every: (fn, ms) => {
        fake.tick = fn;
        fake.period = ms;
        return () => { fake.stopped = true; };
      },
    });
    expect(set).toEqual([NOW]);
    expect(fake.period).toBe(60_000);
    fake.ms = T2 + 999; // whole seconds only
    fake.tick();
    expect(set).toEqual([NOW, NOW + 13 * 60]);
    stop();
    expect(fake.stopped).toBe(true);
  });
});

describe("the visible answer is only the date", () => {
  it("a settlement payout shows its market date, and the sentence moves behind the ?", () => {
    const t = buyCallTiming({ expiry: EXPIRY, now: NOW });
    expect(payoutWhen(t)).toBe("09/25/2026");
    const out = renderToStaticMarkup(createElement(PayoutTimingNote, { timing: t }));
    expect(out).toMatch(/data-slot="payout-when"[^>]*>09\/25\/2026</);
    expect(out).toContain('role="tooltip"');
  });

  it("money that moves in the same transaction says Right away; an order that waits says When it fills", () => {
    expect(payoutWhen(ledgerWithdrawTiming(NOW))).toBe("Right away");
    expect(payoutWhen(restingOrderTiming({ kind: "ask", validUntil: NOW + 86_400, now: NOW }))).toBe("When it fills");
  });
});
