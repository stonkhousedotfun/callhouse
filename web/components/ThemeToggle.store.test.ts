/**
 * The stateful ThemeToggle's document side, which a server render never reaches: the snapshot reads data-theme from
 * <html>, falls back to the system preference (and to day when matchMedia is missing or throws), the subscription
 * watches only data-theme and disconnects, and a click applies the OTHER theme read from the document at click time.
 * useSyncExternalStore is replaced by a pass-through that records the subscribe function and calls the client snapshot.
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme } from "@/lib/theme";
import { ThemeToggle } from "./ThemeToggle";

const store = vi.hoisted(() => ({ subscribe: undefined as undefined | ((cb: () => void) => () => void) }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useSyncExternalStore: (subscribe: (cb: () => void) => () => void, getSnapshot: () => unknown) => {
      store.subscribe = subscribe;
      return getSnapshot();
    },
  };
});
vi.mock("@/lib/theme", async (orig) => ({ ...(await orig<typeof import("@/lib/theme")>()), applyTheme: vi.fn() }));

type Props = { theme: string; className?: string; onToggle: () => void };
let attr: string | null;
let matchMedia: (q: string) => { matches: boolean };

beforeEach(() => {
  attr = null;
  matchMedia = () => ({ matches: false });
  vi.mocked(applyTheme).mockReset();
  vi.stubGlobal("document", { documentElement: { getAttribute: (name: string) => (name === "data-theme" ? attr : null) } });
  vi.stubGlobal("window", { matchMedia: (q: string) => matchMedia(q) });
});
afterEach(() => vi.unstubAllGlobals());

const button = () => ThemeToggle({ className: "x" }) as ReactElement<Props>;

describe("ThemeToggle on the client", () => {
  it("reads data-theme from <html> and passes the className through", () => {
    attr = "day";
    expect(button().props).toMatchObject({ theme: "day", className: "x" });
    attr = "night";
    expect(button().props.theme).toBe("night");
  });

  it("no (or a junk) attribute: the system preference decides", () => {
    attr = "sepia";
    matchMedia = (q) => ({ matches: q === "(prefers-color-scheme: dark)" });
    expect(button().props.theme).toBe("night");
    matchMedia = () => ({ matches: false });
    expect(button().props.theme).toBe("day");
  });

  it("matchMedia throwing (old browser) falls back to day, not a crash", () => {
    matchMedia = () => { throw new Error("no matchMedia"); };
    expect(button().props.theme).toBe("day");
  });

  it("a click applies the other theme, read from the document at click time", () => {
    attr = "night";
    const { onToggle } = button().props;
    attr = "day"; // another toggle changed the page after this one rendered
    onToggle();
    expect(applyTheme).toHaveBeenCalledWith("night");
    attr = "night";
    onToggle();
    expect(applyTheme).toHaveBeenLastCalledWith("day");
  });

  it("subscribes to data-theme mutations on <html> only, and disconnects on cleanup", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let callback: (() => void) | undefined;
    vi.stubGlobal("MutationObserver", class {
      constructor(cb: () => void) { callback = cb; }
      observe = observe;
      disconnect = disconnect;
    });
    button();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe!(onChange);
    expect(observe).toHaveBeenCalledWith(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    callback!();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
