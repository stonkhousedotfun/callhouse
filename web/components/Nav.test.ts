/**
 * UX review item 6, the chrome half: the mobile link row faded its overflow behind a mask while
 * also suppressing the scrollbar, so on a phone Trust and Wins were not merely hard to reach but
 * invisible — and nothing on screen said anything was hidden.
 *
 * The Neon half: on v2 the whole row is hidden below 1024px, where the phone tab bar carries the
 * five, and the header mounts the theme toggle and the tab bar. The v1 scroll-row assertions below are unchanged;
 * they still describe v1, which has no tab bar.
 *
 * This is a source assertion because the defect IS the class list: there is no behaviour to
 * render, and jsdom does not lay out a scroll container or evaluate a mask.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import { useMounted } from "@/lib/hooks";
import { useMarkets } from "@/lib/v2/hooks";
import { WalletMenu } from "./ConnectButton";
import { Nav } from "./Nav";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/nvda",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useConnect: vi.fn(), useConnectors: vi.fn(), useDisconnect: vi.fn(), useSwitchChain: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useMounted: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));
vi.mock("@/components/TxToast", () => ({ useNotice: () => vi.fn(), describeError: (e: unknown) => String(e) }));

const source = readFileSync(fileURLToPath(new URL("./Nav.tsx", import.meta.url)), "utf8");

/**
 * The nav's own class attribute, isolated.
 *
 * The first version of this file grepped the WHOLE SOURCE for an unprefixed
 * `[scrollbar-width:none]` and went red against the explanatory comment that quotes the very
 * class it was asserting about. Searching a file for a string that the file legitimately
 * discusses is its own small false-positive; the assertion has to look at the class list.
 */
const navClass = (() => {
  const at = source.indexOf('aria-label="App"');
  const open = source.indexOf('className="', at);
  return source.slice(open, source.indexOf('"', open + 'className="'.length) + 1);
})();

describe("the mobile nav says when there is more to see", () => {
  it("the source was actually read — the control", () => {
    expect(source).toContain('aria-label="App"');
    expect(source).toContain("overflow-x-auto");
  });

  it("does not suppress the scrollbar where the row actually overflows", () => {
    // The defect: `[scrollbar-width:none]` applied at every width, including the widths where
    // the row scrolls. It is now `lg:` only, where there is nothing hidden to disclose.
    expect(navClass, "the class attribute was located — the control").toContain("overflow-x-auto");
    expect(navClass).not.toMatch(/(^|\s)\[scrollbar-width:none\]/);
    expect(navClass).toContain("lg:[scrollbar-width:none]");
  });

  it("keeps the fade, which reads as 'more this way' once a scrollbar confirms it", () => {
    expect(navClass).toContain("max-lg:[mask-image:linear-gradient(to_right,#000_88%,transparent)]");
  });
});

describe("the Neon header", () => {
  it("hides the v2 link row below 1024px, where the tab bar carries the same five", () => {
    expect(navClass).toContain("data-v2:max-lg:hidden");
    expect(source).toContain('data-v2={v2 ? "" : undefined}');
  });

  it("the hide is v2-only -- v1 keeps its scroll row at every width (the control)", () => {
    // The class is keyed on the data-v2 attribute, not a bare max-lg:hidden that would also hide v1's only nav.
    expect(navClass).not.toMatch(/(^|\s)max-lg:hidden/);
  });

  it("mounts the theme toggle and the tab bar", () => {
    expect(source).toContain("<ThemeToggle />");
    expect(source).toContain("<TabBar />");
    expect(source).toContain('import { TabBar } from "@/components/TabBar";');
  });
});

/**
 * The spec's touch target is 44px, and the browser pass measured
 * Connect at 36px, the NVDA/SPCX chips at 27px and the brand link at 26px. This renders the v2 header in each wallet
 * state and checks the CLASS LIST OF EVERY <a> AND <button> inside header[data-slot="topbar"], not a grep of a source
 * file: a `min-h-11` passed as className beside Button sm's `min-h-9` would satisfy a grep while stylesheet order
 * decides the height (lib/cn.ts does not resolve conflicts).
 *
 * The rule, per control: its class list has exactly one min-height utility and it is min-h-11 (44px) or larger, or it
 * has the important form (`min-h-11!` or larger), which wins regardless of order.
 */
