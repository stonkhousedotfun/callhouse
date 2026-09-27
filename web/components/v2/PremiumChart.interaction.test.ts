/**
 * PremiumChart's interaction and sizing, which a static render cannot drive: the ResizeObserver width (floored at
 * 320 px, disconnected on unmount, skipped when unsupported), pointer selection of the nearest trade (mouse hover,
 * touch only while captured, right-click ignored, zero-width ignored), the keyboard (arrows clamp at the ends,
 * Home/End), and the narrow-width axis. React's useState/useRef/useEffect/useId are a slot stand-in while the
 * component function is called directly; the returned tree is then server-rendered with the real hooks.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trade } from "@/lib/v2/api-types";
import { PremiumChart } from "./PremiumChart";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
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
      if (!H.on) return real.useState(init);
      const k = slot(() => init);
      return [H.slots[k], (v: unknown) => { H.slots[k] = v; }];
    },
    useRef: (init: unknown) => (H.on ? H.slots[slot(() => ({ current: init }))] : real.useRef(init)),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => (H.on ? void H.effects.push(fn) : real.useEffect(fn, deps)),
    useId: () => (H.on ? ":id:" : real.useId()),
  };
});
vi.mock("@/components/ui/Time", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/Time")>()),
  useViewerTimeZone: () => "America/New_York",
}));

function trade(id: string, ts: number, raw: string, takerIsBuyer = true): Trade {
  const formatted = String(Number(raw) / 1e6);
  return {
    id, ts, price: { formatted, raw, decimals: 6 }, units: "150", premium: { formatted, raw, decimals: 6 },
    takerIsBuyer, primary: false, taker: "0x0000000000000000000000000000000000000001",
    maker: "0x0000000000000000000000000000000000000002", tx: `0x${id.padStart(64, "0")}`,
  };
}
// 16:00 New York on consecutive days, one hour apart for the middle one.
const T0 = Date.UTC(2026, 8, 14, 20) / 1000;
const trades = [trade("a", T0, "1000000"), trade("b", T0 + 3_600, "1500000", false), trade("c", T0 + 7_200, "1250000")];

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}
function render(list = trades, extra: { error?: boolean } = {}) {
  H.on = true;
  H.i = 0;
  H.effects = [];
  const tree = PremiumChart({ trades: list, loading: false, error: extra.error ?? false }) as ReactNode;
  H.on = false;
  const slider = all(tree, (e) => e.props.role === "slider")[0]?.props as (Record<string, (e: unknown) => void> & { "aria-valuenow": number; "aria-valuetext": string }) | undefined;
  return { tree, slider, html: renderToStaticMarkup(tree as ReactElement) };
}
function surface(width = 648) {
  const captured = new Set<number>();
  return {
    getBoundingClientRect: () => ({ left: 100, width }),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  };
}
const ev = (t: ReturnType<typeof surface>, over: Record<string, unknown>) =>
  ({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 100, currentTarget: t, ...over });

beforeEach(() => { H.slots = []; });
afterEach(() => vi.unstubAllGlobals());

describe("selection", () => {
  it("defaults to the latest trade", () => {
    const { slider, html } = render();
    expect(slider!["aria-valuenow"]).toBe(3);
    expect(html).toContain("Latest trade: 1.25 USDG per share");
    expect(html).toContain("1.5 shares. Buyer took the ask.");
  });

  it("a mouse press captures and selects the nearest trade; hover then follows; right-click is ignored", () => {
    const t = surface();
    render().slider!.onPointerDown(ev(t, { button: 2, clientX: 100 }));
    expect(render().slider!["aria-valuenow"]).toBe(3);
    render().slider!.onPointerDown(ev(t, { clientX: 100 }));
    expect(t.setPointerCapture).toHaveBeenCalledWith(1);
    const first = render();
    expect(first.slider!["aria-valuenow"]).toBe(1);
    expect(first.html).toContain("Selected trade: 1 USDG per share");
    first.slider!.onPointerMove(ev(t, { clientX: 100 + 648 / 2 + 10 }));
    const middle = render();
    expect(middle.slider!["aria-valuenow"]).toBe(2);
    expect(middle.html).toContain("Seller took the bid.");
    expect(middle.html).toMatch(/data-slot="crosshair-price"[\s\S]*?>1\.5<\/text>/);
  });

  it("touch: a move without capture does not steal the scroll; release and cancel let go", () => {
    const t = surface();
    render().slider!.onPointerMove(ev(t, { pointerType: "touch", clientX: 100 }));
    expect(render().slider!["aria-valuenow"]).toBe(3);
    render().slider!.onPointerDown(ev(t, { pointerType: "touch", button: -1, clientX: 100 }));
    render().slider!.onPointerMove(ev(t, { pointerType: "touch", clientX: 400 }));
    expect(render().slider!["aria-valuenow"]).toBe(2);
    render().slider!.onPointerUp(ev(t, {}));
    expect(t.releasePointerCapture).toHaveBeenCalledTimes(1);
    render().slider!.onPointerUp(ev(t, {}));
    render().slider!.onPointerCancel(ev(t, {}));
    expect(t.releasePointerCapture, "nothing held, nothing released").toHaveBeenCalledTimes(1);
    render().slider!.onPointerDown(ev(t, { clientX: 100 }));
    render().slider!.onPointerCancel(ev(t, {}));
    expect(t.releasePointerCapture).toHaveBeenCalledTimes(2);
  });

  it("points past the plot edges clamp to the first or last trade; a zero-width surface is ignored", () => {
    render().slider!.onPointerDown(ev(surface(), { clientX: -1_000 }));
    expect(render().slider!["aria-valuenow"]).toBe(1);
    render().slider!.onPointerDown(ev(surface(), { clientX: 10_000 }));
    expect(render().slider!["aria-valuenow"]).toBe(3);
    render().slider!.onPointerDown(ev(surface(), { clientX: 100 }));
    render().slider!.onPointerDown(ev(surface(0), { clientX: 10_000 }));
    expect(render().slider!["aria-valuenow"]).toBe(1);
  });

  it("keys: arrows step and clamp at both ends, Home and End jump, others are ignored", () => {
    const key = (k: string) => {
      const e = { key: k, preventDefault: vi.fn() };
      render().slider!.onKeyDown(e);
      return e;
    };
    expect(key("ArrowRight").preventDefault).toHaveBeenCalled();
    expect(render().slider!["aria-valuenow"], "clamped at the end").toBe(3);
    key("ArrowLeft");
    expect(render().slider!["aria-valuenow"]).toBe(2);
    key("ArrowDown");
    key("ArrowDown");
    expect(render().slider!["aria-valuenow"], "clamped at the start").toBe(1);
    key("ArrowUp");
    expect(render().slider!["aria-valuenow"]).toBe(2);
    key("End");
    expect(render().slider!["aria-valuenow"]).toBe(3);
    key("Home");
    expect(render().slider!["aria-valuenow"]).toBe(1);
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
  });

  it("a selected trade that drops out of the data falls back to the latest", () => {
    render().slider!.onKeyDown({ key: "Home", preventDefault: vi.fn() });
    expect(render(trades.slice(1)).slider!["aria-valuenow"]).toBe(2);
  });

  it("one trade: no slider and no inspect hint", () => {
    const { slider, html } = render(trades.slice(0, 1));
    expect(slider).toBeUndefined();
    expect(html).not.toContain("to inspect a trade");
    expect(html).toContain("1 trade · latest 1 USDG");
  });
});

describe("sizing", () => {
  it("measures the container, floors the width at 320 px, and disconnects on unmount", () => {
    let callback: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: typeof callback) { callback = cb; }
      observe = observe;
      disconnect = disconnect;
    });
    const { tree } = render();
    const container = all(tree, (e) => e.props.ref !== undefined)[0]!;
    const node = {};
    (container.props.ref as { current: unknown }).current = node;
    const cleanup = H.effects[0]!() as () => void;
    expect(observe).toHaveBeenCalledWith(node);
    callback!([{ contentRect: { width: 400.4 } }]);
    expect(render().html).toContain('viewBox="0 0 400 304"');
    callback!([{ contentRect: { width: 200 } }]);
    expect(render().html).toContain('viewBox="0 0 320 304"');
    callback!([]);
    expect(render().html, "an empty entry list changes nothing").toContain('viewBox="0 0 320 304"');
    cleanup();
    expect(disconnect).toHaveBeenCalled();
  });

  it("narrow (<480 px): only the first and last time labels; wide: first, middle and last", () => {
    const labels = (html: string) => (html.match(/font-size="12">[A-Z][a-z]{2} \d/g) ?? []).length;
    expect(labels(render().html)).toBe(3);
    H.slots = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    const { tree } = render();
    (all(tree, (e) => e.props.ref !== undefined)[0]!.props.ref as { current: unknown }).current = {};
    H.effects[0]!();
    expect(labels(render().html)).toBe(2);
  });

  it("no ResizeObserver, or no container yet: keeps the default 720 px", () => {
    render();
    expect(H.effects[0]!(), "no container").toBeUndefined();
    vi.stubGlobal("ResizeObserver", undefined);
    const { tree } = render();
    (all(tree, (e) => e.props.ref !== undefined)[0]!.props.ref as { current: unknown }).current = {};
    expect(H.effects[0]!()).toBeUndefined();
    expect(render().html).toContain('viewBox="0 0 720 304"');
  });
});
