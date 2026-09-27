/**
 * PayoffChart's handlers, which a static render cannot fire: mouse drag with pointer capture, the touch axis lock
 * (a vertical swipe scrolls the page, a horizontal one drags, a tap selects), cancel, the keyboard, the range input,
 * the uncontrolled handle's own state (reset when the series changes) and the controlled `price` prop. React's
 * useState/useRef/useId are a slot stand-in while the component function is called directly; the slider's props are
 * then read from the returned tree. The pointer maps 1:1 onto the chart's view box (a rect CHART_VIEW.width wide).
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { costToBuy } from "@/lib/v2/payoff";
import {
  ARROW_STEP, CHART_VIEW, buildPayoffChart, defaultHandlePrice, priceAtRatio, type ChartInput,
} from "@/lib/v2/payoffChart";
import { PayoffChart } from "./PayoffChart";

const H = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  const slot = (init: () => unknown) => {
    const k = H.i++;
    if (!(k in H.slots)) H.slots[k] = init();
    return k;
  };
  return {
    ...real,
    useState: (init: unknown) => {
      const k = slot(() => init);
      return [H.slots[k], (v: unknown) => { H.slots[k] = v; }];
    },
    useRef: (init: unknown) => H.slots[slot(() => ({ current: init }))],
    useId: () => ":id:",
  };
});

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}

const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const NOW = 1_790_000_000;
const units = 500n;
const take = costToBuy([{ orderId: "1", price: 1_000_000n, units }], units, fees);
const input: ChartInput = {
  ticker: "NVDA", isPut: false, strike: 234_000_000n, units, spot: 229_030_000n,
  cost: take.cost, premium: take.premium, exerciseFeeBps: 25, expiry: NOW + 86_400, now: NOW,
};
const domain = buildPayoffChart(input).domain;
const PLOT = CHART_VIEW.width - CHART_VIEW.left - CHART_VIEW.right;
/** The price a pointer at view-box x selects. */
const priceAtX = (x: number) => priceAtRatio((x - CHART_VIEW.left) / PLOT, domain);

let onPriceChange: ReturnType<typeof vi.fn>;
function render(extra: Partial<Parameters<typeof PayoffChart>[0]> = {}) {
  H.i = 0;
  const tree = PayoffChart({ input, onPriceChange, ...extra }) as ReactNode;
  const slider = all(tree, (e) => e.props.role === "slider")[0];
  const range = all(tree, (e) => e.type === "input")[0];
  return { tree, slider: slider?.props as Record<string, (e: unknown) => void> & { "aria-valuenow": number }, range };
}
function target() {
  const captured = new Set<number>();
  return {
    captured,
    getBoundingClientRect: () => ({ left: 0, width: CHART_VIEW.width }),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  };
}
const ev = (t: ReturnType<typeof target>, over: Record<string, unknown>) =>
  ({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: t, preventDefault: vi.fn(), ...over });

beforeEach(() => {
  H.slots = [];
  onPriceChange = vi.fn();
});