const MIN_H = /^(!?)(?:[\w-]+:)*min-h-(\d+(?:\.\d+)?|\[(\d+(?:\.\d+)?)px\])(!?)$/;
function minHeightPx(token: string): { px: number | null; important: boolean } | null {
  const m = MIN_H.exec(token);
  if (!m) return token.includes("min-h-") ? { px: null, important: false } : null;
  const px = m[3] !== undefined ? Number(m[3]) : Number(m[2]) * 4;
  return { px, important: m[1] === "!" || m[4] === "!" };
}
export function touchTargetProblem(classList: string): string | null {
  const found = classList.split(/\s+/).map(minHeightPx).filter((x): x is NonNullable<typeof x> => x !== null);
  if (found.some((f) => f.important && f.px !== null && f.px >= 44)) return null;
  if (found.length !== 1) return `expected exactly one min-height utility, found ${found.length}`;
  return found[0]!.px !== null && found[0]!.px >= 44 ? null : `min-height below 44px (${found[0]!.px ?? "unparsed"})`;
}

/** The visible text of a control's markup: tags and the new-tab link's sr-only note dropped. */
const textOf = (markup: string) => markup.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "").replace(/<[^>]*>/g, "").trim();

/** Every <a>/<button> opening tag inside the header, with its class attribute. */
function headerControls(html: string): { tag: string; label: string; classes: string }[] {
  const start = html.indexOf('<header data-slot="topbar"');
  const header = html.slice(start, html.indexOf("</header>", start));
  return [...header.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({
    tag: m[1]!,
    label: textOf(m[3]!),
    classes: /class="([^"]*)"/.exec(m[2]!)?.[1] ?? "",
  }));
}

describe("the v2 header's touch targets are 44px", () => {
  const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as const;
  const account = (over: Partial<ReturnType<typeof useAccount>> = {}) =>
    vi.mocked(useAccount).mockReturnValue({ address: undefined, isConnected: false, chainId: undefined, connector: undefined, ...over } as ReturnType<typeof useAccount>);

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    vi.mocked(useMounted).mockReturnValue(true);
    account();
    vi.mocked(useConnectors).mockReturnValue([] as unknown as ReturnType<typeof useConnectors>);
    vi.mocked(useConnect).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useConnect>);
    vi.mocked(useDisconnect).mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<typeof useDisconnect>);
    vi.mocked(useSwitchChain).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as unknown as ReturnType<typeof useSwitchChain>);
    vi.mocked(useMarkets).mockReturnValue({ data: undefined, isError: false } as unknown as ReturnType<typeof useMarkets>);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the rule itself: sm's min-h-9 fails, a className min-h-11 beside it fails, the important form passes", () => {
    expect(touchTargetProblem("min-h-11 px-4")).toBeNull();
    expect(touchTargetProblem("min-h-9 px-4")).toMatch(/below 44px/);
    expect(touchTargetProblem("min-h-9 px-4 min-h-11")).toMatch(/exactly one/);
    expect(touchTargetProblem("min-h-9 min-h-11!")).toBeNull();
    expect(touchTargetProblem("rounded-full px-3 py-1.5")).toMatch(/found 0/);
    expect(touchTargetProblem("min-h-[44px]")).toBeNull();
  });

  const states: [string, () => void, RegExp][] = [
    ["hydrating", () => vi.mocked(useMounted).mockReturnValue(false), />Connect<\/button>/],
    ["disconnected", () => undefined, />Connect<\/button>/],
    ["on the wrong network", () => account({ address: ADDRESS, isConnected: true, chainId: 1 }), /Switch to Robinhood Chain/],
    ["connected", () => account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID }), /aria-haspopup="menu"/],
  ];
  for (const [name, arrange, wallet] of states) {
    it(`every header control, wallet ${name}`, () => {
      arrange();
      const html = renderToStaticMarkup(createElement(Nav));
      expect(html, "the wallet button in this state was rendered -- the control").toMatch(wallet);
      const controls = headerControls(html);
      // The controls the pass measured are all here, so a pass cannot come from an empty or partial list.
      const labels = controls.map((c) => c.label);
      expect(labels).toEqual(expect.arrayContaining(["stonkhouse", "NVDA", "SPCX"]));
      expect(controls.some((c) => c.tag === "button" && /Connect|Switch to Robinhood Chain|0x1234/.test(c.label))).toBe(true);
      for (const control of controls) expect(touchTargetProblem(control.classes), `${control.tag} "${control.label}": ${control.classes}`).toBeNull();
    });
  }

  it("the open wallet menu's items", () => {
    const html = renderToStaticMarkup(createElement(WalletMenu, { address: ADDRESS, via: "MetaMask", onCopy: vi.fn(), onExplorer: vi.fn(), onDisconnect: vi.fn() }));
    const items = [...html.matchAll(/<(a|button)\b([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/\1>/g)]
      .map((m) => ({ label: textOf(m[3]!), classes: /class="([^"]*)"/.exec(m[2]!)?.[1] ?? "" }));
    expect(items.map((i) => i.label)).toEqual(["Copy address", "View on explorer", "Disconnect"]);
    for (const item of items) expect(touchTargetProblem(item.classes), `${item.label}: ${item.classes}`).toBeNull();
  });
});
