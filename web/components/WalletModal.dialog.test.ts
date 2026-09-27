/**
 * WalletModal's client-only parts: the picker's click handlers, and WalletDialog's focus management (focus moves in on
 * open and back to the opener on close, body scroll is locked and restored, Tab/Shift-Tab wrap, Esc and the backdrop
 * close). No DOM here (node environment by design): React's useRef/useEffect are swapped for a slot stand-in, the
 * portal renders in place, and document/elements are small fakes that record focus.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { walletEntries, type ConnectorLike } from "@/lib/wallets";
import { WalletDialog, WalletPicker } from "./WalletModal";

const H = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useRef: (init: unknown) => {
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = { current: init };
      return H.slots[k];
    },
    useEffect: (fn: () => void | (() => void)) => { H.effects.push(fn); },
  };
});
vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  createPortal: (node: ReactNode, target: unknown) => ({ portal: node, target }),
}));

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}

class FakeEl {
  focused = 0;
  focus() { this.focused++; doc.activeElement = this; }
}
const doc = { activeElement: null as unknown, body: { style: { overflow: "auto" } } };

beforeEach(() => {
  H.slots = [];
  doc.activeElement = null;
  doc.body.style.overflow = "auto";
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeEl);
});
afterEach(() => vi.unstubAllGlobals());

function dialog(open: boolean, onClose = vi.fn()) {
  H.i = 0;
  H.effects = [];
  const out = WalletDialog({ open, onClose, labelledBy: "t", children: "body" }) as unknown as { portal: El; target: unknown } | null;
  return { out, onClose, panelRef: H.slots[0] as { current: unknown }, effect: H.effects[0]! };
}

describe("WalletDialog", () => {
  it("closed: renders nothing and its effect does nothing", () => {
    const { out, effect } = dialog(false);
    expect(out).toBeNull();
    expect(effect()).toBeUndefined();
    expect(doc.body.style.overflow).toBe("auto");
  });

  it("no document (server): renders nothing even when open", () => {
    vi.stubGlobal("document", undefined);
    expect(dialog(true).out).toBeNull();
  });

  it("open: a labelled modal portalled into body; the backdrop and × close it", () => {
    const { out, onClose } = dialog(true);
    expect(out!.target).toBe(doc.body);
    const panel = all(out!.portal, (e) => e.props.role === "dialog")[0]!;
    expect(panel.props).toMatchObject({ "aria-modal": "true", "aria-labelledby": "t", tabIndex: -1 });
    const clickers = all(out!.portal, (e) => e.props.onClick === onClose);
    expect(clickers.map((e) => e.props["aria-label"] ?? e.props["aria-hidden"])).toEqual(["true", "Close"]);
  });

  it("focus moves to the first focusable item, scroll locks, and both are restored on close", () => {
    const opener = new FakeEl();
    doc.activeElement = opener;
    const first = new FakeEl();
    const { panelRef, effect } = dialog(true);
    const selectors: string[] = [];
    panelRef.current = { querySelector: (s: string) => { selectors.push(s); return first; }, focus: vi.fn() };
    const cleanup = effect() as () => void;
    expect(first.focused).toBe(1);
    expect(selectors[0]).toContain("button:not([disabled])");
    expect(doc.body.style.overflow).toBe("hidden");
    cleanup();
    expect(doc.body.style.overflow).toBe("auto");
    expect(opener.focused).toBe(1);
  });

  it("nothing focusable inside: the panel itself takes focus; a non-element opener is not refocused", () => {
    doc.activeElement = { focus: vi.fn() }; // not an HTMLElement
    const panelFocus = vi.fn();
    const { panelRef, effect } = dialog(true);
    panelRef.current = { querySelector: () => null, focus: panelFocus };
    (effect() as () => void)();
    expect(panelFocus).toHaveBeenCalledTimes(1);
    expect((doc.activeElement as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();
  });

  describe("keyboard", () => {
    const a = new FakeEl();
    const b = new FakeEl();
    function keyDown(items: FakeEl[] | null) {
      const d = dialog(true);
      d.panelRef.current = items === null ? null : { querySelectorAll: () => items };
      const handler = (d.out!.portal.props.onKeyDown as (e: object) => void);
      return (key: string, shiftKey = false) => {
        const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        handler(event);
        return { event, onClose: d.onClose };
      };
    }

    it("Escape closes and stops the event reaching the page", () => {
      const { event, onClose } = keyDown([a, b])("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it("Tab on the last item wraps to the first; Shift-Tab on the first wraps to the last", () => {
      const press = keyDown([a, b]);
      doc.activeElement = b;
      const fwd = press("Tab");
      expect(fwd.event.preventDefault).toHaveBeenCalled();
      expect(doc.activeElement).toBe(a);
      const back = press("Tab", true);
      expect(back.event.preventDefault).toHaveBeenCalled();
      expect(doc.activeElement).toBe(b);
    });

    it("Tab in the middle is left to the browser; other keys and a missing panel are ignored", () => {
      const press = keyDown([a, b]);
      doc.activeElement = a;
      expect(press("Tab").event.preventDefault).not.toHaveBeenCalled();
      doc.activeElement = b;
      expect(press("Tab", true).event.preventDefault).not.toHaveBeenCalled();
      expect(press("Enter").event.preventDefault).not.toHaveBeenCalled();
      expect(keyDown(null)("Tab").event.preventDefault).not.toHaveBeenCalled();
    });

    it("no focusable item: Tab is swallowed so focus cannot leave the dialog", () => {
      expect(keyDown([])("Tab").event.preventDefault).toHaveBeenCalled();
    });
  });
});

describe("WalletPicker handlers", () => {
  const connectors: ConnectorLike[] = [
    { uid: "c1", id: "io.rabby", name: "Rabby Wallet", type: "injected", rdns: "io.rabby" },
    { uid: "c2", id: "metaMaskSDK", name: "MetaMask", type: "metaMask", rdns: ["io.metamask"] },
  ];
  const base = { detecting: false, mobile: false, onSelect: vi.fn(), onCancel: vi.fn(), onBack: vi.fn(), titleId: "t" };

  it("clicking an installed wallet selects it", () => {
    const entries = walletEntries(connectors, (c) => c.uid === "c1");
    const onSelect = vi.fn();
    const tree = WalletPicker({ ...base, onSelect, view: { kind: "list" }, entries }) as El;
    const buttons = all(tree, (e) => e.type === "button");
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith(entries.find((e) => e.name === "Rabby Wallet"));
    // Installed first, then the missing known wallet under "More wallets".
    const headings = all(tree, (e) => e.type === "h3").map((e) => e.props.children);
    expect(headings).toEqual(["Installed", "More wallets"]);
  });

  it("error view: Try again re-selects the same wallet; Back goes back; an unknown failure shows its detail", () => {
    const entry = walletEntries(connectors, () => true)[0]!;
    const onSelect = vi.fn();
    const onBack = vi.fn();
    const tree = WalletPicker({ ...base, onSelect, onBack, entries: [], view: { kind: "error", entry, failure: "unknown", detail: "RPC said no" } }) as El;
    const clickable = all(tree, (e) => typeof e.props.onClick === "function");
    expect(clickable.map((e) => e.props.children)).toEqual([expect.stringContaining("Back"), expect.stringContaining("Try again")]);
    (clickable[1]!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith(entry);
    (clickable[0]!.props.onClick as () => void)();
    expect(onBack).toHaveBeenCalled();
    expect(all(tree, (e) => e.props.children === "RPC said no")).toHaveLength(1);
    const titled = all(tree, (e) => e.type === "h2")[0]!;
    expect(titled.props.children).toBe(`Could not connect ${entry.name}`);
  });

  it("a known (non-unknown) failure hides the raw detail", () => {
    const entry = walletEntries(connectors, () => true)[0]!;
    const tree = WalletPicker({ ...base, entries: [], view: { kind: "error", entry, failure: "pending", detail: "raw text" } }) as El;
    expect(all(tree, (e) => e.props.children === "raw text")).toHaveLength(0);
  });

  it("detecting with nothing installed yet: no install list is offered while it looks", () => {
    const tree = WalletPicker({ ...base, detecting: true, entries: walletEntries(connectors, () => false), view: { kind: "list" } }) as El;
    expect(all(tree, (e) => e.type === "h3")).toHaveLength(0);
    expect(all(tree, (e) => e.props.children === "Looking for wallets…")).toHaveLength(1);
  });
});