describe("mouse", () => {
  it("press captures the pointer and selects; drag follows only while captured; release lets go", () => {
    const t = target();
    render().slider.onPointerMove(ev(t, { clientX: 300 }));
    expect(onPriceChange, "a hover without a press selects nothing").not.toHaveBeenCalled();
    render().slider.onPointerDown(ev(t, { clientX: 200 }));
    expect(t.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onPriceChange).toHaveBeenLastCalledWith(priceAtX(200));
    render().slider.onPointerMove(ev(t, { clientX: 500 }));
    expect(onPriceChange).toHaveBeenLastCalledWith(priceAtX(500));
    expect(render().slider["aria-valuenow"], "the uncontrolled handle keeps its own price").toBe(Number(priceAtX(500)) / 1e6);
    render().slider.onPointerUp(ev(t, { clientX: 500 }));
    expect(t.releasePointerCapture).toHaveBeenCalledWith(1);
    render().slider.onPointerMove(ev(t, { clientX: 600 }));
    expect(onPriceChange).toHaveBeenCalledTimes(2);
  });

  it("a right click does nothing; past the plot edges the price clamps to the domain", () => {
    const t = target();
    render().slider.onPointerDown(ev(t, { button: 2, clientX: 200 }));
    expect(onPriceChange).not.toHaveBeenCalled();
    render().slider.onPointerDown(ev(t, { clientX: -500 }));
    expect(onPriceChange).toHaveBeenLastCalledWith(domain.min);
    render().slider.onPointerMove(ev(t, { clientX: 5_000 }));
    expect(onPriceChange).toHaveBeenLastCalledWith(domain.max);
  });

  it("a zero-width chart (not laid out) ignores the pointer", () => {
    const t = { ...target(), getBoundingClientRect: () => ({ left: 0, width: 0 }) } as unknown as ReturnType<typeof target>;
    render().slider.onPointerDown(ev(t, { clientX: 200 }));
    expect(onPriceChange).not.toHaveBeenCalled();
  });

  it("cancel releases a held capture", () => {
    const t = target();
    render().slider.onPointerDown(ev(t, { clientX: 200 }));
    render().slider.onPointerCancel(ev(t, {}));
    expect(t.releasePointerCapture).toHaveBeenCalledWith(1);
    render().slider.onPointerCancel(ev(t, {}));
    expect(t.releasePointerCapture).toHaveBeenCalledTimes(1);
  });
});

describe("touch", () => {
  const touch = (t: ReturnType<typeof target>, over: Record<string, unknown>) => ev(t, { pointerType: "touch", button: -1, ...over });

  it("a tap (under 8 px of travel) selects where it lifted, without capturing", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    expect(onPriceChange).not.toHaveBeenCalled();
    render().slider.onPointerMove(touch(t, { clientX: 303, clientY: 102 }));
    expect(onPriceChange, "small jitter is not a drag").not.toHaveBeenCalled();
    render().slider.onPointerUp(touch(t, { clientX: 303, clientY: 102 }));
    expect(onPriceChange).toHaveBeenCalledWith(priceAtX(303));
    expect(t.setPointerCapture).not.toHaveBeenCalled();
  });

  it("a horizontal swipe locks to a drag: capture, follow, select on lift", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    render().slider.onPointerMove(touch(t, { clientX: 340, clientY: 105 }));
    expect(t.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onPriceChange).toHaveBeenLastCalledWith(priceAtX(340));
    render().slider.onPointerMove(touch(t, { clientX: 400, clientY: 160 }));
    expect(onPriceChange, "once horizontal, it stays a drag").toHaveBeenLastCalledWith(priceAtX(400));
    render().slider.onPointerUp(touch(t, { clientX: 410, clientY: 160 }));
    expect(onPriceChange).toHaveBeenLastCalledWith(priceAtX(410));
    expect(t.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("a vertical swipe is a page scroll: no selection, then or on lift", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    render().slider.onPointerMove(touch(t, { clientX: 302, clientY: 140 }));
    render().slider.onPointerMove(touch(t, { clientX: 350, clientY: 145 }));
    render().slider.onPointerUp(touch(t, { clientX: 350, clientY: 145 }));
    expect(onPriceChange).not.toHaveBeenCalled();
    expect(t.setPointerCapture).not.toHaveBeenCalled();
  });

  it("a diagonal swipe stays undecided (no drag) and is not a tap on lift", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    render().slider.onPointerMove(touch(t, { clientX: 320, clientY: 120 }));
    expect(onPriceChange).not.toHaveBeenCalled();
    render().slider.onPointerUp(touch(t, { clientX: 320, clientY: 120 }));
    expect(onPriceChange).not.toHaveBeenCalled();
  });

  it("an undecided gesture that lifts after moving mostly sideways still selects", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    render().slider.onPointerUp(touch(t, { clientX: 330, clientY: 102 }));
    expect(onPriceChange).toHaveBeenCalledWith(priceAtX(330));
  });

  it("a second finger is ignored while one gesture is live; cancel ends the gesture", () => {
    const t = target();
    render().slider.onPointerDown(touch(t, { clientX: 300, clientY: 100 }));
    render().slider.onPointerDown(touch(t, { pointerId: 2, clientX: 600, clientY: 100 }));
    render().slider.onPointerMove(touch(t, { pointerId: 2, clientX: 700, clientY: 100 }));
    render().slider.onPointerUp(touch(t, { pointerId: 2, clientX: 700, clientY: 100 }));
    expect(onPriceChange).not.toHaveBeenCalled();
    render().slider.onPointerCancel(touch(t, {}));
    render().slider.onPointerUp(touch(t, { clientX: 300, clientY: 100 }));
    expect(onPriceChange, "the cancelled gesture does not select on a late lift").not.toHaveBeenCalled();
    render().slider.onPointerMove(touch(t, { clientX: 500, clientY: 100 }));
    expect(onPriceChange).not.toHaveBeenCalled();
  });
});

