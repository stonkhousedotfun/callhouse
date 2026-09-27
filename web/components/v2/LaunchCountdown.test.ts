/**
 * The launch-gate UI has no clock. A market that is registered but not enabled, a House vault that is not
 * armed, and a failed chain read each render one static sentence, and every one of them keeps its controls off. The
 * launch gates are read through React Query; the mock hands the component what the chain would.
 */
import { useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchGates } from "@/lib/v2/launchGates";
import { HOUSE_ARMING_UNREAD, HouseArmNotice, LockedMarket, TRADING_UNREAD, houseNotQuoting, useHouseIndexGate } from "./LaunchCountdown";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));

const gates = (data: LaunchGates | undefined, isError = false) =>
  vi.mocked(useQuery).mockReturnValue({ data, isError } as unknown as ReturnType<typeof useQuery>);

afterEach(() => vi.mocked(useQuery).mockReset());

/** Nothing on a launch-gate surface may tick, count or name the Safe's schedule. */
function expectNoClock(html: string) {
  expect(html).not.toContain('role="timer"');
  expect(html).not.toMatch(/\d\d:\d\d:\d\d|--:--:--/);
  expect(html).not.toMatch(/quotes in|opens in|Admin Safe|schedul|execute/i);
}

const asRendered = (copy: string) => copy.replace(/'/g, "&#x27;");

describe("LockedMarket", () => {
  const locked = () => renderToStaticMarkup(
    createElement(LockedMarket, { ticker: "NVDA" } as Parameters<typeof LockedMarket>[0], createElement("button", null, "Buy")));

  it("not enabled: one static line, controls disabled, no clock", () => {
    gates({ trading: { NVDA: false }, house: {} });
    const html = locked();
    expect(html).toContain("NVDA is listed. Trading is not open yet.");
    expect(html).toContain("The buttons below stay off until it opens.");
    expect(html).toMatch(/<fieldset disabled=""/);
    expectNoClock(html);
  });

  it("a failed enabled read says so and keeps the controls off", () => {
    gates(undefined, true);
    const html = locked();
    expect(html).toContain(TRADING_UNREAD);
    expect(html).toMatch(/<fieldset disabled=""/);
    expectNoClock(html);
  });

  it("while unread it is still locked, with the not-enabled line", () => {
    gates(undefined);
    const html = locked();
    expect(html).toContain("NVDA is listed. Trading is not open yet.");
    expect(html).toMatch(/<fieldset disabled=""/);
    expectNoClock(html);
  });
});

describe("HouseArmNotice (the arming of the vault the deposit writes to)", () => {
  const notice = (armed: boolean | null | undefined, isError = false) =>
    renderToStaticMarkup(createElement(HouseArmNotice, { ticker: "NVDA", armed, isError }));

  it("not armed: the static not-quoting sentence, no clock", () => {
    const html = notice(false);
    expect(html).toContain(asRendered(houseNotQuoting("NVDA")));
    expect(html).toContain("Deposits open when it is.");
    expectNoClock(html);
  });

  it("a failed arming read (null, or the query errored) says deposits stay shut until it can be read", () => {
    for (const html of [notice(null), notice(undefined, true)]) {
      expect(html).toContain(HOUSE_ARMING_UNREAD);
      expectNoClock(html);
    }
  });

  it("while the arming is being read it stays up and says deposits stay shut", () => {
    const html = notice(undefined);
    expect(html).toContain("Checking whether the NVDA house vault is quoting. Deposits stay shut until it is.");
    expectNoClock(html);
  });

  it("says what still works in plain words, never the epoch roll", () => {
    for (const html of [notice(false), notice(null), notice(undefined)]) {
      expect(html).toContain("You can still ask to withdraw and claim.");
      expect(html).not.toMatch(/epoch/i);
    }
    // The read and not-armed lines say nothing about the chain; the unread line keeps HOUSE_ARMING_UNREAD, whose words
    // components/v2/VaultsOverview.test.ts pins (outside).
    for (const html of [notice(false), notice(undefined)]) expect(html).not.toMatch(/on chain|on-chain/i);
  });

  it("once the vault is armed the notice is gone", () => {
    expect(notice(true)).toBe("");
  });
});

describe("useHouseIndexGate (the /vaults House card)", () => {
  // useQuery is mocked, so the hook is a plain function here.
  it("opens only when the gates are read and every launch House vault is armed", () => {
    gates({ trading: {}, house: { NVDA: true, SPCX: true } });
    expect(useHouseIndexGate()).toEqual({ open: true, pending: [], isError: false });
    gates({ trading: {}, house: { NVDA: true, SPCX: false } });
    expect(useHouseIndexGate()).toEqual({ open: false, pending: ["SPCX"], isError: false });
  });

  it("stays shut while unread or errored", () => {
    gates(undefined);
    expect(useHouseIndexGate()).toEqual({ open: false, pending: null, isError: false });
    gates(undefined, true);
    expect(useHouseIndexGate()).toEqual({ open: false, pending: null, isError: true });
  });
});
