import type { ComponentType } from "react";
import WalletCoinbase from "@web3icons/react/icons/wallets/WalletCoinbase";
import WalletMetamask from "@web3icons/react/icons/wallets/WalletMetamask";
import WalletPhantom from "@web3icons/react/icons/wallets/WalletPhantom";
import WalletRabby from "@web3icons/react/icons/wallets/WalletRabby";

/**
 * A wallet's logo, in this order:
 *   1. the icon the wallet announced over EIP-6963 (`connector.icon`, a data: URI): the wallet's own
 *      current artwork;
 *   2. the web3icons branded logo for the wallets we know by key (lib/wallets.ts walletKey), so
 *      MetaMask and Phantom show their logos even when the extension is missing or does not
 *      announce;
 *   3. a monogram.
 * Imported per icon (the package exports `./icons/wallets/*` and declares no side effects), so the
 * bundle carries these four SVGs and not the library.
 */
type LogoComponent = ComponentType<{ variant?: "mono" | "branded" | "background"; size?: number | string; className?: string; "aria-hidden"?: boolean }>;

export const WALLET_LOGOS: Record<string, LogoComponent> = {
  metamask: WalletMetamask,
  phantom: WalletPhantom,
  "com.coinbase.wallet": WalletCoinbase,
  "io.rabby": WalletRabby,
};

export function WalletLogo({ walletKey, name, icon, size = 28 }: { walletKey?: string; name: string; icon?: string; size?: number }) {
  if (icon) {
    // An EIP-6963 icon is a data: URI announced by the extension itself; next/image adds nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt="" width={size} height={size} className="shrink-0 rounded-md" />;
  }
  const Logo = walletKey === undefined ? undefined : WALLET_LOGOS[walletKey];
  if (Logo) return <Logo variant="branded" size={size} className="shrink-0" aria-hidden />;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-md bg-surface-2 font-display text-sm font-semibold text-ink-2 ring-1 ring-line"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
