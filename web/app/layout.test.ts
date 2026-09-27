/**
 * The root shell. RootLayout: the theme script runs in <head> before paint, both font variables sit on <html>, the page
 * goes inside <main id="main"> (the skip link's target) under Nav and above Footer, all inside Providers, and the v2
 * config notice is mounted only in the v2 build. Providers: one QueryClient per mount with the chain-read cadence
 * (retry 1, 15s stale, no refetch on focus), the wagmi config, the toast provider and the wrong-network banner.
 * Metadata per build and preview flag is covered in route-pages.test.ts.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { V2ConfigNotice } from "@/components/v2/RouteViews";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { wagmiConfig } from "@/lib/wagmi";
import RootLayout, { viewport } from "./layout";
import { Providers } from "./providers";

const P = vi.hoisted(() => ({ clients: [] as unknown[], configs: [] as unknown[] }));
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ variable: "--sans" }), JetBrains_Mono: () => ({ variable: "--mono" }) }));
vi.mock("wagmi", async (orig) => {
  const real = await orig<typeof import("wagmi")>();
  return { ...real, WagmiProvider: ({ config, children }: { config: unknown; children: ReactNode }) => { P.configs.push(config); return children; } };
});
vi.mock("@tanstack/react-query", async (orig) => {
  const real = await orig<typeof import("@tanstack/react-query")>();
  return { ...real, QueryClientProvider: ({ client, children }: { client: unknown; children: ReactNode }) => { P.clients.push(client); return children; } };
});
vi.mock("@/components/ConnectButton", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { WrongNetworkBanner: () => h("i", null, "[banner]") };
});
vi.mock("@/components/TxToast", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { ToastProvider: ({ children }: { children: ReactNode }) => h("div", { id: "toasts" }, children) };
});

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("RootLayout", () => {
  const tree = (): ReactNode => RootLayout({ children: createElement("p", { id: "page" }) });

  it("fonts on <html>, the theme script first in <head>, the skip link targets <main id=main>", () => {
    const t = tree() as El;
    expect(t.type).toBe("html");
    expect(t.props.lang).toBe("en");
    expect(t.props.className).toBe("--sans --mono");
    const script = all(t, (e) => e.type === "script")[0]!;
    expect((script.props.dangerouslySetInnerHTML as { __html: string }).__html).toBe(THEME_INIT_SCRIPT);
    expect(all(t, (e) => e.type === "a")[0]!.props.href).toBe("#main");
    expect(all(t, (e) => e.type === "main")[0]!.props.id).toBe("main");
  });

  it("the page sits inside <main>, under Nav and above Footer, all inside Providers", () => {
    const providers = all(tree(), (e) => e.type === Providers)[0]!;
    const kids = (providers.props.children as ReactNode[]).filter(isValidElement) as El[];
    expect(kids.map((k) => k.type)).toEqual([Nav, "main", Footer]);
    expect(all(kids[1], (e) => e.props.id === "page")).toHaveLength(1);
  });

  it("the v2 config notice only in the v2 build", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(all(tree(), (e) => e.type === V2ConfigNotice)).toHaveLength(1);
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(all(tree(), (e) => e.type === V2ConfigNotice)).toHaveLength(0);
  });

  it("browser chrome follows the page ground in each scheme", () => {
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
      { media: "(prefers-color-scheme: dark)", color: "#000000" },
    ]);
  });
});

describe("Providers", () => {
  it("wagmi config, a QueryClient with the chain-read cadence, the toast provider, the banner, then the page", () => {
    P.clients = [];
    P.configs = [];
    const html = renderToStaticMarkup(createElement(Providers, null, createElement("p", null, "PAGE")));
    expect(html).toBe('<div id="toasts"><i>[banner]</i><p>PAGE</p></div>');
    expect(P.configs).toEqual([wagmiConfig]);
    const client = P.clients[0] as QueryClient;
    expect(client).toBeInstanceOf(QueryClient);
    expect(client.getDefaultOptions().queries).toEqual({ retry: 1, staleTime: 15_000, refetchOnWindowFocus: false });
  });

  it("each mount gets its own client, so a server render never shares a cache between requests", () => {
    P.clients = [];
    renderToStaticMarkup(createElement(Providers, null, "a"));
    renderToStaticMarkup(createElement(Providers, null, "b"));
    expect(P.clients).toHaveLength(2);
    expect(P.clients[0]).not.toBe(P.clients[1]);
  });
});
