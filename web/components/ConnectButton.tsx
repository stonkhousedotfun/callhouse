"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { useMounted } from "@/lib/hooks";
import { describeError, useNotice } from "./TxToast";

/**
 * Wallet connect, written by hand.
 *
 * connectkit and RainbowKit are not installed and must not be. wagmi's `injected()` connector
 * plus EIP-6963 discovery already enumerates every browser wallet the visitor actually has, so
 * the whole widget is one button and a list — no modal library, no project id, no extra bundle.
 *
 * The app is single-chain: CHAIN_ID is pinned to 4663 (Robinhood Chain). A wallet on any other
 * network gets a switch prompt, never a network picker.
 *
 * `block` stretches the button to its container's width and gives it the md size: the forms render
 * this in place of their submit button when no wallet is connected, and it takes the submit
 * button's full-width slot at the submit button's height.
 */
/** The menu under the button: a lifted surface, right-aligned to the button, above the page. */
const MENU = "absolute right-0 top-[calc(100%+8px)] z-40 rounded-md bg-surface p-2.5 shadow-lift ring-1 ring-line";

export function ConnectButton({ block = false }: { block?: boolean }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const connectors = useConnectors();
  const { mutateAsync: connect, isPending: connecting } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: switchChain, isPending: switching } = useSwitchChain();
  const notice = useNotice();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Server render and first client render must agree, so nothing wallet-shaped exists until
  // after mount. The placeholder keeps the header from jumping.
  if (!mounted) {
    return (
      <Button size={block ? "md" : "sm"} disabled className={block ? "w-full" : undefined}>
        Connect
      </Button>
    );
  }

  if (isConnected && chainId !== CHAIN_ID) {
    return (
      <Button
        size={block ? "md" : "sm"}
        className={block ? "w-full" : undefined}
        disabled={switching}
        onClick={async () => {
          try {
            await switchChain({ chainId: CHAIN_ID });
          } catch (err) {
            notice("error", "Could not switch network", describeError(err));
          }
        }}
      >
        {switching ? "Switching…" : `Switch to Robinhood Chain`}
      </Button>
    );
  }

  if (isConnected && address) {
    return (
      <div ref={wrapRef} className={block ? "relative w-full" : "relative"}>
        <Button
          size={block ? "md" : "sm"}
          variant="ghost"
          className={block ? "w-full" : undefined}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
          <span className="num">{shortAddress(address)}</span>
        </Button>
        {open ? (
          <div className={`${MENU} w-[240px]`}>
            <p className="num mb-2.5 px-1 text-xs leading-snug text-ink-3 [overflow-wrap:anywhere]">{address}</p>
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // Deduplicate by connector id: EIP-6963 discovery and the generic `injected()` connector can
  // both describe the same wallet.
  const seen = new Set<string>();
  const options = connectors.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return (
    <div ref={wrapRef} className={block ? "relative w-full" : "relative"}>
      <Button size={block ? "md" : "sm"} className={block ? "w-full" : undefined} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {connecting ? "Connecting…" : "Connect"}
      </Button>
      {open ? (
        <div className={`${MENU} w-[250px]`}>
          {options.length === 0 ? (
            <p className="px-1 py-0.5 text-[13px] text-ink-2">
              No browser wallet detected. Install one, then reload this page.
            </p>
          ) : (
            <div className="grid gap-1.5">
              {options.map((connector) => (
                <Button
                  key={connector.uid}
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start!"
                  onClick={async () => {
                    setOpen(false);
                    try {
                      await connect({ connector, chainId: CHAIN_ID });
                    } catch (err) {
                      notice("error", "Could not connect", describeError(err));
                    }
                  }}
                >
                  {connector.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
