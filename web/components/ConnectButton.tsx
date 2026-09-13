"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

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
 */
export function ConnectButton() {
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
      <button data-size="sm" disabled>
        Connect
      </button>
    );
  }

  if (isConnected && chainId !== CHAIN_ID) {
    return (
      <button
        data-size="sm"
        data-variant="primary"
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
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div ref={wrapRef} style={{ position: "relative" }}>
        <button data-size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="mono">{shortAddress(address)}</span>
        </button>
        {open ? (
          <div
            className="card"
            style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 210, padding: 10, zIndex: 40 }}
          >
            <div className="tiny faint mono" style={{ overflowWrap: "anywhere", marginBottom: 8 }}>
              {address}
            </div>
            <button
              data-size="sm"
              data-variant="ghost"
              style={{ width: "100%" }}
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
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
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button data-size="sm" data-variant="primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {connecting ? "Connecting…" : "Connect"}
      </button>
      {open ? (
        <div
          className="card"
          style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 230, padding: 10, zIndex: 40 }}
        >
          {options.length === 0 ? (
            <div className="tiny muted">
              No browser wallet detected. Install one, then reload this page.
            </div>
          ) : (
            <div className="rows">
              {options.map((connector) => (
                <button
                  key={connector.uid}
                  data-size="sm"
                  data-variant="ghost"
                  style={{ width: "100%", justifyContent: "flex-start" }}
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
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