describe("keyboard and range input", () => {
  it("arrow keys step 0.50 and prevent scrolling; other keys are left alone", () => {
    const start = defaultHandlePrice(input, domain);
    const right = { key: "ArrowRight", preventDefault: vi.fn() };
    render().slider.onKeyDown(right);
    expect(right.preventDefault).toHaveBeenCalled();
    expect(onPriceChange).toHaveBeenLastCalledWith(start + ARROW_STEP);
    render().slider.onKeyDown({ key: "ArrowLeft", preventDefault: vi.fn() });
    expect(onPriceChange).toHaveBeenLastCalledWith(start);
    const tab = { key: "Tab", preventDefault: vi.fn() };
    render().slider.onKeyDown(tab);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(onPriceChange).toHaveBeenCalledTimes(2);
  });

  it("the range input sets dollars to the cent; a non-number is ignored", () => {
    const change = (value: string) => (render().range!.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
    change("231.237");
    expect(onPriceChange).toHaveBeenLastCalledWith(231_240_000n);
    change("NaN");
    expect(onPriceChange).toHaveBeenCalledTimes(1);
  });
});

describe("controlled and uncontrolled", () => {
  it("a controlled price wins over the chart's own", () => {
    render().slider.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });
    expect(render({ price: 230_000_000n }).slider["aria-valuenow"]).toBe(230);
  });

  it("the handle's own price resets to the default when the series changes", () => {
    render().slider.onKeyDown({ key: "PageUp", preventDefault: vi.fn() });
    expect(render().slider["aria-valuenow"]).not.toBe(Number(defaultHandlePrice(input, domain)) / 1e6);
    const other = { ...input, strike: 236_000_000n };
    const otherDomain = buildPayoffChart(other).domain;
    expect(render({ input: other }).slider["aria-valuenow"]).toBe(Number(defaultHandlePrice(other, otherDomain)) / 1e6);
  });

  it("works without an onPriceChange listener", () => {
    const t = target();
    H.i = 0;
    const slider = all(PayoffChart({ input }) as ReactNode, (e) => e.props.role === "slider")[0]!.props as Record<string, (e: unknown) => void>;
    slider.onPointerDown(ev(t, { clientX: 400 }));
    H.i = 0;
    const again = all(PayoffChart({ input }) as ReactNode, (e) => e.props.role === "slider")[0]!.props as unknown as { "aria-valuenow": number };
    expect(again["aria-valuenow"]).toBe(Number(priceAtX(400)) / 1e6);
  });

  it("mini: no slider, no range input", () => {
    const { slider, range } = render({ variant: "mini" });
    expect(slider).toBeUndefined();
    expect(range).toBeUndefined();
  });
});
