"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui";
import { addressUrl, CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { useMounted } from "@/lib/hooks";
import {
  classifyConnectError,
  isMobileUserAgent,
  mobileDeepLinks,
  readRecent,
  rememberRecent,
  switchOrAddChain,
  walletEntries,
  walletKey,
  type WalletEntry,
} from "@/lib/wallets";
import { describeError, useNotice } from "./TxToast";
import { WalletLogo } from "./WalletLogo";
import { WalletDialog, WalletPicker, type PickerView } from "./WalletModal";

/**
 * Wallet connect. The props are the whole public API ({ block }) and about twenty call sites
 * depend on them, so nothing else is exported for a caller to configure.
 *
 * Disconnected: "Connect" opens the wallet picker (components/WalletModal.tsx): wallets installed
 * in this browser first, the ones used here before marked Recent; MetaMask and Phantom install
 * links when they are missing; on a phone with no injected wallet, links that reopen this page in
 * the MetaMask or Phantom in-app browser. The list and its order come from lib/wallets.ts.
 *
 * Connected on the wrong network: a switch button (the app is single-chain 4663, so there is no
 * network picker). Switching adds 4663 to the wallet first when the wallet does not know it.
 *
 * Connected: the short address; its menu copies the address, opens it on the explorer and
 * disconnects.
 *
 * Before hydration it renders a disabled "Connect", identical on the server and the first client
 * render, so nothing here can cause a hydration mismatch.
 *
 * `block` stretches the button to its container's width (forms render this in place of submit).
 *
 * Unstretched, every state renders at the `touch` size: 44px tall, the spec's touch target, because in the header this
 * button is the only way to the wallet on a phone. `block` keeps `md`.
 */
const MENU = "absolute right-0 top-[calc(100%+8px)] z-40 rounded-md bg-surface p-2 shadow-lift ring-1 ring-line";

type DetectableConnector = ReturnType<typeof useConnectors>[number];

/** Ask each connector whether its provider exists here. EIP-6963 ones always do; static targets may not. */
function useDetected(connectors: readonly DetectableConnector[], active: boolean) {
  const [detected, setDetected] = useState<Record<string, boolean>>({});
  const [detecting, setDetecting] = useState(active);
  // A new probe starts whenever the picker opens or the connector list changes while it is open. Mark it detecting
  // while rendering that change (React's "adjust state when an input changes"), not synchronously in the effect.
  const [probed, setProbed] = useState({ connectors, active });
  if (probed.connectors !== connectors || probed.active !== active) {
    setProbed({ connectors, active });
    if (active) setDetecting(true);
  }
  useEffect(() => {
    if (!active) return;
    let live = true;
    const probe = (c: DetectableConnector) =>
      Promise.race([
        c
          .getProvider()
          .then((p) => p !== undefined && p !== null)
          .catch(() => false), // metaMask() without the extension: its optional SDK is not installed
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
    void Promise.all(connectors.map(async (c) => [c.uid, await probe(c)] as const)).then((pairs) => {
      if (!live) return;
      setDetected(Object.fromEntries(pairs));
      setDetecting(false);
    });
    return () => {
      live = false;
    };
  }, [connectors, active]);
  return { detected, detecting };
}

export function ConnectButton({ block = false }: { block?: boolean }) {
  const mounted = useMounted();
  const { address, isConnected, chainId, connector: activeConnector } = useAccount();
  const connectors = useConnectors();
  const { mutateAsync: connect } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const notice = useNotice();
  const titleId = useId();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<PickerView>({ kind: "list" });
  const [recent, setRecent] = useState<string[]>([]);
  const attempt = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { detected, detecting } = useDetected(connectors, pickerOpen);
  const entries = useMemo(
    () => walletEntries(connectors, (c) => detected[c.uid] === true, recent),
    [connectors, detected, recent],
  );
  const mobile = mounted && typeof navigator !== "undefined" && isMobileUserAgent(navigator.userAgent);
  const deepLinks = mounted && mobile ? mobileDeepLinks(window.location.href) : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // A connection that succeeds closes the picker, whichever path made it. Done while rendering the change, not in an
  // effect, so the open picker never paints once more after the account connects.
  const [wasConnected, setWasConnected] = useState(isConnected);
  if (isConnected !== wasConnected) {
    setWasConnected(isConnected);
    if (isConnected) setPickerOpen(false);
  }

  const openPicker = () => {
    setRecent(readRecent());
    setView({ kind: "list" });
    setPickerOpen(true);
  };
  const closePicker = () => {
    attempt.current += 1; // a late answer from a cancelled attempt is ignored
    setPickerOpen(false);
  };

  const select = useCallback(
    async (entry: WalletEntry) => {
      const mine = ++attempt.current;
      setView({ kind: "connecting", entry });
      try {
        await connect({ connector: entry.connector as DetectableConnector, chainId: CHAIN_ID });
        if (mine !== attempt.current) return;
        setRecent(rememberRecent(entry.key));
        setPickerOpen(false);
      } catch (err) {
        if (mine !== attempt.current) return;
        setView({ kind: "error", entry, failure: classifyConnectError(err), detail: describeError(err) });
      }
    },
    [connect],
  );

  if (!mounted) {
    return (
      <Button size="touch" disabled className={block ? "justify-self-center self-center px-6" : "max-sm:px-3.5 max-sm:text-[13px]"}>
        Connect
      </Button>
    );
  }

  if (isConnected && chainId !== CHAIN_ID) {
    return <SwitchNetworkButton block={block} />;
  }

  if (isConnected && address) {
    return (
      <div ref={wrapRef} className={block ? "relative justify-self-center self-center" : "relative"}>
        <Button
          size="touch"
          variant="ghost"
          className={block ? "justify-self-center self-center px-6" : "max-sm:px-3.5 max-sm:text-[13px]"}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          {activeConnector ? (
            <WalletLogo walletKey={walletKey(activeConnector)} name={activeConnector.name} icon={activeConnector.icon} size={18} />
          ) : (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
          )}
          <span className="num">{shortAddress(address)}</span>
        </Button>
        {menuOpen ? (
          <WalletMenu
            address={address}
            via={activeConnector?.name ?? null}
            onCopy={async () => {
              try {
                await navigator.clipboard.writeText(address);
                notice("success", "Address copied");
              } catch {
                notice("error", "Could not copy", "Your browser blocked the clipboard.");
              }
              setMenuOpen(false);
            }}
            onExplorer={() => setMenuOpen(false)}
            onDisconnect={() => {
              disconnect();
              setMenuOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Button size="touch" className={block ? "justify-self-center self-center px-6" : "max-sm:px-3.5 max-sm:text-[13px]"} onClick={openPicker} aria-haspopup="dialog">
        {view.kind === "connecting" && pickerOpen ? "Connecting…" : "Connect"}
      </Button>
      <WalletDialog open={pickerOpen} onClose={closePicker} labelledBy={titleId}>
        <WalletPicker
          view={view}
          entries={entries}
          detecting={detecting}
          mobile={mobile}
          deepLinks={deepLinks}
          onSelect={(entry) => void select(entry)}
          onCancel={() => {
            attempt.current += 1;
            setView({ kind: "list" });
          }}
          onBack={() => setView({ kind: "list" })}
          titleId={titleId}
        />
      </WalletDialog>
    </>
  );
}

/**
 * The connected wallet's menu: copy, explorer, disconnect. It renders inside the header (MENU is absolutely positioned
 * under the button), so its items are header touch targets too: `touch`, 44px tall.
 *
 * Exported for its test, not for callers: the menu opens on a click, which a server render cannot make, so the test
 * renders this directly. Callers still configure ConnectButton through `{ block }` alone.
 */
export function WalletMenu({ address, via, onCopy, onExplorer, onDisconnect }: {
  address: `0x${string}`;
  via: string | null;
  onCopy: () => void | Promise<void>;
  onExplorer: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className={`${MENU} w-[240px]`} role="menu" aria-label="Wallet">
      <p className="num mb-1 px-1 text-xs leading-snug text-ink-3 [overflow-wrap:anywhere]">{address}</p>
      {via ? <p className="mb-2 px-1 text-xs text-ink-3">via {via}</p> : null}
      <div className="grid gap-1">
        <Button size="touch" variant="ghost" role="menuitem" className="w-full justify-start!" onClick={() => void onCopy()}>
          Copy address
        </Button>
        <Button size="touch" variant="ghost" role="menuitem" className="w-full justify-start!" href={addressUrl(address)} onClick={onExplorer}>
          View on explorer
        </Button>
        <Button size="touch" variant="ghost" role="menuitem" className="w-full justify-start!" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </div>
  );
}

/** Switch to 4663, adding it to the wallet first when the wallet does not know it. */
function useSwitchToAppChain() {
  const { connector } = useAccount();
  const { mutateAsync: switchChain, isPending } = useSwitchChain();
  const notice = useNotice();
  const run = async () => {
    try {
      await switchOrAddChain(
        robinhoodChain,
        (chainId) => switchChain({ chainId }),
        async () => (connector ? ((await connector.getProvider()) as { request: (a: { method: string; params?: unknown }) => Promise<unknown> } | undefined) : undefined),
      );
    } catch (err) {
      const failure = classifyConnectError(err);
      notice("error", "Could not switch network", failure === "rejected" ? "Declined in your wallet." : describeError(err));
    }
  };
  return { run, isPending };
}

function SwitchNetworkButton({ block }: { block: boolean }) {
  const { run, isPending } = useSwitchToAppChain();
  return (
    <Button size="touch" className={block ? "justify-self-center self-center px-6" : "max-sm:px-3.5 max-sm:text-[13px]"} disabled={isPending} onClick={() => void run()}>
      {isPending ? "Switching…" : "Switch to Robinhood Chain"}
    </Button>
  );
}

/**
 * A page-wide notice while a connected wallet is on another network. Rendered once, by
 * app/providers.tsx, above every page: forms show SwitchNetworkButton in place, this says why.
 */
export function WrongNetworkBanner() {
  const mounted = useMounted();
  const { isConnected, chainId } = useAccount();
  const { run, isPending } = useSwitchToAppChain();
  if (!mounted || !isConnected || chainId === CHAIN_ID) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-warn-soft px-4 py-2 text-center text-sm text-ink">
      <span>Your wallet is on another network.</span>
      <Button size="xs" disabled={isPending} onClick={() => void run()}>
        {isPending ? "Switching…" : "Switch to Robinhood Chain"}
      </Button>
    </div>
  );
}
