/**
 * lib/ui/infoTip.ts: when the "?" opens. The rule is "over it for more than 1 second"; the rest
 * (tap, keyboard, Escape) is what makes that usable on a phone and without a mouse. Runs on vitest's fake timers,
 * through the controller's default (real setTimeout) wiring, not a stand-in scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INFO_TIP_DELAY_MS, createInfoTipController } from "./infoTip";

let changes: boolean[];
const make = () => createInfoTipController((open) => changes.push(open));

beforeEach(() => { vi.useFakeTimers(); changes = []; });
afterEach(() => { vi.useRealTimers(); });

describe("hover", () => {
  it("opens only after the pointer has rested for 1 second", () => {
    expect(INFO_TIP_DELAY_MS).toBe(1000);
    const t = make();
    t.pointerEnter("mouse");
    vi.advanceTimersByTime(999);
    expect(t.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.isOpen()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("is cancelled when the pointer leaves first", () => {
    const t = make();
    t.pointerEnter("mouse");
    vi.advanceTimersByTime(600);
    t.pointerLeave("mouse");
    vi.advanceTimersByTime(5000);
    expect(t.isOpen()).toBe(false);
    expect(changes).toEqual([]);
  });

  it("closes when the pointer leaves after it opened", () => {
    const t = make();
    t.pointerEnter("pen");
    vi.advanceTimersByTime(1000);
    t.pointerLeave("pen");
    expect(changes).toEqual([true, false]);
  });

  it("a second enter while waiting does not restart or double the timer", () => {
    const t = make();
    t.pointerEnter("mouse");
    vi.advanceTimersByTime(700);
    t.pointerEnter("mouse");
    vi.advanceTimersByTime(300);
    expect(t.isOpen()).toBe(true);
    expect(changes).toEqual([true]);
  });
});

describe("tap", () => {
  it("toggles at once, and a finger never starts the hover timer", () => {
    const t = make();
    t.pointerEnter("touch");
    vi.advanceTimersByTime(2000);
    expect(t.isOpen()).toBe(false);
    t.press();
    expect(t.isOpen()).toBe(true);
    t.pointerLeave("touch");
    expect(t.isOpen()).toBe(true);
    t.press();
    expect(t.isOpen()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("a click during the hover wait opens now and the timer does not fire a second change", () => {
    const t = make();
    t.pointerEnter("mouse");
    t.press();
    vi.advanceTimersByTime(2000);
    expect(changes).toEqual([true]);
    t.pointerLeave("mouse");
    expect(t.isOpen()).toBe(true);
  });
});

describe("keyboard", () => {
  it("keyboard focus opens at once; focus that came with a press does not", () => {
    const k = make();
    k.focus(true);
    expect(k.isOpen()).toBe(true);
    const p = make();
    p.focus(false);
    expect(p.isOpen()).toBe(false);
  });

  it("Escape closes it and cancels a pending hover", () => {
    const t = make();
    t.focus(true);
    t.escape();
    expect(t.isOpen()).toBe(false);
    t.pointerEnter("mouse");
    vi.advanceTimersByTime(500);
    t.escape();
    vi.advanceTimersByTime(1000);
    expect(t.isOpen()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("blur closes it", () => {
    const t = make();
    t.press();
    t.blur();
    expect(changes).toEqual([true, false]);
  });
});

it("dispose clears a pending hover, so an unmounted tip never calls back", () => {
  const t = make();
  t.pointerEnter("mouse");
  t.dispose();
  vi.advanceTimersByTime(2000);
  expect(changes).toEqual([]);
});
