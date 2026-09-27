import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { walletKey } from "@/lib/wallets";
import { WALLET_LOGOS, WalletLogo } from "./WalletLogo";

const render = (props: Parameters<typeof WalletLogo>[0]) => renderToStaticMarkup(createElement(WalletLogo, props));

describe("wallet logos", () => {
  it("maps the connectors lib/wagmi.ts creates to their logos by wallet key", () => {
    // The keys come from walletKey, not typed here: metaMask()'s id and the Phantom target's id.
    expect(WALLET_LOGOS[walletKey({ id: "metaMaskSDK", uid: "a", name: "MetaMask", type: "metaMask", rdns: ["io.metamask"] })]).toBeDefined();
    expect(WALLET_LOGOS[walletKey({ id: "phantom", uid: "b", name: "Phantom", type: "injected" })]).toBeDefined();
    expect(WALLET_LOGOS[walletKey({ id: "app.phantom", uid: "c", name: "Phantom", type: "injected", rdns: "app.phantom" })]).toBe(WALLET_LOGOS.phantom);
    expect(WALLET_LOGOS[walletKey({ id: "some.unknown.wallet", uid: "d", name: "Unknown", type: "injected" })]).toBeUndefined();
  });

  it("renders MetaMask's and Phantom's branded SVGs, not a monogram", () => {
    const metamask = render({ walletKey: "metamask", name: "MetaMask" });
    expect(metamask).toMatch(/^<svg/);
    expect(metamask, "MetaMask's branded orange").toContain("#FF5C16");
    const phantom = render({ walletKey: "phantom", name: "Phantom" });
    expect(phantom).toMatch(/^<svg/);
    expect(phantom).not.toBe(metamask);
  });

  it("prefers the icon the wallet announced over EIP-6963", () => {
    const html = render({ walletKey: "metamask", name: "MetaMask", icon: "data:image/svg+xml,announced" });
    expect(html).toContain('src="data:image/svg+xml,announced"');
    expect(html).not.toContain("<svg");
  });

  it("falls back to a monogram for a wallet it has no logo for", () => {
    const html = render({ walletKey: "some.unknown.wallet", name: "zeta" });
    expect(html).toContain(">Z</span>");
    expect(html).not.toContain("<svg");
    expect(render({ name: "No key" })).toContain(">N</span>");
  });
});
